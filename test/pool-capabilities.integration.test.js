import test from "node:test";
import assert from "node:assert/strict";
import { PROVIDER_IDS, loadConfig, buildTargets, VISION_POOL } from "../src/config.js";
import { PROVIDERS } from "../src/providers/catalog.js";
import {
  TEXT_POOL,
  describeProviderCapabilities,
  modelPoolIndex,
  modelSupportsPool,
  validateModelForPool
} from "../src/capabilities.js";
import { describeConfig } from "../src/observability/config-view.js";
import { HealthRegistry, targetId } from "../src/health.js";
import { startMockUpstream } from "../test-helpers/mock-upstream.js";
import { startRouter, postJson } from "../test-helpers/router-harness.js";

/**
 * Text/vision pool architecture.
 *
 * Two independent routing pools: text targets and vision targets have their own
 * keys, base URLs, models, health, fallback chains and capability metadata, and
 * a request never crosses between them. These tests pin the contract end to end
 * — catalog, capability derivation, model validation, health identity, the
 * read-only API and the live proxy — so a future change to one provider cannot
 * silently merge the pools.
 */

// The eleven providers that predate the pool work, and the eight added with it.
const OLD_PROVIDERS = [
  "agentrouter", "gemini", "groq", "huggingface", "mistral", "openrouter",
  "cerebras", "cloudflare", "sambanova", "cohere", "zai"
];
const NEW_PROVIDERS = [
  "vercel", "opencode", "nvidia", "nous", "pollinations", "siliconflow", "modelscope", "llm7"
];

const chatReply = (text) => ({
  id: "c1", object: "chat.completion", created: 0, model: "upstream",
  choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
});

const IMG = { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } };
const textBody = (model) => ({ model, messages: [{ role: "user", content: "hi" }] });
const imageBody = (model) => ({
  model,
  messages: [{ role: "user", content: [{ type: "text", text: "what is this?" }, IMG] }]
});

/** One provider (groq) configured in BOTH pools, with a mock upstream each. */
async function bothPools(t) {
  const text = await startMockUpstream(() => ({ status: 200, body: chatReply("from-text") }));
  const vision = await startMockUpstream(() => ({ status: 200, body: chatReply("from-vision") }));
  const router = await startRouter({
    GROQ_API_KEYS: "sk-text-secret", GROQ_MODELS: "groq-text", GROQ_BASE_URL: text.baseUrl,
    GROQ_VISION_API_KEYS: "sk-vision-secret", GROQ_VISION_MODELS: "groq-vision", GROQ_VISION_BASE_URL: vision.baseUrl
  });
  t.after(async () => { await router.close(); await text.close(); await vision.close(); });
  return { text, vision, router };
}

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------

test("the provider catalog is the single source of truth for all 19 providers", () => {
  assert.equal(PROVIDER_IDS.length, 19);
  // `PROVIDERS` must be the same list, not a second copy that can drift.
  assert.deepEqual(PROVIDERS, [...PROVIDER_IDS]);
  assert.equal(new Set(PROVIDERS).size, PROVIDER_IDS.length);
  for (const id of [...OLD_PROVIDERS, ...NEW_PROVIDERS]) {
    assert.ok(PROVIDERS.includes(id), `${id} is registered`);
  }
});

// ---------------------------------------------------------------------------
// Capability metadata
// ---------------------------------------------------------------------------

test("every provider exposes {id, capabilities:{text,vision}, textModels, visionModels}", () => {
  const caps = describeProviderCapabilities(loadConfig({}));
  assert.deepEqual(Object.keys(caps).sort(), [...PROVIDER_IDS].sort());

  for (const id of PROVIDER_IDS) {
    const entry = caps[id];
    assert.equal(entry.id, id);
    assert.equal(typeof entry.capabilities.text, "boolean");
    assert.equal(typeof entry.capabilities.vision, "boolean");
    assert.ok(Array.isArray(entry.textModels));
    assert.ok(Array.isArray(entry.visionModels));
    // Nothing is configured: capability is derived, never assumed from the name.
    assert.equal(entry.capabilities.text, false, `${id} text`);
    assert.equal(entry.capabilities.vision, false, `${id} vision`);
  }
});

