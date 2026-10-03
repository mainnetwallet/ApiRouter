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

const BASE = "https://gen.pollinations.ai/v1";
// Model ids here are test fixtures, not a claim about what Pollinations serves or charges for.
const TEXT = ["kimi", "deepseek", "glm", "community/someone/some-model-free", "claude-fast"];
const VISION = ["kimi", "claude-fast", "community/someone/some-vision-free"];
const env = {
  POLLINATIONS_API_KEYS: "pk1,pk2,pk3", POLLINATIONS_BASE_URL: BASE, POLLINATIONS_MODELS: TEXT.join(","),
  POLLINATIONS_VISION_API_KEYS: "pv1,pv2", POLLINATIONS_VISION_BASE_URL: BASE, POLLINATIONS_VISION_MODELS: VISION.join(",")
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

test(".env.example defines each Pollinations variable exactly once, as real lines", () => {
  const example = readFileSync(new URL("../.env.example", import.meta.url), "utf8");
  assert.ok(!/POLLINATIONS_[A-Z_]*=[^\n]*\\n/.test(example) && !example.includes("\\nPOLLINATIONS_"), "no literal backslash-n text");
  const lines = example.split("\n");
  for (const name of ["API_KEYS", "MODELS", "BASE_URL", "VISION_API_KEYS", "VISION_MODELS", "VISION_BASE_URL"]) {
    assert.equal(lines.filter((l) => l.startsWith("POLLINATIONS_" + name + "=")).length, 1, name);
  }
  assert.ok(lines.includes("POLLINATIONS_BASE_URL=https://gen.pollinations.ai/v1"));
  assert.ok(lines.includes("POLLINATIONS_VISION_BASE_URL=https://gen.pollinations.ai/v1"));
  // The shipped example must actually produce a vision pool when keys are supplied.
  const values = Object.fromEntries(lines.filter((l) => /^POLLINATIONS_\w+=/.test(l)).map((l) => [l.split("=")[0], l.slice(l.indexOf("=") + 1)]));
  const c = loadConfig({ ...values, POLLINATIONS_API_KEYS: "a", POLLINATIONS_VISION_API_KEYS: "b" });
  assert.ok(c.providers.pollinations.models.length > 0);
  assert.ok(c.visionProviders.pollinations.models.length > 0);
  assert.equal(c.visionProviders.pollinations.baseUrl, "https://gen.pollinations.ai/v1");
});

test("pollinations is registered and config reads the text and vision variables", () => {
  assert.ok(PROVIDERS.includes("pollinations"));
  const c = loadConfig(env);
  assert.deepEqual(c.providers.pollinations.apiKeys, ["pk1", "pk2", "pk3"]);
  assert.deepEqual(c.providers.pollinations.models, TEXT);
  assert.equal(c.providers.pollinations.baseUrl, BASE);
  assert.deepEqual(c.visionProviders.pollinations.apiKeys, ["pv1", "pv2"]);
  assert.deepEqual(c.visionProviders.pollinations.models, VISION);
  assert.equal(c.visionProviders.pollinations.baseUrl, BASE);
  assert.deepEqual(providerProtocols("pollinations"), ["openai-chat"]);
});

test("targets: keys x models, configured order kept, pools separate", () => {
  const c = loadConfig(env);
  const text = buildTargets(c.providers);
  const vision = buildTargets(c.visionProviders, VISION_POOL);
  assert.equal(text.length, 5 * 3);
  assert.equal(vision.length, 3 * 2);
  assert.deepEqual([...new Set(text.map((x) => x.model))], TEXT);
  assert.deepEqual([...new Set(vision.map((x) => x.model))], VISION);
  assert.ok(text.every((x) => !x.pool && x.apiKey.startsWith("pk")));
  assert.ok(vision.every((x) => x.pool === "vision" && x.apiKey.startsWith("pv")));
});

test("exact model ids and base URL: no duplicate /v1 for chat or health", () => {
  const c = loadConfig(env);
  for (const target of buildTargets(c.providers)) {
    const req = buildUpstreamRequest(target, "openai-chat", { messages: [] });
    assert.equal(req.url, "https://gen.pollinations.ai/v1/chat/completions");
    assert.equal(JSON.parse(req.options.body).model, target.model);
  }
  const plan = healthProbePlan(buildTargets(c.providers)[0]);
  assert.equal(plan.url, "https://gen.pollinations.ai/v1/models");
  assert.equal(plan.headers.authorization, "Bearer pk1");
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
    POLLINATIONS_API_KEYS: "pk1,pk2", POLLINATIONS_BASE_URL: text.baseUrl + "/v1", POLLINATIONS_MODELS: TEXT.join(","),
    POLLINATIONS_VISION_API_KEYS: "pv1", POLLINATIONS_VISION_BASE_URL: vision.baseUrl + "/v1", POLLINATIONS_VISION_MODELS: VISION.join(","),
    ...extraEnv
  });
  t.after(async () => { await router.close(); await text.close(); await vision.close(); });
  return { text, vision, router };
}

