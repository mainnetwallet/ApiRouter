import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadConfig, buildTargets, VISION_POOL } from "../src/config.js";
import { PROVIDERS } from "../src/providers/catalog.js";
import { providerProtocols, buildUpstreamRequest } from "../src/adapters.js";
import { healthProbePlan, probeTargetHealth, classifyProbeStatus } from "../src/health-checks.js";
import { selectPool } from "../src/vision.js";
import { startMockUpstream } from "../test-helpers/mock-upstream.js";
import { startRouter, postJson } from "../test-helpers/router-harness.js";

const BASE = "https://api.siliconflow.cn/v1";
const TEXT = ["XingChenAGI/Xing4.0-29B", "Qwen/Qwen3.5-4B", "THUDM/GLM-4-9B-0414", "tencent/Hunyuan-MT-7B"];
const VISION = ["Qwen/Qwen3.5-4B", "PaddlePaddle/PaddleOCR-VL-1.5"];
const env = {
  SILICONFLOW_API_KEYS: "sk1,sk2,sk3", SILICONFLOW_BASE_URL: BASE, SILICONFLOW_MODELS: TEXT.join(","),
  SILICONFLOW_VISION_API_KEYS: "sv1,sv2", SILICONFLOW_VISION_BASE_URL: BASE, SILICONFLOW_VISION_MODELS: VISION.join(",")
};

const chatReply = (text) => ({
  id: "c1", object: "chat.completion", created: 0, model: "upstream",
  choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
});
const ok = (text) => () => ({ status: 200, body: chatReply(text) });
const chat = (model, extra = {}) => ({ model, messages: [{ role: "user", content: "hi" }], ...extra });
const IMG = { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } };
const IMG_URL = { type: "image_url", image_url: { url: "https://example.test/a.png" } };
const imageChat = (model, parts = [IMG]) => ({ model, messages: [{ role: "user", content: [{ type: "text", text: "what is this?" }, ...parts] }] });
const sseStream = (...texts) => [
  ...texts.map((t) => `data: ${JSON.stringify({ choices: [{ delta: { content: t } }] })}\n\n`),
  `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 } })}\n\n`,
  "data: [DONE]\n\n"
];

// --------------------------------------------------------------------------- provider / config

test(".env.example defines each SiliconFlow variable once and yields both pools", () => {
  const example = readFileSync(new URL("../.env.example", import.meta.url), "utf8");
  const lines = example.split("\n");
  for (const name of ["API_KEYS", "MODELS", "BASE_URL", "VISION_API_KEYS", "VISION_MODELS", "VISION_BASE_URL"]) {
    assert.equal(lines.filter((l) => l.startsWith("SILICONFLOW_" + name + "=")).length, 1, name);
  }
  const values = Object.fromEntries(lines.filter((l) => /^SILICONFLOW_\w+=/.test(l)).map((l) => [l.split("=")[0], l.slice(l.indexOf("=") + 1)]));
  const c = loadConfig({ ...values, SILICONFLOW_API_KEYS: "a", SILICONFLOW_VISION_API_KEYS: "b" });
  assert.deepEqual([...c.providers.siliconflow.models].sort(), [...TEXT].sort());
  assert.deepEqual(c.visionProviders.siliconflow.models, VISION);
  assert.equal(c.providers.siliconflow.baseUrl, BASE);
  assert.equal(c.visionProviders.siliconflow.baseUrl, BASE);
});

test(".env stays git-ignored", () => {
  const ignore = readFileSync(new URL("../.gitignore", import.meta.url), "utf8").split("\n").map((l) => l.trim());
  assert.ok(ignore.includes(".env"));
});

test("siliconflow is registered once and config reads the text and vision variables", () => {
  assert.equal(PROVIDERS.filter((p) => p === "siliconflow").length, 1);
  const c = loadConfig(env);
  assert.deepEqual(c.providers.siliconflow.apiKeys, ["sk1", "sk2", "sk3"]);
  assert.deepEqual(c.providers.siliconflow.models, TEXT);
  assert.equal(c.providers.siliconflow.baseUrl, BASE);
  assert.deepEqual(c.visionProviders.siliconflow.apiKeys, ["sv1", "sv2"]);
  assert.deepEqual(c.visionProviders.siliconflow.models, VISION);
  assert.equal(c.visionProviders.siliconflow.baseUrl, BASE);
  assert.deepEqual(providerProtocols("siliconflow"), ["openai-chat"]);
});

