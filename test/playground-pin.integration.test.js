import test from "node:test";
import assert from "node:assert/strict";
import { startMockUpstream } from "../test-helpers/mock-upstream.js";
import { startRouter, postJson } from "../test-helpers/router-harness.js";

const chatReply = (text) => ({
  id: "chatcmpl-1",
  object: "chat.completion",
  created: 0,
  model: "upstream",
  choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
});

const chat = (model) => ({ model, messages: [{ role: "user", content: "hi" }] });

async function setup(t, { groqScript, orScript } = {}) {
  const groq = await startMockUpstream(groqScript ?? (() => ({ status: 200, body: chatReply("from-groq") })));
  const orc = await startMockUpstream(orScript ?? (() => ({ status: 200, body: chatReply("from-openrouter") })));
  const router = await startRouter({
    GROQ_API_KEYS: "groq-k0,groq-k1",
    GROQ_MODELS: "shared-model,groq-only",
    GROQ_BASE_URL: groq.baseUrl,
    OPENROUTER_API_KEYS: "or-k0",
    OPENROUTER_MODELS: "shared-model",
    OPENROUTER_BASE_URL: orc.baseUrl
  });
  t.after(async () => { await router.close(); await groq.close(); await orc.close(); });
  return { groq, orc, router };
}

const post = (router, model, pin = {}) =>
  router.request("/v1/chat/completions", postJson(chat(model), pin));

const apiCalls = (mock) => mock.apiRequests;

test("pinning a provider serves a shared model from that provider only", async (t) => {
  const { groq, orc, router } = await setup(t);

  const res = await post(router, "shared-model", { "x-multi-ai-pin-provider": "openrouter" });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("x-multi-ai-provider"), "openrouter");
  assert.equal(apiCalls(orc).length, 1);
  assert.equal(apiCalls(groq).length, 0);
  assert.equal(apiCalls(orc)[0].body.model, "shared-model");
});

test("pinning a key index uses exactly that key", async (t) => {
  const { groq, router } = await setup(t);

  const res = await post(router, "shared-model", {
    "x-multi-ai-pin-provider": "groq",
    "x-multi-ai-pin-key-index": "1"
  });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("x-multi-ai-key-index"), "1");
  assert.equal(apiCalls(groq).length, 1);
  assert.equal(apiCalls(groq)[0].headers.authorization, "Bearer groq-k1");
});

test("a pinned failure does not fall back to another provider or key", async (t) => {
  const { groq, orc, router } = await setup(t, {
    groqScript: () => ({ status: 429, body: { error: { message: "rate limited" } } })
  });

  const res = await post(router, "shared-model", {
    "x-multi-ai-pin-provider": "groq",
    "x-multi-ai-pin-key-index": "0"
  });
  assert.equal(res.status, 502);
  assert.equal(apiCalls(groq).length, 1, "only the pinned key is tried");
  assert.equal(apiCalls(orc).length, 0, "no other provider is tried");
});

test("a pinned target is still reachable while it is cooling down", async (t) => {
  let calls = 0;
  const { groq, router } = await setup(t, {
    groqScript: () => (++calls === 1
      ? { status: 429, body: { error: { message: "rate limited" } } }
      : { status: 200, body: chatReply("recovered") })
  });
  const pin = { "x-multi-ai-pin-provider": "groq", "x-multi-ai-pin-key-index": "0" };

  assert.equal((await post(router, "groq-only", pin)).status, 502);
  const second = await post(router, "groq-only", pin);
  assert.equal(second.status, 200, "cooldown must not lock a pinned target out");
  assert.equal(apiCalls(groq).length, 2);
});

test("a pin that matches nothing is a clear 404, not a silent reroute", async (t) => {
  const { groq, orc, router } = await setup(t);

  const noModel = await post(router, "groq-only", { "x-multi-ai-pin-provider": "openrouter" });
  assert.equal(noModel.status, 404);
  assert.equal((await noModel.json()).error.type, "no_route");

  const noKey = await post(router, "shared-model", {
    "x-multi-ai-pin-provider": "openrouter",
    "x-multi-ai-pin-key-index": "5"
  });
  assert.equal(noKey.status, 404);

  assert.equal(apiCalls(groq).length + apiCalls(orc).length, 0);
});

test("a malformed key index is rejected", async (t) => {
  const { router } = await setup(t);
  const res = await post(router, "shared-model", {
    "x-multi-ai-pin-provider": "groq",
    "x-multi-ai-pin-key-index": "abc"
  });
  assert.equal(res.status, 400);
});

test("without pin headers routing is unchanged", async (t) => {
  const { router } = await setup(t);
  const res = await post(router, "shared-model");
  assert.equal(res.status, 200);
});
