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

const BASE = "https://inference-api.nousresearch.com/v1";
const TEXT = [
  "poolside/laguna-s-2.1:free",
  "stepfun/step-3.7-flash:free",
  "meituan/longcat-2.5-preview:free",
  "inclusionai/ling-3.0-flash-fin:free",
  "meituan/longcat-2.0:free",
  "poolside/laguna-xs-2.1:free",
  "inclusionai/ling-3.0-flash-sante:free",
  "upstage/solar-pro4:free"
];
const VISION = ["stepfun/step-3.7-flash:free"];

test("Nous Portal free model pools are documented and ordered", () => {
  const example = readFileSync(new URL("../.env.example", import.meta.url), "utf8");
  assert.match(example, new RegExp("^NOUS_MODELS=" + TEXT.join(",").replace(/\./g, "\\\.") + "$", "m"));
  assert.match(example, /^NOUS_VISION_MODELS=stepfun\/step-3\.7-flash:free$/m);
  assert.match(example, /^NOUS_BASE_URL=https:\/\/inference-api\.nousresearch\.com\/v1$/m);
  assert.match(example, /^NOUS_VISION_BASE_URL=https:\/\/inference-api\.nousresearch\.com\/v1$/m);
});

test("Nous is a first-class OpenAI-compatible provider with separate vision config", () => {
  assert.ok(PROVIDERS.includes("nous"));
  const c = loadConfig({
    NOUS_API_KEYS: "n1,n2",
    NOUS_BASE_URL: BASE,
    NOUS_MODELS: TEXT.join(","),
    NOUS_VISION_API_KEYS: "nv1",
    NOUS_VISION_BASE_URL: BASE,
    NOUS_VISION_MODELS: VISION.join(",")
  });
  assert.deepEqual(c.providers.nous.models, TEXT);
  assert.deepEqual(c.providers.nous.apiKeys, ["n1", "n2"]);
  assert.equal(c.providers.nous.baseUrl, BASE);
  assert.deepEqual(c.visionProviders.nous.models, VISION);
  assert.deepEqual(providerProtocols("nous"), ["openai-chat"]);
});

test("Nous targets preserve model order and keep vision isolated", () => {
  const c = loadConfig({
    NOUS_API_KEYS: "n1,n2",
    NOUS_BASE_URL: BASE,
    NOUS_MODELS: TEXT.join(","),
    NOUS_VISION_API_KEYS: "nv1",
    NOUS_VISION_BASE_URL: BASE,
    NOUS_VISION_MODELS: VISION.join(",")
  });
  const text = buildTargets(c.providers);
  const vision = buildTargets(c.visionProviders, VISION_POOL);
  assert.equal(text.length, TEXT.length * 2);
  assert.equal(vision.length, 1);
  assert.deepEqual([...new Set(text.map((x) => x.model))], TEXT);
  assert.deepEqual([...new Set(vision.map((x) => x.model))], VISION);
  assert.ok(vision.every((x) => x.pool === "vision"));
});

test("Nous base URL does not duplicate /v1 and health probes use the same endpoint", () => {
  const c = loadConfig({
    NOUS_API_KEYS: "n1",
    NOUS_BASE_URL: BASE,
    NOUS_MODELS: TEXT.join(",")
  });
  const target = buildTargets(c.providers).find((x) => x.model === TEXT[0]);
  const req = buildUpstreamRequest(target, "openai-chat", { messages: [] });
  assert.equal(req.url, BASE + "/chat/completions");
  assert.equal(JSON.parse(req.options.body).model, TEXT[0]);
  const probe = healthProbePlan(target);
  assert.equal(probe.url, BASE + "/models");
  assert.equal(probe.headers.authorization, "Bearer n1");
});

test("Step 3.7 Flash is the only configured Nous free vision model", () => {
  const c = loadConfig({
    NOUS_API_KEYS: "n1",
    NOUS_BASE_URL: BASE,
    NOUS_MODELS: TEXT.join(","),
    NOUS_VISION_API_KEYS: "nv1",
    NOUS_VISION_BASE_URL: BASE,
    NOUS_VISION_MODELS: VISION.join(",")
  });
  const image = { messages: [{ role: "user", content: [
    { type: "text", text: "describe this" },
    { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }
  ] }] };
  const picked = selectPool(image, {
    textTargets: buildTargets(c.providers),
    visionTargets: buildTargets(c.visionProviders, VISION_POOL)
  });
  assert.equal(picked.targets.length, 1);
  assert.equal(picked.targets[0].model, "stepfun/step-3.7-flash:free");
  assert.equal(picked.targets[0].pool, VISION_POOL);
});

