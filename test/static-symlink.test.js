import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import { createStaticHandler } from "../src/static-files.js";

function setup(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "static-"));
  const root = path.join(base, "dist");
  const outside = path.join(base, "outside");
  fs.mkdirSync(path.join(root, "assets"), { recursive: true });
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(root, "index.html"), "<html>app</html>");
  fs.writeFileSync(path.join(root, "assets", "a.js"), "console.log(1)");
  fs.writeFileSync(path.join(outside, "secret.txt"), "TOP-SECRET");
  fs.writeFileSync(path.join(root, "inside.txt"), "inside");
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  return { base, root, outside };
}

async function serve(t, root) {
  const handler = createStaticHandler({ root });
  const server = http.createServer(async (req, res) => {
    const pathname = new URL(req.url, "http://x").pathname;
    if (await handler.serve(req, res, pathname)) return;
    res.writeHead(404); res.end("404");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  return (p) => new Promise((resolve) => {
    http.get({ host: "127.0.0.1", port: server.address().port, path: p }, (res) => {
      let body = ""; res.on("data", (c) => { body += c; }); res.on("end", () => resolve({ status: res.statusCode, body }));
    });
  });
}

test("files inside the root are served, including through a symlink that stays inside it", async (t) => {
  const { root } = setup(t);
  fs.symlinkSync(path.join(root, "inside.txt"), path.join(root, "alias.txt"));
  const get = await serve(t, root);
  assert.equal((await get("/assets/a.js")).status, 200);
  assert.equal((await get("/alias.txt")).body, "inside");
});

test("a symlinked FILE pointing outside the root is not served", async (t) => {
  const { root, outside } = setup(t);
  fs.symlinkSync(path.join(outside, "secret.txt"), path.join(root, "leak.txt"));
  const get = await serve(t, root);
  const res = await get("/leak.txt");
  assert.notEqual(res.body, "TOP-SECRET");
  assert.equal(res.status, 404);
});

test("a symlinked DIRECTORY pointing outside the root is not served", async (t) => {
  const { root, outside } = setup(t);
  fs.symlinkSync(outside, path.join(root, "linkdir"));
  const get = await serve(t, root);
  const res = await get("/linkdir/secret.txt");
  assert.equal(res.status, 404);
  assert.notEqual(res.body, "TOP-SECRET");
});

test("an index.html that is a symlink to outside is not served", async (t) => {
  const { root, outside } = setup(t);
  fs.rmSync(path.join(root, "index.html"));
  fs.writeFileSync(path.join(outside, "evil.html"), "<script>evil</script>");
  fs.symlinkSync(path.join(outside, "evil.html"), path.join(root, "index.html"));
  const get = await serve(t, root);
  const res = await get("/");
  assert.notEqual(res.body, "<script>evil</script>");
});

test("lexical traversal is still refused: dot-dot, encoded, double-encoded, backslash, absolute, dotfiles", async (t) => {
  const { root } = setup(t);
  fs.writeFileSync(path.join(root, ".env"), "SECRET=1");
  const get = await serve(t, root);
  for (const p of ["/../outside/secret.txt", "/%2e%2e/outside/secret.txt", "/%252e%252e/outside/secret.txt", "/assets/..%2f..%2foutside/secret.txt",
    "/assets/..%5c..%5coutside%5csecret.txt", "//etc/passwd", "/%2fetc%2fpasswd", "/.env", "/assets/%00a.js"]) {
    const res = await get(p);
    assert.ok(!/TOP-SECRET|SECRET=1|root:/.test(res.body), p);
  }
});
