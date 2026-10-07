import test, { after } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync
} from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  browserCommand, consoleUrl, displayHost, exitCodeFor, minNodeMajor, needsInstall, parseArgs, probeUrl, which
} from "../scripts/router-lib.mjs";

/**
 * The launcher is exercised for real, in a throwaway checkout whose
 * `ui:build` and `src/server.js` are small stubs that log what ran. The real
 * scripts/router.mjs, scripts/router-lib.mjs, src/config.js and bin/Router are
 * copied in, so path resolution, ordering, exit codes, signals and PORT/HOST
 * handling are the production code paths, with no Vite build and no fixed port.
 */

const root = fileURLToPath(new URL("..", import.meta.url));
const isWindows = process.platform === "win32";
const posixOnly = { skip: isWindows ? "POSIX launcher/signal behaviour" : false };
const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));

const SERVER_STUB = `
import http from "node:http";
import { appendFileSync, writeFileSync } from "node:fs";
const log = process.env.STUB_LOG;
appendFileSync(log, "server\\n");
writeFileSync(process.env.STUB_SERVER_PID, String(process.pid));
const exitCode = process.env.STUB_SERVER_EXIT;
if (exitCode !== undefined) process.exit(Number(exitCode));
const server = http.createServer((req, res) => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ ok: true, service: "multi-ai-router" }));
});
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => { appendFileSync(log, "signal " + signal + "\\n"); server.close(() => process.exit(0)); });
}
server.listen({ port: Number(process.env.PORT), host: process.env.HOST || undefined });
`;

const BUILD_STUB = `
import { appendFileSync, writeFileSync } from "node:fs";
appendFileSync(process.env.STUB_LOG, "build\\n");
writeFileSync(process.env.STUB_BUILD_PID, String(process.pid));
if (process.env.STUB_BUILD_SLEEP) setTimeout(() => {}, 60000);
else process.exit(Number(process.env.STUB_BUILD_EXIT || 0));
`;

function fixture() {
  const dir = mkdtempSync(path.join(tmpdir(), "multiai-router-"));
  mkdirSync(path.join(dir, "scripts"));
  mkdirSync(path.join(dir, "bin"));
  for (const file of ["router.mjs", "router-lib.mjs"]) cpSync(path.join(root, "scripts", file), path.join(dir, "scripts", file));
  for (const file of ["Router", "Router.cmd"]) cpSync(path.join(root, "bin", file), path.join(dir, "bin", file));
  if (!isWindows) chmodSync(path.join(dir, "bin", "Router"), 0o755);
  cpSync(path.join(root, "src"), path.join(dir, "src"), { recursive: true });
  writeFileSync(path.join(dir, "src", "server.js"), SERVER_STUB);
  symlinkSync(path.join(root, "node_modules"), path.join(dir, "node_modules"), "junction");
  writeFileSync(path.join(dir, "build.mjs"), BUILD_STUB);
  writeFileSync(path.join(dir, "package.json"), JSON.stringify({
    name: "router-fixture",
    private: true,
    type: "module",
    engines: pkg.engines,
    scripts: {
      "ui:build": "node build.mjs",
      // Must never run: Router is build + gateway itself, not `npm start` and not the dev server.
      start: "node -e \"require('fs').appendFileSync(process.env.STUB_LOG,'npm-start\\\\n')\"",
      dev: "node -e \"require('fs').appendFileSync(process.env.STUB_LOG,'dev\\\\n')\"",
      "ui:dev": "node -e \"require('fs').appendFileSync(process.env.STUB_LOG,'vite-dev\\\\n')\""
    }
  }));
  const log = path.join(dir, "log.txt");
  const steps = () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : []);
  const env = (extra = {}) => {
    const clean = { ...process.env };
    for (const key of Object.keys(clean)) if (/^(PORT|HOST|MULTIAI_|STUB_|DISPLAY|WAYLAND_DISPLAY|CI|SSH_)/.test(key)) delete clean[key];
    return {
      ...clean,
      npm_config_loglevel: "error",
      STUB_LOG: log,
      STUB_SERVER_PID: path.join(dir, "server.pid"),
      STUB_BUILD_PID: path.join(dir, "build.pid"),
      ...extra
    };
  };
  return { dir, log, steps, env, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => { const { port } = probe.address(); probe.close(() => resolve(port)); });
  });
}

