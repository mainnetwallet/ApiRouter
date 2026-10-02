import test from "node:test";
import assert from "node:assert/strict";
import { startMockUpstream } from "../test-helpers/mock-upstream.js";
import { startRouter, postJson } from "../test-helpers/router-harness.js";

const chatReply = (text) => ({
  id: "chatcmpl-1", object: "chat.completion", created: 0, model: "upstream",
  choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
});

const IMAGE = { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } };
const withImage = { model: "any", max_tokens: 32, messages: [{ role: "user", content: [{ type: "text", text: "what is this?" }, IMAGE] }] };
const textOnly = { model: "any", max_tokens: 32, messages: [{ role: "user", content: "hi" }] };

const reply = (status, text) => () => ({ status, body: status === 200 ? chatReply(text) : { error: { message: "x" } } });

/**
 * One text provider (groq) and two vision providers (openrouter, mistral), each
 * with its own mock upstream, key and model, so the test can see exactly which
 * pool served a request.
 */
async function setup(t, { textStatus = 200, vision1Status = 429, vision2Status = 200 } = {}) {
  const text = await startMockUpstream(reply(textStatus, "from-text"));
  const v1 = await startMockUpstream(reply(vision1Status, "from-v1"));
  const v2 = await startMockUpstream(reply(vision2Status, "from-v2"));
  const router = await startRouter({
    GROQ_API_KEYS: "text-key", GROQ_MODELS: "text-model", GROQ_BASE_URL: text.baseUrl,
    OPENROUTER_VISION_API_KEYS: "vk1", OPENROUTER_VISION_MODELS: "vision-1", OPENROUTER_VISION_BASE_URL: v1.baseUrl,
    MISTRAL_VISION_API_KEYS: "vk2", MISTRAL_VISION_MODELS: "vision-2", MISTRAL_VISION_BASE_URL: v2.baseUrl
  });
  t.after(async () => { await router.close(); await text.close(); await v1.close(); await v2.close(); });
  return { text, v1, v2, router };
}

test("image request goes only to the vision pool and falls back inside it", async (t) => {
  const { text, v1, v2, router } = await setup(t);
  const res = await router.request("/v1/messages", postJson({ ...withImage, model: "vision-1" }));
  assert.equal(res.status, 200);
  assert.equal(text.apiRequests.length, 0, "text pool must not receive an image request");
  assert.equal(v1.apiRequests.length, 1, "first vision target is tried (and fails with 429)");
  assert.equal(v2.apiRequests.length, 1, "next vision target answers");
});

test("image request: when every vision target fails, the text pool is still not used", async (t) => {
  const { text, router } = await setup(t, { vision2Status: 500 });
  const res = await router.request("/v1/messages", postJson(withImage));
  assert.notEqual(res.status, 200);
  assert.equal(text.apiRequests.length, 0);
});

test("text request never reaches the vision pool", async (t) => {
  const { text, v1, v2, router } = await setup(t, { vision1Status: 200, vision2Status: 200 });
  const res = await router.request("/v1/messages", postJson(textOnly));
  assert.equal(res.status, 200);
  assert.equal(text.apiRequests.length, 1);
  assert.equal(v1.apiRequests.length, 0);
  assert.equal(v2.apiRequests.length, 0);
});

test("vision targets use their own key and base URL", async (t) => {
  const v = await startMockUpstream(reply(200, "from-vision"));
  const text = await startMockUpstream(reply(200, "from-text"));
  const router = await startRouter({
    GROQ_API_KEYS: "text-key", GROQ_MODELS: "m", GROQ_BASE_URL: text.baseUrl,
    GROQ_VISION_API_KEYS: "vision-key", GROQ_VISION_MODELS: "vm", GROQ_VISION_BASE_URL: v.baseUrl
  });
  t.after(async () => { await router.close(); await text.close(); await v.close(); });
  const res = await router.request("/v1/messages", postJson(withImage));
  assert.equal(res.status, 200);
  assert.equal(text.apiRequests.length, 0);
  assert.equal(v.apiRequests.length, 1);
  assert.match(JSON.stringify(v.apiRequests[0].headers), /vision-key/);
});

test("no vision pool configured: images keep using the normal pool", async (t) => {
  const text = await startMockUpstream(reply(200, "from-text"));
  const router = await startRouter({ GROQ_API_KEYS: "k1", GROQ_MODELS: "text-model", GROQ_BASE_URL: text.baseUrl });
  t.after(async () => { await router.close(); await text.close(); });
  const res = await router.request("/v1/messages", postJson(withImage));
  assert.equal(res.status, 200);
  assert.equal(text.apiRequests.length, 1);
});