test("key and model parsing trims whitespace and drops empty entries", () => {
  const c = loadConfig({ SILICONFLOW_API_KEYS: " a , ,b,", SILICONFLOW_MODELS: " m1 ,, m2 ", SILICONFLOW_BASE_URL: BASE });
  assert.deepEqual(c.providers.siliconflow.apiKeys, ["a", "b"]);
  assert.deepEqual(c.providers.siliconflow.models, ["m1", "m2"]);
});

test("an unconfigured SiliconFlow yields no targets in either pool", () => {
  const c = loadConfig({});
  assert.equal(buildTargets(c.providers).filter((x) => x.provider === "siliconflow").length, 0);
  assert.equal(buildTargets(c.visionProviders, VISION_POOL).filter((x) => x.provider === "siliconflow").length, 0);
});

test("targets: keys x models in configured order, pools and keys separate", () => {
  const c = loadConfig(env);
  const text = buildTargets(c.providers);
  const vision = buildTargets(c.visionProviders, VISION_POOL);
  assert.equal(text.length, 4 * 3);
  assert.equal(vision.length, 2 * 2);
  assert.deepEqual([...new Set(text.map((x) => x.model))], TEXT);
  assert.deepEqual([...new Set(vision.map((x) => x.model))], VISION);
  assert.ok(text.every((x) => !x.pool && x.apiKey.startsWith("sk")));
  assert.ok(vision.every((x) => x.pool === VISION_POOL && x.apiKey.startsWith("sv")));
  // Only the vision pool holds the PaddleOCR model; text-only models never appear in it.
  assert.ok(!text.some((x) => x.model === "PaddlePaddle/PaddleOCR-VL-1.5"));
  for (const m of ["XingChenAGI/Xing4.0-29B", "THUDM/GLM-4-9B-0414", "tencent/Hunyuan-MT-7B"]) {
    assert.ok(!vision.some((x) => x.model === m), m + " must not be a vision target");
  }
  assert.ok(vision.some((x) => x.model === "Qwen/Qwen3.5-4B") && text.some((x) => x.model === "Qwen/Qwen3.5-4B"));
});

test("exact model ids and base URL: no duplicate /v1 for chat or health", () => {
  const c = loadConfig(env);
  for (const target of buildTargets(c.providers)) {
    const req = buildUpstreamRequest(target, "openai-chat", { messages: [] });
    assert.equal(req.url, BASE + "/chat/completions");
    assert.equal(JSON.parse(req.options.body).model, target.model);
    assert.equal(req.options.headers.authorization, "Bearer " + target.apiKey);
  }
  const plan = healthProbePlan(buildTargets(c.providers)[0]);
  assert.equal(plan.url, BASE + "/models");
  assert.equal(plan.headers.authorization, "Bearer sk1");
});

test("multimodal content is preserved for vision targets (base64 and URL, several images)", () => {
  const target = buildTargets(loadConfig(env).visionProviders, VISION_POOL)[0];
  const content = [{ type: "text", text: "d" }, IMG, IMG_URL];
  const req = buildUpstreamRequest(target, "openai-chat", { messages: [{ role: "user", content }] });
  assert.deepEqual(JSON.parse(req.options.body).messages[0].content, content);
});

test("selectPool: text -> text pool, image -> vision pool only, no vision -> no targets", () => {
  const c = loadConfig(env);
  const textTargets = buildTargets(c.providers);
  const visionTargets = buildTargets(c.visionProviders, VISION_POOL);
  const img = { messages: [{ role: "user", content: [IMG] }] };
  const txt = { messages: [{ role: "user", content: "hi" }] };
  assert.ok(selectPool(img, { textTargets, visionTargets }).targets.every((x) => x.pool === VISION_POOL));
  assert.ok(selectPool(txt, { textTargets, visionTargets }).targets.every((x) => !x.pool));
  assert.deepEqual(selectPool(img, { textTargets, visionTargets: [] }).targets, []);
});

// --------------------------------------------------------------------------- health

test("health probe classification distinguishes healthy, auth, rate limit and provider error", () => {
  assert.equal(classifyProbeStatus(200).ok, true);
  for (const s of [401, 403]) assert.match(classifyProbeStatus(s).reason, /authentication/);
  assert.match(classifyProbeStatus(429).reason, /rate limited/);
  assert.equal(classifyProbeStatus(500).ok, false);
  assert.equal(classifyProbeStatus(503).ok, false);
});

