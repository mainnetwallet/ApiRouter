import test from "node:test";
import assert from "node:assert/strict";

import { startRouter, postJson } from "../test-helpers/router-harness.js";
import { startUpstream, chatJsonReply, PNG_BYTES } from "../test-helpers/http-upstream.js";

const PNG64 = PNG_BYTES.toString("base64");
const geminiReply = JSON.stringify({ candidates: [{ content: { role: "model", parts: [{ text: "seen" }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 } });
const reply = (body) => (req, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end(body); };

// ---- text-only configuration: nothing multimodal may ever reach it ----------

async function textOnly(t) {
  const text = await startUpstream(reply(chatJsonReply("text")));
  const router = await startRouter({ GROQ_API_KEYS: "sk-groq-test-key-1", GROQ_MODELS: "text-model", GROQ_BASE_URL: `${text.url}/v1` });
  t.after(async () => { await router.close(); await text.close(); });
  return { router, text };
}

const MEDIA_REQUESTS = {
  "Anthropic image": ["/v1/messages", { messages: [{ role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: PNG64 } }] }] }],
  "Anthropic PDF document": ["/v1/messages", { messages: [{ role: "user", content: [{ type: "document", source: { type: "base64", media_type: "application/pdf", data: PNG64 } }] }] }],
  "Anthropic tool_result image": ["/v1/messages", { messages: [{ role: "assistant", content: [{ type: "tool_use", id: "t", name: "n", input: {} }] }, { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: PNG64 } }] }] }] }],
  "Chat image_url": ["/v1/chat/completions", { messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "https://e.test/i.png" } }] }, { role: "assistant", content: "ok" }, { role: "user", content: "and?" }] }],
  "Chat file part": ["/v1/chat/completions", { messages: [{ role: "user", content: [{ type: "file", file: { file_id: "f" } }] }] }],
  "Chat input_audio": ["/v1/chat/completions", { messages: [{ role: "user", content: [{ type: "input_audio", input_audio: { data: PNG64, format: "wav" } }] }] }],
  "Responses input_image": ["/v1/responses", { input: [{ type: "message", role: "user", content: [{ type: "input_image", image_url: "https://e.test/i.png" }] }] }],
  "Responses input_file": ["/v1/responses", { input: [{ type: "message", role: "user", content: [{ type: "input_file", file_id: "f" }] }] }],
  "Gemini inlineData image": ["/v1beta/models/text-model:generateContent", { contents: [{ role: "user", parts: [{ inlineData: { mimeType: "image/png", data: PNG64 } }] }] }],
  "Gemini inlineData video": ["/v1beta/models/text-model:generateContent", { contents: [{ role: "user", parts: [{ inlineData: { mimeType: "video/mp4", data: PNG64 } }] }] }],
  "Gemini inlineData pdf": ["/v1beta/models/text-model:generateContent", { contents: [{ role: "user", parts: [{ inlineData: { mimeType: "application/pdf", data: PNG64 } }] }] }],
  "Gemini fileData without mimeType": ["/v1beta/models/text-model:generateContent", { contents: [{ role: "user", parts: [{ fileData: { fileUri: "https://e.test/i.png" } }] }] }],
  "Gemini snake_case inline_data": ["/v1beta/models/text-model:generateContent", { contents: [{ role: "user", parts: [{ inline_data: { mime_type: "image/png", data: PNG64 } }] }] }]
};

for (const [label, [path, body]] of Object.entries(MEDIA_REQUESTS)) {
  test(`no vision route: ${label} -> 503 no_vision_route, and the text provider is never called`, async (t) => {
    const { router, text } = await textOnly(t);
    const response = await router.request(path, postJson(body));
    assert.equal(response.status, 503);
    assert.equal((await response.json()).error.type, "no_vision_route");
    assert.equal(text.calls.length, 0);
  });
}

// ---- both pools configured: media goes to the vision pool only ----------------

async function bothPools(t, visionHandler) {
  const text = await startUpstream(reply(chatJsonReply("text")));
  const vision = await startUpstream(visionHandler ?? reply(chatJsonReply("vision")));
  const router = await startRouter({
    GROQ_API_KEYS: "sk-groq-test-key-1", GROQ_MODELS: "text-model", GROQ_BASE_URL: `${text.url}/v1`,
    OPENROUTER_VISION_API_KEYS: "sk-or-vision-key-1", OPENROUTER_VISION_MODELS: "vision-model", OPENROUTER_VISION_BASE_URL: `${vision.url}/v1`
  });
  t.after(async () => { await router.close(); await text.close(); await vision.close(); });
  return { router, text, vision };
}

test("with a vision pool, every media kind goes to it and never to the text pool", async (t) => {
  const { router, text, vision } = await bothPools(t);
  for (const [label, [path, body]] of Object.entries(MEDIA_REQUESTS)) {
    const callsBefore = vision.calls.length;
    const response = await router.request(path, postJson(body));
    // Some translations legitimately refuse (a chat provider cannot take video): that is a 4xx, never a text fallback.
    assert.ok([200, 400].includes(response.status), `${label}: ${response.status}`);
    if (response.status === 200) assert.equal(vision.calls.length, callsBefore + 1, `${label} reached the vision pool`);
  }
  assert.equal(text.calls.length, 0, "no media request ever fell back to the text pool");
});

