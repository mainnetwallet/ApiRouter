import test from "node:test";
import assert from "node:assert/strict";
import { startMockUpstream } from "../test-helpers/mock-upstream.js";
import { startRouter, postJson } from "../test-helpers/router-harness.js";
import { toGeminiFromChat } from "../src/chat-bridge.js";
import { toGeminiRequest, toOpenAIChatRequest } from "../src/anthropic-bridge.js";
import { toGeminiFromResponses, toOpenAIChatFromResponses } from "../src/codex-bridge.js";

/**
 * Silent multimodal content loss.
 *
 * OpenAI Chat `input_audio` / `file`, Anthropic `document` and OpenAI Responses
 * `input_audio` used to be filtered out by the bridge translations while the
 * request still answered 200. Every such part is now refused with a typed,
 * retryable, no-cooldown 400 `unsupported_content`, before anything is sent
 * upstream. Same-protocol targets still carry the parts untouched.
 */
const refuses = (fn) => assert.throws(fn, (error) => {
  assert.equal(error.status, 400, error.message);
  assert.equal(error.errorType, "unsupported_content");
  assert.equal(error.retryable, true, "a target speaking the client's protocol may carry it");
  assert.equal(error.skipCooldown, true, "a request-shape mismatch must not cool a healthy target");
  return true;
});

const audioPart = { type: "input_audio", input_audio: { data: "QUJD", format: "wav" } };
const filePart = { type: "file", file: { filename: "a.pdf", file_data: "data:application/pdf;base64,QUJD" } };
const documentBlock = { type: "document", source: { type: "base64", media_type: "application/pdf", data: "QUJD" } };
const responsesAudio = { type: "input_audio", input_audio: { data: "QUJD", format: "wav" } };

const chatUser = (...content) => ({ messages: [{ role: "user", content }] });
const anthropicUser = (...content) => ({ messages: [{ role: "user", content }] });
const responsesUser = (...content) => ({ input: [{ type: "message", role: "user", content }] });

// ---------------------------------------------------------------------------
// 1 + 2. Each affected type is rejected, never silently removed
// ---------------------------------------------------------------------------

test("OpenAI Chat input_audio is refused for Gemini, even next to text", () => {
  refuses(() => toGeminiFromChat(chatUser(audioPart)));
  refuses(() => toGeminiFromChat(chatUser({ type: "text", text: "transcribe" }, audioPart)));
});

test("OpenAI Chat file is refused for Gemini, even next to text", () => {
  refuses(() => toGeminiFromChat(chatUser(filePart)));
  refuses(() => toGeminiFromChat(chatUser({ type: "text", text: "summarise" }, filePart)));
});

test("OpenAI Chat input_audio / file are refused in system and tool-result content too", () => {
  refuses(() => toGeminiFromChat({ messages: [{ role: "system", content: [audioPart] }] }));
  refuses(() => toGeminiFromChat({ messages: [{ role: "tool", tool_call_id: "c1", content: [filePart] }] }));
});

test("Anthropic document is refused for Gemini", () => {
  refuses(() => toGeminiRequest(anthropicUser(documentBlock)));
  refuses(() => toGeminiRequest(anthropicUser({ type: "text", text: "read it" }, documentBlock)));
});

test("Anthropic document is refused for OpenAI-compatible targets", () => {
  refuses(() => toOpenAIChatRequest(anthropicUser(documentBlock), "m"));
  refuses(() => toOpenAIChatRequest(anthropicUser({ type: "text", text: "read it" }, documentBlock), "m"));
});

test("an Anthropic document inside a tool result or system block is refused", () => {
  const toolResult = { type: "tool_result", tool_use_id: "t1", content: [documentBlock] };
  refuses(() => toGeminiRequest(anthropicUser(toolResult)));
  refuses(() => toOpenAIChatRequest(anthropicUser(toolResult), "m"));
  refuses(() => toGeminiRequest({ system: [documentBlock], messages: [{ role: "user", content: "hi" }] }));
});

