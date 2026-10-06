import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import { startRouter, postJson } from "../test-helpers/router-harness.js";

/**
 * With no `MULTIAI_ROUTER_API_KEYS` the gateway is open for local trusted use -
 * that is the documented default - but an unauthenticated instance must not be
 * drivable from another host. Loopback keeps full access (so the panel and
 * local development are unaffected); a remote caller is refused the proxy and
 * the admin surface until an operator configures keys.
 *
 * `/health` and `/v1/models` are deliberately public readiness metadata (a load
 * balancer or container probe has no token); they must stay metadata-only and
 * never carry a credential. That contract is pinned below.
 */

/** The machine's first non-internal IPv4, or null when there is none. */
function externalIPv4() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const entry of list ?? []) {
      const family = entry.family === "IPv4" || entry.family === 4;
      if (family && !entry.internal && /^\d+\.\d+\.\d+\.\d+$/.test(entry.address)) return entry.address;
    }
  }
  return null;
}

const LAN = externalIPv4();
const chat = { model: "m", messages: [{ role: "user", content: "hi" }] };
const fromLan = (router, pathname, options) => fetch(`http://${LAN}:${router.port}${pathname}`, options);

test("with no keys configured, a non-loopback caller is refused the proxy and admin surface", async (t) => {
  // HOST unset: the listener is on every interface, exactly the risky default.
  const router = await startRouter({});
  t.after(() => router.close());

  assert.equal((await router.request("/health")).status, 200, "loopback keeps working");

  if (!LAN) {
    t.diagnostic("no non-internal IPv4 found; the loopback-only gate was not exercised");
    return;
  }

  for (const [pathname, options] of [
    ["/api/config", undefined],
    ["/api/requests", undefined],
    ["/v1/chat/completions", postJson(chat)],
    ["/v1/messages", postJson({ max_tokens: 8, messages: [{ role: "user", content: "hi" }] })]
  ]) {
    const remote = await fromLan(router, pathname, options);
    assert.equal(remote.status, 401, `${pathname} must not answer a remote caller`);
  }

  // Public readiness metadata stays available, and stays free of credentials.
  const health = await fromLan(router, "/health");
  assert.equal(health.status, 200);
  const healthBody = await health.text();
  assert.ok(!/api[_-]?key|authorization|bearer\s+\S+/i.test(healthBody), "no credential in the public health payload");
  assert.equal((await fromLan(router, "/v1/models")).status, 200);
});

test("with keys configured, the token is required from every caller and is never echoed back", async (t) => {
  const TOKEN = "client-token-value";
  const router = await startRouter({ MULTIAI_ROUTER_API_KEYS: TOKEN });
  t.after(() => router.close());
  const auth = { headers: { authorization: `Bearer ${TOKEN}` } };

  assert.equal((await router.request("/api/config")).status, 401, "no token, no admin surface");
  assert.equal((await router.request("/v1/chat/completions", postJson(chat))).status, 401, "no token, no proxy");

  // The token alone grants access; with no providers configured the proxy can
  // still legitimately answer 503 no_route, which proves it got past auth.
  const authorized = await router.request("/v1/chat/completions", { ...postJson(chat), ...auth });
  assert.equal(authorized.status, 503);

  const config = await router.request("/api/config", auth);
  assert.equal(config.status, 200);
  const raw = await config.text();
  assert.ok(!raw.includes(TOKEN), "the client token must never be echoed into the config payload");
  assert.equal(JSON.parse(raw).server.clientAuthRequired, true);

  assert.equal((await router.request("/v1/models")).status, 200, "model discovery stays public");

  if (LAN) {
    assert.equal((await fromLan(router, "/api/config")).status, 401, "a remote caller needs the token");
    assert.equal((await fromLan(router, "/api/config", auth)).status, 200, "a remote caller with the token is served");
    assert.equal((await fromLan(router, "/v1/chat/completions", postJson(chat))).status, 401);
    assert.equal((await fromLan(router, "/v1/chat/completions", { ...postJson(chat), ...auth })).status, 503);
  }
});
