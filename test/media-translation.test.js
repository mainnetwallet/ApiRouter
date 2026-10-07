import test from "node:test";
import assert from "node:assert/strict";

import { toGeminiRequest, toOpenAIChatRequest } from "../src/anthropic-bridge.js";
import { toGeminiFromChat } from "../src/chat-bridge.js";
import { toGeminiFromResponses, toOpenAIChatFromResponses } from "../src/codex-bridge.js";
import { toChatFromGemini } from "../src/gemini-bridge.js";
import { collectRemoteImageUrls } from "../src/media.js";

const PNG = "iVBORw0KGgo=";
const URL1 = "https://example.test/one.png";
const URL2 = "https://example.test/two.png";
const media = new Map([
  [URL1, { mimeType: "image/png", data: "RESOLVED1" }],
  [URL2, { mimeType: "image/jpeg", data: "RESOLVED2" }]
]);
const refused = (fn) => assert.throws(fn, (error) => error.status === 400 && typeof error.errorType === "string");
const noPlaceholder = (value) => assert.ok(!JSON.stringify(value).includes("[image]"), "no '[image]' placeholder may stand in for an image");
const inline = (part) => part?.inlineData;

// ------------------------------------------------------------ Anthropic -> Gemini

test("Anthropic -> Gemini: base64 and remote URL images are both preserved as inlineData", () => {
  const body = { messages: [{ role: "user", content: [
    { type: "text", text: "look" },
    { type: "image", source: { type: "base64", media_type: "image/png", data: PNG } },
    { type: "image", source: { type: "url", url: URL1 } },
    { type: "image", source: { type: "url", url: URL2 } }
  ] }] };
  const parts = toGeminiRequest(body, { media }).contents[0].parts;
  assert.deepEqual(parts, [
    { text: "look" },
    { inlineData: { mimeType: "image/png", data: PNG } },
    { inlineData: { mimeType: "image/png", data: "RESOLVED1" } },
    { inlineData: { mimeType: "image/jpeg", data: "RESOLVED2" } }
  ]);
});

test("Anthropic -> Gemini: an image-only turn is not turned into an empty request", () => {
  const body = { messages: [{ role: "user", content: [{ type: "image", source: { type: "url", url: URL1 } }] }] };
  const contents = toGeminiRequest(body, { media }).contents;
  assert.equal(contents.length, 1);
  assert.equal(inline(contents[0].parts[0]).data, "RESOLVED1");
});

test("Anthropic -> Gemini: a remote image that was not fetched is a 400, never a dropped image", () => {
  refused(() => toGeminiRequest({ messages: [{ role: "user", content: [{ type: "image", source: { type: "url", url: URL1 } }] }] }));
  refused(() => toGeminiRequest({ messages: [{ role: "user", content: [{ type: "image", source: { type: "file", file_id: "f" } }] }] }));
});

test("Anthropic -> Gemini: an image returned by a tool is carried, not replaced by '[image]'", () => {
  const body = { messages: [
    { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "shot", input: {} }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: [
      { type: "text", text: "captured" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: PNG } }
    ] }] }
  ] };
  const out = toGeminiRequest(body);
  noPlaceholder(out);
  const parts = out.contents[1].parts;
  assert.equal(parts[0].functionResponse.name, "shot");
  assert.equal(parts[0].functionResponse.response.output, "captured");
  assert.deepEqual(parts[1], { inlineData: { mimeType: "image/png", data: PNG } });
});

test("Anthropic -> Gemini: documents (PDF) are carried; system and assistant media are refused", () => {
  const pdf = { type: "document", source: { type: "base64", media_type: "application/pdf", data: PNG } };
  assert.deepEqual(toGeminiRequest({ messages: [{ role: "user", content: [pdf] }] }).contents[0].parts, [{ inlineData: { mimeType: "application/pdf", data: PNG } }]);
  refused(() => toOpenAIChatRequest({ messages: [{ role: "user", content: [pdf] }] }, "m"));
  refused(() => toGeminiRequest({ system: [{ type: "image", source: { type: "base64", media_type: "image/png", data: PNG } }], messages: [] }));
  refused(() => toGeminiRequest({ messages: [{ role: "assistant", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: PNG } }] }] }));
});

test("Anthropic -> chat: URL and base64 images are preserved; tool-result images follow the tool message", () => {
  const body = { messages: [
    { role: "user", content: [
      { type: "image", source: { type: "url", url: URL1 } },
      { type: "image", source: { type: "base64", media_type: "image/png", data: PNG } }
    ] },
    { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "shot", input: {} }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: [{ type: "image", source: { type: "url", url: URL2 } }] }] }
  ] };
  const out = toOpenAIChatRequest(body, "m");
  noPlaceholder(out);
  assert.deepEqual(out.messages[0].content.map((p) => p.image_url.url), [URL1, `data:image/png;base64,${PNG}`]);
  const roles = out.messages.map((m) => m.role);
  assert.deepEqual(roles, ["user", "assistant", "tool", "user"]);
  assert.equal(out.messages[3].content[1].image_url.url, URL2);
  refused(() => toOpenAIChatRequest({ messages: [{ role: "user", content: [{ type: "image", source: { type: "file", file_id: "f" } }] }] }, "m"));
});

