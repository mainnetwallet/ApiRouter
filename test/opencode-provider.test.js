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

const BASE = "https://opencode.ai/zen/v1";
const TEXT = ["mimo-v2.6-flash-free", "longcat-2.5-preview-free", "nemotron-3-ultra-free", "nemotron-3.5-lightning-free", "big-pickle", "muse-spark-1.3-contributor-free", "ling-3.1-flash-free", "ling-3.0-flash-fin-free", "space-bunny-free", "fledge-alpha-free", "jev-1.13-free"];
const VISION = ["mimo-v2.6-flash-free", "longcat-2.5-preview-free"];
const env = {
  OPENCODE_API_KEYS: "ok1,ok2,ok3", OPENCODE_BASE_URL: BASE, OPENCODE_MODELS: TEXT.join(","),
  OPENCODE_VISION_API_KEYS: "ov1,ov2", OPENCODE_VISION_BASE_URL: BASE, OPENCODE_VISION_MODELS: VISION.join(",")
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

test(".env.example keeps the OpenCode variables and model order", () => {
  const example = readFileSync(new URL("../.env.example", import.meta.url), "utf8");
  assert.match(example, new RegExp("^OPENCODE_MODELS=" + TEXT.join(",").replace(/\./g, "\\.") + "$", "m"));
  assert.match(example, /^OPENCODE_VISION_MODELS=mimo-v2\.6-flash-free,longcat-2\.5-preview-free$/m);
  assert.match(example, /^OPENCODE_BASE_URL=https:\/\/opencode\.ai\/zen\/v1$/m);
  assert.match(example, /^OPENCODE_VISION_BASE_URL=https:\/\/opencode\.ai\/zen\/v1$/m);
});

test("opencode is registered and config reads the text and vision variables", () => {
  assert.ok(PROVIDERS.includes("opencode"));
  const c = loadConfig(env);
  assert.deepEqual(c.providers.opencode.apiKeys, ["ok1", "ok2", "ok3"]);
  assert.deepEqual(c.providers.opencode.models, TEXT);
  assert.equal(c.providers.opencode.baseUrl, BASE);
  assert.deepEqual(c.visionProviders.opencode.apiKeys, ["ov1", "ov2"]);
  assert.deepEqual(c.visionProviders.opencode.models, VISION);
  assert.equal(c.visionProviders.opencode.baseUrl, BASE);
  assert.deepEqual(providerProtocols("opencode"), ["openai-chat"]);
});

test("targets: keys x models, configured order kept, pools separate", () => {
  const c = loadConfig(env);
  const text = buildTargets(c.providers);
  const vision = buildTargets(c.visionProviders, VISION_POOL);
  assert.equal(text.length, 11 * 3);
  assert.equal(vision.length, 2 * 2);
  assert.deepEqual([...new Set(text.map((x) => x.model))], TEXT);
  assert.deepEqual([...new Set(vision.map((x) => x.model))], VISION);
  assert.ok(text.every((x) => !x.pool && x.apiKey.startsWith("ok")));
  assert.ok(vision.every((x) => x.pool === "vision" && x.apiKey.startsWith("ov")));
});

test("exact model ids and base URL: no duplicate /v1 for chat or health", () => {
  const c = loadConfig(env);
  for (const target of buildTargets(c.providers)) {
    const req = buildUpstreamRequest(target, "openai-chat", { messages: [] });
    assert.equal(req.url, "https://opencode.ai/zen/v1/chat/completions");
    assert.equal(JSON.parse(req.options.body).model, target.model);
  }
  const plan = healthProbePlan(buildTargets(c.providers)[0]);
  assert.equal(plan.url, "https://opencode.ai/zen/v1/models");
  assert.equal(plan.headers.authorization, "Bearer ok1");
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
    OPENCODE_API_KEYS: "ok1,ok2", OPENCODE_BASE_URL: text.baseUrl + "/v1", OPENCODE_MODELS: TEXT.join(","),
    OPENCODE_VISION_API_KEYS: "ov1", OPENCODE_VISION_BASE_URL: vision.baseUrl + "/v1", OPENCODE_VISION_MODELS: VISION.join(","),
    ...extraEnv
  });
  t.after(async () => { await router.close(); await text.close(); await vision.close(); });
  return { text, vision, router };
}

test("text request uses the text pool with the exact model id", async (t) => {
  const { text, vision, router } = await rig(t);
  const res = await router.request("/v1/chat/completions", postJson(chat("big-pickle")));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("x-multi-ai-provider"), "opencode");
  assert.equal(text.apiRequests[0].body.model, "big-pickle");
  assert.equal(text.apiRequests[0].url, "/v1/chat/completions");
  assert.equal(vision.apiRequests.length, 0);
});

