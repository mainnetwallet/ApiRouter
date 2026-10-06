import test from "node:test";
import assert from "node:assert/strict";
import { startMockUpstream } from "../test-helpers/mock-upstream.js";
import { startRouter, postJson } from "../test-helpers/router-harness.js";
import { toGeminiFromChat } from "../src/chat-bridge.js";
import { toGeminiRequest, toOpenAIChatRequest } from "../src/anthropic-bridge.js";
import { toGeminiFromResponses, toOpenAIChatFromResponses } from "../src/codex-bridge.js";
import { toChatFromGemini } from "../src/gemini-bridge.js";

/**
 * A request that needs vision must never lose the image silently. Every
 * translation either carries the image across (as `inlineData` for Gemini, as
 * `image_url` for an OpenAI-compatible target) or refuses the request with a
 * `400 unsupported_image_source`. The gateway never fetches a client-supplied
 * URL, so a remote image URL cannot be replayed into Gemini.
 */
const refuses = (fn) => assert.throws(fn, (error) => {
  assert.equal(error.status, 400, error.message);
  assert.equal(error.errorType, "unsupported_image_source");
  assert.equal(error.retryable, true, "another target may carry the image unchanged");
  assert.equal(error.skipCooldown, true, "a request-shape mismatch must not cool a healthy target");
  return true;
});

// ---------------------------------------------------------------------------
// Supported forms are carried across
// ---------------------------------------------------------------------------

test("chat data-URL images become Gemini inlineData", () => {
  const out = toGeminiFromChat({
    messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }] }]
  });
  assert.deepEqual(out.contents[0].parts[0], { inlineData: { mimeType: "image/png", data: "AAAA" } });
});

test("an Anthropic base64 image becomes Gemini inlineData", () => {
  const out = toGeminiRequest({
    messages: [{ role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/jpeg", data: "BBBB" } }] }]
  });
  assert.deepEqual(out.contents[0].parts[0], { inlineData: { mimeType: "image/jpeg", data: "BBBB" } });
});

test("a MIME-less Anthropic base64 image is still carried, not dropped", () => {
  const out = toGeminiRequest({
    messages: [{ role: "user", content: [{ type: "image", source: { type: "base64", data: "CCCC" } }] }]
  });
  assert.deepEqual(out.contents[0].parts[0], { inlineData: { mimeType: "application/octet-stream", data: "CCCC" } });
});

test("a remote Anthropic image URL is preserved for an OpenAI-compatible target", () => {
  const out = toOpenAIChatRequest({
    messages: [{ role: "user", content: [{ type: "image", source: { type: "url", url: "https://cdn.test/cat.png" } }] }]
  }, "m");
  assert.deepEqual(out.messages[0].content[0], { type: "image_url", image_url: { url: "https://cdn.test/cat.png" } });
});

test("a Responses image data URL becomes Gemini inlineData", () => {
  const out = toGeminiFromResponses({
    input: [{ type: "message", role: "user", content: [{ type: "input_image", image_url: "data:image/webp;base64,DDDD" }] }]
  });
  assert.deepEqual(out.contents[0].parts[0], { inlineData: { mimeType: "image/webp", data: "DDDD" } });
});

test("a remote Responses image URL is preserved for an OpenAI-compatible target", () => {
  const out = toOpenAIChatFromResponses({
    input: [{ type: "message", role: "user", content: [{ type: "input_image", image_url: "https://cdn.test/dog.png" }] }]
  }, "m");
  assert.deepEqual(out.messages[0].content[0], { type: "image_url", image_url: { url: "https://cdn.test/dog.png" } });
});

test("Gemini inlineData becomes a chat image URL, camelCase and snake_case alike", () => {
  const camel = toChatFromGemini({ contents: [{ role: "user", parts: [{ inlineData: { mimeType: "image/png", data: "AAAA" } }] }] }, "m");
  assert.equal(camel.messages[0].content[0].image_url.url, "data:image/png;base64,AAAA");

  const snake = toChatFromGemini({ contents: [{ role: "user", parts: [{ inline_data: { mime_type: "image/png", data: "BBBB" } }] }] }, "m");
  assert.equal(snake.messages[0].content[0].image_url.url, "data:image/png;base64,BBBB");

  const noMime = toChatFromGemini({ contents: [{ role: "user", parts: [{ inlineData: { data: "CCCC" } }] }] }, "m");
  assert.equal(noMime.messages[0].content[0].image_url.url, "data:application/octet-stream;base64,CCCC");
});

// ---------------------------------------------------------------------------
// Unsupported forms are refused explicitly, never dropped
// ---------------------------------------------------------------------------

test("a chat remote image URL is refused for Gemini, not dropped", () => {
  refuses(() => toGeminiFromChat({
    messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "https://example.test/cat.png" } }] }]
  }));
});

test("a chat image part with no url is refused for Gemini", () => {
  refuses(() => toGeminiFromChat({ messages: [{ role: "user", content: [{ type: "image_url" }] }] }));
});

test("Anthropic url and file image sources are refused for Gemini", () => {
  refuses(() => toGeminiRequest({
    messages: [{ role: "user", content: [{ type: "image", source: { type: "url", url: "https://cdn.test/a.png" } }] }]
  }));
  refuses(() => toGeminiRequest({
    messages: [{ role: "user", content: [{ type: "image", source: { type: "file", file_id: "file-1" } }] }]
  }));
});