// ---------------------------------------------------------------------------
// Router behaviour through the real server, with mock upstreams.
// ---------------------------------------------------------------------------

const chatReply = (text) => ({
  id: "c1", object: "chat.completion", created: 0, model: "upstream",
  choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
});
const ok = (text) => () => ({ status: 200, body: chatReply(text) });
const chat = (model, extra = {}) => ({ model, messages: [{ role: "user", content: "hi" }], ...extra });
const IMG = { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } };
const imageChat = (model) => ({ model, messages: [{ role: "user", content: [{ type: "text", text: "what is this?" }, IMG] }] });

async function rig(t, { textScript = ok("from-text"), visionScript = ok("from-vision"), extraEnv = {} } = {}) {
  const text = await startMockUpstream(textScript);
  const vision = await startMockUpstream(visionScript);
  const router = await startRouter({
    NOUS_API_KEYS: "n1,n2", NOUS_BASE_URL: text.baseUrl + "/v1", NOUS_MODELS: TEXT.join(","),
    NOUS_VISION_API_KEYS: "nv1", NOUS_VISION_BASE_URL: vision.baseUrl + "/v1", NOUS_VISION_MODELS: VISION.join(","),
    ...extraEnv
  });
  t.after(async () => { await router.close(); await text.close(); await vision.close(); });
  return { text, vision, router };
}

test("text request reaches Nous with the exact model id (slashes and :free kept) and no doubled /v1", async (t) => {
  const { text, vision, router } = await rig(t);
  const res = await router.request("/v1/chat/completions", postJson({
    model: "upstage/solar-pro4:free", temperature: 0.2, max_tokens: 16,
    messages: [{ role: "system", content: "be brief" }, { role: "user", content: "a" }, { role: "assistant", content: "b" }, { role: "user", content: "c" }]
  }));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("x-multi-ai-provider"), "nous");
  const sent = text.apiRequests[0];
  assert.equal(sent.url, "/v1/chat/completions");
  assert.equal(sent.body.model, "upstage/solar-pro4:free");
  assert.equal(sent.body.temperature, 0.2);
  assert.deepEqual(sent.body.messages.map((m) => m.role), ["system", "user", "assistant", "user"]);
  assert.equal(vision.apiRequests.length, 0);
});

test("image request uses only the Nous vision pool and keeps the image parts", async (t) => {
  const { text, vision, router } = await rig(t);
  const res = await router.request("/v1/chat/completions", postJson(imageChat("stepfun/step-3.7-flash:free")));
  assert.equal(res.status, 200);
  assert.equal(text.apiRequests.length, 0, "text pool must not see an image request");
  assert.equal(vision.apiRequests[0].headers.authorization, "Bearer nv1");
  assert.equal(vision.apiRequests[0].body.model, "stepfun/step-3.7-flash:free");
  assert.deepEqual(vision.apiRequests[0].body.messages[0].content[1], IMG);
});

test("a multi-turn conversation that already contains an image stays in the vision pool", async (t) => {
  const { text, vision, router } = await rig(t);
  const res = await router.request("/v1/chat/completions", postJson({
    model: "stepfun/step-3.7-flash:free",
    messages: [
      { role: "user", content: [{ type: "text", text: "what is this?" }, IMG] },
      { role: "assistant", content: "a cat" },
      { role: "user", content: "make it blue" }
    ]
  }));
  assert.equal(res.status, 200);
  assert.equal(text.apiRequests.length, 0);
  assert.equal(vision.apiRequests.length, 1);
});

test("no Nous vision key => 503 no_vision_route and no text model is called", async (t) => {
  const { text, router } = await rig(t, { extraEnv: { NOUS_VISION_API_KEYS: "" } });
  const res = await router.request("/v1/chat/completions", postJson(imageChat("stepfun/step-3.7-flash:free")));
  assert.equal(res.status, 503);
  assert.equal((await res.json()).error.type, "no_vision_route");
  assert.equal(text.apiRequests.length, 0);
});

test("a text request never reaches the vision pool", async (t) => {
  const { vision, router } = await rig(t);
  await router.request("/v1/chat/completions", postJson(chat("stepfun/step-3.7-flash:free")));
  assert.equal(vision.apiRequests.length, 0);
});

