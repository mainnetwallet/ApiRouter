import http from "node:http";

/**
 * Development-only reverse proxy for the control panel.
 *
 * `npm run dev` runs the Vite dev server on a private loopback port and points
 * the gateway at it with `MULTIAI_DEV_UI_ORIGIN`. The gateway stays the single
 * browser-facing origin: it forwards panel requests (HTML, modules, HMR
 * WebSocket) to Vite and keeps handling `/api`, `/v1`, `/v1beta` and `/health`
 * itself. Nothing here is reachable in production, where the variable is unset
 * and `ui/dist` is served instead.
 *
 * The upstream is fixed at start-up and must be a loopback `http://host:port`
 * origin. No part of a request ever selects the destination, so this cannot be
 * used as an open proxy.
 */

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** Hop-by-hop headers that must not be forwarded on a plain (non-upgrade) request. */
const HOP_BY_HOP = ["connection", "keep-alive", "proxy-connection", "transfer-encoding", "te", "trailer", "upgrade"];

/**
 * Validate the configured Vite origin. Throws on anything that is not a bare
 * loopback http origin with an explicit port, so a typo or a hostile value in
 * `.env` fails at start-up instead of becoming a proxy target.
 */
export function parseDevUiOrigin(value) {
  let url;
  try {
    url = new URL(String(value));
  } catch {
    throw new Error(`Invalid MULTIAI_DEV_UI_ORIGIN: expected http://127.0.0.1:<port>`);
  }
  const bare = url.pathname === "/" && !url.search && !url.hash && !url.username && !url.password;
  if (url.protocol !== "http:" || !LOOPBACK_HOSTS.has(url.hostname) || !url.port || !bare) {
    throw new Error("Invalid MULTIAI_DEV_UI_ORIGIN: only a loopback http origin with an explicit port is allowed");
  }
  return url;
}

/** `http://[::1]:1` has hostname "[::1]"; http.request wants it without brackets. */
function connectHost(url) {
  return url.hostname.startsWith("[") ? url.hostname.slice(1, -1) : url.hostname;
}

/** Request targets must be origin-form paths; collapse a leading "//" like the router does. */
function safePath(rawUrl) {
  const value = String(rawUrl ?? "");
  return value.startsWith("/") ? value.replace(/^\/{2,}/, "/") : null;
}

/** Marks requests this proxy forwards, so one that comes back is refused instead of looping. */
export const LOOP_HEADER = "x-multiai-dev-proxy";

/**
 * True when percent-decoding the path (once) and normalising it lands on a
 * gateway-owned prefix, e.g. `/api%2fconfig` or `/%61pi/config`. Such a request
 * is not a panel route and must never be forwarded to Vite. A path with a
 * malformed escape is treated the same way: Vite would reject it anyway and
 * it is not worth forwarding. `isReserved` is the gateway's own predicate, so
 * there is one definition of "reserved".
 */
export function isReservedWhenDecoded(pathname, isReserved) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return true;
  }
  if (decoded === pathname) return false;
  try {
    const canonical = new URL(decoded.replace(/^\/{2,}/, "/"), "http://localhost").pathname.replace(/\/{2,}/g, "/");
    return isReserved(canonical);
  } catch {
    return true;
  }
}

const LOOPBACK_PEERS = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

/**
 * Vite endpoints that read the local filesystem. They stay available to the
 * developer on loopback; a remote client (only possible when `HOST` was set to
 * a non-loopback address on purpose) may fetch just the prebundled dependency
 * files the panel itself needs, never arbitrary project files.
 */
