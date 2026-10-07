/**
 * `Router`: the one production launcher, shared by every platform.
 *
 * bin/Router (POSIX sh) and bin/Router.cmd (Windows) only locate Node and run
 * this file; nothing about the startup flow lives anywhere else.
 *
 *   locate the application -> check Node/npm -> install dependencies if missing
 *   -> load configuration -> build the control panel ONCE (`npm run ui:build`)
 *   -> if the build fails, stop -> start the production gateway (`node src/server.js`)
 *
 * It is the same two steps as `npm start`, run here rather than through
 * `npm start` so the control panel is built exactly once and the launcher can
 * report the URL once the gateway really answers. It never starts Vite's dev
 * server (that is `npm run dev`) and never rewrites PORT or HOST.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  USAGE, browserCommand, consoleUrl, exitCodeFor, isLoopbackHost, isWildcardHost,
  minNodeMajor, needsInstall, parseArgs, probeUrl, readPackage
} from "./router-lib.mjs";

const root = realpathSync(path.resolve(fileURLToPath(new URL("..", import.meta.url))));
const isWindows = process.platform === "win32";
const FORCE_KILL_AFTER_MS = 10000;
const TERMINAL_SIGINT_GRACE_MS = 1500;
const READY_TIMEOUT_MS = 30000;

const say = (message) => console.log(message);
const warn = (message) => console.error(`[router] ${message}`);
function fail(message, code = 1) {
  warn(message);
  process.exit(code);
}

// ---- child process tracking and signals -----------------------------------

let current = null;       // the one child that is running right now
let signalled = null;     // the first stop signal received

function stopChild(entry, signal) {
  if (!entry) return;
  try {
    // Windows has no signals: end the whole tree (npm runs the build through a shell).
    if (isWindows && entry.shell) { if (!entry.exited) spawnSync("taskkill", ["/pid", String(entry.child.pid), "/T", "/F"], { stdio: "ignore" }); }
    // npm steps lead their own process group (see `run`), so the signal reaches
    // npm, its shell and the build underneath it.
    else if (entry.group) process.kill(-entry.child.pid, signal);
    else if (!entry.exited) entry.child.kill(signal);
  } catch { /* already gone */ }
}

const groupAlive = (entry) => {
  try { process.kill(-entry.child.pid, 0); return true; } catch { return false; }
};

function onStopSignal(signal) {
  if (signalled) return;
  signalled = signal === "SIGHUP" ? "SIGTERM" : signal;
  const entry = current;
  if (!entry) return;
  // Ctrl+C in a terminal is delivered to the whole foreground group, so the
  // child already has it. Forwarding at once would hit a gateway that is
  // mid-shutdown with a second SIGINT; give it a moment, then forward only if
  // it is still running (a `kill -INT <router pid>` never reached it).
  // (npm steps run in their own group and never see the terminal's signal, so they get it at once.)
  const fromTerminal = signalled === "SIGINT" && process.stdin.isTTY && !entry.group;
  setTimeout(() => stopChild(entry, signalled), fromTerminal ? TERMINAL_SIGINT_GRACE_MS : 0);
  setTimeout(() => { if (!entry.exited || (entry.group && groupAlive(entry))) stopChild(entry, "SIGKILL"); }, FORCE_KILL_AFTER_MS).unref();
}

for (const signal of ["SIGINT", "SIGTERM", ...(isWindows ? ["SIGBREAK"] : ["SIGHUP"])]) {
  process.on(signal, () => onStopSignal(signal));
}

/**
 * Run a child with the terminal attached; resolves with its exit code (128+n
 * for a signal death). `group` (POSIX) gives the child its own process group so
 * a stop signal reaches everything it started and nothing is left behind.
 */
function run(command, args, { shell = false, group = false } = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd: root, stdio: "inherit", shell, env: process.env, detached: group });
    const entry = { child, shell, group, exited: false };
    current = entry;
    child.once("error", (error) => {
      entry.exited = true;
      current = null;
      warn(`could not run ${command}: ${error.message}`);
      resolve({ code: 127, entry });
    });
    child.once("exit", async (code, signal) => {
      entry.exited = true;
      // The group leader can die before what it started: when we are stopping,
      // do not return until the whole group is gone.
      if (group && signalled) {
        stopChild(entry, "SIGTERM");
        const deadline = Date.now() + 2000;
        while (groupAlive(entry) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
        if (groupAlive(entry)) stopChild(entry, "SIGKILL");
      }
      current = null;
      resolve({ code: exitCodeFor(code, signal, os.constants.signals), entry });
    });
  });
}

