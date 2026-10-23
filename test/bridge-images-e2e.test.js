import test from "node:test";
import assert from "node:assert/strict";
import { startMockUpstream } from "../test-helpers/mock-upstream.js";
import { startRouter, postJson } from "../test-helpers/router-harness.js";

/**
 * End-to-end cover for the image-bridging fix.
 *
 * The unit tests pin what each bridge converts or refuses. These pin what the
 * GATEWAY does with a refusal: a target that cannot carry the image must be
 * skipped in favour of one that can, and when none can the client must get an
 * actionable 400 rather than a plausible answer to a request whose image was
 * silently dropped.
 */

const completion = {
  id: "x",
  object: "chat.completion",
  model: "m",
  choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }]
};

const DATA_URL_IMAGE = [{ type: "image_url", image_url: { url: "data:image/png;base64,iVBORw0KGgo=" } }];
const REMOTE_URL_IMAGE = [{ type: "image_url", image_url: { url: "https://example.com/cat.png" } }];

const imageRequest = (content) => postJson({ messages: [{ role: "user", content }] });
const posts = (mock) => mock.requests.filter((r) => r.method === "POST");

/**
 * Image input is a DECLARED capability of one model, not membership of a vision
 * pool. Declaring it makes a model a candidate; whether its ADAPTER can carry a
 * particular image (a remote URL, say) is a second, separate check.
 */
const IMAGE_CAPABILITIES = ["text_input", "text_output", "image_input"];
async function declareImageInput(router, provider, model) {
  const response = await router.request("/api/model-config", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ provider, model, capabilities: IMAGE_CAPABILITIES })
  });
  assert.ok(response.status >= 200 && response.status < 300, `declaring ${provider}/${model}: ${response.status} ${await response.text()}`);
}

/** A Gemini-protocol provider plus an OpenAI-chat provider; both models declare image_input. */
async function startBoth(t, { gemini = true, groq = true } = {}) {
  const geminiMock = await startMockUpstream(() => ({ status: 200, body: { candidates: [{ content: { role: "model", parts: [{ text: "gemini" }] }, finishReason: "STOP" }] } }));
  const groqMock = await startMockUpstream(() => ({ status: 200, body: completion }));
  t.after(async () => { await geminiMock.close(); await groqMock.close(); });

  const env = {};
  if (gemini) {
    env.GEMINI_API_KEYS = "g0";
    env.GEMINI_MODELS = "gemini-model";
    env.GEMINI_BASE_URL = `${geminiMock.baseUrl}/v1beta`;
  }
  if (groq) {
    env.GROQ_API_KEYS = "q0";
    env.GROQ_MODELS = "groq-model";
    env.GROQ_BASE_URL = `${groqMock.baseUrl}/v1`;
  }

  const router = await startRouter(env);
  t.after(() => router.close());
  if (gemini) await declareImageInput(router, "gemini", "gemini-model");
  if (groq) await declareImageInput(router, "groq", "groq-model");
  return { router, geminiMock, groqMock };
}

test("a remote image URL falls back from the Gemini target to one that accepts it", async (t) => {
  const { router, geminiMock, groqMock } = await startBoth(t);

  const response = await router.request("/v1/chat/completions", imageRequest(REMOTE_URL_IMAGE));
  assert.equal(response.status, 200, await response.text());

  // Gemini cannot carry a remote URL, so it was never called — and the request
  // was not failed either, because another target could serve it.
  assert.equal(posts(geminiMock).length, 0, "the Gemini target should have been refused before any call");
  assert.equal(posts(groqMock).length, 1, "the OpenAI-compatible target should have answered");
  assert.equal(response.headers.get("x-multi-ai-provider"), "groq");

  // The image reached the provider intact.
  assert.match(posts(groqMock)[0].rawBody, /example\.com\/cat\.png/);
});

