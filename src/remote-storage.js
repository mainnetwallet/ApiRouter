import crypto from "node:crypto";

/**
 * Remote persistence for state that must survive a redeploy.
 *
 * A host with an ephemeral disk (a free Render web service) wipes `data/` on
 * every redeploy and every wake-up. Saved custom endpoints hold API keys the
 * operator cannot be asked to retype, so they are kept somewhere that outlives
 * the container: a branch of a GitHub repository, written through the Contents
 * API.
 *
 * Keys must not sit in a repository in clear text, so everything is encrypted
 * with AES-256-GCM before it leaves the process. The passphrase is an env var
 * (CUSTOM_ENDPOINTS_SECRET) that never touches the repository: whoever reads the
 * repo sees only ciphertext, and a wrong or changed passphrase makes the blob
 * unreadable (it is then NEVER overwritten; see `read`).
 *
 * A storage object is `{ name, location, read(): Promise<string|null>, write(text): Promise<void> }`
 * and deals in plain text; encryption is internal.
 */

const MIN_SECRET_LENGTH = 12;
const REQUEST_TIMEOUT_MS = 10_000;

export class RemoteStorageError extends Error {
  constructor(message, { status = null, code = "remote_error" } = {}) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Encryption
// ---------------------------------------------------------------------------

export function encryptText(plain, secret) {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = crypto.scryptSync(secret, salt, 32);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([cipher.update(String(plain), "utf8"), cipher.final()]);
  return JSON.stringify({
    v: 1,
    alg: "aes-256-gcm",
    kdf: "scrypt",
    salt: salt.toString("base64"),
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    data: data.toString("base64")
  });
}

export function decryptText(blob, secret) {
  let envelope;
  try { envelope = JSON.parse(blob); } catch { throw new RemoteStorageError("The stored data is not an encrypted ApiRouter blob", { code: "unreadable" }); }
  if (envelope?.v !== 1 || envelope.alg !== "aes-256-gcm") {
    throw new RemoteStorageError("The stored data uses an unknown format", { code: "unreadable" });
  }
  try {
    const key = crypto.scryptSync(secret, Buffer.from(envelope.salt, "base64"), 32);
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(envelope.iv, "base64"));
    decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(envelope.data, "base64")), decipher.final()]).toString("utf8");
  } catch {
    throw new RemoteStorageError("Could not decrypt the stored data: CUSTOM_ENDPOINTS_SECRET differs from the one it was saved with", { code: "wrong_secret" });
  }
}

// ---------------------------------------------------------------------------
// GitHub (Contents API on a dedicated branch)
// ---------------------------------------------------------------------------

const encodePath = (value) => String(value).split("/").map(encodeURIComponent).join("/");

/**
 * @param repo     "owner/name"
 * @param token    fine-grained token with Contents: read & write on that repo
 * @param branch   branch the file is committed to (created from the default branch when missing).
 *                 When it is the branch the host deploys from, every save redeploys the service.
 * @param path     file path inside the repo
 * @param secret   passphrase for the AES-256-GCM encryption
 * @param apiBase  GitHub API root (GitHub Enterprise, or a mock in tests)
 */
