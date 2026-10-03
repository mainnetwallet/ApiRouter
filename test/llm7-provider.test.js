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

const BASE = "https://api.llm7.io/v1";
const TEXT = ["DeepSeek-V4-Flash-0731", "GLM-5.3-Flash", "minimax-m2.7", "DeepSeek-V4.1-Flash"];
const VISION = ["kimi-k3", "llama-4-maverick", "minimax-m3"];
const TEXT_ONLY = "minimax-m2.7";
const VISION_ONLY = "llama-4-maverick";
const env = {
  LLM7_API_KEYS: "sk1,sk2,sk3", LLM7_BASE_URL: BASE, LLM7_MODELS: TEXT.join(","),
  LLM7_VISION_API_KEYS: "sv1,sv2", LLM7_VISION_BASE_URL: BASE, LLM7_VISION_MODELS: VISION.join(",")
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

test(".env.example defines each LLM7 variable once and yields both pools", () => {
  const example = readFileSync(new URL("../.env.example", import.meta.url), "utf8");
  const lines = example.split("\n");
  for (const name of ["API_KEYS", "MODELS", "BASE_URL", "VISION_API_KEYS", "VISION_MODELS", "VISION_BASE_URL"]) {
    assert.equal(lines.filter((l) => l.startsWith("LLM7_" + name + "=")).length, 1, name);
  }
  const values = Object.fromEntries(lines.filter((l) => /^LLM7_\w+=/.test(l)).map((l) => [l.split("=")[0], l.slice(l.indexOf("=") + 1)]));
  const c = loadConfig({ ...values, LLM7_API_KEYS: "a", LLM7_VISION_API_KEYS: "b" });
  assert.deepEqual(c.providers.llm7.models, TEXT);
  assert.deepEqual(c.visionProviders.llm7.models, VISION);
  assert.equal(c.providers.llm7.baseUrl, BASE);
  assert.equal(c.visionProviders.llm7.baseUrl, BASE);
});

test(".env stays git-ignored", () => {
  const ignore = readFileSync(new URL("../.gitignore", import.meta.url), "utf8").split("\n").map((l) => l.trim());
  assert.ok(ignore.includes(".env"));
});

test("llm7 is registered once and config reads the text and vision variables", () => {
  assert.equal(PROVIDERS.filter((p) => p === "llm7").length, 1);
  const c = loadConfig(env);
  assert.deepEqual(c.providers.llm7.apiKeys, ["sk1", "sk2", "sk3"]);
  assert.deepEqual(c.providers.llm7.models, TEXT);
  assert.equal(c.providers.llm7.baseUrl, BASE);
  assert.deepEqual(c.visionProviders.llm7.apiKeys, ["sv1", "sv2"]);
  assert.deepEqual(c.visionProviders.llm7.models, VISION);
  assert.equal(c.visionProviders.llm7.baseUrl, BASE);
  assert.deepEqual(providerProtocols("llm7"), ["openai-chat"]);
});

test("key and model parsing trims whitespace and drops empty entries", () => {
  const c = loadConfig({ LLM7_API_KEYS: " a , ,b,", LLM7_MODELS: " m1 ,, m2 ", LLM7_BASE_URL: BASE });
  assert.deepEqual(c.providers.llm7.apiKeys, ["a", "b"]);
  assert.deepEqual(c.providers.llm7.models, ["m1", "m2"]);
});

test("an unconfigured LLM7 yields no targets in either pool", () => {
  const c = loadConfig({});
  assert.equal(buildTargets(c.providers).filter((x) => x.provider === "llm7").length, 0);
  assert.equal(buildTargets(c.visionProviders, VISION_POOL).filter((x) => x.provider === "llm7").length, 0);
});

test("targets: keys x models in configured order, pools and keys separate", () => {
  const c = loadConfig(env);
  const text = buildTargets(c.providers);
  const vision = buildTargets(c.visionProviders, VISION_POOL);
  assert.equal(text.length, TEXT.length * 3);
  assert.equal(vision.length, VISION.length * 2);
  assert.deepEqual([...new Set(text.map((x) => x.model))], TEXT);
  assert.deepEqual([...new Set(vision.map((x) => x.model))], VISION);
  assert.ok(text.every((x) => !x.pool && x.apiKey.startsWith("sk")));
  assert.ok(vision.every((x) => x.pool === VISION_POOL && x.apiKey.startsWith("sv")));
  // llama-4-maverick is configured only in the vision pool, minimax-m2.7 only in the text pool.
  assert.ok(!text.some((x) => x.model === VISION_ONLY));
  assert.ok(!vision.some((x) => x.model === TEXT_ONLY), TEXT_ONLY + " must not be a vision target");
  assert.deepEqual(TEXT.filter((m) => VISION.includes(m)), [], "the text and vision pools are disjoint");
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
    LLM7_API_KEYS: "sk1,sk2", LLM7_BASE_URL: text.baseUrl + "/v1", LLM7_MODELS: TEXT.join(","),
    LLM7_VISION_API_KEYS: "sv1", LLM7_VISION_BASE_URL: vision.baseUrl + "/v1", LLM7_VISION_MODELS: VISION.join(","),
    ...extraEnv
  });
  t.after(async () => { await router.close(); await text.close(); await vision.close(); });
  return { text, vision, router };
}