const routerJs = (dir) => path.join(dir, "scripts", "router.mjs");
const runRouter = (f, args = [], extraEnv = {}, cwd = f.dir) =>
  spawnSync(process.execPath, [routerJs(f.dir), ...args], { cwd, encoding: "utf8", env: f.env(extraEnv), timeout: 60000 });

// Whatever a failing assertion leaves running is stopped when the file ends, so a
// broken launcher fails the suite instead of hanging it on an orphaned gateway.
const started = [];
after(() => {
  for (const { child, dir } of started) {
    try { child.kill("SIGTERM"); } catch { /* gone */ }
    for (const name of ["server.pid", "build.pid"]) {
      try { process.kill(Number(readFileSync(path.join(dir, name), "utf8")), "SIGKILL"); } catch { /* gone */ }
    }
  }
});

/** A long-running Router: resolves helpers to wait for output and for exit. */
function startRouter(f, args = [], extraEnv = {}) {
  const child = spawn(process.execPath, [routerJs(f.dir), ...args], { cwd: f.dir, env: f.env(extraEnv), stdio: ["ignore", "pipe", "pipe"] });
  started.push({ child, dir: f.dir });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  const exited = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
  const waitFor = async (predicate, what, timeoutMs = 20000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (predicate()) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    child.kill("SIGTERM");
    assert.fail(`timed out waiting for ${what}; output so far:\n${output}`);
  };
  return { child, exited, output: () => output, waitFor };
}

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const pidOf = (file) => Number(readFileSync(file, "utf8"));

// ---- the real launch sequence ---------------------------------------------------

test("Router builds the UI once, then starts the gateway, and never runs npm start or a dev server", async (t) => {
  const f = fixture();
  t.after(f.cleanup);
  const result = runRouter(f, [], { PORT: "1", STUB_SERVER_EXIT: "0" });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(f.steps(), ["build", "server"], "exactly one build, before the server, and nothing else");
});

test("a failed UI build stops Router: the gateway never starts and the build's exit code is returned", (t) => {
  const f = fixture();
  t.after(f.cleanup);
  const result = runRouter(f, [], { STUB_BUILD_EXIT: "7", STUB_SERVER_EXIT: "0" });
  assert.equal(result.status, 7);
  assert.deepEqual(f.steps(), ["build"]);
  assert.match(result.stderr, /build failed; the gateway was not started/);
});

test("Router returns the gateway's own exit code", (t) => {
  const f = fixture();
  t.after(f.cleanup);
  const result = runRouter(f, [], { STUB_SERVER_EXIT: "3" });
  assert.equal(result.status, 3);
  assert.deepEqual(f.steps(), ["build", "server"]);
});