test("Anthropic file and base64-without-data sources are refused for OpenAI targets", () => {
  refuses(() => toOpenAIChatRequest({
    messages: [{ role: "user", content: [{ type: "image", source: { type: "file", file_id: "file-1" } }] }]
  }, "m"));
  refuses(() => toOpenAIChatRequest({
    messages: [{ role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/png" } }] }]
  }, "m"));
});

test("a Responses remote image URL is refused for Gemini", () => {
  refuses(() => toGeminiFromResponses({
    input: [{ type: "message", role: "user", content: [{ type: "input_image", image_url: "https://cdn.test/dog.png" }] }]
  }));
});

test("a Responses input_file is refused for both bridge targets", () => {
  const body = { input: [{ type: "message", role: "user", content: [{ type: "input_file", file_id: "file-1" }] }] };
  refuses(() => toGeminiFromResponses(body));
  refuses(() => toOpenAIChatFromResponses(body, "m"));
});

test("a file or image inside a Responses tool output is refused", () => {
  refuses(() => toGeminiFromResponses({
    input: [{ type: "function_call_output", call_id: "c1", output: [{ type: "input_image", image_url: "data:image/png;base64,AAAA" }] }]
  }));
});

test("a Gemini fileData reference is refused for chat targets", () => {
  refuses(() => toChatFromGemini({
    contents: [{ role: "user", parts: [{ fileData: { mimeType: "image/png", fileUri: "https://generativelanguage.test/v1beta/files/x" } }] }]
  }, "m"));
});

test("a Gemini inlineData part with no bytes is refused, not dropped", () => {
  refuses(() => toChatFromGemini({ contents: [{ role: "user", parts: [{ inlineData: {} }] }] }, "m"));
});

test("an image inside a tool result is refused, not flattened to text", () => {
  refuses(() => toGeminiFromChat({
    messages: [{
      role: "tool",
      tool_call_id: "c1",
      content: [{ type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }]
    }]
  }));
  refuses(() => toGeminiRequest({
    messages: [{
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "t1", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } }] }]
    }]
  }));
});

// ---------------------------------------------------------------------------
// HTTP matrix
// ---------------------------------------------------------------------------

const geminiReply = { candidates: [{ content: { role: "model", parts: [{ text: "ok" }] }, finishReason: "STOP" }] };

/** A Gemini vision target and nothing else, so a chat image request must bridge. */
async function withGeminiVision(t) {
  const upstream = await startMockUpstream(() => ({ status: 200, body: geminiReply }));
  const router = await startRouter({
    GEMINI_VISION_API_KEYS: "vision-key",
    GEMINI_VISION_MODELS: "gemini-vision",
    GEMINI_VISION_BASE_URL: upstream.baseUrl
  });
  t.after(async () => { await router.close(); await upstream.close(); });
  return { upstream, router };
}

const chatImageRequest = (url) => ({
  model: "gemini-vision",
  messages: [{ role: "user", content: [{ type: "text", text: "see" }, { type: "image_url", image_url: { url } }] }]
});

test("HTTP: a base64 image reaches the Gemini vision target as inlineData", async (t) => {
  const { upstream, router } = await withGeminiVision(t);

  const res = await router.request(
    "/v1/chat/completions",
    postJson(chatImageRequest("data:image/png;base64,AAAA"))
  );

  assert.equal(res.status, 200);
  const [call] = upstream.apiRequests;
  assert.ok(call, "the request reached the provider");
  const inline = call.body.contents.flatMap((c) => c.parts).find((p) => p.inlineData);
  assert.deepEqual(inline?.inlineData, { mimeType: "image/png", data: "AAAA" });
});

test("HTTP: a remote image URL to a Gemini target is a 400, never a 200 with the image gone", async (t) => {
  const { upstream, router } = await withGeminiVision(t);

  const res = await router.request(
    "/v1/chat/completions",
    postJson(chatImageRequest("https://cdn.example.test/cat.png"))
  );
  const body = await res.json();

  assert.equal(res.status, 400);
  assert.equal(body.error.type, "unsupported_image_source");
  assert.match(body.error.message, /unsupported_image_source/);
  // The image would have had to be fetched by the gateway, which never happens.
  assert.equal(upstream.apiRequests.length, 0, "no provider is called for a request that cannot be carried");
});

test("HTTP: a refused remote image falls over to an OpenAI-compatible vision target unchanged", async (t) => {
  const geminiUpstream = await startMockUpstream(() => ({ status: 200, body: geminiReply }));
  const groqUpstream = await startMockUpstream(() => ({ status: 200, body: {
    id: "chatcmpl-1",
    object: "chat.completion",
    choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
  } }));
  const router = await startRouter({
    GEMINI_VISION_API_KEYS: "vision-key",
    GEMINI_VISION_MODELS: "gemini-vision",
    GEMINI_VISION_BASE_URL: geminiUpstream.baseUrl,
    GROQ_VISION_API_KEYS: "vision-key",
    GROQ_VISION_MODELS: "groq-vision",
    GROQ_VISION_BASE_URL: groqUpstream.baseUrl,
    VISION_PRIORITY_MODELS: "gemini/gemini-vision,groq/groq-vision"
  });
  t.after(async () => {
    await router.close();
    await geminiUpstream.close();
    await groqUpstream.close();
  });

  const res = await router.request(
    "/v1/chat/completions",
    postJson(chatImageRequest("https://cdn.example.test/cat.png"))
  );

  assert.equal(res.status, 200);
  assert.equal(geminiUpstream.apiRequests.length, 0, "Gemini never received a request it cannot translate");
  const [call] = groqUpstream.apiRequests;
  assert.ok(call, "the OpenAI-compatible vision target served the request");
  const image = call.body.messages.flatMap((m) => (Array.isArray(m.content) ? m.content : []))
    .find((part) => part.type === "image_url");
  assert.deepEqual(image?.image_url, { url: "https://cdn.example.test/cat.png" },
    "the image URL is replayed verbatim, not fetched or rewritten");
});
