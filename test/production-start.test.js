import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * `npm start` is the one production command: build the control panel, and only
 * if that succeeds, start the gateway.
 *
 * These tests run the REAL `start` command line from package.json through real
 * `npm start`, in a throwaway project whose `ui:build` and `src/server.js` are
 * tiny stubs that log what ran. That exercises the actual npm/shell sequencing
 * (ordering, failure propagation, exit codes) without a Vite build or a bound port.
 */

const root = fileURLToPath(new URL("..", import.meta.url));
const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const npm = process.platform === "win32" ? "npm.cmd" : "npm";

function fixture({ buildExit = 0, serverExit = 0 } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "multiai-start-"));
  mkdirSync(path.join(dir, "src"));
  const log = path.join(dir, "log.txt");
  writeFileSync(path.join(dir, "package.json"), JSON.stringify({
    name: "start-fixture",
    private: true,
    type: "module",
    scripts: { start: pkg.scripts.start, "ui:build": "node build.mjs" }
  }));
  writeFileSync(path.join(dir, "build.mjs"),
    `import { appendFileSync } from "node:fs";\nappendFileSync(${JSON.stringify(log)}, "build\\n");\nprocess.exit(${buildExit});\n`);
  writeFileSync(path.join(dir, "src", "server.js"),
    `import { appendFileSync } from "node:fs";\nappendFileSync(${JSON.stringify(log)}, "server\\n");\nprocess.exit(${serverExit});\n`);
  const steps = () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : []);
  return { dir, steps, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const runStart = (dir) => spawnSync(npm, ["start"], {
  cwd: dir,
  encoding: "utf8",
  shell: process.platform === "win32",
  env: { ...process.env, npm_config_loglevel: "error" }
});

test("npm start builds the UI first, then starts the gateway", (t) => {
  const f = fixture();
  t.after(f.cleanup);
  const result = runStart(f.dir);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(f.steps(), ["build", "server"], "build must run, and run before the server");
});

test("a failed UI build fails npm start and the gateway never starts", (t) => {
  const f = fixture({ buildExit: 1 });
  t.after(f.cleanup);
  const result = runStart(f.dir);
  assert.notEqual(result.status, 0, "the build failure must not be swallowed");
  assert.deepEqual(f.steps(), ["build"], "the server must not start after a failed build");
});

test("a gateway failure after a good build is not masked: npm start exits non-zero", (t) => {
  const f = fixture({ serverExit: 3 });
  t.after(f.cleanup);
  const result = runStart(f.dir);
  assert.notEqual(result.status, 0);
  assert.deepEqual(f.steps(), ["build", "server"]);
});

test("everything npm start needs is a production dependency (works after `npm ci --omit=dev`)", () => {
  // `start` runs `ui:build`, which runs Vite with the React plugin. If either were a
  // devDependency, a production-only install could not start the gateway at all.
  assert.match(pkg.scripts["ui:build"], /^vite build\b/);
  for (const name of ["vite", "@vitejs/plugin-react", "react", "react-dom", "dotenv"]) {
    assert.ok(pkg.dependencies?.[name], `${name} must be in dependencies`);
    assert.equal(pkg.devDependencies?.[name], undefined, `${name} must not be in devDependencies`);
  }
});

test("production start never launches a Vite dev server, and the dev workflow is separate", () => {
  assert.doesNotMatch(pkg.scripts.start, /ui:dev|\bvite\s+--|\bdev\b/, "npm start must be build + gateway only");
  assert.match(pkg.scripts.start, /^npm run ui:build && node src\/server\.js$/);
  assert.equal(pkg.scripts.dev, "node scripts/dev.mjs", "npm run dev is unchanged");
  assert.equal(pkg.scripts["dev:server"], "node --watch src/server.js");
});
