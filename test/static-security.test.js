import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import { createStaticHandler } from "../src/static-files.js";

function makeRoot(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "static-sec-"));
  const root = path.join(base, "dist");
  const outside = path.join(base, "outside");
  fs.mkdirSync(path.join(root, "assets"), { recursive: true });
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(root, "index.html"), "<html>ok</html>");
  fs.writeFileSync(path.join(root, "assets", "a.js"), "console.log(1)");
  fs.writeFileSync(path.join(outside, "secret.txt"), "SECRET");
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  return { base, root, outside };
}

async function serve(t, root) {
  const handler = createStaticHandler({ root });
  const server = http.createServer(async (req, res) => {
    const pathname = new URL(req.url, "http://x").pathname;
    if (!(await handler.serve(req, res, pathname))) { res.writeHead(404); res.end("404"); }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const port = server.address().port;
  return (rawPath) => new Promise((resolve) => {
    http.get({ host: "127.0.0.1", port, path: rawPath }, (res) => {
      let body = ""; res.on("data", (c) => { body += c; }); res.on("end", () => resolve({ status: res.statusCode, body }));
    }).on("error", (error) => resolve({ status: 0, body: error.code }));
  });
}

test("a symlink inside the root that points outside it is not served (file and directory)", async (t) => {
  const { root, outside } = makeRoot(t);
  fs.symlinkSync(path.join(outside, "secret.txt"), path.join(root, "leak.txt"));
  fs.symlinkSync(outside, path.join(root, "linkdir"));
  const get = await serve(t, root);
  assert.equal((await get("/leak.txt")).status, 404);
  assert.equal((await get("/linkdir/secret.txt")).status, 404);
});

test("a symlinked index.html that escapes the root is not served as the SPA entry either", async (t) => {
  const { root, outside } = makeRoot(t);
  fs.rmSync(path.join(root, "index.html"));
  fs.writeFileSync(path.join(outside, "index.html"), "SECRET-INDEX");
  fs.symlinkSync(path.join(outside, "index.html"), path.join(root, "index.html"));
  const get = await serve(t, root);
  const res = await get("/");
  assert.ok(!res.body.includes("SECRET-INDEX"));
  assert.equal((await get("/some/spa/route")).body.includes("SECRET-INDEX"), false);
});

test("a symlink that stays inside the root still works", async (t) => {
  const { root } = makeRoot(t);
  fs.symlinkSync(path.join(root, "assets", "a.js"), path.join(root, "alias.js"));
  const get = await serve(t, root);
  const res = await get("/alias.js");
  assert.equal(res.status, 200);
  assert.equal(res.body, "console.log(1)");
});

test("traversal forms are all refused: dot-dot, encoded, double-encoded, backslash, absolute, null byte, dotfiles", async (t) => {
  const { root } = makeRoot(t);
  fs.writeFileSync(path.join(root, ".env"), "DOT");
  const get = await serve(t, root);
  for (const raw of [
    "/../outside/secret.txt", "/%2e%2e/outside/secret.txt", "/%252e%252e/outside/secret.txt", "/assets/..%2f..%2foutside/secret.txt",
    "/assets/..%5c..%5coutside%5csecret.txt", "//etc/passwd", "/%2fetc%2fpasswd", "/assets/a.js%00.png", "/.env"
  ]) {
    const res = await get(raw);
    assert.ok(!/SECRET|DOT|root:/.test(res.body), `${raw} must not leak`);
  }
  assert.equal((await get("/assets/a.js")).status, 200);
});
