import test from "node:test";
import assert from "node:assert/strict";
import { streamToAnthropic, cleanSchemaForGemini, openAIJsonToAnthropic, geminiJsonToAnthropic } from "../src/anthropic-bridge.js";
import { streamToResponses, geminiJsonToResponses } from "../src/codex-bridge.js";
import { streamToChat, geminiJsonToChat } from "../src/chat-bridge.js";
import { toChatFromGemini } from "../src/gemini-bridge.js";
import { toolCallKey, geminiOutputTokens } from "../src/bridge-utils.js";

async function* gen(items) { for (const item of items) yield JSON.stringify(item); }
const collect = async (iterable) => { let out = ""; for await (const part of iterable) out += part; return out; };
const count = (text, pattern) => (text.match(pattern) || []).length;

const noIndexCalls = [
  { choices: [{ delta: { tool_calls: [{ id: "a", function: { name: "read", arguments: '{"p":1}' } }] } }] },
  { choices: [{ delta: { tool_calls: [{ id: "b", function: { name: "write", arguments: '{"p":2}' } }] } }] },
  { choices: [{ finish_reason: "tool_calls", delta: {} }] }
];

// ---- gemini-bridge

test("gemini bridge: id-less functionResponse is paired with the matching call's id", () => {
  const chat = toChatFromGemini({
    contents: [
      { role: "user", parts: [{ text: "go" }] },
      { role: "model", parts: [{ functionCall: { name: "read", args: { p: 1 } } }, { functionCall: { name: "write", args: { p: 2 } } }] },
      { role: "user", parts: [
        { functionResponse: { name: "write", response: { ok: 2 } } },
        { functionResponse: { name: "read", response: { ok: 1 } } }
      ] }
    ]
  }, "m");
  const calls = chat.messages.find((m) => m.tool_calls).tool_calls;
  const results = chat.messages.filter((m) => m.role === "tool");
  const idOf = (name) => calls.find((c) => c.function.name === name).id;
  assert.equal(results[0].tool_call_id, idOf("write"));
  assert.equal(results[1].tool_call_id, idOf("read"));
});

test("gemini bridge: two id-less calls to the same function pair in order", () => {
  const chat = toChatFromGemini({
    contents: [
      { role: "model", parts: [{ functionCall: { name: "read", args: { p: 1 } } }, { functionCall: { name: "read", args: { p: 2 } } }] },
      { role: "user", parts: [{ functionResponse: { name: "read", response: { n: 1 } } }, { functionResponse: { name: "read", response: { n: 2 } } }] }
    ]
  }, "m");
  const [a, b] = chat.messages.find((m) => m.tool_calls).tool_calls;
  const [r1, r2] = chat.messages.filter((m) => m.role === "tool");
  assert.equal(r1.tool_call_id, a.id);
  assert.equal(r2.tool_call_id, b.id);
  assert.notEqual(a.id, b.id);
});

test("gemini bridge: an explicit id is kept", () => {
  const chat = toChatFromGemini({
    contents: [
      { role: "model", parts: [{ functionCall: { id: "c1", name: "read", args: {} } }] },
      { role: "user", parts: [{ functionResponse: { id: "c1", name: "read", response: {} } }] }
    ]
  }, "m");
  assert.equal(chat.messages.find((m) => m.role === "tool").tool_call_id, "c1");
});

test("gemini bridge: tool results come before user text in the same turn", () => {
  const chat = toChatFromGemini({
    contents: [
      { role: "user", parts: [{ text: "go" }] },
      { role: "model", parts: [{ functionCall: { id: "c1", name: "read", args: {} } }] },
      { role: "user", parts: [{ functionResponse: { id: "c1", name: "read", response: {} } }, { text: "also continue" }] }
    ]
  }, "m");
  assert.deepEqual(chat.messages.map((m) => m.role), ["user", "assistant", "tool", "user"]);
});

test("gemini bridge: thought summaries are not replayed as assistant text", () => {
  const chat = toChatFromGemini({
    contents: [{ role: "model", parts: [{ text: "thinking...", thought: true }, { text: "answer" }] }]
  }, "m");
  assert.equal(chat.messages[0].content, "answer");
});

// ---- tool call key

test("toolCallKey: index wins, id separates index-less calls, bare fragments continue the last call", () => {
  const state = { last: null };
  assert.equal(toolCallKey({ index: 3 }, state), 3);
  const a = toolCallKey({ id: "a" }, state);
  const b = toolCallKey({ id: "b" }, state);
  assert.notEqual(a, b);
  assert.equal(toolCallKey({}, state), b);
  assert.equal(toolCallKey({}, { last: null }), 0);
});

