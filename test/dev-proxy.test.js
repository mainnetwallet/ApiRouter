import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createDevUiProxy, parseDevUiOrigin } from "../src/dev-proxy.js";
import { getFreePort } from "../test-helpers/mock-upstream.js";
import { startRouter } from "../test-helpers/router-harness.js";

// The development UI proxy only exists for `npm run dev`. These tests pin its
// safety (fixed loopback target, inert when unset) and its behaviour (HTTP and
// the WebSocket upgrade that carries Vite HMR), and that the gateway keeps
// ownership of /api, /v1, /v1beta and /health when it is enabled.

/** Stand-in for the Vite dev server: echoes what it was asked and accepts a WebSocket upgrade. */
async function startFakeVite() {
  const seen = [];
  const upgraded = new Set();
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      seen.push({ method: req.method, url: req.url, host: req.headers.host, body: Buffer.concat(chunks).toString() });
      res.writeHead(200, { "content-type": "text/html", "x-fake-vite": "1" });
      res.end(`<!doctype html><title>fake-vite</title>${req.url}`);
    });
  });
  server.on("upgrade", (req, socket) => {
    seen.push({ upgrade: req.headers.upgrade, url: req.url, host: req.headers.host });
    upgraded.add(socket);
    socket.on("close", () => upgraded.delete(socket));
    socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n");
    socket.on("data", (d) => socket.write(Buffer.concat([Buffer.from("echo:"), d])));
    socket.on("error", () => {});
  });
  const port = await getFreePort();
  await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
  return {
    port,
    origin: `http://127.0.0.1:${port}`,
    seen,
    // closeAllConnections() does not track upgraded sockets, so drop those too.
    close: () => new Promise((resolve) => {
      for (const socket of upgraded) socket.destroy();
      server.closeAllConnections();
      server.close(resolve);
    })
  };
}

test("parseDevUiOrigin accepts only a bare loopback http origin with a port", () => {
  for (const ok of ["http://127.0.0.1:5173", "http://localhost:5173", "http://[::1]:5173", "http://127.0.0.1:5173/"]) {
    assert.doesNotThrow(() => parseDevUiOrigin(ok), ok);
  }
  for (const bad of [
    "https://127.0.0.1:5173", "http://127.0.0.1", "http://example.com:5173", "http://10.0.0.5:5173",
    "http://169.254.169.254:80", "http://127.0.0.1:5173/app", "http://127.0.0.1:5173/?x=1",
    "http://user:pw@127.0.0.1:5173", "ftp://127.0.0.1:5173", "not a url", "localhost:5173"
  ]) {
    assert.throws(() => parseDevUiOrigin(bad), /MULTIAI_DEV_UI_ORIGIN/, bad);
  }
});

test("createDevUiProxy is inert (null) unless an origin is configured", () => {
  for (const value of [undefined, null, "", "   "]) assert.equal(createDevUiProxy(value), null);
  assert.throws(() => createDevUiProxy("http://evil.example:80"), /loopback/);
});

test("proxies HTTP to the fixed target, rewriting Host and keeping the path", async () => {
  const vite = await startFakeVite();
  const proxy = createDevUiProxy(vite.origin);
  const front = http.createServer((req, res) => proxy.handle(req, res));
  const frontPort = await getFreePort();
  await new Promise((resolve) => front.listen(frontPort, "127.0.0.1", resolve));
  try {
    const res = await fetch(`http://localhost:${frontPort}/src/main.jsx?t=1`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("x-fake-vite"), "1");
    assert.match(await res.text(), /fake-vite/);
    assert.equal(vite.seen[0].url, "/src/main.jsx?t=1");
    assert.equal(vite.seen[0].host, `127.0.0.1:${vite.port}`, "Host is rewritten to the fixed upstream");

    const post = await fetch(`http://localhost:${frontPort}/x`, { method: "POST", body: "payload" });
    assert.equal(post.status, 200);
    assert.equal(vite.seen[1].body, "payload");
  } finally {
    proxy.close();
    front.closeAllConnections();
    await new Promise((resolve) => front.close(resolve));
    await vite.close();
  }
});

test("an absolute-form request target cannot redirect the proxy elsewhere", async () => {
  const vite = await startFakeVite();
  const proxy = createDevUiProxy(vite.origin);
  const front = http.createServer((req, res) => proxy.handle(req, res));
  const frontPort = await getFreePort();
  await new Promise((resolve) => front.listen(frontPort, "127.0.0.1", resolve));
  try {
    const status = await new Promise((resolve, reject) => {
      const socket = net.connect(frontPort, "127.0.0.1", () => {
        socket.write("GET http://169.254.169.254/latest/meta-data HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n");
      });
      let data = "";
      socket.on("data", (d) => { data += d; });
      socket.on("end", () => resolve(data.split(" ")[1]));
      socket.on("error", reject);
    });
    assert.equal(status, "400");
    assert.equal(vite.seen.length, 0, "nothing was forwarded");
  } finally {
    proxy.close();
    front.closeAllConnections();
    await new Promise((resolve) => front.close(resolve));
    await vite.close();
  }
});