test("Responses input_audio is refused for Gemini and for OpenAI-compatible targets", () => {
  refuses(() => toGeminiFromResponses(responsesUser(responsesAudio)));
  refuses(() => toGeminiFromResponses(responsesUser({ type: "input_text", text: "listen" }, responsesAudio)));
  refuses(() => toOpenAIChatFromResponses(responsesUser(responsesAudio), "m"));
  refuses(() => toOpenAIChatFromResponses(responsesUser({ type: "input_text", text: "listen" }, responsesAudio), "m"));
});

test("Responses input_audio is refused alongside an image and inside a tool output", () => {
  refuses(() => toOpenAIChatFromResponses(responsesUser(
    { type: "input_image", image_url: "https://cdn.test/a.png" }, responsesAudio
  ), "m"));
  refuses(() => toGeminiFromResponses({
    input: [{ type: "function_call_output", call_id: "c1", output: [responsesAudio] }]
  }));
});

// ---------------------------------------------------------------------------
// 4. Supported content is unchanged
// ---------------------------------------------------------------------------

test("text and base64 images still translate exactly as before", () => {
  const chat = toGeminiFromChat(chatUser(
    { type: "text", text: "see" },
    { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }
  ));
  assert.deepEqual(chat.contents[0].parts, [
    { text: "see" },
    { inlineData: { mimeType: "image/png", data: "AAAA" } }
  ]);

  const anthropic = toGeminiRequest(anthropicUser(
    { type: "text", text: "see" },
    { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "BBBB" } }
  ));
  assert.deepEqual(anthropic.contents[0].parts, [
    { text: "see" },
    { inlineData: { mimeType: "image/jpeg", data: "BBBB" } }
  ]);

  const openai = toOpenAIChatRequest(anthropicUser({ type: "text", text: "hi" }), "m");
  assert.deepEqual(openai.messages[0], { role: "user", content: "hi" });

  const responses = toOpenAIChatFromResponses(responsesUser({ type: "input_text", text: "hi" }), "m");
  assert.deepEqual(responses.messages[0], { role: "user", content: "hi" });
});

// ---------------------------------------------------------------------------
// 3 + 4. HTTP: refused content never reaches an upstream; same-protocol
// targets still carry it untouched
// ---------------------------------------------------------------------------

const geminiReply = { candidates: [{ content: { role: "model", parts: [{ text: "ok" }] }, finishReason: "STOP" }] };
const chatReply = {
  id: "chatcmpl-1",
  object: "chat.completion",
  choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
};

async function geminiOnly(t) {
  const gemini = await startMockUpstream(() => ({ status: 200, body: geminiReply }));
  const router = await startRouter({
    GEMINI_API_KEYS: "gk", GEMINI_MODELS: "gemini-flash", GEMINI_BASE_URL: gemini.baseUrl
  });
  t.after(async () => { await router.close(); await gemini.close(); });
  return { gemini, router };
}

async function chatAndGemini(t) {
  const gemini = await startMockUpstream(() => ({ status: 200, body: geminiReply }));
  const groq = await startMockUpstream(() => ({ status: 200, body: chatReply }));
  const router = await startRouter({
    GROQ_API_KEYS: "g-key", GROQ_MODELS: "llama-x", GROQ_BASE_URL: groq.baseUrl + "/v1",
    GEMINI_API_KEYS: "gk", GEMINI_MODELS: "gemini-flash", GEMINI_BASE_URL: gemini.baseUrl
  });
  t.after(async () => { await router.close(); await gemini.close(); await groq.close(); });
  return { gemini, groq, router };
}

for (const [name, part] of [["input_audio", audioPart], ["file", filePart]]) {
  test(`HTTP: Chat ${name} to a Gemini-only pool is a 400 and nothing is forwarded`, async (t) => {
    const { gemini, router } = await geminiOnly(t);
    const res = await router.request("/v1/chat/completions", postJson({
      model: "gemini-flash",
      messages: [{ role: "user", content: [{ type: "text", text: "go" }, part] }]
    }));
    const body = await res.json();

    assert.equal(res.status, 400);
    assert.equal(body.error.type, "unsupported_content");
    assert.equal(gemini.apiRequests.length, 0, "the stripped request must never be sent upstream");
  });

  test(`HTTP: Chat ${name} is carried verbatim by an OpenAI-compatible target`, async (t) => {
    const { gemini, groq, router } = await chatAndGemini(t);
    const res = await router.request("/v1/chat/completions", postJson({
      model: "llama-x",
      messages: [{ role: "user", content: [{ type: "text", text: "go" }, part] }]
    }));

    assert.equal(res.status, 200);
    assert.equal(gemini.apiRequests.length, 0);
    const [call] = groq.apiRequests;
    assert.ok(call, "the chat-completions target served the request");
    assert.deepEqual(call.body.messages[0].content[1], part, "the part is forwarded unchanged");
  });
}