test("anthropic stream: index-less tool calls stay separate", async () => {
  const out = await collect(streamToAnthropic("openai-chat", gen(noIndexCalls), "m"));
  assert.equal(count(out, /"type":"tool_use"/g), 2);
  assert.ok(!out.includes('{\\"p\\":1}{\\"p\\":2}'));
});

test("anthropic stream: fragmented calls with an index still accumulate into one block", async () => {
  const out = await collect(streamToAnthropic("openai-chat", gen([
    { choices: [{ delta: { tool_calls: [{ index: 0, id: "a", function: { name: "read", arguments: '{"p"' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: ":1}" } }] } }] },
    { choices: [{ finish_reason: "tool_calls", delta: {} }] }
  ]), "m"));
  assert.equal(count(out, /"type":"tool_use"/g), 1);
});

test("responses stream: index-less tool calls stay separate", async () => {
  const out = await collect(streamToResponses("openai-chat", gen(noIndexCalls), "m"));
  assert.equal(count(out, /event: response\.output_item\.added/g), 2);
});

// ---- mid-stream errors

test("anthropic stream: an upstream error chunk becomes an error event", async () => {
  const out = await collect(streamToAnthropic("openai-chat", gen([
    { choices: [{ delta: { content: "hi" } }] },
    { error: { message: "rate limited" } }
  ]), "m"));
  assert.match(out, /event: error/);
  assert.match(out, /rate limited/);
  assert.ok(!out.includes("message_stop"));
});

test("chat stream: an upstream error chunk is surfaced, then [DONE]", async () => {
  const out = await collect(streamToChat("gemini", gen([
    { candidates: [{ content: { parts: [{ text: "hi" }] } }] },
    { error: { message: "quota exceeded" } }
  ]), "m"));
  assert.match(out, /quota exceeded/);
  assert.ok(out.trimEnd().endsWith("data: [DONE]"));
});

test("responses stream: an upstream error chunk produces response.failed, not completed", async () => {
  const out = await collect(streamToResponses("openai-chat", gen([
    { choices: [{ delta: { content: "hi" } }] },
    { error: { message: "boom" } }
  ]), "m"));
  assert.match(out, /response\.failed/);
  assert.ok(!out.includes("response.completed"));
});

// ---- schema

test("schema: $ref/$defs are inlined instead of degrading to string", () => {
  const out = cleanSchemaForGemini({
    type: "object",
    properties: { file: { $ref: "#/$defs/File", description: "the file" } },
    $defs: { File: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } }
  });
  assert.equal(out.properties.file.type, "object");
  assert.equal(out.properties.file.properties.path.type, "string");
  assert.equal(out.properties.file.description, "the file");
});

test("schema: a recursive $ref stops at an object instead of looping", () => {
  const out = cleanSchemaForGemini({
    type: "object",
    properties: { node: { $ref: "#/$defs/Node" } },
    $defs: { Node: { type: "object", properties: { child: { $ref: "#/$defs/Node" }, name: { type: "string" } } } }
  });
  assert.equal(out.properties.node.properties.child.type, "object");
  assert.equal(out.properties.node.properties.name.type, "string");
});

test("schema: a $ref inside anyOf resolves too", () => {
  const out = cleanSchemaForGemini({
    type: "object",
    properties: { f: { anyOf: [{ $ref: "#/definitions/A" }, { type: "null" }] } },
    definitions: { A: { type: "object", properties: { x: { type: "integer" } } } }
  });
  assert.equal(out.properties.f.type, "object");
  assert.equal(out.properties.f.nullable, true);
});

// ---- usage and stop reason

test("gemini usage counts thinking tokens as output everywhere the client sees usage", async () => {
  const meta = { promptTokenCount: 10, candidatesTokenCount: 5, thoughtsTokenCount: 200, totalTokenCount: 215 };
  assert.equal(geminiOutputTokens(meta), 205);
  const json = { candidates: [{ content: { parts: [{ text: "hi" }] }, finishReason: "STOP" }], usageMetadata: meta };
  assert.equal(geminiJsonToAnthropic(json, "m").usage.output_tokens, 205);
  assert.equal(geminiJsonToChat(json, "m").usage.completion_tokens, 205);
  assert.equal(geminiJsonToResponses(json, "m").usage.output_tokens, 205);

  const chatStream = await collect(streamToChat("gemini", gen([json]), "m", { includeUsage: true }));
  assert.match(chatStream, /"completion_tokens":205/);
});