test("text request goes router -> LLM7 -> exact model on /v1/chat/completions", async (t) => {
  const { text, vision, router } = await rig(t);
  const res = await router.request("/v1/chat/completions", postJson(chat("minimax-m2.7")));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("x-multi-ai-provider"), "llm7");
  assert.equal(text.apiRequests[0].body.model, "minimax-m2.7");
  assert.equal(text.apiRequests[0].url, "/v1/chat/completions");
  assert.equal(text.apiRequests[0].headers.authorization, "Bearer sk1");
  assert.equal(vision.apiRequests.length, 0);
});

test("non-streaming returns the upstream completion unchanged", async (t) => {
  const { router } = await rig(t);
  const res = await router.request("/v1/chat/completions", postJson(chat("GLM-5.3-Flash", { stream: false })));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.choices[0].message.content, "from-text");
  assert.equal(body.choices[0].finish_reason, "stop");
  assert.equal(body.usage.total_tokens, 2);
});

test("streaming passes chunks, finish_reason, usage and [DONE] through", async (t) => {
  const { router } = await rig(t, { textScript: () => ({ status: 200, headers: { "content-type": "text/event-stream" }, stream: sseStream("hel", "lo") }) });
  const res = await router.request("/v1/chat/completions", postJson(chat("GLM-5.3-Flash", { stream: true })));
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
  const res = await router.request("/v1/chat/completions", postJson(imageChat("kimi-k3", [IMG, IMG_URL])));
  assert.equal(res.status, 200);
  assert.equal(text.apiRequests.length, 0);
  assert.equal(vision.apiRequests[0].headers.authorization, "Bearer sv1");
  assert.equal(vision.apiRequests[0].body.model, "kimi-k3");
  assert.deepEqual(vision.apiRequests[0].body.messages[0].content.slice(1), [IMG, IMG_URL]);
});

test("llama-4-maverick (vision-only) is reachable for image requests and never for text requests", async (t) => {
  const { text, vision, router } = await rig(t);
  const pinned = await router.request("/v1/chat/completions", postJson(imageChat("llama-4-maverick")));
  assert.equal(pinned.status, 200);
  assert.equal(vision.apiRequests[0].body.model, "llama-4-maverick");
  const plain = await router.request("/v1/chat/completions", postJson(chat("llama-4-maverick")));
  assert.equal(plain.status, 200);
  assert.ok(text.apiRequests.every((r) => TEXT.includes(r.body.model)), "text pool only ever sees text models");
});

test("text requests never use the vision keys or models", async (t) => {
  const { vision, router } = await rig(t);
  for (const model of TEXT) await router.request("/v1/chat/completions", postJson(chat(model)));
  assert.equal(vision.apiRequests.length, 0);
});

