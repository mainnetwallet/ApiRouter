/**
 * `npm run dev`: one command, one URL.
 *
 * Starts the gateway (`node --watch src/server.js`) and the Vite dev server,
 * and wires the gateway to Vite through `MULTIAI_DEV_UI_ORIGIN` so the browser
 * only ever talks to the gateway port (default http://localhost:999). Vite runs
 * on a free private loopback port that developers never need to open.
 *
 * Plain Node, no shell syntax and no extra dependency, so it behaves the same
 * on Windows, macOS and Linux. If either process exits, the other is stopped
 * and this process exits with the failing status. Ctrl+C stops everything.
 */
import "dotenv/config";
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../src/config.js";
import { gatewayEnv, viteEnv } from "./dev-config.mjs";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const isWindows = process.platform === "win32";
const FORCE_KILL_AFTER_MS = 5000;
const READY_TIMEOUT_MS = 60000;
const GATEWAY_READY_TIMEOUT_MS = 15000;

function resolveViteBin() {
  const require = createRequire(import.meta.url);
  const pkgPath = require.resolve("vite/package.json");
  const pkg = require(pkgPath);
  const bin = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.vite;
  return path.join(path.dirname(pkgPath), bin);
}

/** Ask the OS for a free loopback port (the Vite port is private, so any will do). */
function getFreePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

function canConnect(port, host = "127.0.0.1") {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host });
    socket.once("connect", () => { socket.destroy(); resolve(true); });
    socket.once("error", () => resolve(false));
  });
}

async function waitForPort(port, isAlive, host, timeoutMs = READY_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && isAlive()) {
    if (await canConnect(port, host)) return true;
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}

/** True once `/health` on the app port answers as this gateway (not some other listener). */
async function waitForGateway(port, isAlive, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && isAlive()) {
    try {
      const res = await fetch(`http://localhost:${port}/health`, { signal: AbortSignal.timeout(1000) });
      if (res.ok && (await res.json())?.service === "multi-ai-router") return true;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

const children = [];
let shuttingDown = false;
let exitCode = 0;

function start(name, args, env) {
  // On POSIX each child leads its own process group so one signal reaches the
  // child *and* anything it spawned (`node --watch` runs the server as a
  // grandchild). Windows has no process groups; `taskkill /T` covers it below.
  const child = spawn(process.execPath, args, {
    cwd: root,
    env: { ...process.env, ...env },
    stdio: "inherit",
    detached: !isWindows
  });
  const entry = { name, child, exited: false };
  children.push(entry);

  child.on("error", (error) => {
    console.error(`[dev] failed to start ${name}: ${error.message}`);
    entry.exited = true;
    stopAll(1);
  });
  child.on("exit", (code, signal) => {
    entry.exited = true;
    if (!shuttingDown) {
      const status = code ?? (signal ? 1 : 0);
      console.error(`[dev] ${name} exited (${signal ?? `code ${code}`}); stopping the rest.`);
      stopAll(status);
    }
    if (children.every((c) => c.exited)) finish();
  });
  return entry;
}

function killTree(entry, force) {
  if (entry.child.pid === undefined) return;
  try {
    if (isWindows) {
      if (!entry.exited) spawnSync("taskkill", ["/pid", String(entry.child.pid), "/T", "/F"], { stdio: "ignore" });
    } else {
      // Signal the whole group even if the group leader already died: a
      // `node --watch` parent that is killed leaves its server as a survivor
      // in the same group, and that survivor must not be orphaned.
      process.kill(-entry.child.pid, force ? "SIGKILL" : "SIGTERM");
    }
  } catch { /* group already gone */ }
}

/** True while any process in the child's POSIX group (the child or a grandchild) is alive. */
function groupAlive(entry) {
  try {
    process.kill(-entry.child.pid, 0);
    return true;
  } catch {
    return false;
  }
}

let finishing = false;
/** Exit only once nothing the orchestrator started is still running. */
async function finish() {
  if (finishing) return;
  finishing = true;
  if (!isWindows) {
    const deadline = Date.now() + FORCE_KILL_AFTER_MS;
    while (children.some(groupAlive) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
    }
    for (const entry of children) killTree(entry, true);
  }
  process.exit(exitCode);
}

function stopAll(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  exitCode = code;
  for (const entry of children) killTree(entry, isWindows);
  if (children.every((c) => c.exited)) finish();
  setTimeout(() => {
    for (const entry of children) killTree(entry, true);
    setTimeout(() => process.exit(exitCode), 500).unref();
  }, FORCE_KILL_AFTER_MS).unref();
}

process.once("SIGINT", () => stopAll(0));
process.once("SIGTERM", () => stopAll(0));
if (isWindows) process.once("SIGBREAK", () => stopAll(0));

let appPort = null;
try {
  appPort = loadConfig(process.env).port || null;
} catch {
  // An invalid setting is reported by the gateway itself, with its own message.
}

const vitePort = await getFreePort();
const gateway = start("gateway", ["--watch", "src/server.js"], gatewayEnv(process.env, vitePort));
const vite = start("ui", [
  resolveViteBin(),
  "--config", "ui/vite.config.js",
  "--host", "127.0.0.1",
  "--port", String(vitePort),
  "--strictPort",
  "--logLevel", "warn",
  "--clearScreen", "false"
], viteEnv);

const ready = await waitForPort(vitePort, () => !vite.exited && !gateway.exited);
if (!ready && !shuttingDown) {
  console.error("[dev] The Vite dev server did not become ready in time.");
  stopAll(1);
} else if (!shuttingDown) {
  // `node --watch` stays alive after a start-up crash (it waits for a fix), so
  // confirm the gateway is really listening before announcing the URL.
  const up = appPort === null || await waitForGateway(appPort, () => !gateway.exited && !shuttingDown, GATEWAY_READY_TIMEOUT_MS);
  if (shuttingDown) {
    // already stopping
  } else if (up) {
    const url = `http://localhost:${appPort ?? "<PORT>"}`;
    console.log(`\n[dev] Ready. Open ${url}\n[dev] Edit ui/src for hot reload, src/ restarts the gateway. Ctrl+C stops both.\n`);
  } else {
    console.error(`\n[dev] The gateway is not listening on port ${appPort}. Check the error above (is the port already in use? set PORT in .env). It restarts when you save a file in src/; Ctrl+C stops everything.\n`);
  }
}
