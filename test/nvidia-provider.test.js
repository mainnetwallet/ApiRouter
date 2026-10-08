import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadConfig, buildTargets, VISION_POOL } from "../src/config.js";
import { PROVIDERS } from "../src/providers/catalog.js";
import { providerProtocols, buildUpstreamRequest } from "../src/adapters.js";
import { healthProbePlan } from "../src/health-checks.js";
import { selectPool } from "../src/vision.js";
import { startMockUpstream } from "../test-helpers/mock-upstream.js";
import { startRouter, postJson } from "../test-helpers/router-harness.js";

const BASE = "https://integrate.api.nvidia.com/v1";
const TEXT = ["deepseek-v4.1-flash", "glm-5-3-flash", "glm-5-3", "nemotron-3-super-120b-a12b", "nemotron-3.5-lightning-30b-a3b"];
const VISION = ["deepseek-v4.1-flash", "glm-5-3-flash", "muse-glimmer-30b", "llama-3.2-90b-vision-instruct", "llama-3.2-11b-vision-instruct"];
const env = {
  NVIDIA_API_KEYS: "nk1,nk2,nk3", NVIDIA_BASE_URL: BASE, NVIDIA_MODELS: TEXT.join(","),
  NVIDIA_VISION_API_KEYS: "nv1,nv2", NVIDIA_VISION_BASE_URL: BASE, NVIDIA_VISION_MODELS: VISION.join(",")
};

const chatReply = (text) => ({
  id: "c1", object: "chat.completion", created: 0, model: "upstream",
  choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
});
const ok = (text) => () => ({ status: 200, body: chatReply(text) });
const chat = (model, extra = {}) => ({ model, messages: [{ role: "user", content: "hi" }], ...extra });
const IMG = { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } };
const imageChat = (model) => ({ model, messages: [{ role: "user", content: [{ type: "text", text: "what is this?" }, IMG] }] });

test(".env.example keeps the NVIDIA variables and model order", () => {
  const example = readFileSync(new URL("../.env.example", import.meta.url), "utf8");
  const line = (name, list) => assert.ok(example.split("\n").includes(name + "=" + list.join(",")), name);
  line("NVIDIA_MODELS", TEXT);
  line("NVIDIA_VISION_MODELS", VISION);
  assert.ok(example.split("\n").includes("NVIDIA_BASE_URL=https://integrate.api.nvidia.com/v1"));
  assert.ok(example.split("\n").includes("NVIDIA_VISION_BASE_URL=https://integrate.api.nvidia.com/v1"));
});

test("nvidia is registered and config reads the text and vision variables", () => {
  assert.ok(PROVIDERS.includes("nvidia"));
  const c = loadConfig(env);
  assert.deepEqual(c.providers.nvidia.apiKeys, ["nk1", "nk2", "nk3"]);
  assert.deepEqual(c.providers.nvidia.models, TEXT);
  assert.equal(c.providers.nvidia.baseUrl, BASE);
  assert.deepEqual(c.visionProviders.nvidia.apiKeys, ["nv1", "nv2"]);
  assert.deepEqual(c.visionProviders.nvidia.models, VISION);
  assert.equal(c.visionProviders.nvidia.baseUrl, BASE);
  assert.deepEqual(providerProtocols("nvidia"), ["openai-chat"]);
});

test("targets: keys x models, configured order kept, pools separate", () => {
  const c = loadConfig(env);
  const text = buildTargets(c.providers);
  const vision = buildTargets(c.visionProviders, VISION_POOL);
  assert.equal(text.length, 5 * 3);
  assert.equal(vision.length, 5 * 2);
  assert.deepEqual([...new Set(text.map((x) => x.model))], TEXT);
  assert.deepEqual([...new Set(vision.map((x) => x.model))], VISION);
  assert.ok(text.every((x) => !x.pool && x.apiKey.startsWith("nk")));
  assert.ok(vision.every((x) => x.pool === "vision" && x.apiKey.startsWith("nv")));
});

test("exact model ids and base URL: no duplicate /v1 for chat or health", () => {
  const c = loadConfig(env);
  for (const target of buildTargets(c.providers)) {
    const req = buildUpstreamRequest(target, "openai-chat", { messages: [] });
    assert.equal(req.url, "https://integrate.api.nvidia.com/v1/chat/completions");
    assert.equal(JSON.parse(req.options.body).model, target.model);
  }
  const plan = healthProbePlan(buildTargets(c.providers)[0]);
  assert.equal(plan.url, "https://integrate.api.nvidia.com/v1/models");
  assert.equal(plan.headers.authorization, "Bearer nk1");
});

test("multimodal content is preserved for vision targets", () => {
  const target = buildTargets(loadConfig(env).visionProviders, VISION_POOL)[0];
  const content = [{ type: "text", text: "d" }, IMG, { type: "image_url", image_url: { url: "https://example.test/a.png" } }];
  const req = buildUpstreamRequest(target, "openai-chat", { messages: [{ role: "user", content }] });
  assert.deepEqual(JSON.parse(req.options.body).messages[0].content, content);
});

