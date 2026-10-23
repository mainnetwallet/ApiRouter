import test from "node:test";
import assert from "node:assert/strict";

import { loadConfig, buildTargets, PROVIDER_IDS } from "../src/config.js";
import { providerProtocols, buildUpstreamRequest } from "../src/adapters.js";
import { healthProbePlan } from "../src/health-checks.js";
import { normalizeEntries } from "../src/fallback-chain.js";
import { inferCapabilities } from "../src/model-capabilities.js";

/**
 * UnoRouter is a plain OpenAI-compatible gateway, so it needs no adapter of its
 * own: registering the id in PROVIDER_IDS must be enough for routing, health
 * probes and the fallback chain, including `:free` model ids.
 */

// ONE model list, ONE key list, ONE base URL. The gemma model used to live in a
// separate vision list; it is now an ordinary model of the provider, and what it
// can do is a declaration in the Model Configurator, not a list it belongs to.
const ENV = {
  UNOROUTER_API_KEYS: "k1,k2",
  UNOROUTER_MODELS: "deepseek-v4-flash:free,glm-5.2:free,gemma-4-31b-it:free",
  UNOROUTER_BASE_URL: "https://api.unorouter.com/v1"
};

test("unorouter is a registered provider and speaks openai-chat only", () => {
  assert.ok(PROVIDER_IDS.includes("unorouter"));
  assert.deepEqual(providerProtocols("unorouter"), ["openai-chat"]);
});

test("one target per model and key, :free ids preserved", () => {
  const config = loadConfig(ENV);
  const targets = buildTargets(config.providers).filter((t) => t.provider === "unorouter");
  assert.equal(targets.length, 6, "3 models x 2 keys");
  assert.deepEqual([...new Set(targets.map((t) => t.model))],
    ["deepseek-v4-flash:free", "glm-5.2:free", "gemma-4-31b-it:free"]);
  assert.deepEqual(targets.filter((t) => t.model === "gemma-4-31b-it:free").map((t) => t.keyIndex), [0, 1]);
});

test("the retired UNOROUTER_VISION_* variables add no target, no pool and no vision id", () => {
  const config = loadConfig({
    ...ENV,
    UNOROUTER_VISION_API_KEYS: "vk",
    UNOROUTER_VISION_MODELS: "vision-only-model",
    UNOROUTER_VISION_BASE_URL: "https://vision.unorouter.test/v1"
  });
  assert.equal(config.visionProviders, undefined, "there is no second provider table");
  const targets = buildTargets(config.providers).filter((t) => t.provider === "unorouter");
  assert.ok(!targets.some((t) => t.model === "vision-only-model"), "a retired variable never contributes a model");
  assert.ok(!targets.some((t) => String(t.baseUrl).includes("vision.unorouter.test")), "nor a base URL");
  assert.ok(!targets.some((t) => "id" in t && String(t.id).startsWith("vision:")), "no vision: identifiers");
  assert.ok(!targets.some((t) => "pool" in t), "targets carry no pool");
});

test("an unorouter model defaults to text, streaming and nothing else: image input is never inferred from the provider, the model name or the old vision list", () => {
  const config = loadConfig(ENV);
  const protocols = buildTargets(config.providers).find((t) => t.provider === "unorouter").protocols;
  assert.deepEqual(inferCapabilities({ protocols }), ["text_input", "text_output", "streaming"]);
});

test("chat and health URLs resolve to /v1 for every spelling of the base URL", () => {
  for (const base of ["https://api.unorouter.com/v1", "https://api.unorouter.com/v1/", "https://api.unorouter.com"]) {
    const config = loadConfig({ ...ENV, UNOROUTER_BASE_URL: base });
    const target = buildTargets(config.providers).find((t) => t.provider === "unorouter");
    assert.equal(buildUpstreamRequest(target, "openai-chat", { model: "m", messages: [] }).url,
      "https://api.unorouter.com/v1/chat/completions", base);
    assert.equal(healthProbePlan(target).url, "https://api.unorouter.com/v1/models", base);
  }
});

test("fallback chain keeps unorouter :free models as distinct entries", () => {
  const entries = normalizeEntries([
    { provider: "unorouter", model: "deepseek-v4-flash:free" },
    { provider: "unorouter", model: "glm-5.2:free" }
  ]);
  assert.equal(entries.length, 2);
});

test("an unconfigured unorouter contributes no targets", () => {
  const config = loadConfig({});
  assert.equal(buildTargets(config.providers, "text").some((t) => t.provider === "unorouter"), false);
});