test("capabilities are derived per pool from what is actually configured", () => {
  const config = loadConfig({
    GEMINI_API_KEYS: "gk", GEMINI_MODELS: "gemini-text", GEMINI_BASE_URL: "https://g/v1",
    GEMINI_VISION_API_KEYS: "gvk", GEMINI_VISION_MODELS: "gemini-vision", GEMINI_VISION_BASE_URL: "https://g/v1",
    GROQ_API_KEYS: "qk", GROQ_MODELS: "groq-text", GROQ_BASE_URL: "https://q/v1"
  });
  const caps = describeProviderCapabilities(config);

  assert.deepEqual(caps.gemini.capabilities, { text: true, vision: true });
  assert.deepEqual(caps.gemini.textModels, ["gemini-text"]);
  assert.deepEqual(caps.gemini.visionModels, ["gemini-vision"]);

  // A text-only provider claims text and nothing else.
  assert.deepEqual(caps.groq.capabilities, { text: true, vision: false });
  assert.deepEqual(caps.groq.visionModels, []);
});

// ---------------------------------------------------------------------------
// Model-level capability validation
// ---------------------------------------------------------------------------

const indexFor = (env) => modelPoolIndex(loadConfig(env));

test("a text-only model named on a vision request is rejected", () => {
  const index = indexFor({ GROQ_API_KEYS: "k", GROQ_MODELS: "text-only", GROQ_BASE_URL: "https://q/v1" });
  const rejection = validateModelForPool(index, "text-only", VISION_POOL);
  assert.deepEqual(rejection, {
    model: "text-only",
    required_capability: "vision",
    type: "model_not_vision_capable"
  });
});

test("a vision-only model named on a text request widens instead of being rejected", () => {
  const index = indexFor({
    GROQ_VISION_API_KEYS: "k", GROQ_VISION_MODELS: "vision-only", GROQ_VISION_BASE_URL: "https://q/v1"
  });
  // Not rejected: the vision-only model is simply never selected, and the text
  // pool serves the request as it always has.
  assert.equal(validateModelForPool(index, "vision-only", TEXT_POOL), null);
  assert.equal(modelSupportsPool(index, "vision-only", TEXT_POOL), false);
  assert.equal(modelSupportsPool(index, "vision-only", VISION_POOL), true);
});

test("a model configured for both pools passes validation in both", () => {
  const index = indexFor({
    GROQ_API_KEYS: "k", GROQ_MODELS: "shared", GROQ_BASE_URL: "https://q/v1",
    GROQ_VISION_API_KEYS: "vk", GROQ_VISION_MODELS: "shared", GROQ_VISION_BASE_URL: "https://v/v1"
  });
  assert.equal(validateModelForPool(index, "shared", TEXT_POOL), null);
  assert.equal(validateModelForPool(index, "shared", VISION_POOL), null);
});

test("an unknown or custom model passes validation and keeps widen-to-all working", () => {
  const index = indexFor({ GROQ_API_KEYS: "k", GROQ_MODELS: "known", GROQ_BASE_URL: "https://q/v1" });
  assert.equal(validateModelForPool(index, "brand-new-model", VISION_POOL), null);
  assert.equal(validateModelForPool(index, "", VISION_POOL), null);
  assert.equal(validateModelForPool(index, null, VISION_POOL), null);
});

test("a model listed by an unconfigured provider is not evidence of capability", () => {
  // Models but no keys and no base URL: the provider cannot serve anything, so
  // its model list says nothing about the model's capability.
  const index = indexFor({ GEMINI_MODELS: "orphan" });
  assert.equal(modelSupportsPool(index, "orphan", TEXT_POOL), null);
  assert.equal(validateModelForPool(index, "orphan", VISION_POOL), null);
});

// ---------------------------------------------------------------------------
// Target and health identity
// ---------------------------------------------------------------------------

