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
 *
 * The unified model configuration (see model-config.js) is stored by the same
 * Contents API machinery but as PLAIN versioned JSON, because it holds no
 * credentials at all — model ids, capability declarations and flags only. Its
 * storage object is `{ name, location, read(): Promise<{text,revision}|null>, write(text, { expectedRevision }) }`,
 * and unlike the encrypted store it NEVER retries over a conflict: a write with
 * a stale revision is refused, so a newer configuration saved elsewhere cannot
 * be overwritten by this instance.
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
 * The shared Contents-API client: branch creation, reads that carry the blob
 * sha, and writes that use that sha as a concurrency token.
 *
 * `put()` throws `RemoteStorageError` with `code: "conflict"` when GitHub
 * rejects the sha. How a caller recovers is deliberately its own decision: the
 * encrypted endpoint store retries once (it owns the whole list), while the
 * model configuration refuses and asks the operator to reload.
 */
function createGithubClient({ repo, token, branch, path, apiBase = "https://api.github.com", fetchImpl = fetch, noun = "configuration" }) {
  const root = `${String(apiBase).replace(/\/+$/, "")}/repos/${repo}`;
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

  /** `{ text, revision }` for the file as GitHub holds it, or null when absent. */
  async function readSnapshot() {
    const result = await call("GET", `${root}/contents/${encodePath(path)}?ref=${encodeURIComponent(branch)}`);
    if (result.status === 404) return null;
    if (result.status !== 200) throw fail(result.status, `reading the saved ${noun}`);
    return {
      text: Buffer.from(String(result.json.content ?? ""), "base64").toString("utf8"),
      revision: result.json.sha ?? null
    };
  }

  async function put(text, { revision = null, message } = {}) {
    const content = Buffer.from(text, "utf8").toString("base64");
    const result = await call("PUT", `${root}/contents/${encodePath(path)}`, {
      message,
      content,
      branch,
      ...(revision ? { sha: revision } : {})
    });
    if (result.status === 409 || result.status === 422) {
      throw new RemoteStorageError(
        `The saved ${noun} changed on GitHub while it was being saved (HTTP ${result.status}). Reload and try again.`,
        { status: 409, code: "conflict" }
      );
    }
    if (result.status !== 200 && result.status !== 201) throw fail(result.status, `saving the ${noun}`);
    return { revision: result.json?.content?.sha ?? revision };
  }

  return {
    location: `github:${repo}@${branch}:${path}`,
    ensureBranch,
    readSnapshot,
    put
  };
}

/**
 * The encrypted custom-endpoint store (unchanged wire behaviour).
 *
 * @param repo     "owner/name"
 * @param token    fine-grained token with Contents: read & write on that repo
 * @param branch   branch the file is committed to (created from the default branch when missing).
 * @param path     file path inside the repo
 * @param secret   passphrase for the AES-256-GCM encryption
 * @param apiBase  GitHub API root (GitHub Enterprise, or a mock in tests)
 */
export function createGithubStorage({ repo, token, branch, path, secret, apiBase = "https://api.github.com", fetchImpl = fetch }) {
  const client = createGithubClient({ repo, token, branch, path, apiBase, fetchImpl, noun: "endpoints" });
  let sha = null;

  return {
    name: "github",
    location: client.location,

    /** Plain text, or null when nothing has been saved yet. Throws if it exists but cannot be read. */
    async read() {
      const snapshot = await client.readSnapshot();
      if (snapshot === null) { sha = null; return null; }
      sha = snapshot.revision;
      return decryptText(snapshot.text, secret);
    },

    async write(text) {
      await client.ensureBranch();
      const blob = encryptText(text, secret);
      const message = "apirouter: update saved custom endpoints";
      const put = () => client.put(blob, { revision: sha, message });
      let result;
      try {
        result = await put();
      } catch (error) {
        // Someone else (or an earlier instance) changed the file: take its sha and try once more.
        if (error?.code !== "conflict") throw error;
        const latest = await client.readSnapshot();
        sha = latest?.revision ?? null;
        result = await put();
      }
      sha = result.revision;
    }
  };
}

/**
 * Builds the configured remote storage for custom endpoints, or null when none
 * is configured. Fails fast on a half-set configuration: a repo without a token
 * or without an encryption secret must stop startup, not quietly fall back to
 * the disk that the operator is trying to get away from.
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

/**
 * Plain, versioned JSON storage for the unified model configuration.
 *
 * No encryption: the document holds model ids, capability declarations, enabled
 * flags and a non-secret metadata bag; credentials are never accepted (see
 * model-config.js). The blob sha read with the document is its revision, and a
 * write must present that revision — GitHub then refuses a stale save instead
 * of silently replacing a newer one from another device.
 */
export function createModelConfigStorage(options, { fetchImpl = fetch } = {}) {
  if (!options?.repo) return null;
  if (!/^[\w.-]+\/[\w.-]+$/.test(options.repo)) {
    throw new Error("Invalid MODEL_CONFIG_GITHUB_REPO: expected owner/name");
  }
  if (!options.token) {
    throw new Error("MODEL_CONFIG_GITHUB_TOKEN (or CUSTOM_ENDPOINTS_GITHUB_TOKEN) is required when MODEL_CONFIG_GITHUB_REPO is set");
  }
  const client = createGithubClient({
    repo: options.repo,
    token: options.token,
    branch: options.branch || "main",
    path: options.path || "model-config.json",
    apiBase: options.apiBase || "https://api.github.com",
    fetchImpl,
    noun: "model configuration"
  });

  let revision = null;

  return {
    name: "github",
    kind: "plain",
    location: client.location,

    /** `{ text, revision }`, or null when nothing has been saved yet. */
    async read() {
      const snapshot = await client.readSnapshot();
      revision = snapshot?.revision ?? null;
      return snapshot;
    },

    /** Returns the new revision. A stale `expectedRevision` is refused, never retried over. */
    async write(text, { expectedRevision = revision } = {}) {
      await client.ensureBranch();
      const result = await client.put(text, {
        revision: expectedRevision,
        message: "apirouter: update model configuration"
      });
      revision = result.revision;
      return result;
    }
  };
}
