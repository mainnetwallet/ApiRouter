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

async function setup(t, { textStatus = 200, vision1Status = 429, vision2Status = 200 } = {}) {
  const text = await startMockUpstream(() => ({ status: textStatus, body: textStatus === 200 ? chatReply("from-text") : { error: { message: "x" } } }));
  const v1 = await startMockUpstream(() => ({ status: vision1Status, body: vision1Status === 200 ? chatReply("from-v1") : { error: { message: "x" } } }));
  const v2 = await startMockUpstream(() => ({ status: vision2Status, body: vision2Status === 200 ? chatReply("from-v2") : { error: { message: "x" } } }));
  const router = await startRouter({
    GROQ_API_KEYS: "k1", GROQ_MODELS: "text-model", GROQ_BASE_URL: text.baseUrl,
    OPENROUTER_API_KEYS: "k2", OPENROUTER_MODELS: "vision-1", OPENROUTER_BASE_URL: v1.baseUrl,
    MISTRAL_API_KEYS: "k3", MISTRAL_MODELS: "vision-2", MISTRAL_BASE_URL: v2.baseUrl,
    VISION_MODELS: "vision-1,vision-2"
  });
  t.after(async () => { await router.close(); await text.close(); await v1.close(); await v2.close(); });
  return { text, v1, v2, router };
}

test("image request: text-only model is never tried; a failing vision model falls back to the next vision model", async (t) => {
  const { text, v1, v2, router } = await setup(t);
  // Asking for vision-1 makes it the first target, so the fallback path is deterministic.
  const res = await router.request("/v1/messages", postJson({ ...withImage, model: "vision-1" }));
  assert.equal(res.status, 200);
  assert.equal(text.apiRequests.length, 0, "text-only model must not receive an image request");
  assert.equal(v1.apiRequests.length, 1, "first vision model is tried (and fails with 429)");
  assert.equal(v2.apiRequests.length, 1, "next vision model answers");
});

test("image request: when every vision model fails, the text-only model is still not used", async (t) => {
  const { text, router } = await setup(t, { vision2Status: 500 });
  const res = await router.request("/v1/messages", postJson(withImage));
  assert.notEqual(res.status, 200);
  assert.equal(text.apiRequests.length, 0);
});

test("text-only request: all models stay eligible, exactly as before", async (t) => {
  const { text, router } = await setup(t, { vision1Status: 500, vision2Status: 500 });
  const res = await router.request("/v1/messages", postJson(textOnly));
  assert.equal(res.status, 200, "falls through the failing vision models to the text model");
  assert.equal(text.apiRequests.length, 1);
});

test("image request with no configured vision target gets a clear 503", async (t) => {
  const text = await startMockUpstream(() => ({ status: 200, body: chatReply("from-text") }));
  const router = await startRouter({
    GROQ_API_KEYS: "k1", GROQ_MODELS: "text-model", GROQ_BASE_URL: text.baseUrl,
    VISION_MODELS: "some-other-vision-model"
  });
  t.after(async () => { await router.close(); await text.close(); });
  const res = await router.request("/v1/messages", postJson(withImage));
  assert.equal(res.status, 503);
  assert.equal(text.apiRequests.length, 0);
});
