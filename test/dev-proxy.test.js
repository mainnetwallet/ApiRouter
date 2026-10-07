import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import os from "node:os";
import { PassThrough, Readable } from "node:stream";
import { createDevUiProxy, isReservedWhenDecoded, LOOP_HEADER, parseDevUiOrigin } from "../src/dev-proxy.js";
import { gatewayEnv, resolveGatewayHost, viteEnv } from "../scripts/dev-config.mjs";
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


// ---------------------------------------------------------------------------
// Regression: encoded reserved prefixes must never loop gateway -> Vite -> gateway
// ---------------------------------------------------------------------------

const RESERVED = ["/api", "/v1", "/v1beta", "/health"];
const isReserved = (pathname) => RESERVED.some((prefix) => pathname === prefix || pathname.startsWith(prefix + "/"));

/**
 * A Vite that behaves like the real one did before the fix: anything whose raw
 * URL starts with an API prefix is proxied straight back to the gateway, with
 * the caller's headers. Against the old implementation that is an endless
 * gateway <-> Vite bounce; the client request never completes.
 */
async function startLoopingVite() {
  const seen = [];
  const state = { routerBase: null };
  const server = http.createServer((req, res) => {
    seen.push(req.url);
    if (state.routerBase && RESERVED.some((prefix) => req.url.startsWith(prefix))) {
      const back = http.request(state.routerBase + req.url, { method: req.method, headers: { ...req.headers, host: new URL(state.routerBase).host } }, (backRes) => {
        res.writeHead(backRes.statusCode, backRes.headers);
        backRes.pipe(res);
      });
      back.on("error", () => res.destroy());
      req.pipe(back);
      return;
    }
    res.writeHead(200, { "content-type": "text/html" });
    res.end(`vite:${req.url}`);
  });
  const port = await getFreePort();
  await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
  return {
    origin: `http://127.0.0.1:${port}`,
    seen,
    setRouter(base) { state.routerBase = base; },
    close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); })
  };
}

const get = (base, pathname) => fetch(base + pathname, { signal: AbortSignal.timeout(3000) });

test("isReservedWhenDecoded: decodes once and recognises gateway prefixes", () => {
  for (const hit of ["/api%2fconfig", "/v1%2fmodels", "/v1beta%2fmodels", "/health%2f", "/%61pi/config", "/x%2f..%2fapi%2fconfig", "/api%5cconfig", "/api%3fx", "/api%zz"]) {
    assert.equal(isReservedWhenDecoded(hit, isReserved), true, hit);
  }
  for (const miss of ["/", "/dashboard", "/some/spa/route", "/src/main.jsx", "/@vite/client", "/a%20b", "/apiary", "/api%252fconfig"]) {
    assert.equal(isReservedWhenDecoded(miss, isReserved), false, miss);
  }
});

test("encoded reserved prefixes get a 404 from the gateway and never reach Vite", async () => {
  const vite = await startLoopingVite();
  const router = await startRouter({ MULTIAI_DEV_UI_ORIGIN: vite.origin });
  vite.setRouter(router.baseUrl);
  try {
    for (const encoded of ["/api%2fconfig", "/v1%2fmodels", "/v1beta%2fmodels", "/health%2f", "/%61pi/config", "/v1%2Fmodels"]) {
      const res = await get(router.baseUrl, encoded);
      assert.equal(res.status, 404, encoded);
      assert.match(res.headers.get("content-type"), /application\/json/, encoded);
    }
    assert.deepEqual(vite.seen, [], "none of them reached Vite, so none could be proxied back");

    // A burst (the original reproduction used 12 abandoned requests) leaves the gateway healthy.
    await Promise.all(Array.from({ length: 12 }, (_, i) => get(router.baseUrl, `/api%2fconfig${i}`).then((r) => r.status)));
    assert.deepEqual(vite.seen, []);
    assert.equal((await get(router.baseUrl, "/health")).status, 200);
  } finally {
    await router.close();
    await vite.close();
  }
});

test("a lookalike prefix that does reach Vite is stopped by the loop guard after exactly one hop", async () => {
  const vite = await startLoopingVite();
  const router = await startRouter({ MULTIAI_DEV_UI_ORIGIN: vite.origin });
  vite.setRouter(router.baseUrl);
  try {
    for (const lookalike of ["/apiary", "/health.js", "/v1beta2"]) {
      const before = vite.seen.length;
      const res = await get(router.baseUrl, lookalike);
      assert.equal(res.status, 508, `${lookalike} must end in Loop Detected, not hang`);
      assert.equal(vite.seen.length - before, 1, `${lookalike}: exactly one gateway->Vite hop`);
    }
  } finally {
    await router.close();
    await vite.close();
  }
});