/** npm is a `.cmd` shim on Windows, which Node can only start through a shell (fixed arguments only). */
const npm = (args) => run("npm", args, { shell: isWindows, group: !isWindows });

// ---- steps -------------------------------------------------------------------

function checkNode() {
  const required = minNodeMajor(readPackage(root));
  const major = Number(process.versions.node.split(".")[0]);
  if (major < required) fail(`Node.js ${required} or newer is required (this is ${process.versions.node}). Install a current LTS from https://nodejs.org and try again.`);
}

function checkNpm() {
  const probe = spawnSync("npm", ["--version"], { shell: isWindows, stdio: "ignore" });
  if (probe.error || probe.status !== 0) fail("npm was not found on PATH. It ships with Node.js: install Node.js from https://nodejs.org and try again.");
}

/** Same rules as the gateway: .env first-class, real environment variables win. Process env is not modified. */
async function loadSettings() {
  const { default: dotenv } = await import("dotenv");
  const envFile = path.join(root, ".env");
  const fromFile = existsSync(envFile) ? dotenv.parse(readFileSync(envFile)) : {};
  const { loadConfig } = await import(new URL("../src/config.js", import.meta.url));
  return loadConfig({ ...fromFile, ...process.env });
}

async function waitForGateway(url, alive, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && alive()) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(1000) });
      if (res.ok && (await res.json())?.service === "multi-ai-router") return true;
    } catch { /* not listening yet */ }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return false;
}

function announce(config) {
  const url = consoleUrl(config.host, config.port);
  say(`\nMultiAI Router is running:\n${url}\n`);
  if (!isLoopbackHost(config.host)) {
    const where = isWildcardHost(config.host) ? "all network interfaces" : `HOST=${config.host}`;
    say(`Listening on ${where}. From another machine use http://SERVER_IP:${config.port}`);
    say(config.routerApiKeys.length === 0
      ? "MULTIAI_ROUTER_API_KEYS is not set, so other machines are refused. Set it before exposing the Router.\n"
      : "Clients must send a key from MULTIAI_ROUTER_API_KEYS.\n");
  }
}

function openBrowser(url, open) {
  const plan = browserCommand({ url, open, isTTY: Boolean(process.stdout.isTTY) });
  if (!plan) return;
  try {
    const child = spawn(plan.command, plan.args, { stdio: "ignore", detached: true });
    child.on("error", () => { /* the URL is already printed */ });
    child.unref();
  } catch { /* the URL is already printed */ }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.error) { warn(options.error); process.stderr.write(USAGE); return 2; }
  if (options.help) { process.stdout.write(USAGE); return 0; }

  if (!existsSync(path.join(root, "package.json")) || !existsSync(path.join(root, "src", "server.js"))) {
    warn(`Cannot find the MultiAI Router application (expected package.json and src/server.js in ${root}).`);
    return 1;
  }
  checkNode();
  checkNpm();

  if (needsInstall(root)) {
    say("[router] Installing dependencies (npm install)...");
    const install = await npm(["install"]);
    if (install.code !== 0) { warn("npm install failed; not starting."); return install.code; }
    if (signalled) return exitCodeFor(null, signalled, os.constants.signals);
  }

  let config;
  try { config = await loadSettings(); }
  catch (error) { warn(`Configuration error: ${error.message}`); return 1; }

  if (signalled) return exitCodeFor(null, signalled, os.constants.signals);
  say("[router] Building the control panel...");
  const build = await npm(["run", "ui:build"]);
  if (signalled) return exitCodeFor(null, signalled, os.constants.signals);
  if (build.code !== 0) { warn("The control panel build failed; the gateway was not started."); return build.code; }

  const gateway = run(process.execPath, ["src/server.js"]);
  // `run` has registered the child synchronously, so readiness can watch it.
  const entry = current;
  if (config.port > 0) {
    waitForGateway(probeUrl(config.host, config.port), () => !entry.exited && !signalled, READY_TIMEOUT_MS).then((ready) => {
      if (ready) {
        announce(config);
        openBrowser(consoleUrl(config.host, config.port), options.open);
      } else if (!entry.exited && !signalled) {
        warn("The gateway has not answered /health yet; check its output above.");
      }
    });
  }

  const result = await gateway;
  if (!signalled && result.code !== 0) {
    warn(`The gateway exited with code ${result.code}. If the port is already in use, set a different PORT in .env.`);
  }
  return result.code;
}

process.exitCode = await main();
