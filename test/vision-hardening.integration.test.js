import test from "node:test";
import assert from "node:assert/strict";

import { startRouter, postJson } from "../test-helpers/router-harness.js";
import { startUpstream, chatJsonReply } from "../test-helpers/http-upstream.js";

const B64 = "AAAA";
const json = (reply) => (req, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end(reply); };

const MEDIA_REQUESTS = {
  "Anthropic document (PDF)": ["/v1/messages", { max_tokens: 5, messages: [{ role: "user", content: [{ type: "document", source: { type: "base64", media_type: "application/pdf", data: B64 } }] }] }],
  "Chat file part": ["/v1/chat/completions", { messages: [{ role: "user", content: [{ type: "file", file: { filename: "a.pdf", file_data: `data:application/pdf;base64,${B64}` } }] }] }],
  "Chat input_audio": ["/v1/chat/completions", { messages: [{ role: "user", content: [{ type: "input_audio", input_audio: { data: B64, format: "wav" } }] }] }],
  "Responses input_file": ["/v1/responses", { input: [{ type: "message", role: "user", content: [{ type: "input_file", file_id: "file-1" }] }] }],
  "Responses input_image": ["/v1/responses", { input: [{ type: "message", role: "user", content: [{ type: "input_image", image_url: "https://example.test/a.png" }] }] }],
  "Gemini video inlineData": ["/v1beta/models/m:generateContent", { contents: [{ role: "user", parts: [{ inlineData: { mimeType: "video/mp4", data: B64 } }] }] }],
  "Gemini PDF inlineData": ["/v1beta/models/m:generateContent", { contents: [{ role: "user", parts: [{ inlineData: { mimeType: "application/pdf", data: B64 } }] }] }],
  "Gemini fileData without mimeType": ["/v1beta/models/m:generateContent", { contents: [{ role: "user", parts: [{ fileData: { fileUri: "https://example.test/a" } }] }] }],
  "Gemini snake_case inline_data": ["/v1beta/models/m:generateContent", { contents: [{ role: "user", parts: [{ inline_data: { mime_type: "image/png", data: B64 } }] }] }],
  "Gemini image in a tool response": ["/v1beta/models/m:generateContent", { contents: [
    { role: "model", parts: [{ functionCall: { name: "shot", args: {} } }] },
    { role: "user", parts: [{ functionResponse: { name: "shot", response: {}, parts: [{ inlineData: { mimeType: "image/png", data: B64 } }] } }] }
  ] }]
};

test("without a vision route, every kind of attachment gets 503 no_vision_route and never reaches a text provider", async (t) => {
  const text = await startUpstream(json(chatJsonReply("from-text")));
  const router = await startRouter({ GROQ_API_KEYS: "sk-groq-test-key-1", GROQ_MODELS: "text-model", GROQ_BASE_URL: `${text.url}/v1` });
  t.after(async () => { await router.close(); await text.close(); });
  for (const [label, [path, body]] of Object.entries(MEDIA_REQUESTS)) {
    const res = await router.request(path, postJson(body));
    const payload = await res.json();
    assert.equal(res.status, 503, label);
    assert.equal(payload.error.type, "no_vision_route", label);
  }
  assert.equal(text.calls.length, 0, "the text provider was never called");
  // ... and plain text still works, so the 503s above were about the attachments.
  const plain = await router.request("/v1/chat/completions", postJson({ messages: [{ role: "user", content: "hi" }] }));
  assert.equal(plain.status, 200);
});

test("with both pools, attachment requests are served by the vision pool only, text requests by the text pool only", async (t) => {
  const text = await startUpstream(json(chatJsonReply("from-text")));
  const vision = await startUpstream(json(chatJsonReply("from-vision")));
  const router = await startRouter({
    GROQ_API_KEYS: "sk-groq-test-key-1", GROQ_MODELS: "text-model", GROQ_BASE_URL: `${text.url}/v1`,
    MISTRAL_VISION_API_KEYS: "sk-mistral-test-1", MISTRAL_VISION_MODELS: "vision-model", MISTRAL_VISION_BASE_URL: `${vision.url}/v1`
  });
  t.after(async () => { await router.close(); await text.close(); await vision.close(); });

  // Attachments that a chat-compatible vision provider can take (images) are served; others are a clear 4xx, never the text pool.
  const image = await router.request("/v1/chat/completions", postJson({ messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "https://example.test/a.png" } }] }] }));
  assert.equal(image.status, 200);
  assert.equal(image.headers.get("x-multi-ai-provider"), "mistral");
  const pdf = await router.request("/v1/messages", postJson(MEDIA_REQUESTS["Anthropic document (PDF)"][1]));
  assert.equal(pdf.status, 400, "a PDF a chat provider cannot carry is refused, not handed to the text pool");
  assert.equal((await pdf.json()).error.type, "unsupported_media");
  assert.equal(text.calls.length, 0, "no attachment request ever reached the text provider");

  const plain = await router.request("/v1/chat/completions", postJson({ messages: [{ role: "user", content: "hi" }] }));
  assert.equal(plain.headers.get("x-multi-ai-provider"), "groq");
  assert.equal(vision.calls.length, 1, "the text request did not go to the vision pool");
});

test("an unsupported media type is refused by every vision target: the client gets a 4xx explaining why, with no health penalty", async (t) => {
  const vision = await startUpstream(json(chatJsonReply("from-vision")));
  const router = await startRouter({ MISTRAL_VISION_API_KEYS: "sk-mistral-test-1", MISTRAL_VISION_MODELS: "vision-model", MISTRAL_VISION_BASE_URL: `${vision.url}/v1` });
  t.after(async () => { await router.close(); await vision.close(); });
  const res = await router.request("/v1beta/models/m:generateContent", postJson(MEDIA_REQUESTS["Gemini PDF inlineData"][1]));
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.error.type, "unsupported_media");
  assert.match(body.error.message, /cannot be forwarded/);
  assert.equal(vision.calls.length, 0);
  const health = (await (await router.request("/api/health")).json()).targets.find((x) => x.provider === "mistral");
  assert.equal(health.failures, 0, "a request the target cannot take is not a target failure");
});