test("text request uses the text pool with the exact model id", async (t) => {
  const { text, vision, router } = await rig(t);
  const res = await router.request("/v1/chat/completions", postJson(chat("glm")));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("x-multi-ai-provider"), "pollinations");
  assert.equal(text.apiRequests[0].body.model, "glm");
  assert.equal(text.apiRequests[0].url, "/v1/chat/completions");
  assert.equal(vision.apiRequests.length, 0);
});

test("image request uses only the vision pool and keeps the image parts", async (t) => {
  const { text, vision, router } = await rig(t);
  const res = await router.request("/v1/chat/completions", postJson(imageChat("community/someone/some-vision-free")));
  assert.equal(res.status, 200);
  assert.equal(text.apiRequests.length, 0);
  assert.equal(vision.apiRequests[0].headers.authorization, "Bearer pv1");
  assert.equal(vision.apiRequests[0].body.model, "community/someone/some-vision-free");
  assert.deepEqual(vision.apiRequests[0].body.messages[0].content[1], IMG);
});

test("image request with no POLLINATIONS vision pool => 503 no_vision_route, text models untouched", async (t) => {
  const text = await startMockUpstream(ok("from-text"));
  const router = await startRouter({ POLLINATIONS_API_KEYS: "pk1", POLLINATIONS_BASE_URL: text.baseUrl, POLLINATIONS_MODELS: TEXT.join(",") });
  t.after(async () => { await router.close(); await text.close(); });
  const res = await router.request("/v1/chat/completions", postJson(imageChat("kimi")));
  assert.equal(res.status, 503);
  assert.equal((await res.json()).error.type, "no_vision_route");
  assert.equal(text.apiRequests.length, 0);
});

test("streaming passes through", async (t) => {
  const sse = ['data: {"choices":[{"delta":{"content":"hel"}}]}\n\n', 'data: {"choices":[{"delta":{"content":"lo"}}]}\n\n', "data: [DONE]\n\n"];
  const { router } = await rig(t, { textScript: () => ({ status: 200, headers: { "content-type": "text/event-stream" }, stream: sse }) });
  const res = await router.request("/v1/chat/completions", postJson(chat("kimi", { stream: true })));
  assert.equal(res.status, 200);
  const body = await res.text();
  assert.match(body, /hel/);
  assert.match(body, /DONE/);
});

test("fallback walks the configured models in order after 429, 500 and an unavailable model", async (t) => {
  const failures = {
    "kimi": { status: 429, body: { error: { message: "slow down" } } },
    "deepseek": { status: 500, body: { error: { message: "boom" } } },
    "glm": { status: 404, body: { error: { message: "The model does not exist" } } }
  };
  const { text, router } = await rig(t, {
    textScript: (req) => failures[req.body.model] ?? { status: 200, body: chatReply("from-" + req.body.model) },
    extraEnv: { POLLINATIONS_API_KEYS: "pk1" }
  });
  const res = await router.request("/v1/chat/completions", postJson(chat("kimi")));
  assert.equal(res.status, 200);
  assert.deepEqual(text.apiRequests.map((r) => r.body.model), TEXT.slice(0, 4));
});