test("text and vision targets never share an id or a health state", () => {
  const config = loadConfig({
    GROQ_API_KEYS: "tk", GROQ_MODELS: "shared", GROQ_BASE_URL: "https://t/v1",
    GROQ_VISION_API_KEYS: "vk", GROQ_VISION_MODELS: "shared", GROQ_VISION_BASE_URL: "https://v/v1"
  });
  const text = buildTargets(config.providers);
  const vision = buildTargets(config.visionProviders, VISION_POOL);

  assert.equal(text.length, 1);
  assert.equal(vision.length, 1);
  assert.equal(vision[0].pool, "vision");

  const textIds = new Set(text.map(targetId));
  for (const target of vision) {
    assert.ok(!textIds.has(targetId(target)), "vision target id must not collide with a text target");
  }

  // A failure in one pool leaves the other pool's state untouched.
  const registry = new HealthRegistry();
  registry.markFailure(text[0], 500);
  const described = registry.describe([...text, ...vision]);

  const textEntry = described.find((entry) => entry.id === targetId(text[0]));
  const visionEntry = described.find((entry) => entry.id === targetId(vision[0]));
  assert.equal(textEntry.pool, "text");
  assert.equal(visionEntry.pool, "vision");
  assert.equal(textEntry.status, "cooldown");
  assert.notEqual(visionEntry.status, "cooldown");
});

// ---------------------------------------------------------------------------
// Read-only configuration view
// ---------------------------------------------------------------------------

test("the config view reports both pools, capability metadata and blocked cross-pool fallback", () => {
  const config = loadConfig({
    GROQ_API_KEYS: "k", GROQ_MODELS: "groq-text", GROQ_BASE_URL: "https://q/v1",
    MISTRAL_VISION_API_KEYS: "vk", MISTRAL_VISION_MODELS: "mistral-vision", MISTRAL_VISION_BASE_URL: "https://m/v1"
  });
  const targets = [...buildTargets(config.providers), ...buildTargets(config.visionProviders, VISION_POOL)];
  const view = describeConfig(config, targets);

  assert.deepEqual(view.routing.pools, ["text", "vision"]);
  assert.equal(view.routing.crossPoolFallback, "blocked");
  assert.equal(view.capabilities.length, 19);
  assert.equal(view.visionProviders.length, 19);

  const groq = view.capabilities.find((entry) => entry.id === "groq");
  assert.deepEqual(groq.capabilities, { text: true, vision: false });
  assert.deepEqual(groq.capabilities.vision, false);

  assert.equal(view.summary.configuredTargets, 1);
  assert.equal(view.summary.configuredVisionTargets, 1);
  assert.equal(view.summary.textCapableProviders, 1);
  assert.equal(view.summary.visionCapableProviders, 1);
  assert.equal(view.summary.dualCapableProviders, 0);
});

// ---------------------------------------------------------------------------
// Live proxy + read-only API
// ---------------------------------------------------------------------------

test("an image request naming a text-only model is refused before anything is dialled", async (t) => {
  const { text, vision, router } = await bothPools(t);
  const res = await router.request("/v1/chat/completions", postJson(imageBody("groq-text")));

  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.error.type, "model_not_vision_capable");
  assert.equal(body.error.model, "groq-text");
  assert.equal(body.error.required_capability, "vision");
  assert.equal(text.apiRequests.length, 0);
  assert.equal(vision.apiRequests.length, 0);
});

test("each request is served by exactly its own pool", async (t) => {
  const { text, vision, router } = await bothPools(t);

  const textRes = await router.request("/v1/chat/completions", postJson(textBody("groq-text")));
  assert.equal(textRes.status, 200);
  assert.equal(text.apiRequests.at(-1).body.model, "groq-text");

  // A vision-only model named on a text request widens to the text pool.
  const widened = await router.request("/v1/chat/completions", postJson(textBody("groq-vision")));
  assert.equal(widened.status, 200);
  assert.ok(text.apiRequests.every((request) => request.body.model === "groq-text"));
  assert.equal(vision.apiRequests.length, 0);

  // An unknown model on an image request widens to the vision pool.
  const imageRes = await router.request("/v1/chat/completions", postJson(imageBody("brand-new-model")));
  assert.equal(imageRes.status, 200);
  assert.equal(vision.apiRequests.at(-1).body.model, "groq-vision");
});