test("image request with no LLM7 vision pool => 503 no_vision_route, text models untouched", async (t) => {
  const text = await startMockUpstream(ok("from-text"));
  const router = await startRouter({ LLM7_API_KEYS: "sk1", LLM7_BASE_URL: text.baseUrl + "/v1", LLM7_MODELS: TEXT.join(",") });
  t.after(async () => { await router.close(); await text.close(); });
  const res = await router.request("/v1/chat/completions", postJson(imageChat("kimi-k3")));
  assert.equal(res.status, 503);
  assert.equal((await res.json()).error.type, "no_vision_route");
  assert.equal(text.apiRequests.length, 0);
});

test("vision fallback: a failing LLM7 vision target falls to another vision provider", async (t) => {
  const other = await startMockUpstream(ok("from-other-vision"));
  const { vision, router } = await rig(t, {
    visionScript: () => ({ status: 500, body: { error: { message: "boom" } } }),
    extraEnv: { GROQ_VISION_API_KEYS: "gv1", GROQ_VISION_MODELS: "groq-vision", GROQ_VISION_BASE_URL: other.baseUrl }
  });
  t.after(() => other.close());
  const res = await router.request("/v1/chat/completions", postJson(imageChat("kimi-k3")));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("x-multi-ai-provider"), "groq");
  assert.equal(vision.apiRequests[0].body.model, "kimi-k3");
  assert.ok(vision.apiRequests.every((r) => VISION.includes(r.body.model)));
  assert.equal(other.apiRequests.length, 1);
});

test("vision keys rotate on 401 and stay isolated from text keys", async (t) => {
  const { text, vision, router } = await rig(t, {
    visionScript: (req) => req.headers.authorization === "Bearer sv1"
      ? { status: 401, body: { error: { message: "bad key" } } }
      : { status: 200, body: chatReply("from-sv2") },
    extraEnv: { LLM7_VISION_API_KEYS: "sv1,sv2" }
  });
  const res = await router.request("/v1/chat/completions", postJson(imageChat("kimi-k3")));
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
  const res = await router.request("/v1/chat/completions", postJson({ model: "GLM-5.3-Flash", messages }));
  assert.equal(res.status, 200);
  assert.equal(text.apiRequests.length, 0);
  assert.deepEqual(vision.apiRequests[0].body.messages, messages);
});

test("multi-turn text history reaches LLM7 intact", async (t) => {
  const { text, router } = await rig(t);
  const messages = [
    { role: "user", content: "hello" },
    { role: "assistant", content: "hello" },
    { role: "user", content: "what did I just say?" }
  ];
  const res = await router.request("/v1/chat/completions", postJson({ model: "GLM-5.3-Flash", messages }));
  assert.equal(res.status, 200);
  assert.deepEqual(text.apiRequests[0].body.messages, messages);
});