test("media a chat-compatible vision provider cannot take is a 400 for the client, not a silent drop or a text fallback", async (t) => {
  const { router, text, vision } = await bothPools(t);
  const response = await router.request("/v1beta/models/m:generateContent", postJson(MEDIA_REQUESTS["Gemini inlineData video"][1]));
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error.type, "unsupported_media");
  assert.equal(vision.calls.length, 0);
  assert.equal(text.calls.length, 0);
});

test("a plain text request still never reaches the vision pool", async (t) => {
  const { router, text, vision } = await bothPools(t);
  const response = await router.request("/v1/chat/completions", postJson({ messages: [{ role: "user", content: "hello" }] }));
  assert.equal(response.status, 200);
  assert.equal(text.calls.length, 1);
  assert.equal(vision.calls.length, 0);
});

// ---- remote image URLs for a Gemini vision provider ---------------------------------

const REMOTE = { REMOTE_IMAGE_ALLOW_HTTP: "1", REMOTE_IMAGE_ALLOW_PRIVATE_NETWORK: "1" };

async function geminiVision(t, env = REMOTE, imageHandler) {
  const gemini = await startUpstream(reply(geminiReply));
  const images = await startUpstream(imageHandler ?? ((req, res) => { res.writeHead(200, { "content-type": "image/png" }); res.end(PNG_BYTES); }));
  const router = await startRouter({
    GEMINI_VISION_API_KEYS: "gemini-vision-key-1", GEMINI_VISION_MODELS: "gemini-vision-model", GEMINI_VISION_BASE_URL: `${gemini.url}/v1beta`,
    ...env
  });
  t.after(async () => { await router.close(); await gemini.close(); await images.close(); });
  return { router, gemini, images };
}
const imageRequests = (url) => ({
  anthropic: ["/v1/messages", { max_tokens: 10, messages: [{ role: "user", content: [{ type: "text", text: "look" }, { type: "image", source: { type: "url", url } }] }] }],
  chat: ["/v1/chat/completions", { messages: [{ role: "user", content: [{ type: "text", text: "look" }, { type: "image_url", image_url: { url } }] }] }],
  responses: ["/v1/responses", { input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "look" }, { type: "input_image", image_url: url }] }] }]
});

for (const protocol of ["anthropic", "chat", "responses"]) {
  test(`remote image URL (${protocol} client) reaches a Gemini provider as inlineData — nothing dropped`, async (t) => {
    const { router, gemini, images } = await geminiVision(t);
    const [path, body] = imageRequests(`${images.url}/img/cat.png`)[protocol];
    const response = await router.request(path, postJson(body));
    assert.equal(response.status, 200);
    assert.equal(gemini.calls.length, 1);
    assert.equal(gemini.calls[0].url, "/v1beta/models/gemini-vision-model:generateContent", "one /v1beta even though the base URL already ended in /v1beta");
    const parts = gemini.calls[0].body.contents[0].parts;
    assert.deepEqual(parts.find((p) => p.inlineData).inlineData, { mimeType: "image/png", data: PNG64 });
    assert.equal(parts.filter((p) => p.inlineData).length, 1);
  });
}

test("a remote image that cannot be fetched is a 400 — the request is never sent without it", async (t) => {
  const { router, gemini } = await geminiVision(t, REMOTE, (req, res) => { res.writeHead(404); res.end(); });
  const [path, body] = imageRequests("http://127.0.0.1:1/img/missing.png").anthropic;
  const response = await router.request(path, postJson(body));
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error.type, "unsupported_media");
  assert.equal(gemini.calls.length, 0);
});

test("by default the router will not fetch images from private or loopback addresses (SSRF)", async (t) => {
  const { router, gemini, images } = await geminiVision(t, {});
  const [path, body] = imageRequests(`${images.url}/img/cat.png`).chat;
  const response = await router.request(path, postJson(body));
  assert.equal(response.status, 400);
  assert.equal(images.calls.length, 0, "the internal address was never contacted");
  assert.equal(gemini.calls.length, 0);

  for (const url of ["https://169.254.169.254/latest/meta-data/", "https://[::1]/x.png", "https://10.0.0.1/x.png"]) {
    const refused = await router.request(...(() => { const [p, b] = imageRequests(url).anthropic; return [p, postJson(b)]; })());
    assert.equal(refused.status, 400, url);
  }
});

test("a chat-compatible provider that accepts URLs natively still gets the original URL", async (t) => {
  const { router, vision } = await bothPools(t);
  const url = "https://example.test/cat.png";
  const [path, body] = imageRequests(url).anthropic;
  const response = await router.request(path, postJson(body));
  assert.equal(response.status, 200);
  assert.equal(vision.calls[0].body.messages[0].content.find((p) => p.type === "image_url").image_url.url, url);
});
