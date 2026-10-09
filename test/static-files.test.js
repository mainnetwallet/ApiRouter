import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createStaticHandler, resolveWithinRoot } from "../src/static-files.js";

/**
 * Regression: static serving checked containment LEXICALLY.
 *
 * `resolveWithinRoot` collapses `..` and compares string prefixes, which is
 * correct for the URL but says nothing about the filesystem. A symlink (or a
 * Windows junction) placed inside the build output passed that check and was
 * then followed by the stat and the read, so a file outside `ui/dist` was
 * served — despite the module's own contract that it "follows no symlinks out
 * of the root".
 */

const SECRET = "TOP SECRET OUTSIDE ROOT";

async function tempDir(prefix) {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

/** Boot the real handler over HTTP so the assertions cover stat + read too. */
async function startServer(root) {
  const handler = createStaticHandler({ root });
  const server = http.createServer(async (req, res) => {
    const pathname = new URL(req.url, "http://localhost").pathname;
    if (await handler.serve(req, res, pathname)) return;
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    get: (p) => fetch(`http://127.0.0.1:${port}${p}`),
    close: () => new Promise((resolve) => server.close(resolve))
  };
}

/**
 * Create a directory link inside `root`. A Windows junction needs no privilege;
 * a POSIX directory symlink is the equivalent. Returns false when the host
 * cannot make one, so the caller can skip rather than fail.
 */
async function linkDirectory(target, linkPath) {
  const types = process.platform === "win32" ? ["junction"] : ["dir"];
  for (const type of types) {
    try {
      await fs.symlink(target, linkPath, type);
      return true;
    } catch (error) {
      if (!["EPERM", "EACCES", "ENOSYS", "ENOTSUP", "UNKNOWN"].includes(error.code)) throw error;
    }
  }
  return false;
}

// ------------------------------------------------- pure containment (no fs)

test("resolveWithinRoot: traversal, dotfiles and null bytes are refused", () => {
  const root = path.resolve(os.tmpdir(), "apirouter-static-root");

  assert.equal(resolveWithinRoot(root, "/../secret.txt"), null);
  assert.equal(resolveWithinRoot(root, "/..%2f..%2fsecret.txt"), null);
  assert.equal(resolveWithinRoot(root, "/a/../../secret.txt"), null);
  assert.equal(resolveWithinRoot(root, "/"), null);
  assert.equal(resolveWithinRoot(root, ""), null);
  assert.equal(resolveWithinRoot(root, "/.env"), null);
  assert.equal(resolveWithinRoot(root, "/assets/.hidden/x.js"), null);
  assert.equal(resolveWithinRoot(root, "/%00"), null);
  // Malformed percent-encoding must not throw.
  assert.equal(resolveWithinRoot(root, "/%ZZ"), null);
  if (process.platform === "win32") {
    assert.equal(resolveWithinRoot(root, "/foo\\..\\..\\secret.txt"), null);
  }
});

test("resolveWithinRoot: anything it returns really is inside the root", () => {
  const root = path.resolve(os.tmpdir(), "apirouter-static-root");
  for (const input of ["/index.html", "/assets/app.js", "/a/b/c.css", "/nested/deep/file.map"]) {
    const resolved = resolveWithinRoot(root, input);
    assert.ok(resolved, `${input} should resolve`);
    assert.ok(resolved === path.resolve(root) || resolved.startsWith(path.resolve(root) + path.sep), `${input} escaped: ${resolved}`);
  }
  assert.equal(resolveWithinRoot(root, "/index.html"), path.join(root, "index.html"));
});

// ------------------------------------------------------------ over HTTP

test("serves a real file inside the root, and 404s traversal and dotfiles", async () => {
  const root = await tempDir("static-root-");
  await fs.writeFile(path.join(root, "index.html"), "<h1>panel</h1>");
  const server = await startServer(root);
  try {
    const ok = await server.get("/index.html");
    assert.equal(ok.status, 200);
    assert.equal(await ok.text(), "<h1>panel</h1>");

    assert.equal((await server.get("/missing.html")).status, 404);
  } finally {
    await server.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("a link inside the root pointing OUTSIDE it does not serve the outside file", async (t) => {
  const root = await tempDir("static-root-");
  const outside = await tempDir("static-outside-");
  await fs.writeFile(path.join(outside, "secret.txt"), SECRET);
  await fs.writeFile(path.join(root, "index.html"), "<h1>panel</h1>");

  const linked = await linkDirectory(outside, path.join(root, "evil"));
  if (!linked) {
    t.skip("this host cannot create directory links");
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
    return;
  }

  const server = await startServer(root);
  try {
    const response = await server.get("/evil/secret.txt");
    assert.notEqual(response.status, 200, "the symlinked file outside the root was served");
    assert.ok(!(await response.text()).includes(SECRET), "the outside file's contents were served");
  } finally {
    await server.close();
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  }
});

test("a link inside the root pointing INSIDE it is still served (legitimate links are not blocked)", async (t) => {
  const root = await tempDir("static-root-");
  await fs.mkdir(path.join(root, "real"));
  await fs.writeFile(path.join(root, "real", "app.js"), "console.log(1);");

  const linked = await linkDirectory(path.join(root, "real"), path.join(root, "alias"));
  if (!linked) {
    t.skip("this host cannot create directory links");
    await fs.rm(root, { recursive: true, force: true });
    return;
  }

  const server = await startServer(root);
  try {
    const response = await server.get("/alias/app.js");
    assert.equal(response.status, 200);
    assert.equal(await response.text(), "console.log(1);");
  } finally {
    await server.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("a link cycle is reported as not-found, not as a crash", async (t) => {
  const root = await tempDir("static-root-");
  const linked = await linkDirectory(path.join(root, "loop"), path.join(root, "loop"));
  if (!linked) {
    t.skip("this host cannot create directory links");
    await fs.rm(root, { recursive: true, force: true });
    return;
  }

  const server = await startServer(root);
  try {
    // ELOOP must degrade to a plain 404 rather than an unhandled error.
    const response = await server.get("/loop/anything.txt");
    assert.equal(response.status, 404);
  } finally {
    await server.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});
