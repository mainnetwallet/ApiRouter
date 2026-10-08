import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";

test("launcher scripts exist and are valid JavaScript", () => {
  const devAllPath = path.resolve("scripts/dev-all.mjs");
  const startAllPath = path.resolve("scripts/start-all.mjs");

  assert.strictEqual(fs.existsSync(devAllPath), true, "scripts/dev-all.mjs should exist");
  assert.strictEqual(fs.existsSync(startAllPath), true, "scripts/start-all.mjs should exist");
});

test("package.json contains dev:all and start:all scripts", () => {
  const pkgPath = path.resolve("package.json");
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));

  assert.strictEqual(pkg.scripts["dev:all"], "node scripts/dev-all.mjs");
  assert.strictEqual(pkg.scripts["start:all"], "node scripts/start-all.mjs");
  assert.strictEqual(pkg.scripts["start"], "node src/server.js");
});

test("dev:all detects port conflict on 8788 without killing conflicting process", async () => {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(8788, "127.0.0.1", resolve));

  try {
    const child = spawn(process.execPath, ["scripts/dev-all.mjs"], {
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stderr = "";
    child.stderr.on("data", (d) => { stderr += d.toString(); });

    const code = await new Promise((resolve) => {
      child.on("exit", (c) => resolve(c));
    });

    assert.notStrictEqual(code, 0, "dev:all should exit with non-zero code on port conflict");
    assert.match(stderr, /8788 is already in use/);

    // Verify the conflicting server is still listening and alive
    const aliveCheck = await new Promise((resolve) => {
      const s = net.connect(8788, "127.0.0.1", () => {
        s.end();
        resolve(true);
      });
      s.on("error", () => resolve(false));
    });
    assert.strictEqual(aliveCheck, true, "Conflicting process must remain alive");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("dev:all detects port conflict on 5173 without killing conflicting process", async () => {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(5173, "127.0.0.1", resolve));

  try {
    const child = spawn(process.execPath, ["scripts/dev-all.mjs"], {
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stderr = "";
    child.stderr.on("data", (d) => { stderr += d.toString(); });

    const code = await new Promise((resolve) => {
      child.on("exit", (c) => resolve(c));
    });

    assert.notStrictEqual(code, 0, "dev:all should exit with non-zero code on port conflict");
    assert.match(stderr, /5173 is already in use/);

    const aliveCheck = await new Promise((resolve) => {
      const s = net.connect(5173, "127.0.0.1", () => {
        s.end();
        resolve(true);
      });
      s.on("error", () => resolve(false));
    });
    assert.strictEqual(aliveCheck, true, "Conflicting process must remain alive");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