export function createGithubStorage({ repo, token, branch, path, secret, apiBase = "https://api.github.com", fetchImpl = fetch }) {
  const root = `${String(apiBase).replace(/\/+$/, "")}/repos/${repo}`;
  let sha = null;            // blob sha of the file as last seen, needed for updates
  let branchChecked = false;

  async function call(method, url, body) {
    let response;
    try {
      response = await fetchImpl(url, {
        method,
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${token}`,
          "x-github-api-version": "2022-11-28",
          "user-agent": "apirouter-storage",
          ...(body ? { "content-type": "application/json" } : {})
        },
        body: body ? JSON.stringify(body) : undefined,
        redirect: "error",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      });
    } catch (error) {
      const timedOut = error?.name === "TimeoutError" || error?.name === "AbortError";
      throw new RemoteStorageError(timedOut ? "GitHub did not answer in time" : "Could not reach GitHub", { code: "network" });
    }
    let json = null;
    try { json = await response.json(); } catch { json = null; }
    return { status: response.status, json };
  }

  const fail = (status, what) => new RemoteStorageError(
    status === 401 || status === 403
      ? `GitHub refused the token while ${what} (HTTP ${status}). It needs Contents read and write on ${repo}`
      : `GitHub answered HTTP ${status} while ${what}`,
    { status, code: status === 401 || status === 403 ? "auth" : "remote_error" }
  );

  async function ensureBranch() {
    if (branchChecked) return;
    const ref = await call("GET", `${root}/git/ref/heads/${encodePath(branch)}`);
    if (ref.status === 200) { branchChecked = true; return; }
    if (ref.status !== 404) throw fail(ref.status, "checking the data branch");

    const info = await call("GET", root);
    if (info.status !== 200) throw fail(info.status, "reading the repository");
    const base = await call("GET", `${root}/git/ref/heads/${encodePath(info.json.default_branch)}`);
    if (base.status !== 200) throw fail(base.status, "reading the default branch");
    const created = await call("POST", `${root}/git/refs`, { ref: `refs/heads/${branch}`, sha: base.json.object.sha });
    // 422 "Reference already exists" means another instance created it first.
    if (created.status !== 201 && created.status !== 422) throw fail(created.status, "creating the data branch");
    branchChecked = true;
  }

  async function fetchFile() {
    const result = await call("GET", `${root}/contents/${encodePath(path)}?ref=${encodeURIComponent(branch)}`);
    if (result.status === 404) { sha = null; return null; }
    if (result.status !== 200) throw fail(result.status, "reading the saved endpoints");
    sha = result.json.sha ?? null;
    return Buffer.from(String(result.json.content ?? ""), "base64").toString("utf8");
  }

  return {
    name: "github",
    location: `github:${repo}@${branch}:${path}`,

    /** Plain text, or null when nothing has been saved yet. Throws if it exists but cannot be read. */
    async read() {
      const blob = await fetchFile();
      if (blob === null) return null;
      return decryptText(blob, secret);
    },

    async write(text) {
      await ensureBranch();
      const content = Buffer.from(encryptText(text, secret), "utf8").toString("base64");
      const put = () => call("PUT", `${root}/contents/${encodePath(path)}`, {
        message: "apirouter: update saved custom endpoints",
        content,
        branch,
        ...(sha ? { sha } : {})
      });
      let result = await put();
      // Someone else (or an earlier instance) changed the file: take its sha and try once more.
      if (result.status === 409 || result.status === 422) {
        await fetchFile();
        result = await put();
      }
      if (result.status !== 200 && result.status !== 201) throw fail(result.status, "saving the endpoints");
      sha = result.json?.content?.sha ?? sha;
    }
  };
}

/**
 * Builds the configured remote storage, or null when none is configured. Fails
 * fast on a half-set configuration: a repo without a token or without an
 * encryption secret must stop startup, not quietly fall back to the disk that
 * the operator is trying to get away from.
 */
export function createRemoteStorage(options, { fetchImpl } = {}) {
  if (!options) return null;
  if (!options.repo) return null;
  if (!/^[\w.-]+\/[\w.-]+$/.test(options.repo)) {
    throw new Error("Invalid CUSTOM_ENDPOINTS_GITHUB_REPO: expected owner/name");
  }
  if (!options.token) throw new Error("CUSTOM_ENDPOINTS_GITHUB_TOKEN is required when CUSTOM_ENDPOINTS_GITHUB_REPO is set");
  if (!options.secret || options.secret.length < MIN_SECRET_LENGTH) {
    throw new Error(`CUSTOM_ENDPOINTS_SECRET is required with GitHub storage (at least ${MIN_SECRET_LENGTH} characters): saved API keys are encrypted with it before they are stored`);
  }
  return createGithubStorage({ ...options, fetchImpl });
}