test("a 401 on one key falls back to the next key", async (t) => {
  const { text, router } = await rig(t, {
    textScript: (req) => req.headers.authorization === "Bearer pk1"
      ? { status: 401, body: { error: { message: "bad key" } } }
      : { status: 200, body: chatReply("from-pk2") }
  });
  const res = await router.request("/v1/chat/completions", postJson(chat("kimi")));
  assert.equal(res.status, 200);
  assert.deepEqual(text.apiRequests.map((r) => r.headers.authorization), ["Bearer pk1", "Bearer pk2"]);
  assert.ok(text.apiRequests.every((r) => r.body.model === "kimi"));
});

test("pinning an pollinations key and model uses exactly that, with no fallback", async (t) => {
  const { text, router } = await rig(t);
  const res = await router.request("/v1/chat/completions", postJson(chat("claude-fast"), {
    "x-multi-ai-pin-provider": "pollinations", "x-multi-ai-pin-key-index": "1"
  }));
  assert.equal(res.status, 200);
  assert.equal(text.apiRequests.length, 1);
  assert.equal(text.apiRequests[0].headers.authorization, "Bearer pk2");
  assert.equal(text.apiRequests[0].body.model, "claude-fast");
});

test("API keys never appear in /health, /api/providers, /api/config, errors or logs", async (t) => {
  const { router } = await rig(t, { textScript: () => ({ status: 500, body: { error: { message: "upstream failed" } } }) });
  const failed = await router.request("/v1/chat/completions", postJson(chat("kimi")));
  const bodies = [await failed.text()];
  for (const p of ["/health", "/api/providers", "/api/config", "/api/requests"]) {
    const res = await router.request(p);
    bodies.push(await res.text());
  }
  assert.match(bodies[1], /pollinations/);
  bodies.push(router.stdout, router.stderr);
  for (const body of bodies) for (const secret of ["pk1", "pk2", "pv1"]) {
    assert.ok(!body.includes(secret), `${secret} leaked`);
  }
});

for (const status of [502, 503]) {
  test(`a ${status} on one model falls back to the next POLLINATIONS model`, async (t) => {
    const { text, router } = await rig(t, {
      textScript: (req) => req.body.model === "kimi"
        ? { status, body: { error: { message: "unavailable" } } }
        : { status: 200, body: chatReply("from-" + req.body.model) },
      extraEnv: { POLLINATIONS_API_KEYS: "pk1" }
    });
    const res = await router.request("/v1/chat/completions", postJson(chat("kimi")));
    assert.equal(res.status, 200);
    assert.deepEqual(text.apiRequests.map((r) => r.body.model), TEXT.slice(0, 2));
  });
}

test("a failing POLLINATIONS pool falls through to another configured provider", async (t) => {
  const other = await startMockUpstream(ok("from-groq"));
  const { text, router } = await rig(t, {
    textScript: () => ({ status: 500, body: { error: { message: "boom" } } }),
    extraEnv: { POLLINATIONS_API_KEYS: "pk1", GROQ_API_KEYS: "g1", GROQ_MODELS: "groq-model", GROQ_BASE_URL: other.baseUrl }
  });
  t.after(() => other.close());
  const res = await router.request("/v1/chat/completions", postJson(chat("kimi")));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("x-multi-ai-provider"), "groq");
  assert.ok(text.apiRequests.length >= 1);
  assert.equal(other.apiRequests.length, 1);
});

