import test from "node:test";
import assert from "node:assert/strict";

import { toGeminiFromChat } from "../src/chat-bridge.js";
import { toGeminiFromResponses, toOpenAIChatFromResponses } from "../src/codex-bridge.js";
import { toChatFromGemini } from "../src/gemini-bridge.js";
import { toGeminiRequest, toOpenAIChatRequest } from "../src/anthropic-bridge.js";

/**
 * Regression: an image must never be silently discarded while the request
 * crosses provider formats.
 *
 * Every bridge used to convert only the image form it recognised and drop
 * anything else on the floor — an `https:` `image_url` heading for Gemini, a
 * Gemini `fileData`/`inline_data` part heading for an OpenAI-compatible
 * provider, an Anthropic url-source image heading for Gemini. The request then
 * reached the model as if the image had never been attached, and the client got
 * a confident answer about content the model never received.
 *
 * The contract tested here: convert what the target protocol can carry, and
 * raise a 400 `UnsupportedMediaError` for what it cannot.
 */

const PNG = "iVBORw0KGgoAAAANSUhEUg==";
const DATA_URL = `data:image/png;base64,${PNG}`;

/** Assert an error is the actionable refusal the fallback walk understands. */
function assertUnsupported(error, expectedText) {
  assert.equal(error.name, "UnsupportedMediaError", `got ${error.name}: ${error.message}`);
  // 400 + retryable + skipCooldown is what makes walkPlan record the attempt,
  // move to the next target, and NOT cool this provider down.
  assert.equal(error.status, 400);
  assert.equal(error.retryable, true);
  assert.equal(error.skipCooldown, true);
  assert.match(error.message, expectedText);
  // The message must be actionable and must not echo client content back.
  assert.ok(!error.message.includes(PNG), "the message echoed the image payload");
  return true;
}

// ------------------------------------------------ OpenAI chat -> Gemini

test("chat -> gemini: a base64 image is preserved as inlineData", () => {
  const payload = toGeminiFromChat({
    messages: [{ role: "user", content: [{ type: "text", text: "what is this?" }, { type: "image_url", image_url: { url: DATA_URL } }] }]
  });
  const parts = payload.contents[0].parts;
  assert.deepEqual(parts[0], { text: "what is this?" });
  assert.deepEqual(parts[1], { inlineData: { mimeType: "image/png", data: PNG } });
});

test("chat -> gemini: an https image URL is refused, not dropped", () => {
  assert.throws(
    () => toGeminiFromChat({
      messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "https://example.com/cat.png" } }] }]
    }),
    (error) => {
      assertUnsupported(error, /Gemini/);
      return true;
    }
  );
});

test("chat -> gemini: an image_url part with no url is refused", () => {
  assert.throws(
    () => toGeminiFromChat({ messages: [{ role: "user", content: [{ type: "image_url", image_url: {} }] }] }),
    (error) => assertUnsupported(error, /Gemini/)
  );
});

test("chat -> gemini: the text around a refused image still fails loudly rather than sending half a turn", () => {
  assert.throws(
    () => toGeminiFromChat({
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "describe" },
          { type: "image_url", image_url: { url: "https://example.com/cat.png" } },
          { type: "text", text: "in detail" }
        ]
      }]
    }),
    (error) => assertUnsupported(error, /Gemini/)
  );
});

// ------------------------------------------------ OpenAI Responses -> Gemini

test("responses -> gemini: a base64 input_image is preserved as inlineData", () => {
  const payload = toGeminiFromResponses({
    input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }, { type: "input_image", image_url: DATA_URL }] }]
  });
  assert.deepEqual(payload.contents[0].parts[0], { text: "hi" });
  assert.deepEqual(payload.contents[0].parts[1], { inlineData: { mimeType: "image/png", data: PNG } });
});

test("responses -> gemini: an https input_image is refused, not dropped", () => {
  assert.throws(
    () => toGeminiFromResponses({
      input: [{ type: "message", role: "user", content: [{ type: "input_image", image_url: "https://example.com/cat.png" }] }]
    }),
    (error) => assertUnsupported(error, /Gemini/)
  );
});

// ------------------------------------------------ OpenAI Responses -> OpenAI chat

test("responses -> chat: both base64 and https input_images are preserved", () => {
  const payload = toOpenAIChatFromResponses({
    input: [{
      type: "message",
      role: "user",
      content: [
        { type: "input_text", text: "compare" },
        { type: "input_image", image_url: DATA_URL },
        { type: "input_image", image_url: "https://example.com/cat.png" }
      ]
    }]
  }, "m");
  const content = payload.messages.at(-1).content;
  assert.equal(content[0].text, "compare");
  assert.equal(content[1].image_url.url, DATA_URL);
  assert.equal(content[2].image_url.url, "https://example.com/cat.png");
});

