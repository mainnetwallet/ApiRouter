import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig, buildTargets, VISION_POOL } from "../src/config.js";
import { PROVIDERS } from "../src/providers/catalog.js";
import { providerProtocols, buildUpstreamRequest } from "../src/adapters.js";
import { healthProbePlan } from "../src/health-checks.js";
import { selectPool } from "../src/vision.js";
import { startMockUpstream } from "../test-helpers/mock-upstream.js";
import { startRouter, postJson } from "../test-helpers/router-harness.js";

const BASE = "https://ai-gateway.vercel.sh/v1";
const TEXT_MODELS = "minimax/minimax-m3-free,inclusionai/ling-3.1-flash-free,poolside/laguna-s-2.1-free";
const VISION_MODELS = "minimax/minimax-m3-free,inclusionai/ling-3.0-flash-vl-free";

const env = {
  VERCEL_API_KEYS: "tk1,tk2,tk3", VERCEL_BASE_URL: BASE, VERCEL_MODELS: TEXT_MODELS,
  VERCEL_VISION_API_KEYS: "vk1,vk2", VERCEL_VISION_BASE_URL: BASE, VERCEL_VISION_MODELS: VISION_MODELS
};

const chatReply = (text) => ({
  id: "c1", object: "chat.completion", created: 0, model: "upstream",
  choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
});
const ok = (text) => () => ({ status: 200, body: chatReply(text) });
const fail = (status) => () => ({ status, body: { error: { message: "nope" } } });

test("vercel is registered in the provider catalog and config", () => {
  assert.ok(PROVIDERS.includes("vercel"));
  const config = loadConfig(env);
  assert.ok("vercel" in config.providers);
  assert.ok("vercel" in config.visionProviders);
  assert.equal(config.providers.vercel.baseUrl, BASE);
  assert.equal(config.providers.vercel.apiKeys.length, 3);
  assert.equal(config.visionProviders.vercel.apiKeys.length, 2);
});

test("vercel uses the OpenAI-compatible protocol", () => {
  assert.deepEqual(providerProtocols("vercel"), ["openai-chat"]);
});

test("each key and model becomes a target; vision pool is separate", () => {
  const config = loadConfig(env);
  const text = buildTargets(config.providers);
  const vision = buildTargets(config.visionProviders, VISION_POOL);
  assert.equal(text.length, 3 * 3);
  assert.equal(vision.length, 2 * 2);
  assert.ok(text.every((x) => x.provider === "vercel" && !x.pool && x.baseUrl === BASE));
  assert.ok(vision.every((x) => x.pool === "vision" && x.id.startsWith("vision:vercel:")));
  assert.deepEqual([...new Set(text.map((x) => x.apiKey))].sort(), ["tk1", "tk2", "tk3"]);
  assert.deepEqual([...new Set(vision.map((x) => x.apiKey))].sort(), ["vk1", "vk2"]);
  // Text keys never leak into the vision pool, or the reverse.
  assert.ok(!vision.some((x) => x.apiKey.startsWith("tk")));
  assert.ok(!text.some((x) => x.apiKey.startsWith("vk")));
});

test("a vision pool without keys or models creates no vision targets", () => {
  const config = loadConfig({ ...env, VERCEL_VISION_API_KEYS: "" });
  assert.equal(buildTargets(config.visionProviders, VISION_POOL).length, 0);
  assert.equal(buildTargets(config.providers).length, 9);
});

test("model ids are sent upstream exactly as configured", () => {
  const config = loadConfig(env);
  for (const target of buildTargets(config.providers)) {
    const req = buildUpstreamRequest(target, "openai-chat", { messages: [] });
    assert.equal(req.url, BASE + "/chat/completions");
    assert.equal(JSON.parse(req.options.body).model, target.model);
    assert.equal(req.options.headers.authorization, "Bearer " + target.apiKey);
  }
  assert.ok(buildTargets(config.providers).some((x) => x.model === "inclusionai/ling-3.1-flash-free"));
});

test("multimodal content parts pass through untouched", () => {
  const target = buildTargets(loadConfig(env).visionProviders, VISION_POOL)[0];
  const content = [
    { type: "text", text: "describe" },
    { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
    { type: "image_url", image_url: { url: "https://example.test/a.png" } }
  ];
  const req = buildUpstreamRequest(target, "openai-chat", { messages: [{ role: "user", content }] });
  assert.deepEqual(JSON.parse(req.options.body).messages[0].content, content);
});

test("selectPool keeps text and image requests in their own pools", () => {
  const config = loadConfig(env);
  const textTargets = buildTargets(config.providers);
  const visionTargets = buildTargets(config.visionProviders, VISION_POOL);
  const image = { messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "data:image/png;base64,AA" } }] }] };
  const plain = { messages: [{ role: "user", content: "hi" }] };
  assert.equal(selectPool(image, { textTargets, visionTargets }).pool, "vision");
  assert.equal(selectPool(plain, { textTargets, visionTargets }).pool, "text");
  assert.ok(selectPool(image, { textTargets, visionTargets }).targets.every((x) => x.pool === "vision"));
  assert.ok(selectPool(plain, { textTargets, visionTargets }).targets.every((x) => !x.pool));
});

test("health probe uses the Vercel base URL and the target's own key", () => {
  const target = buildTargets(loadConfig(env).providers)[1];
  const plan = healthProbePlan(target);
  assert.equal(plan.url, BASE + "/models");
  assert.equal(plan.headers.authorization, "Bearer " + target.apiKey);
});