test("HTTP: a refused Chat input_audio falls over to a chat target instead of being dropped for Gemini", async (t) => {
  const { gemini, groq, router } = await chatAndGemini(t);
  const res = await router.request("/v1/chat/completions", postJson({
    model: "gemini-flash",
    messages: [{ role: "user", content: [{ type: "text", text: "go" }, audioPart] }]
  }));

  assert.equal(res.status, 200);
  assert.equal(gemini.apiRequests.length, 0, "Gemini never received the audio-stripped request");
  assert.deepEqual(groq.apiRequests[0].body.messages[0].content[1], audioPart);
});

test("HTTP: Anthropic document to a Gemini-only pool is a 400 and nothing is forwarded", async (t) => {
  const { gemini, router } = await geminiOnly(t);
  const res = await router.request("/v1/messages", postJson({
    model: "gemini-flash",
    max_tokens: 64,
    messages: [{ role: "user", content: [{ type: "text", text: "read" }, documentBlock] }]
  }));
  const body = await res.json();

  assert.equal(res.status, 400);
  assert.equal(body.error.type, "unsupported_content");
  assert.equal(gemini.apiRequests.length, 0);
});

test("HTTP: Anthropic document is refused by every bridge target and never forwarded", async (t) => {
  const { gemini, groq, router } = await chatAndGemini(t);
  const res = await router.request("/v1/messages", postJson({
    model: "llama-x",
    max_tokens: 64,
    messages: [{ role: "user", content: [{ type: "text", text: "read" }, documentBlock] }]
  }));

  assert.equal(res.status, 400);
  assert.equal(gemini.apiRequests.length, 0);
  assert.equal(groq.apiRequests.length, 0);
});

test("HTTP: Anthropic text and base64 image still work through the bridge", async (t) => {
  const gemini = await startMockUpstream(() => ({ status: 200, body: geminiReply }));
  const router = await startRouter({
    GEMINI_VISION_API_KEYS: "vision-key",
    GEMINI_VISION_MODELS: "gemini-vision",
    GEMINI_VISION_BASE_URL: gemini.baseUrl
  });
  t.after(async () => { await router.close(); await gemini.close(); });

  const res = await router.request("/v1/messages", postJson({
    model: "gemini-vision",
    max_tokens: 64,
    messages: [{ role: "user", content: [
      { type: "text", text: "see" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } }
    ] }]
  }));

  assert.equal(res.status, 200);
  const parts = gemini.apiRequests[0].body.contents[0].parts;
  assert.deepEqual(parts[1], { inlineData: { mimeType: "image/png", data: "AAAA" } });
});

test("HTTP: Responses input_audio is refused by every bridge target and never forwarded", async (t) => {
  const { gemini, groq, router } = await chatAndGemini(t);
  const res = await router.request("/v1/responses", postJson({
    model: "llama-x",
    input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "listen" }, responsesAudio] }]
  }));
  const body = await res.json();

  assert.equal(res.status, 400);
  assert.equal(body.error.type, "unsupported_content");
  assert.equal(gemini.apiRequests.length, 0);
  assert.equal(groq.apiRequests.length, 0);
});

test("HTTP: Responses text still works through the bridge", async (t) => {
  const { groq, router } = await chatAndGemini(t);
  const res = await router.request("/v1/responses", postJson({
    model: "llama-x",
    input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] }]
  }));

  assert.equal(res.status, 200);
  assert.equal(groq.apiRequests[0].body.messages.at(-1).content, "hello");
});