test("normal panel routes still reach Vite untouched", async () => {
  const vite = await startLoopingVite();
  const router = await startRouter({ MULTIAI_DEV_UI_ORIGIN: vite.origin });
  vite.setRouter(router.baseUrl);
  try {
    for (const route of ["/", "/dashboard", "/some/spa/route", "/src/main.jsx", "/@vite/client", "/a%20b"]) {
      const res = await get(router.baseUrl, route);
      assert.equal(res.status, 200, route);
      assert.equal(await res.text(), `vite:${route}`, route);
    }
    // Real API routes are still answered by the gateway itself.
    for (const api of ["/health", "/v1/models", "/api/config"]) {
      const before = vite.seen.length;
      assert.equal((await get(router.baseUrl, api)).status, 200, api);
      assert.equal(vite.seen.length, before, `${api} must not reach Vite`);
    }
  } finally {
    await router.close();
    await vite.close();
  }
});

test("the proxy refuses a request that already carries its loop marker", async () => {
  const vite = await startFakeVite();
  const proxy = createDevUiProxy(vite.origin);
  const front = http.createServer((req, res) => proxy.handle(req, res));
  const frontPort = await getFreePort();
  await new Promise((resolve) => front.listen(frontPort, "127.0.0.1", resolve));
  try {
    const res = await fetch(`http://127.0.0.1:${frontPort}/x`, { headers: { [LOOP_HEADER]: "1" } });
    assert.equal(res.status, 508);
    assert.equal(vite.seen.length, 0);
    const ok = await fetch(`http://127.0.0.1:${frontPort}/x`);
    assert.equal(ok.status, 200);
    assert.equal(vite.seen[0].url, "/x");
  } finally {
    proxy.close();
    front.closeAllConnections();
    await new Promise((resolve) => front.close(resolve));
    await vite.close();
  }
});

// ---------------------------------------------------------------------------
// Regression: Vite filesystem endpoints are not offered to remote clients
// ---------------------------------------------------------------------------

/** Drives proxy.handle with a stubbed connection so the peer address can be non-loopback. */
function viaPeer(proxy, remoteAddress, url) {
  return new Promise((resolve) => {
    const req = Object.assign(Readable.from([]), { url, method: "GET", headers: {}, socket: { remoteAddress } });
    const res = new PassThrough();
    let body = "";
    res.writeHead = (status) => { res.status = status; };
    res.on("data", (chunk) => { body += chunk; });
    res.on("end", () => resolve({ status: res.status, body }));
    res.on("close", () => resolve({ status: res.status, body }));
    proxy.handle(req, res);
  });
}

test("remote peers cannot reach Vite's filesystem endpoints; loopback and prebundled deps still work", async () => {
  const vite = await startFakeVite();
  const proxy = createDevUiProxy(vite.origin);
  try {
    const remote = "192.0.2.9";
    for (const blocked of [
      "/@fs/home/dev/repo/src/config.js",
      "/@fs/home/dev/repo/package.json",
      "/@fs/home/dev/repo/node_modules/.vite/deps/../../../src/config.js",
      "/@fs/home/dev/repo/node_modules/.vite/deps/%2e%2e/%2e%2e/%2e%2e/src/config.js",
      "/%40fs/home/dev/repo/src/config.js",
      "/@FS/home/dev/repo/src/config.js",
      "/__open-in-editor?file=src/config.js",
      "/@fs/%zz"
    ]) {
      const res = await viaPeer(proxy, remote, blocked);
      assert.equal(res.status, 403, blocked);
    }
    assert.equal(vite.seen.length, 0, "blocked requests were not forwarded");

    // What the panel itself needs from a remote browser keeps working.
    for (const allowed of [
      "/@fs/home/dev/repo/node_modules/.vite/deps/react.js?v=49926102",
      "/@fs/home/dev/repo/node_modules/.vite/deps/react-dom_client.js?v=1",
      "/src/main.jsx",
      "/@vite/client",
      "/"
    ]) {
      const res = await viaPeer(proxy, remote, allowed);
      assert.equal(res.status, 200, allowed);
    }

    // The developer on this machine is unrestricted.
    for (const local of ["127.0.0.1", "::1", "::ffff:127.0.0.1"]) {
      assert.equal((await viaPeer(proxy, local, "/@fs/home/dev/repo/src/config.js")).status, 200, local);
    }
  } finally {
    proxy.close();
    await vite.close();
  }
});

// ---------------------------------------------------------------------------
// Regression: `npm run dev` binds to loopback unless HOST is set on purpose
// ---------------------------------------------------------------------------

test("dev launch config: HOST defaults to loopback and an explicit HOST is never overridden", () => {
  for (const unset of [{}, { HOST: "" }, { HOST: "   " }, { HOST: undefined }]) {
    assert.equal(resolveGatewayHost(unset), "127.0.0.1", JSON.stringify(unset));
  }
  for (const explicit of ["0.0.0.0", "::", "192.168.1.5", "localhost", "::1"]) {
    assert.equal(resolveGatewayHost({ HOST: explicit }), explicit);
  }
  assert.equal(resolveGatewayHost({ HOST: " 0.0.0.0 " }), "0.0.0.0");

  const env = gatewayEnv({}, 4321);
  assert.deepEqual(env, { HOST: "127.0.0.1", MULTIAI_DEV_UI_ORIGIN: "http://127.0.0.1:4321" });
  assert.doesNotThrow(() => parseDevUiOrigin(env.MULTIAI_DEV_UI_ORIGIN), "the origin handed to the gateway passes its own validation");
  assert.equal(gatewayEnv({ HOST: "0.0.0.0" }, 1).HOST, "0.0.0.0");
  assert.equal(viteEnv.MULTIAI_UI_BEHIND_GATEWAY, "1");
});