test("selectPool: text -> text pool, image -> vision pool only, no vision -> no targets", () => {
  const c = loadConfig(env);
  const textTargets = buildTargets(c.providers);
  const visionTargets = buildTargets(c.visionProviders, VISION_POOL);
  const img = { messages: [{ role: "user", content: [IMG] }] };
  const txt = { messages: [{ role: "user", content: "hi" }] };
  assert.ok(selectPool(img, { textTargets, visionTargets }).targets.every((x) => x.pool === "vision"));
  assert.ok(selectPool(txt, { textTargets, visionTargets }).targets.every((x) => !x.pool));
  assert.deepEqual(selectPool(img, { textTargets, visionTargets: [] }).targets, []);
});

async function rig(t, { textScript = ok("from-text"), visionScript = ok("from-vision"), extraEnv = {} } = {}) {
  const text = await startMockUpstream(textScript);
  const vision = await startMockUpstream(visionScript);
  const router = await startRouter({
    NVIDIA_API_KEYS: "nk1,nk2", NVIDIA_BASE_URL: text.baseUrl + "/v1", NVIDIA_MODELS: TEXT.join(","),
    NVIDIA_VISION_API_KEYS: "nv1", NVIDIA_VISION_BASE_URL: vision.baseUrl + "/v1", NVIDIA_VISION_MODELS: VISION.join(","),
    ...extraEnv
  });
  t.after(async () => { await router.close(); await text.close(); await vision.close(); });
  return { text, vision, router };
}

test("text request uses the text pool with the exact model id", async (t) => {
  const { text, vision, router } = await rig(t);
  const res = await router.request("/v1/chat/completions", postJson(chat("glm-5-3")));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("x-multi-ai-provider"), "nvidia");
  assert.equal(text.apiRequests[0].body.model, "glm-5-3");
  assert.equal(text.apiRequests[0].url, "/v1/chat/completions");
  assert.equal(vision.apiRequests.length, 0);
});

test("image request uses only the vision pool and keeps the image parts", async (t) => {
  const { text, vision, router } = await rig(t);
  const res = await router.request("/v1/chat/completions", postJson(imageChat("glm-5-3-flash")));
  assert.equal(res.status, 200);
  assert.equal(text.apiRequests.length, 0);
  assert.equal(vision.apiRequests[0].headers.authorization, "Bearer nv1");
  assert.equal(vision.apiRequests[0].body.model, "glm-5-3-flash");
  assert.deepEqual(vision.apiRequests[0].body.messages[0].content[1], IMG);
});

test("image request with no NVIDIA vision pool => 503 no_vision_route, text models untouched", async (t) => {
  const text = await startMockUpstream(ok("from-text"));
  const router = await startRouter({ NVIDIA_API_KEYS: "nk1", NVIDIA_BASE_URL: text.baseUrl, NVIDIA_MODELS: TEXT.join(",") });
  t.after(async () => { await router.close(); await text.close(); });
  const res = await router.request("/v1/chat/completions", postJson(imageChat("deepseek-v4.1-flash")));
  assert.equal(res.status, 503);
  assert.equal((await res.json()).error.type, "no_vision_route");
  assert.equal(text.apiRequests.length, 0);
});

test("streaming passes through", async (t) => {
  const sse = ['data: {"choices":[{"delta":{"content":"hel"}}]}\n\n', 'data: {"choices":[{"delta":{"content":"lo"}}]}\n\n', "data: [DONE]\n\n"];
  const { router } = await rig(t, { textScript: () => ({ status: 200, headers: { "content-type": "text/event-stream" }, stream: sse }) });
  const res = await router.request("/v1/chat/completions", postJson(chat("deepseek-v4.1-flash", { stream: true })));
  assert.equal(res.status, 200);
  const body = await res.text();
  assert.match(body, /hel/);
  assert.match(body, /DONE/);
});

test("fallback walks the configured models in order after 429, 500 and an unavailable model", async (t) => {
  const failures = {
    "deepseek-v4.1-flash": { status: 429, body: { error: { message: "slow down" } } },
    "glm-5-3-flash": { status: 500, body: { error: { message: "boom" } } },
    "glm-5-3": { status: 404, body: { error: { message: "The model does not exist" } } }
  };
  const { text, router } = await rig(t, {
    textScript: (req) => failures[req.body.model] ?? { status: 200, body: chatReply("from-" + req.body.model) },
    extraEnv: { NVIDIA_API_KEYS: "nk1" }
  });
  const res = await router.request("/v1/chat/completions", postJson(chat("deepseek-v4.1-flash")));
  assert.equal(res.status, 200);
  assert.deepEqual(text.apiRequests.map((r) => r.body.model), TEXT.slice(0, 4));
});