// ------------------------------------------------------------ OpenAI Chat -> Gemini

test("Chat -> Gemini: data URL and remote image_url both become inlineData; multiple images keep order", () => {
  const body = { messages: [{ role: "user", content: [
    { type: "text", text: "a" },
    { type: "image_url", image_url: { url: URL1 } },
    { type: "image_url", image_url: { url: `data:image/webp;base64,${PNG}` } }
  ] }] };
  assert.deepEqual(toGeminiFromChat(body, { media }).contents[0].parts, [
    { text: "a" },
    { inlineData: { mimeType: "image/png", data: "RESOLVED1" } },
    { inlineData: { mimeType: "image/webp", data: PNG } }
  ]);
});

test("Chat -> Gemini: image-only, multi-turn and tool-message images are all preserved", () => {
  const body = { messages: [
    { role: "user", content: [{ type: "image_url", image_url: { url: URL1 } }] },
    { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "shot", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "c1", content: [{ type: "text", text: "done" }, { type: "image_url", image_url: { url: URL2 } }] },
    { role: "user", content: "and?" }
  ] };
  const out = toGeminiFromChat(body, { media });
  noPlaceholder(out);
  assert.equal(inline(out.contents[0].parts[0]).data, "RESOLVED1");
  const last = out.contents[2].parts;
  assert.equal(last[0].functionResponse.name, "shot");
  assert.equal(inline(last[1]).data, "RESOLVED2", "the tool's image follows its function response");
  assert.deepEqual(last[2], { text: "and?" });
});

test("Chat -> Gemini: input_audio and file data are carried; file_id and system/assistant media are refused", () => {
  const body = { messages: [{ role: "user", content: [
    { type: "input_audio", input_audio: { data: PNG, format: "mp3" } },
    { type: "file", file: { filename: "a.pdf", file_data: `data:application/pdf;base64,${PNG}` } }
  ] }] };
  assert.deepEqual(toGeminiFromChat(body).contents[0].parts, [
    { inlineData: { mimeType: "audio/mp3", data: PNG } },
    { inlineData: { mimeType: "application/pdf", data: PNG } }
  ]);
  refused(() => toGeminiFromChat({ messages: [{ role: "user", content: [{ type: "file", file: { file_id: "f" } }] }] }));
  refused(() => toGeminiFromChat({ messages: [{ role: "system", content: [{ type: "image_url", image_url: { url: URL1 } }] }] }, { media }));
  refused(() => toGeminiFromChat({ messages: [{ role: "assistant", content: [{ type: "image_url", image_url: { url: URL1 } }] }] }, { media }));
});

// ------------------------------------------------------------ Responses

test("Responses -> Gemini: input_image (data URL and remote), input_file data, and function output images are preserved", () => {
  const body = { input: [
    { type: "message", role: "user", content: [
      { type: "input_text", text: "see" },
      { type: "input_image", image_url: URL1 },
      { type: "input_image", image_url: `data:image/png;base64,${PNG}` },
      { type: "input_file", filename: "a.pdf", file_data: `data:application/pdf;base64,${PNG}` }
    ] },
    { type: "function_call", call_id: "c1", name: "shot", arguments: "{}" },
    { type: "function_call_output", call_id: "c1", output: [{ type: "input_image", image_url: URL2 }] }
  ] };
  const out = toGeminiFromResponses(body, { media });
  noPlaceholder(out);
  assert.deepEqual(out.contents[0].parts.slice(1).map(inline), [
    { mimeType: "image/png", data: "RESOLVED1" },
    { mimeType: "image/png", data: PNG },
    { mimeType: "application/pdf", data: PNG }
  ]);
  const toolTurn = out.contents[2].parts;
  assert.equal(toolTurn[0].functionResponse.name, "shot");
  assert.equal(inline(toolTurn[1]).data, "RESOLVED2");
});

test("Responses: file_id images are refused (400) instead of becoming '[image]' or vanishing", () => {
  const body = { input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "x" }, { type: "input_image", file_id: "file-1" }] }] };
  refused(() => toGeminiFromResponses(body));
  refused(() => toOpenAIChatFromResponses(body, "m"));
  refused(() => toOpenAIChatFromResponses({ input: [{ type: "message", role: "user", content: [{ type: "input_file", file_id: "f" }] }] }, "m"));
});