test("probeTargetHealth sends the key to {base}/models and maps the answer", async () => {
  const target = buildTargets(loadConfig(env).providers)[0];
  const seen = [];
  const fetchWith = (status) => async (url, init) => { seen.push({ url, init }); return { status, body: null }; };
  assert.equal((await probeTargetHealth(target, { fetchImpl: fetchWith(200) })).ok, true);
  assert.equal((await probeTargetHealth(target, { fetchImpl: fetchWith(401) })).ok, false);
  assert.equal((await probeTargetHealth(target, { fetchImpl: fetchWith(429) })).ok, false);
  assert.equal((await probeTargetHealth(target, { fetchImpl: fetchWith(500) })).ok, false);
  assert.equal((await probeTargetHealth(target, { fetchImpl: async () => { throw new Error("down"); } })).ok, false);
  assert.ok(seen.every((r) => r.url === BASE + "/models" && r.init.headers.authorization === "Bearer sk1"));
});

// --------------------------------------------------------------------------- end to end

async function rig(t, { textScript = ok("from-text"), visionScript = ok("from-vision"), extraEnv = {} } = {}) {
  const text = await startMockUpstream(textScript);
  const vision = await startMockUpstream(visionScript);
  const router = await startRouter({
    SILICONFLOW_API_KEYS: "sk1,sk2", SILICONFLOW_BASE_URL: text.baseUrl + "/v1", SILICONFLOW_MODELS: TEXT.join(","),
    SILICONFLOW_VISION_API_KEYS: "sv1", SILICONFLOW_VISION_BASE_URL: vision.baseUrl + "/v1", SILICONFLOW_VISION_MODELS: VISION.join(","),
    ...extraEnv
  });
  t.after(async () => { await router.close(); await text.close(); await vision.close(); });
  return { text, vision, router };
}

test("text request goes router -> SiliconFlow -> exact model on /v1/chat/completions", async (t) => {
  const { text, vision, router } = await rig(t);
  const res = await router.request("/v1/chat/completions", postJson(chat("THUDM/GLM-4-9B-0414")));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("x-multi-ai-provider"), "siliconflow");
  assert.equal(text.apiRequests[0].body.model, "THUDM/GLM-4-9B-0414");
  assert.equal(text.apiRequests[0].url, "/v1/chat/completions");
  assert.equal(text.apiRequests[0].headers.authorization, "Bearer sk1");
  assert.equal(vision.apiRequests.length, 0);
});

test("non-streaming returns the upstream completion unchanged", async (t) => {
  const { router } = await rig(t);
  const res = await router.request("/v1/chat/completions", postJson(chat("Qwen/Qwen3.5-4B", { stream: false })));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.choices[0].message.content, "from-text");
  assert.equal(body.choices[0].finish_reason, "stop");
  assert.equal(body.usage.total_tokens, 2);
});