test("an inline base64 image still reaches the Gemini target (the refusal is not over-broad)", async (t) => {
  const { router, geminiMock, groqMock } = await startBoth(t);

  const response = await router.request("/v1/chat/completions", imageRequest(DATA_URL_IMAGE));
  assert.equal(response.status, 200, await response.text());

  // The Gemini target is first in configuration order, and it can carry inline
  // bytes, so it answers and the fallback is never reached.
  assert.equal(posts(geminiMock).length, 1);
  assert.equal(posts(groqMock).length, 0);
  assert.equal(response.headers.get("x-multi-ai-provider"), "gemini");
});

test("when no target can carry the image the client gets an actionable 400, not a silent answer", async (t) => {
  const { router, geminiMock } = await startBoth(t, { groq: false });

  const response = await router.request("/v1/chat/completions", imageRequest(REMOTE_URL_IMAGE));
  const payload = await response.json();
  assert.equal(response.status, 400, JSON.stringify(payload));
  const message = payload.error.message;
  // Actionable: says what is wrong and what to do about it.
  assert.match(message, /Gemini/);
  assert.match(message, /base64|data:/i);
  // And the attempt was recorded, so the operator can see why Gemini was skipped.
  assert.ok(Array.isArray(payload.error.failures) && payload.error.failures.length > 0, "no failure detail was reported");
  assert.ok(payload.error.failures.some((f) => f.provider === "gemini" && f.status === 400), JSON.stringify(payload.error.failures));

  // Crucially: the provider was never called with a request missing its image.
  assert.equal(posts(geminiMock).length, 0);
});

test("a refused image does not cool the provider down for later text traffic", async (t) => {
  const geminiMock = await startMockUpstream(() => ({ status: 200, body: { candidates: [{ content: { role: "model", parts: [{ text: "gemini" }] }, finishReason: "STOP" }] } }));
  const groqMock = await startMockUpstream(() => ({ status: 200, body: completion }));
  t.after(async () => { await geminiMock.close(); await groqMock.close(); });

  // One provider, one key list, one model list each. The same Gemini model
  // serves text and (by declaration) images, so it is a candidate for both.
  const router = await startRouter({
    GEMINI_API_KEYS: "g0",
    GEMINI_MODELS: "gemini-model",
    GEMINI_BASE_URL: `${geminiMock.baseUrl}/v1beta`,
    GROQ_API_KEYS: "q0",
    GROQ_MODELS: "groq-model",
    GROQ_BASE_URL: `${groqMock.baseUrl}/v1`
  });
  t.after(() => router.close());
  await declareImageInput(router, "gemini", "gemini-model");
  await declareImageInput(router, "groq", "groq-model");

  // The refusal must not be charged to the provider as a failure.
  const refused = await router.request("/v1/chat/completions", imageRequest(REMOTE_URL_IMAGE));
  assert.equal(refused.status, 200);

  const health = await (await router.request("/health")).json();
  const geminiRows = health.health.filter((row) => row.provider === "gemini");
  assert.ok(geminiRows.length > 0);
  for (const row of geminiRows) {
    assert.notEqual(row.status, "failed", "the Gemini target was marked failed by a request-level limitation");
    assert.equal(row.cooldownUntil, 0, "the Gemini target was cooled down by a request-level limitation");
  }

  // ...and it really is still usable for text. Automatic routing would prefer
  // groq (it just answered the image), so the request is PINNED to Gemini: the
  // pin is strict, so a 200 here proves Gemini itself accepted the text request.
  const geminiBefore = posts(geminiMock).length;
  const text = await router.request("/v1/chat/completions", postJson(
    { model: "gemini-model", messages: [{ role: "user", content: "hello" }] },
    { "x-multi-ai-pin-provider": "gemini" }
  ));
  assert.equal(text.status, 200, await text.text());
  assert.equal(posts(geminiMock).length, geminiBefore + 1, "Gemini still serves text after refusing an image it could not carry");
});
