import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { createStaticHandler, resolveWithinRoot, placeholderPage } from "../src/static-files.js";

async function makeRoot(t, files = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "apirouter-static-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  for (const [relative, contents] of Object.entries(files)) {
    const full = path.join(root, relative);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, contents);
  }

  return root;
}

/** Serve `root` on a real socket so the handler runs under real req/res. */
async function serveRoot(t, root) {
  const handler = createStaticHandler({ root });
  const server = http.createServer(async (req, res) => {
    const pathname = new URL(req.url, "http://localhost").pathname;
    if (await handler.serve(req, res, pathname)) return;
    return handler.serveIndex(req, res);
  });

  await new Promise((resolve) => server.listen(0, "localhost", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));

  return { baseUrl: `http://localhost:${server.address().port}`, handler };
}

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

test("resolveWithinRoot accepts paths inside the root", () => {
  const root = path.resolve("/srv/ui/dist");

  assert.equal(resolveWithinRoot(root, "/assets/app.js"), path.join(root, "assets", "app.js"));
  assert.equal(resolveWithinRoot(root, "/index.html"), path.join(root, "index.html"));
  assert.equal(resolveWithinRoot(root, "/deep/nested/file.css"), path.join(root, "deep", "nested", "file.css"));
});

test("resolveWithinRoot rejects traversal and absolute escapes", () => {
  const root = path.resolve("/srv/ui/dist");

  for (const attempt of [
    "/../secrets.env",
    "/assets/../../etc/passwd",
    "/..%2f..%2fetc/passwd",
    "/%2e%2e/%2e%2e/etc/passwd",
    "/....//....//etc/passwd"
  ]) {
    const resolved = resolveWithinRoot(root, attempt);
    assert.ok(
      resolved === null || resolved.startsWith(root + path.sep),
      `escaped the root: ${attempt} -> ${resolved}`
    );
  }
});

test("resolveWithinRoot rejects null bytes, dotfiles and the root itself", () => {
  const root = path.resolve("/srv/ui/dist");

  assert.equal(resolveWithinRoot(root, "/app.js\u0000.png"), null);
  assert.equal(resolveWithinRoot(root, "/.env"), null);
  assert.equal(resolveWithinRoot(root, "/.git/config"), null);
  assert.equal(resolveWithinRoot(root, "/"), null);
  assert.equal(resolveWithinRoot(root, ""), null);
});

// ---------------------------------------------------------------------------
// Serving
// ---------------------------------------------------------------------------

test("serves a built asset with the right type, ETag and immutable caching", async (t) => {
  const root = await makeRoot(t, {
    "index.html": "<!doctype html><title>panel</title>",
    "assets/app-abc123.js": "export const x = 1;"
  });
  const { baseUrl } = await serveRoot(t, root);

  const res = await fetch(`${baseUrl}/assets/app-abc123.js`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /text\/javascript/);
  assert.match(res.headers.get("cache-control"), /immutable/);
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  assert.equal(await res.text(), "export const x = 1;");

  const etag = res.headers.get("etag");
  assert.ok(etag);

  const cached = await fetch(`${baseUrl}/assets/app-abc123.js`, { headers: { "if-none-match": etag } });
  assert.equal(cached.status, 304);
});

test("the SPA entry point is not cached and supports conditional requests", async (t) => {
  const root = await makeRoot(t, { "index.html": "<!doctype html><title>panel</title>" });
  const { baseUrl } = await serveRoot(t, root);

  const res = await fetch(`${baseUrl}/index.html`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /text\/html/);
  assert.equal(res.headers.get("cache-control"), "no-cache");
});

test("an extensionless route falls back to the SPA shell", async (t) => {
  const root = await makeRoot(t, { "index.html": "<!doctype html><title>panel</title>" });
  const { baseUrl } = await serveRoot(t, root);

  const res = await fetch(`${baseUrl}/health-monitor`);
  assert.equal(res.status, 200);
  assert.equal(await res.text(), "<!doctype html><title>panel</title>");
});

test("a traversal attempt cannot read a file outside the root", async (t) => {
  const root = await makeRoot(t, { "index.html": "panel" });
  await writeFile(path.join(root, "..", "outside-secret.txt"), "top secret");
  t.after(() => rm(path.join(root, "..", "outside-secret.txt"), { force: true }));

  const { baseUrl } = await serveRoot(t, root);

  for (const attempt of ["/../outside-secret.txt", "/%2e%2e/outside-secret.txt", "/assets/../../outside-secret.txt"]) {
    const res = await fetch(baseUrl + attempt);
    const body = await res.text();
    assert.ok(!body.includes("top secret"), `leaked a file outside the root via ${attempt}`);
  }
});

test("dotfiles are never served", async (t) => {
  const root = await makeRoot(t, { "index.html": "panel", ".env": "SECRET=1" });
  const { baseUrl } = await serveRoot(t, root);

  const res = await fetch(`${baseUrl}/.env`);
  const body = await res.text();
  assert.ok(!body.includes("SECRET=1"));
});

test("an unbuilt panel serves an actionable placeholder instead of failing", async (t) => {
  const root = await makeRoot(t, {});
  const { baseUrl, handler } = await serveRoot(t, root);

  assert.equal(await handler.isBuilt(), false);

  const res = await fetch(`${baseUrl}/`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /text\/html/);

  const body = await res.text();
  assert.match(body, /npm run ui:build/);
  assert.match(body, /\/health/);
  assert.match(body, /\/api\/system/);
});

test("the placeholder page never mentions credentials", () => {
  const page = placeholderPage();
  assert.ok(!/api[_-]?key\s*[:=]\s*\S+/i.test(page));
  assert.ok(!/authorization/i.test(page));
  assert.ok(!/Bearer /.test(page));
});