test("streaming passes chunks, finish_reason, usage and [DONE] through", async (t) => {
  const { router } = await rig(t, { textScript: () => ({ status: 200, headers: { "content-type": "text/event-stream" }, stream: sseStream("hel", "lo") }) });
  const res = await router.request("/v1/chat/completions", postJson(chat("Qwen/Qwen3.5-4B", { stream: true })));
  assert.equal(res.status, 200);
  const body = await res.text();
  assert.match(body, /hel/);
  assert.match(body, /lo/);
  assert.match(body, /finish_reason":"stop"/);
  assert.match(body, /total_tokens":3/);
  assert.match(body, /\[DONE\]/);
});

test("image request uses only the vision pool and keeps image parts (base64 + URL)", async (t) => {
  const { text, vision, router } = await rig(t);
  const res = await router.request("/v1/chat/completions", postJson(imageChat("Qwen/Qwen3.5-4B", [IMG, IMG_URL])));
  assert.equal(res.status, 200);
  assert.equal(text.apiRequests.length, 0);
  assert.equal(vision.apiRequests[0].headers.authorization, "Bearer sv1");
  assert.equal(vision.apiRequests[0].body.model, "Qwen/Qwen3.5-4B");
  assert.deepEqual(vision.apiRequests[0].body.messages[0].content.slice(1), [IMG, IMG_URL]);
});

test("PaddleOCR is reachable for image requests and never for text requests", async (t) => {
  const { text, vision, router } = await rig(t);
  const pinned = await router.request("/v1/chat/completions", postJson(imageChat("PaddlePaddle/PaddleOCR-VL-1.5")));
  assert.equal(pinned.status, 200);
  assert.equal(vision.apiRequests[0].body.model, "PaddlePaddle/PaddleOCR-VL-1.5");
  const plain = await router.request("/v1/chat/completions", postJson(chat("PaddlePaddle/PaddleOCR-VL-1.5")));
  assert.equal(plain.status, 200);
  assert.ok(text.apiRequests.every((r) => TEXT.includes(r.body.model)), "text pool only ever sees text models");
});

test("text requests never use the vision keys or models", async (t) => {
  const { vision, router } = await rig(t);
  for (const model of TEXT) await router.request("/v1/chat/completions", postJson(chat(model)));
  assert.equal(vision.apiRequests.length, 0);
});

test("image request with no SiliconFlow vision pool => 503 no_vision_route, text models untouched", async (t) => {
  const text = await startMockUpstream(ok("from-text"));
  const router = await startRouter({ SILICONFLOW_API_KEYS: "sk1", SILICONFLOW_BASE_URL: text.baseUrl + "/v1", SILICONFLOW_MODELS: TEXT.join(",") });
  t.after(async () => { await router.close(); await text.close(); });
  const res = await router.request("/v1/chat/completions", postJson(imageChat("Qwen/Qwen3.5-4B")));
  assert.equal(res.status, 503);
  assert.equal((await res.json()).error.type, "no_vision_route");
  assert.equal(text.apiRequests.length, 0);
});

test("vision fallback: a failing SiliconFlow vision target falls to another vision provider", async (t) => {
  const other = await startMockUpstream(ok("from-other-vision"));
  const { vision, router } = await rig(t, {
    visionScript: () => ({ status: 500, body: { error: { message: "boom" } } }),
    extraEnv: { GROQ_VISION_API_KEYS: "gv1", GROQ_VISION_MODELS: "groq-vision", GROQ_VISION_BASE_URL: other.baseUrl }
  });
  t.after(() => other.close());
  const res = await router.request("/v1/chat/completions", postJson(imageChat("Qwen/Qwen3.5-4B")));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("x-multi-ai-provider"), "groq");
  assert.equal(vision.apiRequests[0].body.model, "Qwen/Qwen3.5-4B");
  assert.ok(vision.apiRequests.every((r) => VISION.includes(r.body.model)));
  assert.equal(other.apiRequests.length, 1);
});

test("vision keys rotate on 401 and stay isolated from text keys", async (t) => {
  const { text, vision, router } = await rig(t, {
    visionScript: (req) => req.headers.authorization === "Bearer sv1"
      ? { status: 401, body: { error: { message: "bad key" } } }
      : { status: 200, body: chatReply("from-sv2") },
    extraEnv: { SILICONFLOW_VISION_API_KEYS: "sv1,sv2" }
  });
  const res = await router.request("/v1/chat/completions", postJson(imageChat("Qwen/Qwen3.5-4B")));
  assert.equal(res.status, 200);
  assert.deepEqual(vision.apiRequests.map((r) => r.headers.authorization), ["Bearer sv1", "Bearer sv2"]);
  assert.equal(text.apiRequests.length, 0);
});

test("a multi-turn conversation containing an image stays in the vision pool with its history", async (t) => {
  const { text, vision, router } = await rig(t);
  const messages = [
    { role: "user", content: [{ type: "text", text: "what is this?" }, IMG] },
    { role: "assistant", content: "a cat" },
    { role: "user", content: "and now?" }
  ];
  const res = await router.request("/v1/chat/completions", postJson({ model: "Qwen/Qwen3.5-4B", messages }));
  assert.equal(res.status, 200);
  assert.equal(text.apiRequests.length, 0);
  assert.deepEqual(vision.apiRequests[0].body.messages, messages);
});

test("multi-turn text history reaches SiliconFlow intact", async (t) => {
  const { text, router } = await rig(t);
  const messages = [
    { role: "user", content: "hello" },
    { role: "assistant", content: "hello" },
    { role: "user", content: "what did I just say?" }
  ];
  const res = await router.request("/v1/chat/completions", postJson({ model: "Qwen/Qwen3.5-4B", messages }));
  assert.equal(res.status, 200);
  assert.deepEqual(text.apiRequests[0].body.messages, messages);
});

test("Anthropic-style requests are served through SiliconFlow's OpenAI-compatible pathway", async (t) => {
  const { text, router } = await rig(t);
  const res = await router.request("/v1/messages", postJson({
    model: "Qwen/Qwen3.5-4B", max_tokens: 50,
    messages: [{ role: "user", content: "hello" }, { role: "assistant", content: "hello" }, { role: "user", content: "what did I say?" }]
  }));
  assert.equal(res.status, 200);
  assert.equal(text.apiRequests[0].url, "/v1/chat/completions");
  const sent = text.apiRequests[0].body.messages.map((m) => m.content);
  assert.deepEqual(sent.slice(-3), ["hello", "hello", "what did I say?"]);
});

// --------------------------------------------------------------------------- fallback / errors

// 401/402/403 describe the API key, so the router skips the key's sibling models and moves to the next key.
for (const status of [401, 402, 403]) {
  test(`a ${status} on one SiliconFlow key falls back to the next key`, async (t) => {
    const { text, router } = await rig(t, {
      textScript: (req) => req.headers.authorization === "Bearer sk1"
        ? { status, body: { error: { message: "failed" } } }
        : { status: 200, body: chatReply("from-sk2") }
    });
    const res = await router.request("/v1/chat/completions", postJson(chat(TEXT[0])));
    assert.equal(res.status, 200);
    const keys = text.apiRequests.map((r) => r.headers.authorization);
    assert.equal(keys.filter((k) => k === "Bearer sk1").length, 1, "the rejected key is tried once, not once per model");
    assert.equal(keys.at(-1), "Bearer sk2");
  });
}

for (const status of [404, 408, 429, 500, 502, 503]) {
  test(`a ${status} on one SiliconFlow model falls back to the next model`, async (t) => {
    const { text, router } = await rig(t, {
      textScript: (req) => req.body.model === TEXT[0]
        ? { status, body: { error: { message: "failed" } } }
        : { status: 200, body: chatReply("from-" + req.body.model) },
      extraEnv: { SILICONFLOW_API_KEYS: "sk1" }
    });
    const res = await router.request("/v1/chat/completions", postJson(chat(TEXT[0])));
    assert.equal(res.status, 200);
    assert.deepEqual(text.apiRequests.map((r) => r.body.model), TEXT.slice(0, 2));
  });
}

test("a 401 on one key falls back to the next key with the same model", async (t) => {
  const { text, router } = await rig(t, {
    textScript: (req) => req.headers.authorization === "Bearer sk1"
      ? { status: 401, body: { error: { message: "bad key" } } }
      : { status: 200, body: chatReply("from-sk2") }
  });
  const res = await router.request("/v1/chat/completions", postJson(chat(TEXT[0])));
  assert.equal(res.status, 200);
  assert.deepEqual(text.apiRequests.map((r) => r.headers.authorization), ["Bearer sk1", "Bearer sk2"]);
  assert.ok(text.apiRequests.every((r) => r.body.model === TEXT[0]));
});

test("a malformed upstream answer does not crash the router", async (t) => {
  const { router } = await rig(t, { textScript: () => ({ status: 200, raw: "<html>not json</html>" }) });
  const res = await router.request("/v1/chat/completions", postJson(chat(TEXT[0])));
  assert.ok([200, 502, 503].includes(res.status));
  const health = await router.request("/health");
  assert.equal(health.status, 200);
});

test("a stream that never answers falls back instead of hanging", async (t) => {
  const { text, router } = await rig(t, {
    textScript: (req) => req.body.model === TEXT[0]
      ? { hang: true }
      : { status: 200, headers: { "content-type": "text/event-stream" }, stream: sseStream("ok") },
    extraEnv: { SILICONFLOW_API_KEYS: "sk1", STREAM_CONNECT_TIMEOUT_MS: "300" }
  });
  const res = await router.request("/v1/chat/completions", postJson(chat(TEXT[0], { stream: true })));
  assert.equal(res.status, 200);
  assert.match(await res.text(), /ok/);
  assert.equal(text.apiRequests[0].body.model, TEXT[0]);
  assert.equal(text.apiRequests[1].body.model, TEXT[1]);
});

test("participates in a cross-provider chain: another provider answers when SiliconFlow fails", async (t) => {
  const other = await startMockUpstream(ok("from-groq"));
  const { text, router } = await rig(t, {
    textScript: () => ({ status: 500, body: { error: { message: "boom" } } }),
    extraEnv: { SILICONFLOW_API_KEYS: "sk1", GROQ_API_KEYS: "g1", GROQ_MODELS: "groq-model", GROQ_BASE_URL: other.baseUrl }
  });
  t.after(() => other.close());
  const res = await router.request("/v1/chat/completions", postJson(chat(TEXT[0])));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("x-multi-ai-provider"), "groq");
  assert.ok(text.apiRequests.length >= 1);
  assert.equal(other.apiRequests.length, 1);
});