test("responses -> chat: an input_image with no url is refused, not turned into the text \"[image]\"", () => {
  assert.throws(
    () => toOpenAIChatFromResponses({
      input: [{ type: "message", role: "user", content: [{ type: "input_image" }] }]
    }, "m"),
    (error) => assertUnsupported(error, /input_image/)
  );
});

test("responses -> chat: one url-less input_image among valid ones is refused, not filtered out", () => {
  assert.throws(
    () => toOpenAIChatFromResponses({
      input: [{
        type: "message",
        role: "user",
        content: [{ type: "input_image", image_url: DATA_URL }, { type: "input_image" }]
      }]
    }, "m"),
    (error) => assertUnsupported(error, /input_image/)
  );
});

// ------------------------------------------------ Gemini -> OpenAI chat

test("gemini -> chat: inlineData becomes an image_url data URL", () => {
  const chat = toChatFromGemini({
    contents: [{ role: "user", parts: [{ text: "look" }, { inlineData: { mimeType: "image/png", data: PNG } }] }]
  }, "m");
  const content = chat.messages.at(-1).content;
  assert.equal(content[0].text, "look");
  assert.equal(content[1].type, "image_url");
  assert.equal(content[1].image_url.url, DATA_URL);
});

test("gemini -> chat: the snake_case inline_data spelling is carried too, not dropped", () => {
  // `vision.js` detects `inline_data` as an image and routes the request to the
  // vision pool, so dropping it here would send an image request to a text-only
  // upstream as plain text.
  const chat = toChatFromGemini({
    contents: [{ role: "user", parts: [{ inline_data: { mime_type: "image/png", data: PNG } }] }]
  }, "m");
  const content = chat.messages.at(-1).content;
  assert.equal(content[0].image_url.url, DATA_URL);
});

test("gemini -> chat: an inlineData part with no payload is refused", () => {
  assert.throws(
    () => toChatFromGemini({ contents: [{ role: "user", parts: [{ inlineData: { mimeType: "image/png" } }] }] }, "m"),
    (error) => assertUnsupported(error, /inlineData/)
  );
});

test("gemini -> chat: fileData is refused, not dropped", () => {
  assert.throws(
    () => toChatFromGemini({
      contents: [{ role: "user", parts: [{ fileData: { mimeType: "image/png", fileUri: "https://generativelanguage.googleapis.com/v1beta/files/abc" } }] }]
    }, "m"),
    (error) => assertUnsupported(error, /fileData/)
  );
});

test("gemini -> chat: the snake_case file_data spelling is refused too", () => {
  assert.throws(
    () => toChatFromGemini({ contents: [{ role: "user", parts: [{ file_data: { file_uri: "https://example.com/f" } }] }] }, "m"),
    (error) => assertUnsupported(error, /fileData/)
  );
});

// ------------------------------------------------ Anthropic -> Gemini

test("anthropic -> gemini: a base64 image block is preserved as inlineData", () => {
  const payload = toGeminiRequest({
    messages: [{ role: "user", content: [{ type: "text", text: "look" }, { type: "image", source: { type: "base64", media_type: "image/png", data: PNG } }] }]
  });
  assert.deepEqual(payload.contents[0].parts[0], { text: "look" });
  assert.deepEqual(payload.contents[0].parts[1], { inlineData: { mimeType: "image/png", data: PNG } });
});

test("anthropic -> gemini: a url-source image block is refused, not dropped", () => {
  assert.throws(
    () => toGeminiRequest({ messages: [{ role: "user", content: [{ type: "image", source: { type: "url", url: "https://example.com/cat.png" } }] }] }),
    (error) => assertUnsupported(error, /Gemini/)
  );
});

test("anthropic -> chat: both image source forms are preserved unchanged", () => {
  const payload = toOpenAIChatRequest({
    messages: [{
      role: "user",
      content: [
        { type: "image", source: { type: "base64", media_type: "image/png", data: PNG } },
        { type: "image", source: { type: "url", url: "https://example.com/cat.png" } }
      ]
    }]
  }, "m");
  const content = payload.messages.at(-1).content;
  assert.equal(content[0].image_url.url, DATA_URL);
  assert.equal(content[1].image_url.url, "https://example.com/cat.png");
});

// ------------------------------------------------ no false refusals

test("an image-free request is unaffected in every direction", () => {
  assert.deepEqual(toGeminiFromChat({ messages: [{ role: "user", content: "hello" }] }).contents[0].parts, [{ text: "hello" }]);
  assert.deepEqual(toGeminiFromResponses({ input: "hello" }).contents[0].parts, [{ text: "hello" }]);
  assert.deepEqual(toGeminiRequest({ messages: [{ role: "user", content: "hello" }] }).contents[0].parts, [{ text: "hello" }]);
  assert.equal(toChatFromGemini({ contents: [{ role: "user", parts: [{ text: "hello" }] }] }, "m").messages[0].content, "hello");
});
