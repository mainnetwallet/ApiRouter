import http from "node:http";
import { getFreePort } from "./mock-upstream.js";

/**
 * A tiny stand-in for the parts of the GitHub REST API that remote storage
 * uses: repo info, branch refs and the Contents API (with sha conflict rules).
 * Everything is kept in memory, so "the repository" outlives any router process
 * a test starts and stops, exactly like the real thing outlives a Render deploy.
 */
export async function startMockGithub({ token = "ghp_testtoken", repo = "acme/data", defaultBranch = "main" } = {}) {
  const branches = new Map([[defaultBranch, "base-sha"]]);
  const files = new Map(); // `${branch}:${path}` -> { content (base64), sha }
  const requests = [];
  let counter = 0;
  let failing = false;

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const url = new URL(req.url, "http://x");
      let body = null;
      try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { body = null; }
      requests.push({ method: req.method, path: url.pathname, headers: req.headers, body });

      const send = (status, json) => {
        const payload = JSON.stringify(json ?? {});
        res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(payload) });
        res.end(payload);
      };
      if (failing) return send(503, { message: "unavailable" });
      if (req.headers.authorization !== `Bearer ${token}`) return send(401, { message: "Bad credentials" });

      const base = `/repos/${repo}`;
      const p = url.pathname;
      if (req.method === "GET" && p === base) return send(200, { default_branch: defaultBranch });

      const ref = p.startsWith(`${base}/git/ref/heads/`) ? decodeURIComponent(p.slice(`${base}/git/ref/heads/`.length)) : null;
      if (req.method === "GET" && ref !== null) return branches.has(ref) ? send(200, { object: { sha: branches.get(ref) } }) : send(404, {});

      if (req.method === "POST" && p === `${base}/git/refs`) {
        const name = String(body?.ref ?? "").replace("refs/heads/", "");
        if (branches.has(name)) return send(422, { message: "Reference already exists" });
        branches.set(name, body.sha);
        return send(201, {});
      }

      if (p.startsWith(`${base}/contents/`)) {
        const file = decodeURIComponent(p.slice(`${base}/contents/`.length));
        if (req.method === "GET") {
          const branch = url.searchParams.get("ref") || defaultBranch;
          const entry = files.get(`${branch}:${file}`);
          return entry ? send(200, { content: entry.content, sha: entry.sha, encoding: "base64" }) : send(404, {});
        }
        if (req.method === "PUT") {
          const branch = body?.branch || defaultBranch;
          if (!branches.has(branch)) return send(404, { message: "Branch not found" });
          const entry = files.get(`${branch}:${file}`);
          if (entry && body.sha !== entry.sha) return send(409, { message: "sha does not match" });
          if (!entry && body.sha) return send(422, { message: "sha given for a new file" });
          counter += 1;
          const saved = { content: body.content, sha: `sha-${counter}` };
          files.set(`${branch}:${file}`, saved);
          return send(entry ? 200 : 201, { content: { sha: saved.sha } });
        }
      }
      return send(404, { message: "not mocked" });
    });
  });

  const port = await getFreePort();
  await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
  return {
    apiBase: `http://127.0.0.1:${port}`,
    token,
    repo,
    branches,
    files,
    requests,
    /** Make every call answer 503 (GitHub down) until set back to false. */
    setFailing(value) { failing = value; },
    /** Stored text of a file, exactly as the repository holds it. */
    stored(branch, file) {
      const entry = files.get(`${branch}:${file}`);
      return entry ? Buffer.from(entry.content, "base64").toString("utf8") : null;
    },
    close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); })
  };
}
