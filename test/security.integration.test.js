import test from "node:test";
import assert from "node:assert/strict";

import { startRouter, postJson } from "../test-helpers/router-harness.js";
import { startUpstream, chatJsonReply } from "../test-helpers/http-upstream.js";
import { publicBaseUrl } from "../src/observability/config-view.js";

const KEY = "router-secret-key-123";

async function rig(t, env = {}) {
  const upstream = await startUpstream((req, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end(chatJsonReply()); });
  const router = await startRouter({ GROQ_API_KEYS: "sk-groq-test-key-1", GROQ_MODELS: "m1", GROQ_BASE_URL: `${upstream.url}/v1`, MULTIAI_ROUTER_API_KEYS: KEY, ...env });
  t.after(async () => { await router.close(); await upstream.close(); });
  return router;
}
const chat = { messages: [{ role: "user", content: "hi" }] };

test("auth: Bearer, x-api-key and x-goog-api-key are accepted; a wrong key, a prefix, and a query key are not", async (t) => {
  const router = await rig(t);
  assert.equal((await router.request("/v1/chat/completions", postJson(chat, { authorization: `Bearer ${KEY}` }))).status, 200);
  assert.equal((await router.request("/v1/chat/completions", postJson(chat, { "x-api-key": KEY }))).status, 200);
  assert.equal((await router.request("/v1/chat/completions", postJson(chat, { "x-goog-api-key": KEY }))).status, 200);
  for (const headers of [{}, { authorization: "Bearer wrong" }, { authorization: `Bearer ${KEY.slice(0, -1)}` }, { authorization: `Bearer ${KEY}x` }, { "x-api-key": "nope" }, { authorization: KEY }]) {
    assert.equal((await router.request("/v1/chat/completions", postJson(chat, headers))).status, 401, JSON.stringify(headers));
  }
  assert.equal((await router.request(`/v1/chat/completions?key=${KEY}`, postJson(chat))).status, 401, "a key in the URL is not accepted: URLs get logged");
});

test("auth: with several router keys, any one works", async (t) => {
  const router = await rig(t, { MULTIAI_ROUTER_API_KEYS: "first-key-aaaaaaaa,second-key-bbbbbbb" });
  assert.equal((await router.request("/v1/chat/completions", postJson(chat, { "x-api-key": "second-key-bbbbbbb" }))).status, 200);
  assert.equal((await router.request("/api/config", { headers: { "x-api-key": "first-key-aaaaaaaa" } })).status, 200);
});

test("the Cloudflare account id never appears in the control panel's config or providers views", async (t) => {
  const accountId = "abcdef0123456789abcdef0123456789";
  const router = await startRouter({ CLOUDFLARE_API_KEYS: "cf-token-123456789", CLOUDFLARE_ACCOUNT_IDS: accountId, CLOUDFLARE_MODELS: "@cf/x/y" });
  t.after(() => router.close());
  for (const path of ["/api/config", "/api/providers", "/api/models", "/api/health", "/health", "/v1/models"]) {
    const res = await router.request(path);
    assert.ok(!(await res.text()).includes(accountId), `${path} leaked the account id`);
  }
  const config = await (await router.request("/api/config")).json();
  assert.match(config.providers.find((p) => p.id === "cloudflare").baseUrl, /\/accounts\/\[account-id\]\//);
});

test("publicBaseUrl hides account ids, credentials and query strings but keeps the host and path", () => {
  assert.equal(publicBaseUrl("https://api.cloudflare.com/client/v4/accounts/abc123/ai/v1"), "https://api.cloudflare.com/client/v4/accounts/[account-id]/ai/v1");
  assert.equal(publicBaseUrl("https://user:pass@example.com/v1?key=SECRET#frag"), "https://example.com/v1");
  assert.equal(publicBaseUrl("https://api.groq.com/openai/v1"), "https://api.groq.com/openai/v1");
  assert.equal(publicBaseUrl(null), null);
  assert.equal(publicBaseUrl("not a url with SECRET"), "[invalid URL]");
});

test("HOST can restrict the listener to loopback", async (t) => {
  const router = await startRouter({ HOST: "127.0.0.1" });
  t.after(() => router.close());
  assert.equal((await router.request("/health")).status, 200);
});
