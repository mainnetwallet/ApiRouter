import test from "node:test";
import assert from "node:assert/strict";

import { toChatFromGemini, chatJsonToGemini, streamToGemini, normalizeGeminiBody } from "../src/gemini-bridge.js";

const roles = (messages) => messages.map((m) => m.role);

test("function calls without ids get stable ids, and each response is paired with its call", () => {
  const body = { contents: [
    { role: "user", parts: [{ text: "go" }] },
    { role: "model", parts: [{ functionCall: { name: "read", args: { p: "a" } } }, { functionCall: { name: "read", args: { p: "b" } } }] },
    { role: "user", parts: [{ functionResponse: { name: "read", response: { r: "A" } } }, { functionResponse: { name: "read", response: { r: "B" } } }] }
  ] };
  const messages = toChatFromGemini(body, "m").messages;
  const calls = messages[1].tool_calls;
  assert.equal(calls.length, 2, "parallel calls are preserved");
  assert.notEqual(calls[0].id, calls[1].id, "same-name calls get distinct ids");
  assert.deepEqual(messages.filter((m) => m.role === "tool").map((m) => m.tool_call_id), [calls[0].id, calls[1].id], "responses pair in order");
  assert.deepEqual(messages.filter((m) => m.role === "tool").map((m) => JSON.parse(m.content).r), ["A", "B"]);

  const again = toChatFromGemini(body, "m").messages[1].tool_calls.map((c) => c.id);
  assert.deepEqual(again, calls.map((c) => c.id), "the same history yields the same ids on every request");
});

test("a client-supplied call id is kept and used by the matching response", () => {
  const body = { contents: [
    { role: "model", parts: [{ functionCall: { id: "client-1", name: "f", args: {} } }, { functionCall: { id: "client-2", name: "f", args: {} } }] },
    { role: "user", parts: [{ functionResponse: { id: "client-2", name: "f", response: { n: 2 } } }, { functionResponse: { id: "client-1", name: "f", response: { n: 1 } } }] }
  ] };
  const messages = toChatFromGemini(body, "m").messages;
  assert.deepEqual(messages[0].tool_calls.map((c) => c.id), ["client-1", "client-2"]);
  assert.deepEqual(messages.filter((m) => m.role === "tool").map((m) => m.tool_call_id), ["client-2", "client-1"]);
});

test("tool messages come right after the assistant turn, before any text sent in the same user turn", () => {
  const body = { contents: [
    { role: "model", parts: [{ functionCall: { name: "read", args: {} } }] },
    { role: "user", parts: [{ text: "also note this" }, { functionResponse: { name: "read", response: { r: 1 } } }] }
  ] };
  assert.deepEqual(roles(toChatFromGemini(body, "m").messages), ["assistant", "tool", "user"]);
});

test("a functionResponse with no earlier matching call is a 400, not a guessed id", () => {
  const body = { contents: [{ role: "user", parts: [{ functionResponse: { name: "read", response: {} } }] }] };
  assert.throws(() => toChatFromGemini(body, "m"), (error) => error.status === 400 && error.code === "orphan_function_response");
});

test("multiple turns keep earlier calls answered and later calls pending", () => {
  const body = { contents: [
    { role: "model", parts: [{ functionCall: { name: "a", args: {} } }] },
    { role: "user", parts: [{ functionResponse: { name: "a", response: { v: 1 } } }] },
    { role: "model", parts: [{ functionCall: { name: "a", args: { again: true } } }] },
    { role: "user", parts: [{ functionResponse: { name: "a", response: { v: 2 } } }] }
  ] };
  const messages = toChatFromGemini(body, "m").messages;
  const callIds = messages.filter((m) => m.tool_calls).map((m) => m.tool_calls[0].id);
  assert.notEqual(callIds[0], callIds[1]);
  assert.deepEqual(messages.filter((m) => m.role === "tool").map((m) => m.tool_call_id), callIds);
});

