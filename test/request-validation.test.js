import test from "node:test";
import assert from "node:assert/strict";

import { validateRequestShape } from "../src/request-validation.js";

/**
 * Regression: request validation accepted a `message.content` that was a bare
 * object, e.g. `{ type: "text", text: "Hello" }`.
 *
 * No supported protocol defines `content` that way — it is a string or an array
 * of parts in every one of them — and every bridge reads a non-array as "no
 * content at all". So the message was silently dropped while the request still
 * looked routable, and the client got an answer to a prompt the model never saw.
 * It is a client mistake and must be a local 400.
 */

const ok = (protocol, body) => assert.equal(validateRequestShape(protocol, body), null, `${protocol} should accept ${JSON.stringify(body)}`);
const rejected = (protocol, body, pattern) => {
  const error = validateRequestShape(protocol, body);
  assert.ok(error, `${protocol} should have rejected ${JSON.stringify(body)}`);
  assert.match(error, pattern);
  // Messages name the field and never echo the client's value back.
  assert.ok(!error.includes("Hello"), `the message echoed client content: ${error}`);
};

// ------------------------------------------------------------ accepted shapes

test("accepts a string content", () => {
  ok("openai-chat", { messages: [{ role: "user", content: "Hello" }] });
  ok("anthropic", { messages: [{ role: "user", content: "Hello" }] });
});

test("accepts an array of text parts", () => {
  ok("openai-chat", { messages: [{ role: "user", content: [{ type: "text", text: "Hello" }] }] });
  ok("anthropic", { messages: [{ role: "user", content: [{ type: "text", text: "Hello" }] }] });
});

test("accepts an array of image parts, in each provider's own spelling", () => {
  // Chat Completions
  ok("openai-chat", { messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "data:image/png;base64,AA==" } }] }] });
  // Anthropic
  ok("anthropic", { messages: [{ role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "AA==" } }] }] });
  // Responses
  ok("openai-responses", { input: [{ type: "message", role: "user", content: [{ type: "input_image", image_url: "data:image/png;base64,AA==" }] }] });
});

test("accepts mixed text and image parts", () => {
  ok("openai-chat", {
    messages: [{ role: "user", content: [{ type: "text", text: "what is this?" }, { type: "image_url", image_url: { url: "data:image/png;base64,AA==" } }] }]
  });
});

test("accepts null content, as used by assistant tool-call turns", () => {
  ok("openai-chat", { messages: [{ role: "assistant", content: null, tool_calls: [] }] });
  ok("anthropic", { messages: [{ role: "assistant", content: null }] });
});

test("accepts absent content and an absent messages array", () => {
  ok("openai-chat", { messages: [{ role: "assistant", tool_calls: [] }] });
  ok("openai-chat", {});
  ok("anthropic", {});
  ok("openai-responses", {});
});

test("accepts Responses input as a plain string or as items", () => {
  ok("openai-responses", { input: "Hello" });
  ok("openai-responses", { input: [{ type: "message", role: "user", content: "Hello" }] });
  ok("openai-responses", { input: [{ type: "function_call_output", call_id: "c1", output: "done" }] });
});

test("accepts Gemini contents as an array, a single object, and their parts", () => {
  ok("gemini", { contents: [{ role: "user", parts: [{ text: "Hello" }] }] });
  ok("gemini", { contents: { role: "user", parts: [{ text: "Hello" }] } });
  ok("gemini", { contents: [{ role: "user", parts: [{ inlineData: { mimeType: "image/png", data: "AA==" } }] }] });
  ok("gemini", {});
});

// ------------------------------------------------------------ rejected shapes

test("rejects a bare object as message content, for every protocol that has messages", () => {
  for (const protocol of ["openai-chat", "anthropic"]) {
    rejected(protocol, { messages: [{ role: "user", content: { type: "text", text: "Hello" } }] }, /messages\[0\]\.content/);
  }
});

test("rejects a bare object as Responses message content", () => {
  rejected(
    "openai-responses",
    { input: [{ type: "message", role: "user", content: { type: "text", text: "Hello" } }] },
    /input\[0\]\.content/
  );
});

test("rejects scalars and other non-content values", () => {
  rejected("openai-chat", { messages: [{ role: "user", content: 5 }] }, /messages\[0\]\.content/);
  rejected("openai-chat", { messages: [{ role: "user", content: true }] }, /messages\[0\]\.content/);
  rejected("anthropic", { messages: [{ role: "user", content: 5 }] }, /messages\[0\]\.content/);
});

test("still rejects the shapes it always rejected", () => {
  rejected("openai-chat", { messages: 5 }, /"messages" must be an array/);
  rejected("openai-chat", { messages: [5] }, /messages\[0\]/);
  // Anthropic reads `.type` off every block, so a non-object entry is a 400.
  rejected("anthropic", { messages: [{ role: "user", content: [null] }] }, /messages\[0\]\.content\[0\]/);
  rejected("openai-responses", { input: 5 }, /"input" must be a string or an array/);
  rejected("gemini", { contents: 5 }, /"contents" must be an array or an object/);
  rejected("gemini", { contents: [{ role: "user", parts: 5 }] }, /parts/);
});

test("a Responses item that is not a message is not checked for content", () => {
  // Other item kinds have no `content` field; only `message` items do.
  ok("openai-responses", { input: [{ type: "function_call", call_id: "c1", name: "f", arguments: "{}" }] });
  ok("openai-responses", { input: [{ type: "custom_tool_call_output", call_id: "c1", output: { nested: true } }] });
});

// ------------------------------------------------------------ the actual bug

test("the shape that used to be dropped before reaching Gemini is now a 400, not an empty turn", () => {
  // Before: validation accepted this, then `toGeminiFromChat` read the object as
  // "no content" and emitted a turn containing nothing.
  const body = { model: "m", messages: [{ role: "user", content: { type: "text", text: "Hello" } }] };
  assert.match(validateRequestShape("openai-chat", body), /content/);
});