test("a stream that never answers falls back instead of hanging", async (t) => {
  const { text, router } = await rig(t, {
    textScript: (req) => req.body.model === "kimi"
      ? { hang: true }
      : { status: 200, headers: { "content-type": "text/event-stream" }, stream: ['data: {"choices":[{"delta":{"content":"ok"}}]}\n\n', "data: [DONE]\n\n"] },
    extraEnv: { POLLINATIONS_API_KEYS: "pk1", STREAM_CONNECT_TIMEOUT_MS: "300" }
  });
  const res = await router.request("/v1/chat/completions", postJson(chat("kimi", { stream: true })));
  assert.equal(res.status, 200);
  assert.match(await res.text(), /ok/);
  assert.equal(text.apiRequests[0].body.model, "kimi");
  assert.equal(text.apiRequests[1].body.model, "deepseek");
});

test("the router probes GET {base}/models with the target's key", async (t) => {
  const seen = [];
  const text = await startMockUpstream(ok("x"), { health: (req) => { seen.push(req); return { status: 200, body: { data: [] } }; } });
  const router = await startRouter({ POLLINATIONS_API_KEYS: "pk1", POLLINATIONS_BASE_URL: text.baseUrl + "/v1", POLLINATIONS_MODELS: "kimi" });
  t.after(async () => { await router.close(); await text.close(); });
  await new Promise((r) => setTimeout(r, 300));
  assert.ok(seen.length >= 1, "startup health probe ran");
  assert.equal(seen[0].url, "/v1/models");
  assert.equal(seen[0].headers.authorization, "Bearer pk1");
});

test("a text-only model id is never sent for an image request", async (t) => {
  const { text, vision, router } = await rig(t);
  // "deepseek" exists only in the text pool; the image must still go to a vision target.
  const res = await router.request("/v1/chat/completions", postJson(imageChat("deepseek")));
  assert.equal(res.status, 200);
  assert.equal(text.apiRequests.length, 0);
  assert.ok(vision.apiRequests.length >= 1);
  assert.ok(vision.apiRequests.every((r) => VISION.includes(r.body.model)));
});

test("pinning pollinations and a vision key serves an image from exactly that vision target", async (t) => {
  const { text, vision, router } = await rig(t, { extraEnv: { POLLINATIONS_VISION_API_KEYS: "pv1,pv2" } });
  const res = await router.request("/v1/chat/completions", postJson(imageChat("kimi"), {
    "x-multi-ai-pin-provider": "pollinations", "x-multi-ai-pin-key-index": "1"
  }));
  assert.equal(res.status, 200);
  assert.equal(text.apiRequests.length, 0);
  assert.equal(vision.apiRequests.length, 1);
  assert.equal(vision.apiRequests[0].headers.authorization, "Bearer pv2");
  assert.equal(vision.apiRequests[0].body.model, "kimi");
});

test("vision streaming passes through the vision pool", async (t) => {
  const sse = ['data: {"choices":[{"delta":{"content":"a cat"}}]}\n\n', "data: [DONE]\n\n"];
  const { text, router } = await rig(t, { visionScript: () => ({ status: 200, headers: { "content-type": "text/event-stream" }, stream: sse }) });
  const res = await router.request("/v1/chat/completions", postJson({ ...imageChat("kimi"), stream: true }));
  assert.equal(res.status, 200);
  assert.match(await res.text(), /a cat/);
  assert.equal(text.apiRequests.length, 0);
});

test("a multi-turn conversation that already contains an image stays in the vision pool", async (t) => {
  const { text, vision, router } = await rig(t);
  const res = await router.request("/v1/chat/completions", postJson({
    model: "kimi",
    messages: [
      { role: "user", content: [{ type: "text", text: "what is this?" }, IMG] },
      { role: "assistant", content: "a cat" },
      { role: "user", content: "and now?" }
    ]
  }));
  assert.equal(res.status, 200);
  assert.equal(text.apiRequests.length, 0);
  assert.equal(vision.apiRequests.length, 1);
});