test("a port that is already taken surfaces a hint and a non-zero exit", (t) => {
  const f = fixture();
  t.after(f.cleanup);
  const result = runRouter(f, [], { STUB_SERVER_EXIT: "1" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /set a different PORT in \.env/);
});

test("an invalid PORT is reported before anything is built", (t) => {
  const f = fixture();
  t.after(f.cleanup);
  const result = runRouter(f, [], { PORT: "not-a-port" });
  assert.notEqual(result.status, 0);
  assert.deepEqual(f.steps(), [], "configuration is validated before the build");
  assert.match(result.stderr, /Configuration error/);
});

test("Router finds the application from any working directory", async (t) => {
  const f = fixture();
  t.after(f.cleanup);
  const elsewhere = mkdtempSync(path.join(tmpdir(), "multiai-elsewhere-"));
  t.after(() => rmSync(elsewhere, { recursive: true, force: true }));
  const result = runRouter(f, [], { STUB_SERVER_EXIT: "0" }, elsewhere);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(f.steps(), ["build", "server"]);
});

test("custom PORT and HOST: the printed URL and the readiness check follow the configuration", async (t) => {
  const f = fixture();
  t.after(f.cleanup);
  const port = await freePort();
  const router = startRouter(f, ["--no-open"], { PORT: String(port), HOST: "127.0.0.1" });
  await router.waitFor(() => router.output().includes("MultiAI Router is running:"), "the running banner");
  assert.ok(router.output().includes(`http://localhost:${port}`), router.output());
  assert.ok(!router.output().includes(":9999"), "the default port must not leak into a custom-port run");
  const health = await (await fetch(`http://127.0.0.1:${port}/health`)).json();
  assert.equal(health.service, "multi-ai-router");
  router.child.kill("SIGTERM");
  await router.exited;
});

test("HOST=0.0.0.0 is respected, not rewritten, and the remote-access note says auth is needed", async (t) => {
  const f = fixture();
  t.after(f.cleanup);
  const port = await freePort();
  const router = startRouter(f, ["--no-open"], { PORT: String(port), HOST: "0.0.0.0" });
  await router.waitFor(() => router.output().includes("MultiAI Router is running:"), "the running banner");
  assert.match(router.output(), new RegExp(`http://SERVER_IP:${port}`));
  assert.match(router.output(), /MULTIAI_ROUTER_API_KEYS is not set/);
  router.child.kill("SIGTERM");
  await router.exited;
});

test("Router refuses to run when it cannot find the application, instead of running npm somewhere else", (t) => {
  const f = fixture();
  t.after(f.cleanup);
  rmSync(path.join(f.dir, "src", "server.js"));
  const result = runRouter(f);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Cannot find the MultiAI Router application/);
  assert.deepEqual(f.steps(), []);
});

test("an invalid option is rejected without building anything; --help works", (t) => {
  const f = fixture();
  t.after(f.cleanup);
  const bad = runRouter(f, ["--bogus"]);
  assert.equal(bad.status, 2);
  assert.deepEqual(f.steps(), []);
  const help = runRouter(f, ["--help"]);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /Usage: Router/);
  assert.deepEqual(f.steps(), []);
});

// ---- headless / browser ------------------------------------------------------------

function fakeBrowserDir(f) {
  const bin = path.join(f.dir, "fakebin");
  mkdirSync(bin);
  const opened = path.join(f.dir, "opened.txt");
  writeFileSync(path.join(bin, "xdg-open"), `#!/bin/sh\necho "$1" >> "${opened}"\n`);
  chmodSync(path.join(bin, "xdg-open"), 0o755);
  return { bin, opened };
}

test("headless Linux (no display, SSH): Router runs, prints the URL and never tries a browser", { skip: process.platform !== "linux" }, async (t) => {
  const f = fixture();
  t.after(f.cleanup);
  const { bin, opened } = fakeBrowserDir(f);
  const port = await freePort();
  const PATH = `${bin}${path.delimiter}${process.env.PATH}`;
  for (const extra of [{}, { DISPLAY: ":0", SSH_CONNECTION: "1.2.3.4 1 5.6.7.8 22" }, { DISPLAY: ":0", CI: "1" }]) {
    const router = startRouter(f, [], { PORT: String(port), HOST: "127.0.0.1", PATH, ...extra });
    await router.waitFor(() => router.output().includes("MultiAI Router is running:"), "the running banner");
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(existsSync(opened), false, `no browser may be launched for ${JSON.stringify(extra)}`);
    router.child.kill("SIGTERM");
    await router.exited;
  }
});