test("vite.config only proxies the API in standalone mode, never behind the gateway", async () => {
  const configUrl = new URL("../ui/vite.config.js", import.meta.url).href;
  const load = async (flag) => {
    const previous = process.env.MULTIAI_UI_BEHIND_GATEWAY;
    if (flag === undefined) delete process.env.MULTIAI_UI_BEHIND_GATEWAY; else process.env.MULTIAI_UI_BEHIND_GATEWAY = flag;
    try {
      return (await import(`${configUrl}?flag=${String(flag)}`)).default.server.proxy;
    } finally {
      if (previous === undefined) delete process.env.MULTIAI_UI_BEHIND_GATEWAY; else process.env.MULTIAI_UI_BEHIND_GATEWAY = previous;
    }
  };
  assert.deepEqual(Object.keys(await load(undefined)).sort(), ["/api", "/health", "/v1", "/v1beta"], "standalone ui:dev keeps its proxy");
  assert.equal(await load("1"), undefined, "behind the gateway Vite proxies nothing");
});

const externalIPv4 = Object.values(os.networkInterfaces()).flat().find((i) => i && i.family === "IPv4" && !i.internal)?.address;
const repoRoot = fileURLToPath(new URL("..", import.meta.url));

async function launchDev(envOverrides) {
  const port = await getFreePort();
  const env = { ...process.env, PORT: String(port), DOTENV_CONFIG_PATH: "/nonexistent/.env", MULTIAI_DEV_UI_ORIGIN: "", ...envOverrides };
  if (envOverrides.HOST === undefined) delete env.HOST;
  const child = spawn(process.execPath, ["scripts/dev.mjs"], { cwd: repoRoot, env, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", (c) => { out += c; });
  child.stderr.on("data", (c) => { out += c; });
  const exited = new Promise((resolve) => child.once("exit", resolve));
  const deadline = Date.now() + 60000;
  while (!out.includes("[dev] Ready")) {
    if (Date.now() > deadline || child.exitCode !== null) throw new Error(`npm run dev did not become ready:\n${out}`);
    await new Promise((r) => setTimeout(r, 100));
  }
  return {
    port,
    async stop() {
      child.kill("SIGINT");
      await Promise.race([exited, new Promise((r) => setTimeout(r, 10000))]);
      if (child.exitCode === null) child.kill("SIGKILL");
    }
  };
}

function canConnect(host, port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port, timeout: 2000 });
    socket.once("connect", () => { socket.destroy(); resolve(true); });
    socket.once("error", () => resolve(false));
    socket.once("timeout", () => { socket.destroy(); resolve(false); });
  });
}

test("npm run dev with HOST unset listens on loopback only", { skip: externalIPv4 ? false : "no non-loopback IPv4 interface to probe", timeout: 90000 }, async () => {
  const dev = await launchDev({});
  try {
    assert.equal((await fetch(`http://127.0.0.1:${dev.port}/health`)).status, 200, "loopback works");
    assert.equal(await canConnect(externalIPv4, dev.port), false, "the LAN address must refuse connections");
  } finally {
    await dev.stop();
  }
});

test("npm run dev with an explicit HOST=0.0.0.0 is reachable, but still withholds the source tree from remote peers", { skip: externalIPv4 ? false : "no non-loopback IPv4 interface to probe", timeout: 90000 }, async () => {
  const dev = await launchDev({ HOST: "0.0.0.0" });
  try {
    const remote = `http://${externalIPv4}:${dev.port}`;
    assert.equal((await fetch(`${remote}/health`)).status, 200, "explicit HOST is honoured");
    const main = await (await fetch(`${remote}/src/main.jsx`)).text();
    const dep = main.match(/"(\/@fs\/[^"]*\/node_modules\/\.vite\/deps\/[^"]+)"/)?.[1];
    assert.ok(dep, "the panel's dependencies are still addressed through /@fs");
    assert.equal((await fetch(remote + dep)).status, 200, "so the panel keeps working for a remote browser");

    const secret = `/@fs${repoRoot.replace(/\/$/, "")}/src/config.js`;
    assert.equal((await fetch(remote + secret)).status, 403, "backend source is not served to a remote peer");
    assert.equal((await fetch(`${remote}/@fs${repoRoot.replace(/\/$/, "")}/package.json`)).status, 403);
    assert.equal((await fetch(`http://127.0.0.1:${dev.port}${secret}`)).status, 200, "the local developer is unrestricted");
  } finally {
    await dev.stop();
  }
});