test("image request uses only the vision pool and keeps the image parts", async (t) => {
  const { text, vision, router } = await rig(t);
  const res = await router.request("/v1/chat/completions", postJson(imageChat("longcat-2.5-preview-free")));
  assert.equal(res.status, 200);
  assert.equal(text.apiRequests.length, 0);
  assert.equal(vision.apiRequests[0].headers.authorization, "Bearer ov1");
  assert.equal(vision.apiRequests[0].body.model, "longcat-2.5-preview-free");
  assert.deepEqual(vision.apiRequests[0].body.messages[0].content[1], IMG);
});

test("image request with no OpenCode vision pool => 503 no_vision_route, text models untouched", async (t) => {
  const text = await startMockUpstream(ok("from-text"));
  const router = await startRouter({ OPENCODE_API_KEYS: "ok1", OPENCODE_BASE_URL: text.baseUrl, OPENCODE_MODELS: TEXT.join(",") });
  t.after(async () => { await router.close(); await text.close(); });
  const res = await router.request("/v1/chat/completions", postJson(imageChat("mimo-v2.6-flash-free")));
  assert.equal(res.status, 503);
  assert.equal((await res.json()).error.type, "no_vision_route");
  assert.equal(text.apiRequests.length, 0);
});

test("streaming passes through", async (t) => {
  const sse = ['data: {"choices":[{"delta":{"content":"hel"}}]}\n\n', 'data: {"choices":[{"delta":{"content":"lo"}}]}\n\n', "data: [DONE]\n\n"];
  const { router } = await rig(t, { textScript: () => ({ status: 200, headers: { "content-type": "text/event-stream" }, stream: sse }) });
  const res = await router.request("/v1/chat/completions", postJson(chat("mimo-v2.6-flash-free", { stream: true })));
  assert.equal(res.status, 200);
  const body = await res.text();
  assert.match(body, /hel/);
  assert.match(body, /DONE/);
});

test("fallback walks the configured models in order after 429, 500 and an unavailable model", async (t) => {
  const failures = {
    "mimo-v2.6-flash-free": { status: 429, body: { error: { message: "slow down" } } },
    "longcat-2.5-preview-free": { status: 500, body: { error: { message: "boom" } } },
    "nemotron-3-ultra-free": { status: 404, body: { error: { message: "The model does not exist" } } }
  };
  const { text, router } = await rig(t, {
    textScript: (req) => failures[req.body.model] ?? { status: 200, body: chatReply("from-" + req.body.model) },
    extraEnv: { OPENCODE_API_KEYS: "ok1" }
  });
  const res = await router.request("/v1/chat/completions", postJson(chat("mimo-v2.6-flash-free")));
  assert.equal(res.status, 200);
  assert.deepEqual(text.apiRequests.map((r) => r.body.model), TEXT.slice(0, 4));
});

test("a 401 on one key falls back to the next key", async (t) => {
  const { text, router } = await rig(t, {
    textScript: (req) => req.headers.authorization === "Bearer ok1"
      ? { status: 401, body: { error: { message: "bad key" } } }
      : { status: 200, body: chatReply("from-ok2") }
  });
  const res = await router.request("/v1/chat/completions", postJson(chat("mimo-v2.6-flash-free")));
  assert.equal(res.status, 200);
  assert.deepEqual(text.apiRequests.map((r) => r.headers.authorization), ["Bearer ok1", "Bearer ok2"]);
  assert.ok(text.apiRequests.every((r) => r.body.model === "mimo-v2.6-flash-free"));
});

test("pinning an opencode key and model uses exactly that, with no fallback", async (t) => {
  const { text, router } = await rig(t);
  const res = await router.request("/v1/chat/completions", postJson(chat("ling-3.1-flash-free"), {
    "x-multi-ai-pin-provider": "opencode", "x-multi-ai-pin-key-index": "1"
  }));
  assert.equal(res.status, 200);
  assert.equal(text.apiRequests.length, 1);
  assert.equal(text.apiRequests[0].headers.authorization, "Bearer ok2");
  assert.equal(text.apiRequests[0].body.model, "ling-3.1-flash-free");
});

test("API keys never appear in /health, /api/providers, /api/config, errors or logs", async (t) => {
  const { router } = await rig(t, { textScript: () => ({ status: 500, body: { error: { message: "upstream failed" } } }) });
  const failed = await router.request("/v1/chat/completions", postJson(chat("mimo-v2.6-flash-free")));
  const bodies = [await failed.text()];
  for (const p of ["/health", "/api/providers", "/api/config", "/api/requests"]) {
    const res = await router.request(p);
    bodies.push(await res.text());
  }
  assert.match(bodies[1], /opencode/);
  bodies.push(router.stdout, router.stderr);
  for (const body of bodies) for (const secret of ["ok1", "ok2", "ov1"]) {
    assert.ok(!body.includes(secret), `${secret} leaked`);
  }
});