async function rig(t, { textScript = ok("from-vercel"), visionScript = ok("from-vision"), fallbackScript = ok("from-fallback") } = {}) {
  const text = await startMockUpstream(textScript);
  const vision = await startMockUpstream(visionScript);
  const other = await startMockUpstream(fallbackScript);
  const router = await startRouter({
    VERCEL_API_KEYS: "tk1,tk2", VERCEL_BASE_URL: text.baseUrl, VERCEL_MODELS: "minimax/minimax-m3-free,poolside/laguna-s-2.1-free",
    VERCEL_VISION_API_KEYS: "vk1", VERCEL_VISION_BASE_URL: vision.baseUrl, VERCEL_VISION_MODELS: "inclusionai/ling-3.0-flash-vl-free",
    GROQ_API_KEYS: "gk", GROQ_MODELS: "groq-model", GROQ_BASE_URL: other.baseUrl
  });
  t.after(async () => { await router.close(); await text.close(); await vision.close(); await other.close(); });
  return { text, vision, other, router };
}

const chat = (model, extra = {}) => ({ model, messages: [{ role: "user", content: "hi" }], ...extra });
const imageChat = (model) => ({
  model,
  messages: [{ role: "user", content: [
    { type: "text", text: "what is this?" },
    { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }
  ] }]
});

test("text request reaches Vercel with the exact model id and never the vision pool", async (t) => {
  const { text, vision, router } = await rig(t);
  const res = await router.request("/v1/chat/completions", postJson(chat("poolside/laguna-s-2.1-free")));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("x-multi-ai-provider"), "vercel");
  assert.equal(text.apiRequests.length, 1);
  assert.equal(text.apiRequests[0].body.model, "poolside/laguna-s-2.1-free");
  assert.equal(vision.apiRequests.length, 0);
});

test("image request reaches only the Vercel vision pool", async (t) => {
  const { text, vision, router } = await rig(t);
  const res = await router.request("/v1/chat/completions", postJson(imageChat("inclusionai/ling-3.0-flash-vl-free")));
  assert.equal(res.status, 200);
  assert.equal(vision.apiRequests.length, 1);
  assert.equal(vision.apiRequests[0].headers.authorization, "Bearer vk1");
  assert.equal(vision.apiRequests[0].body.model, "inclusionai/ling-3.0-flash-vl-free");
  assert.deepEqual(vision.apiRequests[0].body.messages[0].content[1], { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } });
  assert.equal(text.apiRequests.length, 0);
});

test("streaming passes through the Vercel target", async (t) => {
  const sse = ['data: {"choices":[{"delta":{"content":"hel"}}]}\n\n', 'data: {"choices":[{"delta":{"content":"lo"}}]}\n\n', "data: [DONE]\n\n"];
  const { router } = await rig(t, { textScript: () => ({ status: 200, headers: { "content-type": "text/event-stream" }, stream: sse }) });
  const res = await router.request("/v1/chat/completions", postJson(chat("poolside/laguna-s-2.1-free", { stream: true })));
  assert.equal(res.status, 200);
  const body = await res.text();
  assert.match(body, /hel/);
  assert.match(body, /DONE/);
});

for (const status of [429, 500]) {
  test(`Vercel ${status} falls back to another provider`, async (t) => {
    const { text, other, router } = await rig(t, { textScript: fail(status) });
    const res = await router.request("/v1/chat/completions", postJson(chat("minimax/minimax-m3-free")));
    assert.equal(res.status, 200);
    assert.ok(text.apiRequests.length >= 1, "Vercel is tried first for its own model");
    assert.equal(other.apiRequests.length, 1);
  });
}

test("an unavailable Vercel model moves on to the next target", async (t) => {
  const { text, other, router } = await rig(t, {
    textScript: () => ({ status: 404, body: { error: { message: "The model `x` does not exist" } } })
  });
  const res = await router.request("/v1/chat/completions", postJson(chat("minimax/minimax-m3-free")));
  assert.equal(res.status, 200);
  assert.ok(text.apiRequests.length >= 1, "Vercel is tried first for its own model");
  assert.equal(other.apiRequests.length, 1);
});

test("pinning vercel and a key index uses exactly that key and never falls back", async (t) => {
  const { text, other, router } = await rig(t);
  const res = await router.request("/v1/chat/completions", postJson(chat("minimax/minimax-m3-free"), {
    "x-multi-ai-pin-provider": "vercel", "x-multi-ai-pin-key-index": "1"
  }));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("x-multi-ai-key-index"), "1");
  assert.equal(text.apiRequests[0].headers.authorization, "Bearer tk2");
  assert.equal(other.apiRequests.length, 0);
});

test("health, providers and config views list Vercel text and vision targets without leaking keys", async (t) => {
  const { router } = await rig(t);
  const [health, providers, config] = await Promise.all(
    ["/health", "/api/providers", "/api/config"].map(async (p) => (await router.request(p)).text())
  );
  assert.match(health, /vercel/);
  assert.match(providers, /vercel/);
  assert.match(providers, /vision/);
  for (const body of [health, providers, config]) {
    for (const secret of ["tk1", "tk2", "vk1"]) assert.ok(!body.includes(`"${secret}"`) && !body.includes(`Bearer ${secret}`), `${secret} leaked`);
  }
});