test("desktop Linux with --open and xdg-open: the browser is opened once with the control panel URL", { skip: process.platform !== "linux" }, async (t) => {
  const f = fixture();
  t.after(f.cleanup);
  const { bin, opened } = fakeBrowserDir(f);
  const port = await freePort();
  const router = startRouter(f, ["--open"], { PORT: String(port), HOST: "127.0.0.1", DISPLAY: ":0", PATH: `${bin}${path.delimiter}${process.env.PATH}` });
  await router.waitFor(() => existsSync(opened), "the fake browser to be invoked");
  assert.equal(readFileSync(opened, "utf8").trim(), `http://localhost:${port}`);
  router.child.kill("SIGTERM");
  await router.exited;
});

test("--no-open wins even on a desktop", { skip: process.platform !== "linux" }, async (t) => {
  const f = fixture();
  t.after(f.cleanup);
  const { bin, opened } = fakeBrowserDir(f);
  const port = await freePort();
  const router = startRouter(f, ["--no-open"], { PORT: String(port), HOST: "127.0.0.1", DISPLAY: ":0", MULTIAI_ROUTER_OPEN: "1", PATH: `${bin}${path.delimiter}${process.env.PATH}` });
  await router.waitFor(() => router.output().includes("MultiAI Router is running:"), "the running banner");
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(existsSync(opened), false);
  router.child.kill("SIGTERM");
  await router.exited;
});

test("browserCommand decision table (every platform, without needing that platform)", () => {
  const url = "http://localhost:9999";
  const has = (...names) => (name) => (names.includes(name) ? `/usr/bin/${name}` : null);
  const tty = { url, isTTY: true };
  assert.deepEqual(browserCommand({ ...tty, platform: "win32", env: {} }), { command: "cmd.exe", args: ["/c", "start", "", url] });
  assert.deepEqual(browserCommand({ ...tty, platform: "darwin", env: {}, find: has("open") }), { command: "open", args: [url] });
  assert.equal(browserCommand({ ...tty, platform: "darwin", env: {}, find: has() }), null, "no `open` binary");
  assert.deepEqual(browserCommand({ ...tty, platform: "linux", env: { DISPLAY: ":0" }, find: has("xdg-open") }), { command: "xdg-open", args: [url] });
  assert.deepEqual(browserCommand({ ...tty, platform: "linux", env: { WAYLAND_DISPLAY: "wayland-0" }, find: has("xdg-open") }), { command: "xdg-open", args: [url] });
  assert.equal(browserCommand({ ...tty, platform: "linux", env: {}, find: has("xdg-open") }), null, "no graphical session");
  assert.equal(browserCommand({ ...tty, platform: "linux", env: { DISPLAY: ":0" }, find: has() }), null, "no xdg-open");
  assert.equal(browserCommand({ ...tty, platform: "linux", env: { DISPLAY: ":0" }, find: has("open") }), null, "macOS `open` is not a Linux fallback");
  assert.equal(browserCommand({ url, isTTY: false, platform: "linux", env: { DISPLAY: ":0" }, find: has("xdg-open") }), null, "not a terminal (service manager, pipe)");
  for (const env of [{ SSH_CONNECTION: "x" }, { SSH_TTY: "/dev/pts/0" }, { SSH_CLIENT: "x" }, { CI: "true" }]) {
    assert.equal(browserCommand({ ...tty, platform: "darwin", env, find: has("open") }), null, JSON.stringify(env));
    assert.equal(browserCommand({ ...tty, platform: "win32", env }), null, JSON.stringify(env));
  }
  assert.equal(browserCommand({ ...tty, open: false, platform: "win32", env: {} }), null, "--no-open");
  assert.equal(browserCommand({ ...tty, platform: "win32", env: { MULTIAI_ROUTER_OPEN: "0" } }), null);
  assert.ok(browserCommand({ ...tty, open: true, platform: "darwin", env: { SSH_TTY: "x" }, find: has("open") }), "--open overrides the SSH heuristic");
  assert.equal(browserCommand({ ...tty, open: true, platform: "linux", env: {}, find: has("xdg-open") }), null, "--open still needs a display");
});

// ---- signals / orphans -------------------------------------------------------------

