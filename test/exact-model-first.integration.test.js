import test from "node:test";
import assert from "node:assert/strict";
import { startMockUpstream } from "../test-helpers/mock-upstream.js";
import { startRouter, postJson } from "../test-helpers/router-harness.js";

/**
 * HTTP-level proof of the exact-model-first guarantee for the three client
 * protocols that did not have one.
 *
 * `test/gemini-client-bridge.integration.test.js` covers the Gemini path; these
 * drive the same property through `/v1/messages`, `/v1/responses` and
 * `/v1/chat/completions`. The scenario is the one that used to break: the
 * session is made sticky on the *different-model* fallback, and then the exact
 * model is requested. Health ranking and session affinity used to be able to
 * promote that sticky fallback ahead of the available exact match.
 */

const anthropicReply = (text) => ({
  id: "msg_1",
  type: "message",
  role: "assistant",
  model: "upstream",
  content: [{ type: "text", text }],
  stop_reason: "end_turn",
  usage: { input_tokens: 1, output_tokens: 1 }
});

const responsesReply = (text) => ({
  id: "resp_1",
  object: "response",
  created_at: 0,
  model: "upstream",
  status: "completed",
  output: [{
    type: "message",
    id: "msg_item_1",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text, annotations: [] }]
  }]
});

const chatReply = (text) => ({
  id: "chatcmpl-1",
  object: "chat.completion",
  created: 0,
  model: "upstream",
  choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
});

/**
 * Each entry pairs a native provider (agentrouter for the Anthropic and
 * Responses protocols) with a chat-only provider reached through the bridge.
 * The native provider answers in the client's own shape; the chat-only one
 * always answers in chat shape because that is all it speaks.
 */
const PROTOCOLS = [
  {
    name: "anthropic",
    endpoint: "/v1/messages",
    request: (model) => ({ model, max_tokens: 32, messages: [{ role: "user", content: "hi" }] }),
    native: anthropicReply,
    exactProvider: "agentrouter",
    exactModel: "wanted-model",
    fallbackModel: "other-model",
    env: (exactUrl, fallbackUrl) => ({
      AGENTROUTER_API_KEYS: "ar-key",
      AGENTROUTER_MODELS: "wanted-model",
      AGENTROUTER_BASE_URL: exactUrl,
      OPENROUTER_API_KEYS: "orc-key",
      OPENROUTER_MODELS: "other-model",
      OPENROUTER_BASE_URL: fallbackUrl
    })
  },
  {
    name: "openai-responses",
    endpoint: "/v1/responses",
    request: (model) => ({ model, input: "hi" }),
    native: responsesReply,
    exactProvider: "agentrouter",
    exactModel: "wanted-model",
    fallbackModel: "other-model",
    env: (exactUrl, fallbackUrl) => ({
      AGENTROUTER_API_KEYS: "ar-key",
      AGENTROUTER_MODELS: "wanted-model",
      AGENTROUTER_BASE_URL: exactUrl,
      OPENROUTER_API_KEYS: "orc-key",
      OPENROUTER_MODELS: "other-model",
      OPENROUTER_BASE_URL: fallbackUrl
    })
  },
  {
    name: "openai-chat",
    endpoint: "/v1/chat/completions",
    request: (model) => ({ model, messages: [{ role: "user", content: "hi" }] }),
    native: chatReply,
    exactProvider: "groq",
    exactModel: "wanted-model",
    fallbackModel: "other-model",
    env: (exactUrl, fallbackUrl) => ({
      GROQ_API_KEYS: "groq-key",
      GROQ_MODELS: "wanted-model",
      GROQ_BASE_URL: exactUrl,
      OPENROUTER_API_KEYS: "orc-key",
      OPENROUTER_MODELS: "other-model",
      OPENROUTER_BASE_URL: fallbackUrl
    })
  }
];

for (const protocol of PROTOCOLS) {
  test(`${protocol.name}: an available exact match outranks the session's sticky fallback`, async (t) => {
    const exact = await startMockUpstream(() => ({ status: 200, body: protocol.native("from-exact") }));
    const fallback = await startMockUpstream(() => ({ status: 200, body: chatReply("from-other") }));
    const router = await startRouter(protocol.env(exact.baseUrl, fallback.baseUrl));
    t.after(async () => {
      await router.close();
      await exact.close();
      await fallback.close();
    });

    const session = { "x-multi-ai-session-id": `exact-first-${protocol.name}` };

    // 1. Ask for a model only the fallback serves, so the session goes sticky.
    const first = await router.request(protocol.endpoint, postJson(protocol.request(protocol.fallbackModel), session));
    assert.equal(first.status, 200);
    assert.equal(fallback.apiRequests.length, 1, "the first request is served by the fallback");
    assert.equal(exact.apiRequests.length, 0, "the exact provider is not touched by the fallback's model");

    // 2. Ask for the exact model. The sticky fallback must not preempt it.
    const second = await router.request(protocol.endpoint, postJson(protocol.request(protocol.exactModel), session));

    assert.equal(second.status, 200);
    assert.equal(
      second.headers.get("x-multi-ai-provider"),
      protocol.exactProvider,
      "the exact model's own provider must serve the request"
    );
    assert.equal(exact.apiRequests.length, 1, "the exact provider is tried");
    assert.equal(
      fallback.apiRequests.length,
      1,
      "the sticky fallback must not receive a second request while an exact match is available"
    );
  });

  test(`${protocol.name}: the exact provider is reached first, before any different model`, async (t) => {
    const exact = await startMockUpstream(() => ({ status: 200, body: protocol.native("from-exact") }));
    const fallback = await startMockUpstream(() => ({ status: 200, body: chatReply("from-other") }));
    const router = await startRouter(protocol.env(exact.baseUrl, fallback.baseUrl));
    t.after(async () => {
      await router.close();
      await exact.close();
      await fallback.close();
    });

    const res = await router.request(protocol.endpoint, postJson(protocol.request(protocol.exactModel)));

    assert.equal(res.status, 200);
    assert.equal(exact.apiRequests.length, 1);
    assert.equal(fallback.apiRequests.length, 0, "no fallback should be consulted when the exact match succeeds");
  });
}

test("anthropic: a 400 from the exact provider is returned and the fallback is never tried", async (t) => {
  // The unit-level policy is covered in test/router.test.js; this confirms it
  // survives the whole HTTP path, status code included.
  const exact = await startMockUpstream(() => ({
    status: 400,
    body: { type: "error", error: { type: "invalid_request_error", message: "bad request" } }
  }));
  const fallback = await startMockUpstream(() => ({ status: 200, body: chatReply("from-other") }));
  const router = await startRouter({
    AGENTROUTER_API_KEYS: "ar-key",
    AGENTROUTER_MODELS: "wanted-model",
    AGENTROUTER_BASE_URL: exact.baseUrl,
    OPENROUTER_API_KEYS: "orc-key",
    OPENROUTER_MODELS: "other-model",
    OPENROUTER_BASE_URL: fallback.baseUrl
  });
  t.after(async () => {
    await router.close();
    await exact.close();
    await fallback.close();
  });

  const res = await router.request(
    "/v1/messages",
    postJson({ model: "wanted-model", max_tokens: 32, messages: [{ role: "user", content: "hi" }] })
  );

  assert.equal(res.status, 400, "the exact provider's status is surfaced unchanged");
  assert.equal(exact.apiRequests.length, 1);
  assert.equal(fallback.apiRequests.length, 0, "a non-retryable failure must not fall back");
});