test("SiliconFlow is not hard-wired as the preferred provider", async (t) => {
  const other = await startMockUpstream(ok("from-groq"));
  const { text, router } = await rig(t, {
    extraEnv: { GROQ_API_KEYS: "g1", GROQ_MODELS: "groq-model", GROQ_BASE_URL: other.baseUrl }
  });
  t.after(() => other.close());
  const res = await router.request("/v1/chat/completions", postJson(chat("groq-model")));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("x-multi-ai-provider"), "groq");
  assert.equal(text.apiRequests.length, 0);
});

test("pinning a siliconflow key and model uses exactly that, with no fallback", async (t) => {
  const { text, router } = await rig(t);
  const res = await router.request("/v1/chat/completions", postJson(chat("tencent/Hunyuan-MT-7B"), {
    "x-multi-ai-pin-provider": "siliconflow", "x-multi-ai-pin-key-index": "1"
  }));
  assert.equal(res.status, 200);
  assert.equal(text.apiRequests.length, 1);
  assert.equal(text.apiRequests[0].headers.authorization, "Bearer sk2");
  assert.equal(text.apiRequests[0].body.model, "tencent/Hunyuan-MT-7B");
});

// --------------------------------------------------------------------------- UI/API + secrets

test("providers endpoint lists SiliconFlow with its text and vision models, without any key", async (t) => {
  const { router } = await rig(t);
  const res = await router.request("/api/providers");
  assert.equal(res.status, 200);
  const raw = await res.text();
  assert.match(raw, /siliconflow/);
  for (const model of [...TEXT, ...VISION]) assert.ok(raw.includes(model), model + " listed");
  for (const secret of ["sk1", "sk2", "sv1"]) assert.ok(!raw.includes(secret), secret + " leaked");
});