test("anthropic stream reports input tokens in message_delta", async () => {
  const out = await collect(streamToAnthropic("openai-chat", gen([
    { choices: [{ delta: { content: "hi" } }] },
    { choices: [{ finish_reason: "stop", delta: {} }], usage: { prompt_tokens: 5000, completion_tokens: 10 } }
  ]), "m"));
  assert.match(out, /"input_tokens":5000/);
});

test("a tool call cut off by the token limit reports max_tokens, not tool_use", async () => {
  const cut = [
    { choices: [{ delta: { tool_calls: [{ index: 0, id: "a", function: { name: "read", arguments: '{"p"' } }] } }] },
    { choices: [{ finish_reason: "length", delta: {} }] }
  ];
  assert.match(await collect(streamToAnthropic("openai-chat", gen(cut), "m")), /"stop_reason":"max_tokens"/);
  const json = { choices: [{ finish_reason: "length", message: { tool_calls: [{ id: "a", function: { name: "read", arguments: '{"p"' } }] } }] };
  assert.equal(openAIJsonToAnthropic(json, "m").stop_reason, "max_tokens");
});

test("a complete Gemini tool call still reports tool_use even at MAX_TOKENS", async () => {
  const json = { candidates: [{ content: { parts: [{ functionCall: { name: "read", args: {} } }] }, finishReason: "MAX_TOKENS" }] };
  assert.equal(geminiJsonToAnthropic(json, "m").stop_reason, "tool_use");
  const out = await collect(streamToAnthropic("gemini", gen([json]), "m"));
  assert.match(out, /"stop_reason":"tool_use"/);
});

// ---- gemini stream (chat upstream -> Gemini client)

import { streamToGemini } from "../src/gemini-bridge.js";

const geminiEvents = async (events) => (await collect(streamToGemini(gen(events))))
  .split("\n\n").filter(Boolean).map((chunk) => JSON.parse(chunk.replace(/^data: /, "")));

test("gemini stream: only the last chunk carries finishReason, and it carries usage", async () => {
  const chunks = await geminiEvents([
    { choices: [{ delta: { role: "assistant", content: "hel" } }] },
    { choices: [{ delta: { content: "lo" } }] },
    { choices: [{ delta: {}, finish_reason: "stop" }] },
    { choices: [], usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 } },
    "[DONE]"
  ].map((item) => item));
  assert.equal(chunks.length, 3);
  assert.equal(chunks[0].candidates[0].finishReason, undefined);
  assert.equal(chunks[1].candidates[0].finishReason, undefined);
  assert.equal(chunks[2].candidates[0].finishReason, "STOP");
  assert.deepEqual(chunks[2].usageMetadata, { promptTokenCount: 7, candidatesTokenCount: 3, totalTokenCount: 10 });
});

test("gemini stream: fragmented and index-less tool calls assemble into separate functionCalls", async () => {
  const chunks = await geminiEvents([
    { choices: [{ delta: { tool_calls: [{ index: 0, id: "a", function: { name: "read", arguments: '{"p"' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: ":1}" } }] } }] },
    { choices: [{ delta: { tool_calls: [{ id: "b", function: { name: "write", arguments: '{"q":2}' } }] } }] },
    { choices: [{ delta: {}, finish_reason: "tool_calls" }] }
  ]);
  const calls = chunks.flatMap((c) => c.candidates[0].content.parts).filter((p) => p.functionCall).map((p) => p.functionCall);
  assert.deepEqual(calls.map((c) => [c.name, c.args]), [["read", { p: 1 }], ["write", { q: 2 }]]);
  assert.equal(chunks.at(-1).candidates[0].finishReason, "STOP");
});

test("gemini stream: an upstream error ends the stream and nothing follows it", async () => {
  const chunks = await geminiEvents([
    { choices: [{ delta: { content: "hi" } }] },
    { error: { message: "boom" } },
    { choices: [{ delta: {}, finish_reason: "stop" }] }
  ]);
  assert.equal(chunks.at(-1).error.message, "boom");
  assert.ok(!chunks.some((c) => c.candidates?.[0]?.finishReason));
});

test("gemini request: a streaming call asks the chat upstream for usage", () => {
  const out = toChatFromGemini({ contents: [{ role: "user", parts: [{ text: "hi" }] }] }, "m", { stream: true });
  assert.deepEqual(out.stream_options, { include_usage: true });
  const plain = toChatFromGemini({ contents: [{ role: "user", parts: [{ text: "hi" }] }] }, "m");
  assert.equal(plain.stream_options, undefined);
});
