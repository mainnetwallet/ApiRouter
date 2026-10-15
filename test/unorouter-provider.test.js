import test from "node:test";
import assert from "node:assert/strict";

import { loadConfig, buildTargets, PROVIDER_IDS } from "../src/config.js";
import { providerProtocols, buildUpstreamRequest } from "../src/adapters.js";
import { healthProbePlan } from "../src/health-checks.js";
import { normalizeEntries } from "../src/fallback-chain.js";

/**
 * UnoRouter is a plain OpenAI-compatible gateway, so it needs no adapter of its
 * own: registering the id in PROVIDER_IDS must be enough for text and vision
 * routing, health probes and the fallback chain, including `:free` model ids.
 */

const ENV = {
  UNOROUTER_API_KEYS: "k1,k2",
  UNOROUTER_MODELS: "deepseek-v4-flash:free,glm-5.2:free",
  UNOROUTER_BASE_URL: "https://api.unorouter.com/v1",
  UNOROUTER_VISION_API_KEYS: "vk",
  UNOROUTER_VISION_MODELS: "gemma-4-31b-it:free",
  UNOROUTER_VISION_BASE_URL: "https://api.unorouter.com/v1"
};

test("unorouter is a registered provider and speaks openai-chat only", () => {
  assert.ok(PROVIDER_IDS.includes("unorouter"));
  assert.deepEqual(providerProtocols("unorouter"), ["openai-chat"]);
});

test("text pool: one target per model and key, :free ids preserved", () => {
  const config = loadConfig(ENV);
  const targets = buildTargets(config.providers, "text").filter((t) => t.provider === "unorouter");
  assert.equal(targets.length, 4);
  assert.deepEqual([...new Set(targets.map((t) => t.model))], ["deepseek-v4-flash:free", "glm-5.2:free"]);
});

test("vision pool is configured independently of the text pool", () => {
  const config = loadConfig(ENV);
  const targets = buildTargets(config.visionProviders, "vision").filter((t) => t.provider === "unorouter");
  assert.equal(targets.length, 1);
  assert.equal(targets[0].id, "vision:unorouter:gemma-4-31b-it:free:key-0");
});

test("chat and health URLs resolve to /v1 for every spelling of the base URL", () => {
  for (const base of ["https://api.unorouter.com/v1", "https://api.unorouter.com/v1/", "https://api.unorouter.com"]) {
    const config = loadConfig({ ...ENV, UNOROUTER_BASE_URL: base });
    const target = buildTargets(config.providers, "text").find((t) => t.provider === "unorouter");
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