test("Anthropic-style requests are served through LLM7's OpenAI-compatible pathway", async (t) => {
  const { text, router } = await rig(t);
  const res = await router.request("/v1/messages", postJson({
    model: "GLM-5.3-Flash", max_tokens: 50,
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
  test(`a ${status} on one LLM7 key falls back to the next key`, async (t) => {
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
  test(`a ${status} on one LLM7 model falls back to the next model`, async (t) => {
    const { text, router } = await rig(t, {
      textScript: (req) => req.body.model === TEXT[0]
        ? { status, body: { error: { message: "failed" } } }
        : { status: 200, body: chatReply("from-" + req.body.model) },
      extraEnv: { LLM7_API_KEYS: "sk1" }
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

test("a 200 with a non-JSON body is forwarded unchanged and the router stays up", async (t) => {
  // Regression: the usage inspector consumed the body and, on a JSON parse failure, dropped the
  // buffer, so the later stream-copy failed and the client saw a dropped connection.
  const html = "<html>not json</html>";
  const { router } = await rig(t, { textScript: () => ({ status: 200, body: html }) });
  const res = await router.request("/v1/chat/completions", postJson(chat(TEXT[0])));
  assert.equal(res.status, 200);
  assert.equal(await res.text(), html);
  assert.equal((await router.request("/health")).status, 200);
});

test("a stream that never answers falls back instead of hanging", async (t) => {
  const { text, router } = await rig(t, {
    textScript: (req) => req.body.model === TEXT[0]
      ? { hang: true }
      : { status: 200, headers: { "content-type": "text/event-stream" }, stream: sseStream("ok") },
    extraEnv: { LLM7_API_KEYS: "sk1", STREAM_CONNECT_TIMEOUT_MS: "300" }
  });
  const res = await router.request("/v1/chat/completions", postJson(chat(TEXT[0], { stream: true })));
  assert.equal(res.status, 200);
  assert.match(await res.text(), /ok/);
  assert.equal(text.apiRequests[0].body.model, TEXT[0]);
  assert.equal(text.apiRequests[1].body.model, TEXT[1]);
});

test("participates in a cross-provider chain: another provider answers when LLM7 fails", async (t) => {
  const other = await startMockUpstream(ok("from-groq"));
  const { text, router } = await rig(t, {
    textScript: () => ({ status: 500, body: { error: { message: "boom" } } }),
    extraEnv: { LLM7_API_KEYS: "sk1", GROQ_API_KEYS: "g1", GROQ_MODELS: "groq-model", GROQ_BASE_URL: other.baseUrl }
  });
  t.after(() => other.close());
  const res = await router.request("/v1/chat/completions", postJson(chat(TEXT[0])));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("x-multi-ai-provider"), "groq");
  assert.ok(text.apiRequests.length >= 1);
  assert.equal(other.apiRequests.length, 1);
});

test("LLM7 is not hard-wired as the preferred provider", async (t) => {
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

test("pinning a llm7 key and model uses exactly that, with no fallback", async (t) => {
  const { text, router } = await rig(t);
  const res = await router.request("/v1/chat/completions", postJson(chat("DeepSeek-V4.1-Flash"), {
    "x-multi-ai-pin-provider": "llm7", "x-multi-ai-pin-key-index": "1"
  }));
  assert.equal(res.status, 200);
  assert.equal(text.apiRequests.length, 1);
  assert.equal(text.apiRequests[0].headers.authorization, "Bearer sk2");
  assert.equal(text.apiRequests[0].body.model, "DeepSeek-V4.1-Flash");
});

// --------------------------------------------------------------------------- UI/API + secrets

test("providers endpoint lists LLM7 with its text and vision models, without any key", async (t) => {
  const { router } = await rig(t);
  const res = await router.request("/api/providers");
  assert.equal(res.status, 200);
  const raw = await res.text();
  assert.match(raw, /llm7/);
  for (const model of [...TEXT, ...VISION]) assert.ok(raw.includes(model), model + " listed");
  for (const secret of ["sk1", "sk2", "sv1"]) assert.ok(!raw.includes(secret), secret + " leaked");
});

test("health endpoint reports LLM7 targets without leaking keys", async (t) => {
  const { router } = await rig(t);
  const raw = await (await router.request("/health")).text();
  assert.match(raw, /llm7/);
  for (const secret of ["sk1", "sk2", "sv1"]) assert.ok(!raw.includes(secret), secret + " leaked");
});

test("API keys never appear in /health, /api/providers, /api/config, /api/requests, errors or logs", async (t) => {
  const TK = "sk-llm7-text-key-1", TK2 = "sk-llm7-text-key-2", VK = "sk-llm7-vision-key-1";
  // The upstream deliberately echoes the credential back in its error text.
  const { router } = await rig(t, {
    textScript: () => ({ status: 401, body: { error: { message: `invalid key ${TK} / Bearer ${TK}` } } }),
    visionScript: () => ({ status: 500, body: { error: { message: `boom ${VK} authorization: Bearer ${VK}` } } }),
    extraEnv: { LLM7_API_KEYS: `${TK},${TK2}`, LLM7_VISION_API_KEYS: VK }
  });
  const bodies = [
    await (await router.request("/v1/chat/completions", postJson(chat(TEXT[0])))).text(),
    await (await router.request("/v1/chat/completions", postJson(imageChat("kimi-k3")))).text()
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
  const router = await startRouter({ LLM7_API_KEYS: "sk1", LLM7_BASE_URL: text.baseUrl + "/v1", LLM7_MODELS: "GLM-5.3-Flash" });
  t.after(async () => { await router.close(); await text.close(); });
  await new Promise((r) => setTimeout(r, 300));
  assert.ok(seen.length >= 1, "startup health probe ran");
  assert.equal(seen[0].url, "/v1/models");
  assert.equal(seen[0].headers.authorization, "Bearer sk1");
});

// --------------------------------------------------------------------------- LLM7-specific additions

test("no LLM7 vision credentials: image requests go to another configured vision provider", async (t) => {
  const text = await startMockUpstream(ok("from-text"));
  const other = await startMockUpstream(ok("from-other-vision"));
  const router = await startRouter({
    LLM7_API_KEYS: "sk1", LLM7_BASE_URL: text.baseUrl + "/v1", LLM7_MODELS: TEXT.join(","),
    GROQ_VISION_API_KEYS: "gv1", GROQ_VISION_MODELS: "groq-vision", GROQ_VISION_BASE_URL: other.baseUrl
  });
  t.after(async () => { await router.close(); await text.close(); await other.close(); });
  const res = await router.request("/v1/chat/completions", postJson(imageChat("kimi-k3")));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("x-multi-ai-provider"), "groq");
  assert.equal(text.apiRequests.length, 0, "LLM7 text keys are never spent on an image");
  assert.equal(other.apiRequests.length, 1);
});

test("an image request never consumes the LLM7 text key or models, and text never the vision key", async (t) => {
  const { text, vision, router } = await rig(t);
  await router.request("/v1/chat/completions", postJson(imageChat("kimi-k3")));
  await router.request("/v1/chat/completions", postJson(chat("GLM-5.3-Flash")));
  assert.ok(text.apiRequests.every((r) => r.headers.authorization.startsWith("Bearer sk") && TEXT.includes(r.body.model)));
  assert.ok(vision.apiRequests.every((r) => r.headers.authorization === "Bearer sv1" && VISION.includes(r.body.model)));
  assert.equal(text.apiRequests.length, 1);
  assert.equal(vision.apiRequests.length, 1);
});

test("vision streaming passes through the vision pool", async (t) => {
  const { text, router } = await rig(t, { visionScript: () => ({ status: 200, headers: { "content-type": "text/event-stream" }, stream: sseStream("a cat") }) });
  const res = await router.request("/v1/chat/completions", postJson({ ...imageChat("kimi-k3"), stream: true }));
  assert.equal(res.status, 200);
  const body = await res.text();
  assert.match(body, /a cat/);
  assert.match(body, /\[DONE\]/);
  assert.equal(text.apiRequests.length, 0);
});

test("a malformed SSE event does not break the stream or the router", async (t) => {
  const stream = ['data: {not json}\n\n', ...sseStream("still", " works")];
  const { router } = await rig(t, { textScript: () => ({ status: 200, headers: { "content-type": "text/event-stream" }, stream }) });
  const res = await router.request("/v1/chat/completions", postJson(chat(TEXT[0], { stream: true })));
  assert.equal(res.status, 200);
  assert.match(await res.text(), /still/);
  assert.equal((await router.request("/health")).status, 200);
});

test("a client that disconnects mid-stream leaves the router serving", async (t) => {
  const { router } = await rig(t, {
    textScript: () => ({ status: 200, headers: { "content-type": "text/event-stream" }, delayMs: 50, stream: sseStream("a", "b", "c", "d", "e", "f") })
  });
  const controller = new AbortController();
  const res = await router.request("/v1/chat/completions", { ...postJson(chat(TEXT[0], { stream: true })), signal: controller.signal });
  const reader = res.body.getReader();
  await reader.read();
  controller.abort();
  await reader.read().catch(() => {});
  const next = await router.request("/v1/chat/completions", postJson(chat(TEXT[1])));
  assert.equal(next.status, 200);
});

test("the LLM7 free-token quota is documented as quota-based, never as free-priced models", () => {
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  const section = readme.slice(readme.indexOf("### LLM7"), readme.indexOf("Retryable statuses:"));
  assert.match(section, /free-token quota/i);
  assert.match(section, /can change/i);
  // Drop the two sentences that deny those claims, then make sure nothing asserts them.
  const claims = section
    .replace(/not permanently free model pricing/gi, "")
    .replace(/nothing here promises unlimited usage/gi, "");
  assert.ok(!/unlimited|permanently free|\$0|free model/i.test(claims), "no unlimited/free-model claim");
});