test("/api/providers and /api/health report the two pools separately, without keys", async (t) => {
  const { router } = await bothPools(t);

  const providers = await (await router.request("/api/providers")).json();
  const textGroq = providers.providers.find((provider) => provider.id === "groq");
  const visionGroq = providers.visionProviders.find((provider) => provider.id === "groq");

  assert.deepEqual(textGroq.capabilities, { text: true, vision: true });
  assert.ok(textGroq.targets.every((target) => (target.pool ?? "text") === "text"));
  assert.ok(visionGroq.targets.every((target) => target.pool === "vision"));
  assert.equal(textGroq.targets.length, 1);
  assert.equal(visionGroq.targets.length, 1);

  const health = await (await router.request("/api/health")).json();
  assert.equal(health.poolSummary.text.total, 1);
  assert.equal(health.poolSummary.vision.total, 1);
  assert.ok(health.ranked.every((row) => row.pool === "text" || row.pool === "vision"));

  // Credentials never cross the wire, in any of these payloads.
  const serialized = JSON.stringify([providers, health]);
  assert.ok(!serialized.includes("sk-text-secret"));
  assert.ok(!serialized.includes("sk-vision-secret"));
});

test("/api/router/preview runs against the requested pool only", async (t) => {
  const { router } = await bothPools(t);

  const vision = await (await router.request("/api/router/preview?protocol=openai-chat&pool=vision")).json();
  assert.equal(vision.pool, "vision");
  assert.equal(vision.poolLabel, "VISION");
  assert.ok(vision.candidates.every((candidate) => candidate.pool === "vision"));
  assert.equal(vision.selected.model, "groq-vision");

  const text = await (await router.request("/api/router/preview?protocol=openai-chat")).json();
  assert.equal(text.pool, "text");
  assert.ok(text.candidates.every((candidate) => candidate.pool === "text"));
  assert.equal(text.selected.model, "groq-text");
});

test("/api/router/preview rejects an unknown pool with the valid values", async (t) => {
  const { router } = await bothPools(t);
  const res = await router.request("/api/router/preview?protocol=openai-chat&pool=sideways");

  assert.equal(res.status, 400);
  const body = await res.json();
  assert.match(body.error.message, /sideways/);
  assert.deepEqual(body.error.details.pools, ["text", "vision"]);
});

test("/api/models tags every row with its pool", async (t) => {
  const { router } = await bothPools(t);
  const models = await (await router.request("/api/models")).json();

  assert.deepEqual(models.filters.pools, ["text", "vision"]);
  assert.ok(models.models.every((model) => model.pool === "text" || model.pool === "vision"));
  assert.equal(models.models.filter((model) => model.pool === "vision").length, 1);
  assert.equal(models.models.filter((model) => model.pool === "text").length, 1);
});

test("the request log carries the pool and can filter by it", async (t) => {
  const { router } = await bothPools(t);

  await router.request("/v1/chat/completions", postJson(textBody("groq-text")));
  await router.request("/v1/chat/completions", postJson(imageBody("groq-vision")));
  await router.request("/v1/chat/completions", postJson(imageBody("groq-text"))); // rejected up front

  const all = await (await router.request("/api/requests")).json();
  const pools = new Set(all.entries.map((entry) => entry.pool));
  assert.ok(pools.has("text"));
  assert.ok(pools.has("vision"));

  const visionOnly = await (await router.request("/api/requests?pool=vision")).json();
  assert.ok(visionOnly.entries.length >= 2);
  assert.ok(visionOnly.entries.every((entry) => entry.pool === "vision"));

  // The rejection is logged with its own type and the pool it was judged against.
  const refused = all.entries.find((entry) => entry.errorType === "model_not_vision_capable");
  assert.ok(refused, "capability rejection appears in the request log");
  assert.equal(refused.pool, "vision");
  assert.equal(refused.requestedModel, "groq-text");
});
