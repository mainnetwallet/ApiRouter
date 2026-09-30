import test from "node:test";
import assert from "node:assert/strict";
import { buildTargets, isProviderConfigured, loadConfig } from "../src/config.js";
import { isRetryableStatus, withFallback } from "../src/router.js";

test("retryable statuses include quota/rate-limit/server failures", () => {
  for (const code of [402,408,429,500,502,503,504]) assert.equal(isRetryableStatus(code), true);
});

test("401 and 403 are not retryable by default", () => {
  assert.equal(isRetryableStatus(401), false);
  assert.equal(isRetryableStatus(403), false);
});

test("fallback continues after a retryable failure", async () => {
  const result = await withFallback(
    [{id:"a"},{id:"b"}],
    async (target) => {
      if (target.id === "a") { const e = new Error("quota"); e.status = 402; throw e; }
      return target.id;
    }
  );
  assert.equal(result, "b");
});

test("provider is invalid when any required field is missing", () => {
  assert.equal(isProviderConfigured({ apiKeys:["k"], models:["m"], baseUrl:"https://x.test" }), true);
  assert.equal(isProviderConfigured({ apiKeys:[], models:["m"], baseUrl:"https://x.test" }), false);
  assert.equal(isProviderConfigured({ apiKeys:["k"], models:[], baseUrl:"https://x.test" }), false);
  assert.equal(isProviderConfigured({ apiKeys:["k"], models:["m"], baseUrl:"" }), false);
});

test("incomplete providers produce no fallback targets", () => {
  const config = loadConfig({
    AGENTROUTER_API_KEYS: "key1,key2",
    AGENTROUTER_MODELS: "model1,model2",
    AGENTROUTER_BASE_URL: "https://example.test",
    GEMINI_API_KEYS: "key",
    GEMINI_MODELS: "",
    GEMINI_BASE_URL: "https://example.test"
  });
  const targets = buildTargets(config.providers);
  assert.equal(targets.some((t) => t.provider === "agentrouter"), true);
  assert.equal(targets.some((t) => t.provider === "gemini"), false);
  assert.equal(targets.length, 4);
});