test("SIGTERM stops the gateway cleanly and leaves no orphan; Router exits with the gateway's status", posixOnly, async (t) => {
  const f = fixture();
  t.after(f.cleanup);
  const port = await freePort();
  const router = startRouter(f, ["--no-open"], { PORT: String(port), HOST: "127.0.0.1" });
  await router.waitFor(() => router.output().includes("MultiAI Router is running:"), "the running banner");
  const gatewayPid = pidOf(path.join(f.dir, "server.pid"));
  router.child.kill("SIGTERM");
  const { code, signal } = await router.exited;
  assert.equal(signal, null, "Router must exit on its own, not be killed by the signal");
  assert.equal(code, 0);
  assert.ok(f.steps().includes("signal SIGTERM"), "the gateway received the signal and shut down itself");
  assert.equal(alive(gatewayPid), false, "no orphaned gateway");
});

test("SIGINT behaves the same as SIGTERM", posixOnly, async (t) => {
  const f = fixture();
  t.after(f.cleanup);
  const port = await freePort();
  const router = startRouter(f, ["--no-open"], { PORT: String(port), HOST: "127.0.0.1" });
  await router.waitFor(() => router.output().includes("MultiAI Router is running:"), "the running banner");
  const gatewayPid = pidOf(path.join(f.dir, "server.pid"));
  router.child.kill("SIGINT");
  const { code } = await router.exited;
  assert.equal(code, 0);
  assert.equal(alive(gatewayPid), false);
});

test("a stop signal during the build ends the build and the gateway is never started", posixOnly, async (t) => {
  const f = fixture();
  t.after(f.cleanup);
  const router = startRouter(f, ["--no-open"], { STUB_BUILD_SLEEP: "1" });
  await router.waitFor(() => existsSync(path.join(f.dir, "build.pid")), "the build to start");
  const buildPid = pidOf(path.join(f.dir, "build.pid"));
  router.child.kill("SIGTERM");
  const { code } = await router.exited;
  assert.notEqual(code, 0, "an interrupted build is not a success");
  assert.deepEqual(f.steps(), ["build"], "the gateway must not start");
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(alive(buildPid), false, "the build process must not outlive Router");
});

// ---- the POSIX wrapper (bin/Router) -------------------------------------------------

test("bin/Router: runs from outside the repo, through a symlink, forwards arguments and the exit code", posixOnly, (t) => {
  const f = fixture();
  t.after(f.cleanup);
  const elsewhere = mkdtempSync(path.join(tmpdir(), "multiai-bin-"));
  t.after(() => rmSync(elsewhere, { recursive: true, force: true }));
  const link = path.join(elsewhere, "Router");
  symlinkSync(path.join(f.dir, "bin", "Router"), link);
  const viaLink = spawnSync(link, ["--help"], { cwd: elsewhere, encoding: "utf8", env: f.env() });
  assert.equal(viaLink.status, 0, viaLink.stderr);
  assert.match(viaLink.stdout, /Usage: Router/);
  const code = spawnSync(link, [], { cwd: elsewhere, encoding: "utf8", env: f.env({ STUB_SERVER_EXIT: "5" }) });
  assert.equal(code.status, 5, "the gateway's exit code comes back through the wrapper");
  assert.deepEqual(f.steps(), ["build", "server"]);
  // A relative symlink must resolve too.
  const rel = path.join(elsewhere, "rel");
  mkdirSync(rel);
  symlinkSync(path.relative(rel, path.join(f.dir, "bin", "Router")), path.join(rel, "Router"));
  const viaRel = spawnSync(path.join(rel, "Router"), ["--help"], { cwd: rel, encoding: "utf8", env: f.env() });
  assert.equal(viaRel.status, 0, viaRel.stderr);
});

test("bin/Router with no Node.js on PATH explains what to install and exits 127", posixOnly, (t) => {
  const f = fixture();
  t.after(f.cleanup);
  const sh = spawnSync("sh", ["-c", "command -v sh"], { encoding: "utf8" }).stdout.trim();
  const result = spawnSync(sh, [path.join(f.dir, "bin", "Router")], { encoding: "utf8", env: { PATH: "/nonexistent" } });
  assert.equal(result.status, 127);
  assert.match(result.stderr, /Node\.js was not found/);
});