const FS_ENDPOINTS = ["/@fs", "/__open-in-editor"];
const PREBUNDLED_DEPS = /^\/@fs\/[^?#]*\/node_modules\/\.vite\/deps\/[A-Za-z0-9_.@-]+$/;

function isRestrictedForRemote(path) {
  const rawPath = path.split(/[?#]/, 1)[0];
  let decoded;
  try {
    decoded = decodeURIComponent(rawPath);
  } catch {
    return true;
  }
  let canonical;
  try {
    canonical = new URL(decoded, "http://localhost").pathname;
  } catch {
    return true;
  }
  const lower = canonical.toLowerCase();
  const rawLower = rawPath.toLowerCase();
  const touchesFs = FS_ENDPOINTS.some((prefix) => lower.startsWith(prefix) || rawLower.startsWith(prefix));
  if (!touchesFs) return false;
  return !(decoded === rawPath && canonical === rawPath && PREBUNDLED_DEPS.test(canonical));
}

/**
 * Returns `null` when no origin is configured (production), so callers can use
 * `devUi?.…` and the whole feature is inert unless explicitly enabled.
 */
export function createDevUiProxy(originValue) {
  if (originValue === undefined || originValue === null || String(originValue).trim() === "") return null;
  const target = parseDevUiOrigin(String(originValue).trim());
  const hostname = connectHost(target);
  const sockets = new Set();

  function unavailable(res) {
    if (res.headersSent || res.writableEnded) {
      res.destroy();
      return;
    }
    res.writeHead(502, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
    res.end("Control panel dev server (Vite) is not reachable. It is started by `npm run dev`; check that terminal for errors.\n");
  }

  /** Forward one HTTP request to Vite and stream the response back. */
  function handle(req, res) {
    const path = safePath(req.url);
    if (path === null) {
      res.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
      res.end("Invalid request target\n");
      return;
    }
    if (req.headers[LOOP_HEADER]) {
      res.writeHead(508, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
      res.end("Loop detected: this request already passed through the dev proxy.\n");
      return;
    }
    if (!LOOPBACK_PEERS.has(req.socket?.remoteAddress) && isRestrictedForRemote(path)) {
      res.writeHead(403, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
      res.end("Forbidden: this development endpoint is only available from the local machine.\n");
      return;
    }
    const headers = { ...req.headers, host: target.host, [LOOP_HEADER]: "1" };
    for (const name of HOP_BY_HOP) delete headers[name];

    const upstream = http.request(
      { hostname, port: Number(target.port), method: req.method, path, headers },
      (upstreamRes) => {
        res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
        upstreamRes.pipe(res);
        upstreamRes.on("error", () => res.destroy());
      }
    );
    upstream.on("error", () => unavailable(res));
    res.on("close", () => upstream.destroy());
    req.pipe(upstream);
  }

  /** Forward a WebSocket upgrade (Vite HMR) and then relay bytes both ways. */
  function upgrade(req, socket, head) {
    const path = safePath(req.url);
    if (path === null || req.headers[LOOP_HEADER] || String(req.headers.upgrade ?? "").toLowerCase() !== "websocket") {
      socket.destroy();
      return;
    }
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => socket.destroy());

    const upstream = http.request({
      hostname,
      port: Number(target.port),
      method: req.method,
      path,
      headers: { ...req.headers, host: target.host, [LOOP_HEADER]: "1" }
    });
    upstream.on("upgrade", (upstreamRes, upstreamSocket, upstreamHead) => {
      sockets.add(upstreamSocket);
      upstreamSocket.on("close", () => { sockets.delete(upstreamSocket); socket.destroy(); });
      upstreamSocket.on("error", () => upstreamSocket.destroy());
      socket.on("close", () => upstreamSocket.destroy());

      let raw = `HTTP/1.1 ${upstreamRes.statusCode} ${upstreamRes.statusMessage}\r\n`;
      for (let i = 0; i < upstreamRes.rawHeaders.length; i += 2) {
        raw += `${upstreamRes.rawHeaders[i]}: ${upstreamRes.rawHeaders[i + 1]}\r\n`;
      }
      socket.write(raw + "\r\n");
      if (upstreamHead?.length) socket.write(upstreamHead);
      if (head?.length) upstreamSocket.write(head);
      upstreamSocket.pipe(socket);
      socket.pipe(upstreamSocket);
    });
    // Vite declined the upgrade (e.g. a non-HMR path): relay its answer and close.
    upstream.on("response", (upstreamRes) => {
      let raw = `HTTP/1.1 ${upstreamRes.statusCode} ${upstreamRes.statusMessage}\r\n`;
      for (let i = 0; i < upstreamRes.rawHeaders.length; i += 2) {
        raw += `${upstreamRes.rawHeaders[i]}: ${upstreamRes.rawHeaders[i + 1]}\r\n`;
      }
      socket.write(raw + "\r\n");
      upstreamRes.pipe(socket);
    });
    upstream.on("error", () => socket.destroy());
    upstream.end();
  }

  /** Drop every live upgraded socket so `server.close()` can finish on shutdown. */
  function close() {
    for (const socket of sockets) socket.destroy();
    sockets.clear();
  }

  return { origin: target.origin, handle, upgrade, close };
}
