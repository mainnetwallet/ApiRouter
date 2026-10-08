import test from "node:test";
import assert from "node:assert/strict";
import { startMockUpstream } from "../test-helpers/mock-upstream.js";
import { startRouter, postJson } from "../test-helpers/router-harness.js";

// End to end: an upstream that echoes the credential it was sent must never get
// that credential back out of the router, on any route a client or operator can read.

const ACCOUNT_ID = "0123456789abcdef0123456789abcdef";
const PROVIDERS = [
  { id: "nvidia", key: "nvapi-INTEGRATION1234567890nvSECRET", model: "m-nvidia" },
  { id: "cerebras", key: "csk-INTEGRATION1234567890cbSECRET", model: "m-cerebras" },
  { id: "cloudflare", key: "CfTokenINTEGRATION1234567890abcdefghijkl", model: "m-cloudflare", account: ACCOUNT_ID },
  { id: "groq", key: "unknown-format-INTEGRATION-secret-77", model: "m-groq" },
  { id: "mistral", key: "sk-integration-0987654321abcdefSECRET", model: "m-mistral" }
];
// Secrets the router does NOT know about: only the generic patterns can catch these.
const FOREIGN = ["AIzaSyForeignKey0123456789abcdefgh", "hf_ForeignToken0123456789abcd", "gsk_ForeignToken0123456789abcd"];
const STATUSES = [400, 401, 402, 403, 404, 408, 409, 413, 422, 429, 500, 503];

async function boot(t) {
  const upstream = await startMockUpstream((record) => {
    const auth = String(record.headers.authorization || record.headers["x-api-key"] || "");
    const status = Number(/status:(\d+)/.exec(record.rawBody)?.[1] || 500);
    const key = auth.replace(/^Bearer\s+/i, "");
    return {
      status,
      body: {
        error: {
          message: `authentication failed for ${key} (sent Bearer ${key}); also saw ${FOREIGN.join(" ")}`,
          url: record.url
        }
      }
    };
  });
  const env = {};
  for (const p of PROVIDERS) {
    const prefix = p.id.toUpperCase();
    env[`${prefix}_API_KEYS`] = p.key;
    env[`${prefix}_MODELS`] = p.model;
    env[`${prefix}_BASE_URL`] = p.account ? `${upstream.baseUrl}/accounts/{ACCOUNT_ID}/ai/v1` : upstream.baseUrl;
    if (p.account) env[`${prefix}_ACCOUNT_IDS`] = p.account;
  }
  const router = await startRouter(env);
  t.after(async () => { await router.close(); await upstream.close(); });
  return router;
}

const allSecrets = () => [
  ...PROVIDERS.map((p) => p.key),
  ACCOUNT_ID,
  ...FOREIGN,
  ...PROVIDERS.map((p) => p.key.replace(/^(nvapi-|csk-|sk-)/, "")) // the secret part alone
];

// `/api/providers` deliberately shows each provider's resolved base URL (existing
// operator-facing behaviour), which for Cloudflare contains the account id, so
// that one identifier is exempt there. API keys are not exempt anywhere.
function assertClean(label, text, { allowAccountId = false } = {}) {
  for (const secret of allSecrets()) {
    if (allowAccountId && secret === ACCOUNT_ID) continue;
    assert.ok(!text.includes(secret), `${label} leaked ${secret}`);
  }
}

test("no configured or echoed credential leaves the router, for any provider or status", async (t) => {
  const router = await boot(t);
  const seen = [];

  for (const p of PROVIDERS) {
    for (const status of STATUSES) {
      const res = await router.request("/v1/chat/completions", postJson(
        { model: p.model, messages: [{ role: "user", content: `status:${status}` }] },
        { "x-multi-ai-pin-provider": p.id, "x-multi-ai-pin-key-index": "0", "x-multi-ai-pin-custom-model": "1" }
      ));
      const text = await res.text();
      seen.push(`${p.id}/${status}: ${text}`);
      assertClean(`response ${p.id}/${status}`, text + JSON.stringify([...res.headers]));
      assert.ok(res.status >= 400, `${p.id}/${status} unexpectedly succeeded (${res.status})`);
    }
  }

  // The diagnostic must survive redaction for the statuses that surface upstream text.
  assert.ok(seen.some((line) => /authentication failed for/.test(line)), "diagnostic text was removed entirely");

  for (const path of ["/api/requests", "/health", "/api/providers"]) {
    const res = await router.request(path);
    assertClean(path, await res.text(), { allowAccountId: path === "/api/providers" });
  }
  assertClean("router stdout", router.stdout);
  assertClean("router stderr", router.stderr);
});

test("a secret in an upstream 400 body is redacted in the client message and failures list", async (t) => {
  const router = await boot(t);
  const p = PROVIDERS[0];
  const res = await router.request("/v1/chat/completions", postJson(
    { model: p.model, messages: [{ role: "user", content: "status:400" }] },
    { "x-multi-ai-pin-provider": p.id, "x-multi-ai-pin-key-index": "0", "x-multi-ai-pin-custom-model": "1" }
  ));
  const body = await res.json();
  assert.equal(res.status, 400);
  assert.match(body.error.message, /authentication failed for/);
  assert.ok(!body.error.message.includes("INTEGRATION1234567890nvSECRET"));
  assert.ok(!JSON.stringify(body).includes(p.key));
});
