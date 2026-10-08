import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";

test("launcher scripts exist and are valid", () => {
  assert.strictEqual(fs.existsSync("bin/Router.cmd"), true, "bin/Router.cmd should exist");
  assert.strictEqual(fs.existsSync("scripts/router.mjs"), true, "scripts/router.mjs should exist");
  assert.strictEqual(fs.existsSync("scripts/install-router.ps1"), true, "scripts/install-router.ps1 should exist");
});

test("Router.cmd content check", () => {
  const content = fs.readFileSync("bin/Router.cmd", "utf8");
  assert.match(content, /node "%~dp0\.\.\\scripts\\router\.mjs"/);
});

test("router.mjs detects port conflict on 8788", async () => {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(8788, "127.0.0.1", resolve));

  try {
    const child = spawn(process.execPath, ["scripts/router.mjs"], {
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stderr = "";
    child.stderr.on("data", (d) => { stderr += d.toString(); });

    const code = await new Promise((resolve) => {
      child.on("exit", (c) => resolve(c));
    });

    assert.notStrictEqual(code, 0, "Router should exit with non-zero code on port conflict");
    assert.match(stderr, /8788 is already in use/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});



test('Router uses direct process.execPath without shell:true', () => {
  const content = fs.readFileSync('scripts/router.mjs', 'utf8');
  assert.strictEqual(content.includes('shell: true'), false);
  assert.strictEqual(content.includes('npm run'), false);
  assert.strictEqual(content.includes('process.execPath'), true);
  assert.strictEqual(content.includes('npmCmd'), true);
});



test("dev:all exits non-zero when 5173 is occupied and leaves process alive", async () => {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(5173, "127.0.0.1", resolve));
  try {
    const child = spawn(process.execPath, ["scripts/router.mjs"], { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (d) => { stderr += d.toString(); });
    const code = await new Promise((resolve) => child.on("exit", (c) => resolve(c)));
    assert.notStrictEqual(code, 0);
    assert.match(stderr, /5173 is already in use/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});