test("streaming passes through", async (t) => {
  const sse = ['data: {"choices":[{"delta":{"content":"hel"}}]}\n\n', 'data: {"choices":[{"delta":{"content":"lo"}}]}\n\n', "data: [DONE]\n\n"];
  const { router } = await rig(t, { textScript: () => ({ status: 200, headers: { "content-type": "text/event-stream" }, stream: sse }) });
  const res = await router.request("/v1/chat/completions", postJson(chat(TEXT[0], { stream: true })));
  assert.equal(res.status, 200);
  const body = await res.text();
  assert.match(body, /hel/);
  assert.match(body, /DONE/);
});

test("fallback walks the Nous models in the configured order after 429, 500 and an unavailable model", async (t) => {
  const failures = {
    [TEXT[0]]: { status: 429, body: { error: { message: "slow down" } } },
    [TEXT[1]]: { status: 500, body: { error: { message: "boom" } } },
    [TEXT[2]]: { status: 404, body: { error: { message: "The model does not exist" } } }
  };
  const { text, router } = await rig(t, {
    textScript: (req) => failures[req.body.model] ?? { status: 200, body: chatReply("from-" + req.body.model) },
    extraEnv: { NOUS_API_KEYS: "n1" }
  });
  const res = await router.request("/v1/chat/completions", postJson(chat(TEXT[0])));
  assert.equal(res.status, 200);
  assert.deepEqual(text.apiRequests.map((r) => r.body.model), TEXT.slice(0, 4));
});

test("a 401 on one key moves to the next key, and vision keys are never used for text", async (t) => {
  const { text, vision, router } = await rig(t, {
    textScript: (req) => req.headers.authorization === "Bearer n1"
      ? { status: 401, body: { error: { message: "bad key" } } }
      : { status: 200, body: chatReply("from-n2") }
  });
  const res = await router.request("/v1/chat/completions", postJson(chat(TEXT[0])));
  assert.equal(res.status, 200);
  assert.deepEqual(text.apiRequests.map((r) => r.headers.authorization), ["Bearer n1", "Bearer n2"]);
  assert.equal(vision.apiRequests.length, 0);
});

test("pinning the nous provider, a key and a model uses exactly that target", async (t) => {
  const { text, router } = await rig(t);
  const res = await router.request("/v1/chat/completions", postJson(chat("meituan/longcat-2.0:free"), {
    "x-multi-ai-pin-provider": "nous", "x-multi-ai-pin-key-index": "1"
  }));
  assert.equal(res.status, 200);
  assert.equal(text.apiRequests.length, 1);
  assert.equal(text.apiRequests[0].headers.authorization, "Bearer n2");
  assert.equal(text.apiRequests[0].body.model, "meituan/longcat-2.0:free");
});

test("startup health probe calls GET {base}/models with the text key", async (t) => {
  const seen = [];
  const text = await startMockUpstream(ok("x"), { health: (req) => { seen.push(req); return { status: 200, body: { data: [] } }; } });
  const router = await startRouter({ NOUS_API_KEYS: "n1", NOUS_BASE_URL: text.baseUrl + "/v1", NOUS_MODELS: TEXT[0] });
  t.after(async () => { await router.close(); await text.close(); });
  await new Promise((r) => setTimeout(r, 300));
  assert.ok(seen.length >= 1);
  assert.equal(seen[0].url, "/v1/models");
  assert.equal(seen[0].headers.authorization, "Bearer n1");
});

test("API keys never appear in /health, /api/providers, /api/config, /api/requests, errors or logs", async (t) => {
  const { router } = await rig(t, { textScript: () => ({ status: 500, body: { error: { message: "upstream failed" } } }) });
  const failed = await router.request("/v1/chat/completions", postJson(chat(TEXT[0])));
  const bodies = [await failed.text()];
  for (const p of ["/health", "/api/providers", "/api/config", "/api/requests"]) bodies.push(await (await router.request(p)).text());
  assert.match(bodies[1], /nous/);
  bodies.push(router.stdout, router.stderr);
  for (const body of bodies) for (const secret of ["n1", "n2", "nv1"]) {
    assert.ok(!new RegExp(`(?<![A-Za-z0-9])${secret}(?![A-Za-z0-9])`).test(body.replace(/NOUS_[A-Z_]+/g, "")), `${secret} leaked`);
  }
});