test("answers 502 when the dev server is down", async () => {
  const deadPort = await getFreePort();
  const proxy = createDevUiProxy(`http://127.0.0.1:${deadPort}`);
  const front = http.createServer((req, res) => proxy.handle(req, res));
  const frontPort = await getFreePort();
  await new Promise((resolve) => front.listen(frontPort, "127.0.0.1", resolve));
  try {
    const res = await fetch(`http://localhost:${frontPort}/`);
    assert.equal(res.status, 502);
    assert.match(await res.text(), /npm run dev/);
  } finally {
    proxy.close();
    front.closeAllConnections();
    await new Promise((resolve) => front.close(resolve));
  }
});

test("relays a WebSocket upgrade (Vite HMR) both ways and close() drops it", async () => {
  const vite = await startFakeVite();
  const proxy = createDevUiProxy(vite.origin);
  const front = http.createServer((req, res) => proxy.handle(req, res));
  front.on("upgrade", (req, socket, head) => proxy.upgrade(req, socket, head));
  const frontPort = await getFreePort();
  await new Promise((resolve) => front.listen(frontPort, "127.0.0.1", resolve));
  try {
    const socket = net.connect(frontPort, "127.0.0.1");
    let received = "";
    socket.on("data", (d) => { received += d; });
    socket.on("error", () => {});
    await new Promise((resolve) => socket.once("connect", resolve));
    socket.write("GET /?token=abc HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGVzdA==\r\nSec-WebSocket-Protocol: vite-hmr\r\n\r\n");
    await waitFor(() => received.includes("101 Switching Protocols"));
    socket.write("ping");
    await waitFor(() => received.includes("echo:ping"));
    assert.equal(vite.seen[0].upgrade, "websocket");
    assert.equal(vite.seen[0].url, "/?token=abc");

    const closed = new Promise((resolve) => socket.once("close", resolve));
    proxy.close();
    await closed;
  } finally {
    proxy.close();
    front.closeAllConnections();
    await new Promise((resolve) => front.close(resolve));
    await vite.close();
  }
});

test("a non-WebSocket upgrade request is refused", async () => {
  const vite = await startFakeVite();
  const proxy = createDevUiProxy(vite.origin);
  const front = http.createServer((req, res) => proxy.handle(req, res));
  front.on("upgrade", (req, socket, head) => proxy.upgrade(req, socket, head));
  const frontPort = await getFreePort();
  await new Promise((resolve) => front.listen(frontPort, "127.0.0.1", resolve));
  try {
    const socket = net.connect(frontPort, "127.0.0.1");
    socket.on("error", () => {});
    await new Promise((resolve) => socket.once("connect", resolve));
    const closed = new Promise((resolve) => socket.once("close", resolve));
    socket.write("GET / HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: h2c\r\n\r\n");
    await closed;
    assert.equal(vite.seen.length, 0);
  } finally {
    proxy.close();
    front.closeAllConnections();
    await new Promise((resolve) => front.close(resolve));
    await vite.close();
  }
});

test("gateway with the dev proxy enabled: panel goes to Vite, gateway routes stay on the gateway", async () => {
  const vite = await startFakeVite();
  const router = await startRouter({ MULTIAI_DEV_UI_ORIGIN: vite.origin });
  try {
    const panel = await router.request("/providers");
    assert.equal(panel.status, 200);
    assert.match(await panel.text(), /fake-vite/);

    for (const reserved of ["/health", "/v1/models", "/api/config"]) {
      const before = vite.seen.length;
      const res = await router.request(reserved);
      assert.equal(res.status, 200, reserved);
      assert.match(res.headers.get("content-type"), /application\/json/, reserved);
      assert.equal(vite.seen.length, before, `${reserved} must not reach Vite`);
    }
    for (const unknown of ["/v1/nope", "/api/nope", "/v1beta/nope"]) {
      const before = vite.seen.length;
      const res = await router.request(unknown);
      assert.equal(res.status, 404, unknown);
      assert.equal(vite.seen.length, before, `${unknown} must not reach Vite`);
    }
    const post = await router.request("/dashboard", { method: "POST", body: "{}" });
    assert.equal(post.status, 404, "non-GET panel paths are not forwarded");
  } finally {
    await router.close();
    await vite.close();
  }
});

test("gateway without MULTIAI_DEV_UI_ORIGIN never proxies (production behaviour)", async () => {
  const vite = await startFakeVite();
  const router = await startRouter();
  try {
    const res = await router.request("/some-route");
    assert.ok(!(await res.text()).includes("fake-vite"));
    assert.equal(vite.seen.length, 0);
  } finally {
    await router.close();
    await vite.close();
  }
});

test("gateway refuses to start with a non-loopback MULTIAI_DEV_UI_ORIGIN", async () => {
  const server = fileURLToPath(new URL("../src/server.js", import.meta.url));
  const port = await getFreePort();
  const child = spawn(process.execPath, [server], {
    env: { ...process.env, PORT: String(port), MULTIAI_DEV_UI_ORIGIN: "http://example.com:80" },
    stdio: ["ignore", "ignore", "pipe"]
  });
  let stderr = "";
  child.stderr.on("data", (c) => { stderr += c; });
  const code = await new Promise((resolve) => child.once("exit", resolve));
  assert.notEqual(code, 0);
  assert.match(stderr, /MULTIAI_DEV_UI_ORIGIN/);
});

async function waitFor(predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for condition");
    await new Promise((r) => setTimeout(r, 20));
  }
}
