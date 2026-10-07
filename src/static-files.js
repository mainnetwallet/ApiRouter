import { createReadStream } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import path from "node:path";

/**
 * Minimal static file handler for the built control panel.
 *
 * Deliberately not a general-purpose server: it serves one directory, has no
 * directory listing, follows no symlinks out of the root, and never serves a
 * dotfile. The gateway is a security boundary, so the static path is written
 * as a strict allow-list rather than a path-join convenience.
 */

const MIME_TYPES = new Map([
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".map", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".gif", "image/gif"],
  [".webp", "image/webp"],
  [".ico", "image/x-icon"],
  [".woff", "font/woff"],
  [".woff2", "font/woff2"],
  [".ttf", "font/ttf"],
  [".txt", "text/plain; charset=utf-8"],
  [".webmanifest", "application/manifest+json"]
]);

const contentTypeFor = (filePath) =>
  MIME_TYPES.get(path.extname(filePath).toLowerCase()) ?? "application/octet-stream";

/**
 * Build an ETag from size + mtime. Content hashing would be stronger, but the
 * only writer is the build step, which always changes mtime; this keeps
 * conditional polling cheap without reading every file to answer a 304.
 */
function etagFor(stats) {
  return `W/"${stats.size.toString(16)}-${Math.floor(stats.mtimeMs).toString(16)}"`;
}

function send(res, status, headers, body) {
  res.writeHead(status, headers);
  if (body === undefined) return res.end();
  return res.end(body);
}

/**
 * Resolve a URL pathname inside `root`, or return null when it escapes.
 * Rejects traversal, absolute paths, null bytes and dotfiles.
 */
export function resolveWithinRoot(root, pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(String(pathname ?? ""));
  } catch {
    return null;
  }

  if (decoded.includes("\u0000")) return null;

  const relative = decoded.replace(/^\/+/, "");
  if (relative === "") return null;

  const segments = relative.split("/");
  // A dotfile anywhere in the path is never a build artifact.
  if (segments.some((segment) => segment.startsWith(".") && segment !== "")) return null;
  if (segments.some((segment) => segment === "..")) return null;

  const resolved = path.resolve(root, ...segments);
  const rootWithSep = path.resolve(root) + path.sep;

  // `path.resolve` already collapses `..`, so this is the authoritative check:
  // whatever is left must still be inside the root.
  if (resolved !== path.resolve(root) && !resolved.startsWith(rootWithSep)) return null;

  return resolved;
}

export function createStaticHandler({ root, indexFile = "index.html" } = {}) {
  const indexPath = path.join(root, indexFile);

  async function statFile(filePath) {
    try {
      const stats = await stat(filePath);
      return stats.isFile() ? stats : null;
    } catch {
      return null;
    }
  }

  /**
   * Resolve a request path to a real regular file inside `root`, following
   * symlinks. `resolveWithinRoot` only checks the requested path lexically, so a
   * symlink planted inside the root could still point at a file outside it;
   * this is the check that refuses that. Returns null when the path escapes,
   * does not exist, or is not a regular file.
   */
  async function resolveFile(pathname) {
    const filePath = resolveWithinRoot(root, pathname);
    if (!filePath) return null;
    let real;
    try {
      real = await realpath(filePath);
    } catch {
      return null;
    }
    const realRoot = await realpath(root).catch(() => path.resolve(root));
    if (real !== realRoot && !real.startsWith(realRoot + path.sep)) return null;
    const stats = await statFile(real);
    return stats ? { filePath: real, stats } : null;
  }

  async function sendFile(req, res, filePath, stats, { immutable = false } = {}) {
    const etag = etagFor(stats);
    const lastModified = new Date(stats.mtimeMs).toUTCString();

    const headers = {
      "content-type": contentTypeFor(filePath),
      "content-length": String(stats.size),
      etag,
      "last-modified": lastModified,
      "cache-control": immutable
        ? "public, max-age=31536000, immutable"
        : "no-cache",
      // The panel is same-origin only; these headers keep a compromised or
      // injected asset from reaching out or being framed.
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer"
    };

    if (req.headers["if-none-match"] === etag) {
      delete headers["content-length"];
      return send(res, 304, headers);
    }

    if (req.method === "HEAD") {
      return send(res, 200, headers);
    }

    res.writeHead(200, headers);
    const stream = createReadStream(filePath);
    stream.on("error", () => res.destroy());
    stream.pipe(res);
    return undefined;
  }

  /** Serve a concrete asset path. Returns true when the request was handled. */
  async function serve(req, res, pathname) {
    const resolved = await resolveFile(pathname);
    if (!resolved) return false;

    // Vite emits hashed filenames under /assets, which are safe to cache hard.
    const immutable = pathname.startsWith("/assets/");
    await sendFile(req, res, resolved.filePath, resolved.stats, { immutable });
    return true;
  }

  /**
   * Serve the SPA entry point for a client-side route. Falls back to an
   * operator-facing placeholder when the panel has not been built, so a
   * backend-only deployment still starts and explains itself.
   */
  async function serveIndex(req, res) {
    const resolved = await resolveFile(`/${indexFile}`);

    if (!resolved) {
      return send(res, 200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-cache",
        "x-content-type-options": "nosniff"
      }, placeholderPage(indexFile));
    }

    return sendFile(req, res, resolved.filePath, resolved.stats);
  }

  const isBuilt = async () => Boolean(await statFile(indexPath));

  return { serve, serveIndex, isBuilt, root, indexPath };
}

/** Shown when `ui/dist` is absent — the server must never hard-fail for this. */
export function placeholderPage(indexFile = "index.html") {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>MultiAI Router</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; padding: 2.5rem 1.5rem; background: #0e1116; color: #d7dde5;
         font: 14px/1.6 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
  main { max-width: 46rem; margin: 0 auto; }
  h1 { font-size: 1.1rem; letter-spacing: .04em; text-transform: uppercase; color: #7dd3a0; }
  code, pre { background: #161b22; border: 1px solid #263041; border-radius: 3px; }
  code { padding: .1rem .35rem; }
  pre { padding: .85rem 1rem; overflow-x: auto; }
  a { color: #6ab0f3; }
  table { border-collapse: collapse; margin: .5rem 0 1rem; }
  td { padding: .2rem 1.2rem .2rem 0; }
</style>
</head>
<body>
<main>
  <h1>MultiAI Router — backend running</h1>
  <p>The control panel has not been built yet, so there is no UI to serve.</p>
  <pre>npm install
npm run ui:build</pre>
  <p>Then reload this page. The API is available immediately:</p>
  <table>
    <tr><td><a href="/health">/health</a></td><td>gateway + target health</td></tr>
    <tr><td><a href="/v1/models">/v1/models</a></td><td>model discovery</td></tr>
    <tr><td><a href="/api/system">/api/system</a></td><td>runtime and monitor status</td></tr>
    <tr><td><a href="/api/config">/api/config</a></td><td>safe configuration view</td></tr>
    <tr><td><a href="/api/health">/api/health</a></td><td>health with rollups</td></tr>
    <tr><td><a href="/api/requests">/api/requests</a></td><td>request log</td></tr>
    <tr><td><a href="/api/analytics">/api/analytics</a></td><td>metrics</td></tr>
  </table>
</main>
</body>
</html>
`;
}
