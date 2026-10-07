import test from "node:test";
import assert from "node:assert/strict";

import { fetchRemoteImage, isBlockedAddress, nextRedirectUrl, validateRemoteUrl } from "../src/remote-media.js";
import { startUpstream, PNG_BYTES } from "../test-helpers/http-upstream.js";

const LOCAL = { allowHttp: true, allowPrivateNetwork: true };
const refuses = (promise, code) => assert.rejects(promise, (error) => error.status === 400 && (!code || error.code === code), `expected a 400${code ? ` (${code})` : ""}`);

test("non-public addresses are blocked: private, loopback, link-local/metadata, CGNAT, mapped IPv6", () => {
  for (const address of ["127.0.0.1", "10.0.0.5", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0",
    "::1", "fe80::1", "fc00::1", "::ffff:127.0.0.1", "::ffff:10.0.0.1", "224.0.0.1"]) {
    assert.equal(isBlockedAddress(address), true, address);
  }
  for (const address of ["8.8.8.8", "93.184.216.34", "2606:4700:4700::1111"]) assert.equal(isBlockedAddress(address), false, address);
  assert.equal(isBlockedAddress("not-an-ip"), true, "anything that is not an address is refused");
});

test("URL shape: https only, no credentials, no literal private address", () => {
  assert.throws(() => validateRemoteUrl("http://example.com/a.png"), (e) => e.status === 400);
  assert.throws(() => validateRemoteUrl("ftp://example.com/a.png"), (e) => e.status === 400);
  assert.throws(() => validateRemoteUrl("file:///etc/passwd"), (e) => e.status === 400);
  assert.throws(() => validateRemoteUrl("https://user:pw@example.com/a.png"), (e) => e.status === 400);
  assert.throws(() => validateRemoteUrl("https://169.254.169.254/latest/meta-data"), (e) => e.status === 400);
  assert.throws(() => validateRemoteUrl("https://[::1]/a.png"), (e) => e.status === 400);
  assert.throws(() => validateRemoteUrl("not a url"), (e) => e.status === 400);
  assert.equal(validateRemoteUrl("https://example.com/a.png").hostname, "example.com");
  assert.equal(validateRemoteUrl("http://example.com/a.png", { allowHttp: true }).protocol, "http:");
});

test("a redirect target is validated like a client-supplied URL", () => {
  const from = new URL("https://example.com/a.png");
  assert.equal(nextRedirectUrl(from, "/b.png").href, "https://example.com/b.png");
  assert.throws(() => nextRedirectUrl(from, "http://example.com/b.png"), (e) => e.status === 400, "https -> http downgrade");
  assert.throws(() => nextRedirectUrl(from, "https://169.254.169.254/latest/meta-data/"), (e) => e.status === 400, "to cloud metadata");
  assert.throws(() => nextRedirectUrl(from, "https://10.0.0.1/x.png"), (e) => e.status === 400, "to a private address");
  assert.throws(() => nextRedirectUrl(from, "https://user:pw@evil.test/x.png"), (e) => e.status === 400, "to a URL with credentials");
  assert.throws(() => nextRedirectUrl(from, "file:///etc/passwd"), (e) => e.status === 400, "to a file URL");
});

test("a hostname that resolves to a private address is refused at connect time (DNS-level check)", async (t) => {
  const upstream = await startUpstream((req, res) => { res.writeHead(200, { "content-type": "image/png" }); res.end(PNG_BYTES); });
  t.after(() => upstream.close());
  // `localhost` is a name, so the literal-IP check passes it; only the lookup check can stop it.
  await refuses(fetchRemoteImage(`http://localhost:${upstream.port}/img/a.png`, { allowHttp: true }), "invalid_image_url");
  assert.equal(upstream.calls.length, 0, "the server was never contacted");
});

test("an image is downloaded and returned as base64 with its real MIME type", async (t) => {
  const upstream = await startUpstream((req, res) => { res.writeHead(200, { "content-type": "application/octet-stream" }); res.end(PNG_BYTES); });
  t.after(() => upstream.close());
  const image = await fetchRemoteImage(`${upstream.url}/img/a`, LOCAL);
  assert.equal(image.mimeType, "image/png", "sniffed from the bytes, not trusted from the header");
  assert.equal(image.data, PNG_BYTES.toString("base64"));
});

test("a response that is not an image, an empty body, or an HTTP error is refused", async (t) => {
  const upstream = await startUpstream((req, res) => {
    if (req.url.includes("html")) { res.writeHead(200, { "content-type": "text/html" }); return res.end("<html>"); }
    if (req.url.includes("empty")) { res.writeHead(200, { "content-type": "image/png" }); return res.end(); }
    res.writeHead(404); res.end("nope");
  });
  t.after(() => upstream.close());
  await refuses(fetchRemoteImage(`${upstream.url}/img/html`, LOCAL), "invalid_image_url");
  await refuses(fetchRemoteImage(`${upstream.url}/img/empty`, LOCAL), "invalid_image_url");
  await refuses(fetchRemoteImage(`${upstream.url}/img/missing`, LOCAL), "image_fetch_failed");
});

test("the size cap applies to the declared length and to a body that lies about it", async (t) => {
  const big = Buffer.concat([PNG_BYTES, Buffer.alloc(4096)]);
  const upstream = await startUpstream((req, res) => {
    if (req.url.includes("chunked")) { res.writeHead(200, { "content-type": "image/png" }); res.write(big.subarray(0, 2048)); return setTimeout(() => { res.end(big.subarray(2048)); }, 20); }
    res.writeHead(200, { "content-type": "image/png", "content-length": big.length }); res.end(big);
  });
  t.after(() => upstream.close());
  await refuses(fetchRemoteImage(`${upstream.url}/img/declared`, { ...LOCAL, maxBytes: 1024 }), "image_too_large");
  await refuses(fetchRemoteImage(`${upstream.url}/img/chunked`, { ...LOCAL, maxBytes: 1024 }), "image_too_large");
});

test("redirects are followed a few hops, then refused; a bad hop is refused", async (t) => {
  const upstream = await startUpstream((req, res) => {
    if (req.url.includes("/hop2")) { res.writeHead(200, { "content-type": "image/png" }); return res.end(PNG_BYTES); }
    if (req.url.includes("/hop1")) { res.writeHead(302, { location: "/img/hop2" }); return res.end(); }
    if (req.url.includes("/start")) { res.writeHead(302, { location: "/img/hop1" }); return res.end(); }
    if (req.url.includes("/loop")) { res.writeHead(302, { location: "/img/loop" }); return res.end(); }
    if (req.url.includes("/downgrade")) { res.writeHead(302, { location: "ftp://example.com/x.png" }); return res.end(); }
    res.writeHead(404); res.end();
  });
  t.after(() => upstream.close());
  assert.equal((await fetchRemoteImage(`${upstream.url}/img/start`, LOCAL)).mimeType, "image/png");
  await refuses(fetchRemoteImage(`${upstream.url}/img/loop`, LOCAL), "image_fetch_failed");
  await refuses(fetchRemoteImage(`${upstream.url}/img/downgrade`, LOCAL));
});

test("an aborted download stops (the client left)", async (t) => {
  const upstream = await startUpstream(() => { /* never answers */ });
  t.after(() => upstream.close());
  const controller = new AbortController();
  const pending = fetchRemoteImage(`${upstream.url}/img/slow`, { ...LOCAL, signal: controller.signal, timeoutMs: 5000 });
  setTimeout(() => controller.abort(), 50);
  await assert.rejects(pending, (error) => error.name === "AbortError" || error.status === 400);
});