test("snake_case Gemini requests are read the same as camelCase (parts, system, config, tools)", () => {
  const snake = {
    system_instruction: { parts: [{ text: "be brief" }] },
    generation_config: { max_output_tokens: 50, top_p: 0.5, stop_sequences: ["x"] },
    tools: [{ function_declarations: [{ name: "f", description: "d", parameters: { type: "object", properties: {} } }] }],
    tool_config: { function_calling_config: { mode: "ANY", allowed_function_names: ["f"] } },
    contents: [
      { role: "model", parts: [{ function_call: { name: "f", args: { a: 1 } } }] },
      { role: "user", parts: [{ function_response: { name: "f", response: { ok: true } } }] }
    ]
  };
  const out = toChatFromGemini(snake, "m");
  assert.equal(out.messages[0].content, "be brief");
  assert.equal(out.max_tokens, 50);
  assert.equal(out.tools[0].function.name, "f");
  assert.deepEqual(roles(out.messages), ["system", "assistant", "tool"]);
  assert.equal(normalizeGeminiBody({ contents: { role: "user", parts: [{ text: "hi" }] } }).contents.length, 1, "a single Content object is accepted");
});

test("malformed tool arguments from the upstream are an error, never silently {}", () => {
  const bad = { choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: "c", type: "function", function: { name: "f", arguments: "{not json" } }] }, finish_reason: "tool_calls" }] };
  assert.throws(() => chatJsonToGemini(bad), (error) => error.status === 502 && error.retryable === true);
  const arrayArgs = { choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: "c", type: "function", function: { name: "f", arguments: "[1]" } }] } }] };
  assert.throws(() => chatJsonToGemini(arrayArgs), (error) => error.status === 502);
  const none = { choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: "c", type: "function", function: { name: "f", arguments: "" } }] } }] };
  assert.deepEqual(chatJsonToGemini(none).candidates[0].content.parts[0].functionCall.args, {}, "an empty argument string is a call with no parameters");
});

test("a returned function call always carries an id the client can echo", () => {
  const out = chatJsonToGemini({ choices: [{ message: { role: "assistant", content: null, tool_calls: [{ type: "function", function: { name: "f", arguments: "{}" } }] } }] });
  assert.match(out.candidates[0].content.parts[0].functionCall.id, /^call_/);
});

async function collect(generator) {
  const out = [];
  for await (const chunk of generator) out.push(JSON.parse(chunk.replace(/^data: /, "")));
  return out;
}
async function* events(...items) { for (const item of items) yield typeof item === "string" ? item : JSON.stringify(item); }

test("streaming: finishReason appears only on the final chunk, never on intermediate text deltas", async () => {
  const chunks = await collect(streamToGemini(events(
    { choices: [{ delta: { content: "Hel" } }] },
    { choices: [{ delta: { content: "lo" } }] },
    { choices: [{ delta: {}, finish_reason: "stop" }] },
    "[DONE]"
  )));
  const reasons = chunks.map((c) => c.candidates?.[0]?.finishReason);
  assert.deepEqual(reasons, [undefined, undefined, "STOP"]);
  assert.equal(chunks[0].candidates[0].content.parts[0].text, "Hel");
});

test("streaming: parallel tool calls are preserved with ids, and the finishing chunk follows them", async () => {
  const chunks = await collect(streamToGemini(events(
    { choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "a", arguments: "{\"x\"" } }, { index: 1, id: "c2", function: { name: "b", arguments: "{}" } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: ":1}" } }] } }] },
    { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
    "[DONE]"
  )));
  const calls = chunks.flatMap((c) => c.candidates?.[0]?.content?.parts ?? []).filter((p) => p.functionCall).map((p) => p.functionCall);
  assert.deepEqual(calls.map((c) => [c.id, c.name, c.args]), [["c1", "a", { x: 1 }], ["c2", "b", {}]]);
  assert.equal(chunks.filter((c) => c.candidates?.[0]?.finishReason).length, 1);
});

test("streaming: malformed streamed tool arguments or a broken upstream end in an error event, not a clean finish", async () => {
  const malformed = await collect(streamToGemini(events(
    { choices: [{ delta: { tool_calls: [{ index: 0, id: "c", function: { name: "a", arguments: "{oops" } }] } }] },
    { choices: [{ delta: {}, finish_reason: "tool_calls" }] }
  )));
  assert.equal(malformed.at(-1).error.status, "UNAVAILABLE");
  assert.ok(!malformed.some((c) => c.candidates?.[0]?.finishReason), "no success finish is reported");

  async function* broken() { yield JSON.stringify({ choices: [{ delta: { content: "par" } }] }); throw new Error("socket hang up"); }
  const cut = await collect(streamToGemini(broken()));
  assert.equal(cut[0].candidates[0].content.parts[0].text, "par");
  assert.equal(cut.at(-1).error.code, 502);
});