test("bin/Router signals reach Node directly: the wrapper execs, leaving no shell process behind", posixOnly, async (t) => {
  const f = fixture();
  t.after(f.cleanup);
  const port = await freePort();
  const child = spawn(path.join(f.dir, "bin", "Router"), ["--no-open"], { cwd: f.dir, env: f.env({ PORT: String(port), HOST: "127.0.0.1" }), stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", (c) => { out += c; });
  const exited = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
  const deadline = Date.now() + 20000;
  while (!out.includes("is running") && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
  assert.ok(out.includes("is running"), out);
  const comm = readFileSync(`/proc/${child.pid}/comm`, "utf8").trim();
  assert.match(comm, /node/, "the launcher process is Node itself, not sh");
  child.kill("SIGTERM");
  assert.deepEqual(await exited, { code: 0, signal: null });
});

test("bin/Router keeps its executable bit and LF line endings; Router.cmd stays CRLF-agnostic ASCII", () => {
  const sh = readFileSync(path.join(root, "bin", "Router"), "utf8");
  assert.ok(sh.startsWith("#!/bin/sh\n"));
  assert.ok(!sh.includes("\r"), "a CR in a #!/bin/sh script breaks it on Linux and macOS");
  assert.ok(!sh.includes("bash"), "the launcher must stay POSIX sh");
  if (!isWindows) {
    const tracked = spawnSync("git", ["ls-files", "-s", "bin/Router", "scripts/install-router.sh"], { cwd: root, encoding: "utf8" }).stdout;
    if (tracked) for (const line of tracked.trim().split("\n")) assert.match(line, /^100755 /, `${line} must be tracked executable`);
  }
  const cmd = readFileSync(path.join(root, "bin", "Router.cmd"), "utf8");
  assert.ok(/^[\x00-\x7f]*$/.test(cmd), "Router.cmd must be plain ASCII");
});

test("wrappers hold no startup logic: both only locate Node and run scripts/router.mjs", () => {
  const sh = readFileSync(path.join(root, "bin", "Router"), "utf8");
  const cmd = readFileSync(path.join(root, "bin", "Router.cmd"), "utf8");
  const ps1 = readFileSync(path.join(root, "scripts", "install-router.ps1"), "utf8");
  assert.match(sh, /exec node "\$root\/scripts\/router\.mjs" "\$@"/);
  assert.match(cmd, /node "%~dp0\.\.\\scripts\\router\.mjs" %\*/);
  for (const [name, text] of [["bin/Router", sh], ["bin/Router.cmd", cmd], ["install-router.ps1", ps1]]) {
    assert.doesNotMatch(text, /ui:build|npm (start|install|run)|server\.js|9999/, `${name} must not duplicate startup logic or hardcode the port`);
  }
  assert.match(ps1, /call "\$repo\\bin\\Router\.cmd" %\*/, "the Windows shim delegates to the repository launcher");
});

test("the canonical flow is the production one: `npm run ui:build` then src/server.js, and npm start is unchanged", () => {
  const source = readFileSync(path.join(root, "scripts", "router.mjs"), "utf8");
  assert.equal((source.match(/"ui:build"/g) || []).length, 1, "the UI build is requested in exactly one place");
  assert.match(source, /npm\(\["run", "ui:build"\]\)/);
  assert.match(source, /process\.execPath, \["src\/server\.js"\]/);
  assert.doesNotMatch(source, /ui:dev|vite|"start"|\["dev"\]|npm\(\["start"\]\)/, "no dev server, no `npm start` (that would build twice)");
  assert.doesNotMatch(source, /localhost:9|:9999|PORT\s*=\s*\d/, "no hardcoded port in the platform-independent launcher");
  assert.equal(pkg.scripts.start, "npm run ui:build && node src/server.js");
  assert.equal(pkg.scripts.dev, "node scripts/dev.mjs");
});

// ---- helper unit tests --------------------------------------------------------------

test("URLs follow PORT/HOST without hardcoding", () => {
  assert.equal(consoleUrl("", 9999), "http://localhost:9999");
  assert.equal(consoleUrl("", 8080), "http://localhost:8080");
  assert.equal(consoleUrl("0.0.0.0", 8080), "http://localhost:8080");
  assert.equal(consoleUrl("127.0.0.1", 3000), "http://localhost:3000");
  assert.equal(consoleUrl("::1", 3000), "http://[::1]:3000");
  assert.equal(consoleUrl("10.0.0.5", 3000), "http://10.0.0.5:3000");
  assert.equal(displayHost("LocalHost"), "localhost");
  assert.equal(probeUrl("", 8080), "http://127.0.0.1:8080/health");
  assert.equal(probeUrl("0.0.0.0", 8080), "http://127.0.0.1:8080/health");
  assert.equal(probeUrl("::1", 8080), "http://[::1]:8080/health");
});

test("argument parsing, exit codes and install detection", () => {
  assert.deepEqual(parseArgs([]), { open: "auto", help: false, error: null });
  assert.equal(parseArgs(["--no-open"]).open, false);
  assert.equal(parseArgs(["--open"]).open, true);
  assert.equal(parseArgs(["-h"]).help, true);
  assert.match(parseArgs(["--wat"]).error, /Unknown option/);
  assert.equal(exitCodeFor(3, null, {}), 3);
  assert.equal(exitCodeFor(null, "SIGTERM", { SIGTERM: 15 }), 143);
  assert.equal(minNodeMajor(pkg), 20);
  const empty = mkdtempSync(path.join(tmpdir(), "multiai-empty-"));
  try {
    assert.equal(needsInstall(empty), true, "no node_modules means install first");
    assert.equal(needsInstall(root), false, "this checkout has what the Router needs");
  } finally { rmSync(empty, { recursive: true, force: true }); }
  assert.equal(which("definitely-not-a-real-binary-xyz"), null);
});

test("install-router.sh installs a working symlink, refuses to clobber, and uninstalls", posixOnly, (t) => {
  const home = mkdtempSync(path.join(tmpdir(), "multiai-home-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const installer = path.join(root, "scripts", "install-router.sh");
  const env = { ...process.env, HOME: home, PATH: process.env.PATH };
  const install = spawnSync("sh", [installer], { encoding: "utf8", env });
  assert.equal(install.status, 0, install.stderr);
  const target = path.join(home, ".local", "bin", "Router");
  assert.match(install.stdout, /not on your PATH/);
  assert.equal(spawnSync(target, ["--help"], { encoding: "utf8", env }).status, 0, "the installed command runs");
  assert.equal(spawnSync("sh", [installer], { encoding: "utf8", env }).status, 0, "re-installing is idempotent");
  const onPath = spawnSync("sh", [installer], { encoding: "utf8", env: { ...env, PATH: `${path.dirname(target)}:${env.PATH}` } });
  assert.doesNotMatch(onPath.stdout, /not on your PATH/);
  rmSync(target);
  writeFileSync(target, "someone else's file");
  const clobber = spawnSync("sh", [installer], { encoding: "utf8", env });
  assert.notEqual(clobber.status, 0, "a foreign file is never overwritten without --force");
  assert.equal(readFileSync(target, "utf8"), "someone else's file");
  assert.notEqual(spawnSync("sh", [installer, "--uninstall"], { encoding: "utf8", env }).status, 0, "uninstall leaves foreign files alone");
  assert.equal(spawnSync("sh", [installer, "--force"], { encoding: "utf8", env }).status, 0);
  assert.equal(spawnSync("sh", [installer, "--uninstall"], { encoding: "utf8", env }).status, 0);
  assert.equal(existsSync(target), false);
});