test("health endpoint reports SiliconFlow targets without leaking keys", async (t) => {
  const { router } = await rig(t);
  const raw = await (await router.request("/health")).text();
  assert.match(raw, /siliconflow/);
  for (const secret of ["sk1", "sk2", "sv1"]) assert.ok(!raw.includes(secret), secret + " leaked");
});

test("API keys never appear in /health, /api/providers, /api/config, /api/requests, errors or logs", async (t) => {
  const TK = "sk-siliconflow-text-key-1", TK2 = "sk-siliconflow-text-key-2", VK = "sk-siliconflow-vision-key-1";
  // The upstream deliberately echoes the credential back in its error text.
  const { router } = await rig(t, {
    textScript: () => ({ status: 401, body: { error: { message: `invalid key ${TK} / Bearer ${TK}` } } }),
    visionScript: () => ({ status: 500, body: { error: { message: `boom ${VK} authorization: Bearer ${VK}` } } }),
    extraEnv: { SILICONFLOW_API_KEYS: `${TK},${TK2}`, SILICONFLOW_VISION_API_KEYS: VK }
  });
  const bodies = [
    await (await router.request("/v1/chat/completions", postJson(chat(TEXT[0])))).text(),
    await (await router.request("/v1/chat/completions", postJson(imageChat("Qwen/Qwen3.5-4B")))).text()
  ];
  for (const p of ["/health", "/api/providers", "/api/config", "/api/requests"]) bodies.push(await (await router.request(p)).text());
  bodies.push(router.stdout, router.stderr);
  for (const body of bodies) for (const secret of [TK, TK2, VK]) {
    assert.ok(!body.includes(secret), `${secret} leaked`);
  }
});

test("the router probes GET {base}/models with the target's key at startup", async (t) => {
  const seen = [];
  const text = await startMockUpstream(ok("x"), { health: (req) => { seen.push(req); return { status: 200, body: { data: [] } }; } });
  const router = await startRouter({ SILICONFLOW_API_KEYS: "sk1", SILICONFLOW_BASE_URL: text.baseUrl + "/v1", SILICONFLOW_MODELS: "Qwen/Qwen3.5-4B" });
  t.after(async () => { await router.close(); await text.close(); });
  await new Promise((r) => setTimeout(r, 300));
  assert.ok(seen.length >= 1, "startup health probe ran");
  assert.equal(seen[0].url, "/v1/models");
  assert.equal(seen[0].headers.authorization, "Bearer sk1");
});
