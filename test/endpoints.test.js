import test from "node:test";
import assert from "node:assert/strict";
import { startMockUpstream } from "../test-helpers/mock-upstream.js";
import { startRouter, postJson } from "../test-helpers/router-harness.js";

/**
 * Contract tests for the gateway endpoints that the audit called out:
 *
 *  H — `/v1/messages/count_tokens` must honour the configured body cap.
 *  C — `/v1/models` discovery, its de-duplication, and what a text request
 *      naming a vision-only model is allowed to do.
 *  J — which endpoints are public, pinned so the documented split cannot drift.
 */

const jsonOk = (body = {}) => ({ status: 200, body });

const chatBody = (model, content = "hello") => ({ model, messages: [{ role: "user", content }] });
const imageContent = [
  { type: "text", text: "what is this?" },
  { type: "image_url", image_url: { url: "data:image/png;base64,iVBORw0KGgo=" } }
];

// ------------------------------------------------------------------ H

test("count_tokens enforces the configured MAX_REQUEST_BODY_BYTES", async () => {
  const mock = await startMockUpstream(() => jsonOk());
  const router = await startRouter({
    MAX_REQUEST_BODY_BYTES: "512",
    GROQ_API_KEYS: "k0",
    GROQ_MODELS: "m",
    GROQ_BASE_URL: `${mock.baseUrl}/v1`
  });
  try {
    // A body comfortably over the configured cap. The hard-coded default is
    // 10 MiB, so before the fix this endpoint accepted it.
    const oversized = JSON.stringify({ model: "m", messages: [{ role: "user", content: "x".repeat(4000) }] });
    assert.ok(oversized.length > 512);

    const countResponse = await router.request("/v1/messages/count_tokens", postJson(oversized));
    assert.equal(countResponse.status, 413, "count_tokens ignored the configured body cap");
    const payload = await countResponse.json();
    assert.equal(payload.error.type, "invalid_request_error");
    assert.match(payload.error.message, /maximum allowed size/i);

    // The proxy path enforces the same cap, which is what count_tokens must match.
    const proxyResponse = await router.request("/v1/messages", postJson(oversized));
    assert.equal(proxyResponse.status, 413);

    // A body under the cap is still served normally.
    const small = await router.request("/v1/messages/count_tokens", postJson(chatBody("m", "short")));
    assert.equal(small.status, 200);
    const tokens = await small.json();
    assert.equal(typeof tokens.input_tokens, "number");
    assert.ok(tokens.input_tokens > 0);
  } finally {
    await router.close();
    await mock.close();
  }
});

test("count_tokens still serves a small body under the default cap", async () => {
  const router = await startRouter({});
  try {
    const response = await router.request("/v1/messages/count_tokens", postJson(chatBody("m")));
    assert.equal(response.status, 200);
    assert.ok((await response.json()).input_tokens > 0);
  } finally {
    await router.close();
  }
});

// ------------------------------------------------------------------ C

test("/v1/models lists both pools, de-duplicates overlapping ids, and is stable", async () => {
  const mock = await startMockUpstream(() => jsonOk());
  const router = await startRouter({
    GROQ_API_KEYS: "t0",
    GROQ_MODELS: "shared,m-text",
    GROQ_BASE_URL: `${mock.baseUrl}/v1`,
    GROQ_VISION_API_KEYS: "v0",
    GROQ_VISION_MODELS: "shared,m-vision",
    GROQ_VISION_BASE_URL: `${mock.baseUrl}/v1`
  });
  try {
    const response = await router.request("/v1/models");
    assert.equal(response.status, 200);
    const payload = await response.json();

    const ids = payload.data.map((entry) => entry.id);
    // A model configured for both pools appears once: clients choke on duplicates.
    assert.equal(ids.length, new Set(ids).size, `duplicate model ids: ${JSON.stringify(ids)}`);
    // Discovery spans both pools, so a vision-only model is listed too.
    assert.deepEqual([...ids].sort(), ["m-text", "m-vision", "shared"]);
    assert.equal(payload.object, "list");
    assert.equal(payload.has_more, false);
    for (const entry of payload.data) {
      assert.equal(entry.object, "model");
      assert.equal(typeof entry.provider, "string");
      assert.ok(entry.provider.length > 0);
    }
  } finally {
    await router.close();
    await mock.close();
  }
});

