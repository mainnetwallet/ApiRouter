import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";

test("launcher scripts exist and are valid JavaScript", () => {
  const devAllPath = path.resolve("scripts/dev-all.mjs");
  const startAllPath = path.resolve("scripts/start-all.mjs");

  assert.strictEqual(fs.existsSync(devAllPath), true, "scripts/dev-all.mjs should exist");
  assert.strictEqual(fs.existsSync(startAllPath), true, "scripts/start-all.mjs should exist");

  const devContent = fs.readFileSync(devAllPath, "utf8");
  const startContent = fs.readFileSync(startAllPath, "utf8");

  assert.match(devContent, /BACKEND_PORT = 8788/);
  assert.match(devContent, /FRONTEND_PORT = 5173/);
  assert.match(startContent, /PORT = 8788/);
});

test("package.json contains dev:all and start:all scripts", () => {
  const pkgPath = path.resolve("package.json");
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));

  assert.strictEqual(pkg.scripts["dev:all"], "node scripts/dev-all.mjs");
  assert.strictEqual(pkg.scripts["start:all"], "node scripts/start-all.mjs");
  assert.strictEqual(pkg.scripts["start"], "node src/server.js");
});