test("a 401 on one key falls back to the next key", async (t) => {
  const { text, router } = await rig(t, {
    textScript: (req) => req.headers.authorization === "Bearer nk1"
      ? { status: 401, body: { error: { message: "bad key" } } }
      : { status: 200, body: chatReply("from-nk2") }
  });
  const res = await router.request("/v1/chat/completions", postJson(chat("deepseek-v4.1-flash")));
  assert.equal(res.status, 200);
  assert.deepEqual(text.apiRequests.map((r) => r.headers.authorization), ["Bearer nk1", "Bearer nk2"]);
  assert.ok(text.apiRequests.every((r) => r.body.model === "deepseek-v4.1-flash"));
});

test("pinning an nvidia key and model uses exactly that, with no fallback", async (t) => {
  const { text, router } = await rig(t);
  const res = await router.request("/v1/chat/completions", postJson(chat("nemotron-3-super-120b-a12b"), {
    "x-multi-ai-pin-provider": "nvidia", "x-multi-ai-pin-key-index": "1"
  }));
  assert.equal(res.status, 200);
  assert.equal(text.apiRequests.length, 1);
  assert.equal(text.apiRequests[0].headers.authorization, "Bearer nk2");
  assert.equal(text.apiRequests[0].body.model, "nemotron-3-super-120b-a12b");
});

test("API keys never appear in /health, /api/providers, /api/config, errors or logs", async (t) => {
  const { router } = await rig(t, { textScript: () => ({ status: 500, body: { error: { message: "upstream failed" } } }) });
  const failed = await router.request("/v1/chat/completions", postJson(chat("deepseek-v4.1-flash")));
  const bodies = [await failed.text()];
  for (const p of ["/health", "/api/providers", "/api/config", "/api/requests"]) {
    const res = await router.request(p);
    bodies.push(await res.text());
  }
  assert.match(bodies[1], /nvidia/);
  bodies.push(router.stdout, router.stderr);
  for (const body of bodies) for (const secret of ["nk1", "nk2", "nv1"]) {
    assert.ok(!body.includes(secret), `${secret} leaked`);
  }
});

for (const status of [502, 503]) {
  test(`a ${status} on one model falls back to the next NVIDIA model`, async (t) => {
    const { text, router } = await rig(t, {
      textScript: (req) => req.body.model === "deepseek-v4.1-flash"
        ? { status, body: { error: { message: "unavailable" } } }
        : { status: 200, body: chatReply("from-" + req.body.model) },
      extraEnv: { NVIDIA_API_KEYS: "nk1" }
    });
    const res = await router.request("/v1/chat/completions", postJson(chat("deepseek-v4.1-flash")));
    assert.equal(res.status, 200);
    assert.deepEqual(text.apiRequests.map((r) => r.body.model), TEXT.slice(0, 2));
  });
}

test("a failing NVIDIA pool falls through to another configured provider", async (t) => {
  const other = await startMockUpstream(ok("from-groq"));
  const { text, router } = await rig(t, {
    textScript: () => ({ status: 500, body: { error: { message: "boom" } } }),
    extraEnv: { NVIDIA_API_KEYS: "nk1", GROQ_API_KEYS: "g1", GROQ_MODELS: "groq-model", GROQ_BASE_URL: other.baseUrl }
  });
  t.after(() => other.close());
  const res = await router.request("/v1/chat/completions", postJson(chat("deepseek-v4.1-flash")));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("x-multi-ai-provider"), "groq");
  assert.ok(text.apiRequests.length >= 1);
  assert.equal(other.apiRequests.length, 1);
});

test("a stream that never answers falls back instead of hanging", async (t) => {
  const { text, router } = await rig(t, {
    textScript: (req) => req.body.model === "deepseek-v4.1-flash"
      ? { hang: true }
      : { status: 200, headers: { "content-type": "text/event-stream" }, stream: ['data: {"choices":[{"delta":{"content":"ok"}}]}\n\n', "data: [DONE]\n\n"] },
    extraEnv: { NVIDIA_API_KEYS: "nk1", STREAM_CONNECT_TIMEOUT_MS: "300" }
  });
  const res = await router.request("/v1/chat/completions", postJson(chat("deepseek-v4.1-flash", { stream: true })));
  assert.equal(res.status, 200);
  assert.match(await res.text(), /ok/);
  assert.equal(text.apiRequests[0].body.model, "deepseek-v4.1-flash");
  assert.equal(text.apiRequests[1].body.model, "glm-5-3-flash");
});

test("the router probes GET {base}/models with the target's key", async (t) => {
  const seen = [];
  const text = await startMockUpstream(ok("x"), { health: (req) => { seen.push(req); return { status: 200, body: { data: [] } }; } });
  const router = await startRouter({ NVIDIA_API_KEYS: "nk1", NVIDIA_BASE_URL: text.baseUrl + "/v1", NVIDIA_MODELS: "deepseek-v4.1-flash" });
  t.after(async () => { await router.close(); await text.close(); });
  await new Promise((r) => setTimeout(r, 300));
  assert.ok(seen.length >= 1, "startup health probe ran");
  assert.equal(seen[0].url, "/v1/models");
  assert.equal(seen[0].headers.authorization, "Bearer nk1");
});