test("a text request naming a vision-only model widens instead of failing (documented behaviour)", async () => {
  const mock = await startMockUpstream(() => jsonOk({ id: "x", object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" }] }));
  const router = await startRouter({
    GROQ_API_KEYS: "t0",
    GROQ_MODELS: "m-text",
    GROQ_BASE_URL: `${mock.baseUrl}/v1`,
    GROQ_VISION_API_KEYS: "v0",
    GROQ_VISION_MODELS: "m-vision",
    GROQ_VISION_BASE_URL: `${mock.baseUrl}/v1`
  });
  try {
    // capabilities.js documents this as intentional: the model is simply never
    // selected and the request widens to the compatible text targets.
    const response = await router.request("/v1/chat/completions", postJson(chatBody("m-vision")));
    assert.equal(response.status, 200);
  } finally {
    await router.close();
    await mock.close();
  }
});

test("an image request naming a text-only model is rejected, not silently re-routed", async () => {
  const mock = await startMockUpstream(() => jsonOk({ id: "x", object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" }] }));
  const router = await startRouter({
    GROQ_API_KEYS: "t0",
    GROQ_MODELS: "m-text",
    GROQ_BASE_URL: `${mock.baseUrl}/v1`,
    GROQ_VISION_API_KEYS: "v0",
    GROQ_VISION_MODELS: "m-vision",
    GROQ_VISION_BASE_URL: `${mock.baseUrl}/v1`
  });
  try {
    const response = await router.request("/v1/chat/completions", postJson({ model: "m-text", messages: [{ role: "user", content: imageContent }] }));
    assert.equal(response.status, 400);
    const payload = await response.json();
    assert.equal(payload.error.type, "model_not_vision_capable");
    assert.equal(payload.error.model, "m-text");
    assert.equal(payload.error.required_capability, "vision");
  } finally {
    await router.close();
    await mock.close();
  }
});

// ------------------------------------------------------------------ J

test("with a client token configured, /health and /v1/models stay public and the proxies do not", async () => {
  const mock = await startMockUpstream(() => jsonOk());
  const router = await startRouter({
    APIROUTER_API_KEYS: "tok",
    GROQ_API_KEYS: "k0",
    GROQ_MODELS: "m",
    GROQ_BASE_URL: `${mock.baseUrl}/v1`
  });
  try {
    // Public by design: a liveness probe and model discovery must answer before
    // a client can present a credential.
    assert.equal((await router.request("/health")).status, 200);
    assert.equal((await router.request("/v1/models")).status, 200);

    // Everything else that can spend a provider credential requires the token.
    assert.equal((await router.request("/v1/messages", postJson(chatBody("m")))).status, 401);
    assert.equal((await router.request("/v1/models/count_tokens", postJson(chatBody("m")))).status, 404);
    assert.equal((await router.request("/v1/messages/count_tokens", postJson(chatBody("m")))).status, 401);
    assert.equal((await router.request("/v1/chat/completions", postJson(chatBody("m")))).status, 401);
    assert.equal((await router.request("/api/health")).status, 401);

    // The wrong token is rejected; the right one is accepted.
    const wrong = await router.request("/v1/chat/completions", postJson(chatBody("m"), { authorization: "Bearer nope" }));
    assert.equal(wrong.status, 401);
    const right = await router.request("/v1/chat/completions", postJson(chatBody("m"), { authorization: "Bearer tok" }));
    assert.equal(right.status, 200);
  } finally {
    await router.close();
    await mock.close();
  }
});

test("/health keeps credentials out of its payload while a token is configured", async () => {
  const mock = await startMockUpstream(() => jsonOk());
  const router = await startRouter({
    APIROUTER_API_KEYS: "secret-router-token",
    GROQ_API_KEYS: "secret-provider-key",
    GROQ_MODELS: "m",
    GROQ_BASE_URL: `${mock.baseUrl}/v1`
  });
  try {
    const raw = await (await router.request("/health")).text();
    assert.ok(!raw.includes("secret-provider-key"), "/health leaked a provider key");
    assert.ok(!raw.includes("secret-router-token"), "/health leaked the router token");
  } finally {
    await router.close();
    await mock.close();
  }
});