test("Responses -> chat: remote and data URL images are preserved; tool images follow the tool message", () => {
  const body = { input: [
    { type: "message", role: "user", content: [{ type: "input_image", image_url: URL1 }] },
    { type: "function_call", call_id: "c1", name: "shot", arguments: "{}" },
    { type: "function_call_output", call_id: "c1", output: [{ type: "input_image", image_url: URL2 }] }
  ] };
  const out = toOpenAIChatFromResponses(body, "m");
  noPlaceholder(out);
  assert.equal(out.messages[0].content[0].image_url.url, URL1);
  assert.deepEqual(out.messages.map((m) => m.role), ["user", "assistant", "tool", "user"]);
  assert.equal(out.messages[3].content[1].image_url.url, URL2);
});

// ------------------------------------------------------------ Gemini -> chat

test("Gemini -> chat: inlineData (camelCase and snake_case) and https fileData images are preserved", () => {
  const camel = { contents: [{ role: "user", parts: [{ text: "x" }, { inlineData: { mimeType: "image/png", data: PNG } }, { fileData: { mimeType: "image/png", fileUri: URL1 } }] }] };
  const snake = { contents: [{ role: "user", parts: [{ inline_data: { mime_type: "image/png", data: PNG } }, { file_data: { mime_type: "image/png", file_uri: URL2 } }] }] };
  const a = toChatFromGemini(camel, "m").messages[0].content;
  assert.deepEqual(a.slice(1).map((p) => p.image_url.url), [`data:image/png;base64,${PNG}`, URL1]);
  const b = toChatFromGemini(snake, "m").messages[0].content;
  assert.deepEqual(b.map((p) => p.image_url.url), [`data:image/png;base64,${PNG}`, URL2]);
});

test("Gemini -> chat: media a chat provider cannot take is refused, not dropped", () => {
  refused(() => toChatFromGemini({ contents: [{ role: "user", parts: [{ inlineData: { mimeType: "application/pdf", data: PNG } }] }] }, "m"));
  refused(() => toChatFromGemini({ contents: [{ role: "user", parts: [{ inlineData: { mimeType: "video/mp4", data: PNG } }] }] }, "m"));
  refused(() => toChatFromGemini({ contents: [{ role: "user", parts: [{ fileData: { mimeType: "image/png", fileUri: "gs://bucket/o.png" } }] }] }, "m"));
  refused(() => toChatFromGemini({ contents: [{ role: "model", parts: [{ inlineData: { mimeType: "image/png", data: PNG } }] }] }, "m"));
  refused(() => toChatFromGemini({ systemInstruction: { parts: [{ inlineData: { mimeType: "image/png", data: PNG } }] }, contents: [] }, "m"));
});

test("Gemini -> chat: an image in functionResponse.parts is carried to the provider", () => {
  const body = { contents: [
    { role: "model", parts: [{ functionCall: { name: "shot", args: {} } }] },
    { role: "user", parts: [{ functionResponse: { name: "shot", response: { ok: true }, parts: [{ inlineData: { mimeType: "image/png", data: PNG } }] } }] }
  ] };
  const messages = toChatFromGemini(body, "m").messages;
  assert.deepEqual(messages.map((m) => m.role), ["assistant", "tool", "user"]);
  assert.equal(messages[2].content[1].image_url.url, `data:image/png;base64,${PNG}`);
});

// ------------------------------------------------------------ discovery

test("remote image URLs are collected from every protocol, including tool results", () => {
  assert.deepEqual(collectRemoteImageUrls("anthropic", { messages: [
    { role: "user", content: [{ type: "image", source: { type: "url", url: URL1 } }, { type: "image", source: { type: "base64", media_type: "image/png", data: PNG } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: [{ type: "image", source: { type: "url", url: URL2 } }] }] }
  ] }), [URL1, URL2]);
  assert.deepEqual(collectRemoteImageUrls("openai-chat", { messages: [
    { role: "user", content: [{ type: "image_url", image_url: { url: URL1 } }, { type: "image_url", image_url: { url: `data:image/png;base64,${PNG}` } }] },
    { role: "tool", content: [{ type: "image_url", image_url: { url: URL2 } }] }
  ] }), [URL1, URL2]);
  assert.deepEqual(collectRemoteImageUrls("openai-responses", { input: [
    { type: "message", role: "user", content: [{ type: "input_image", image_url: URL1 }] },
    { type: "function_call_output", call_id: "c", output: [{ type: "input_image", image_url: URL2 }] },
    { type: "input_image", image_url: URL1 }
  ] }), [URL1, URL2], "deduplicated, first-seen order");
  assert.deepEqual(collectRemoteImageUrls("gemini", { contents: [] }), []);
});
