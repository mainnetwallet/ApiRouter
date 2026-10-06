import test from "node:test";
import assert from "node:assert/strict";
import { startMockUpstream } from "../test-helpers/mock-upstream.js";
import { startRouter, postJson } from "../test-helpers/router-harness.js";
import { toGeminiFromChat } from "../src/chat-bridge.js";
import { toGeminiFromResponses } from "../src/codex-bridge.js";

/**
 * PHASE 6 - malformed tool arguments are never silently replaced by `{}`.
 *
 * A chat/Responses tool call carries its arguments as a JSON *string*. Gemini
 * needs an object, so when the string is not valid JSON the gateway cannot
 * carry the call faithfully: it refuses that target (`400
 * invalid_tool_arguments`, retryable, no cooldown) so the same request can
 * still be served by an OpenAI-compatible target, which takes the raw string
 * verbatim. Gemini's only alternative - `{}` - would drop the model's
 * arguments while answering `200`.
 */
const refusesToolArguments = (fn) => assert.throws(fn, (error) => {
  assert.equal(error.status, 400, error.message);
  assert.equal(error.errorType, "invalid_tool_arguments");
  assert.equal(error.retryable, true, "an OpenAI-compatible target can carry the raw string");
  assert.equal(error.skipCooldown, true, "a request-shape mismatch must not cool a healthy target");
  return true;
});

const chatTurn = (args) => ({
  messages: [
    { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "shell", arguments: args } }] },
    { role: "tool", tool_call_id: "c1", content: "a.txt" }
  ]
});

test("chat -> Gemini refuses a tool call whose arguments are not valid JSON", () => {
  refusesToolArguments(() => toGeminiFromChat(chatTurn('{"cmd":')));
});

test("chat -> Gemini still accepts a tool call with no arguments", () => {
  const out = toGeminiFromChat(chatTurn(""));
  assert.deepEqual(out.contents[0].parts[0].functionCall.args, {});
});

test("Responses -> Gemini refuses a function_call whose arguments are not valid JSON", () => {
  refusesToolArguments(() => toGeminiFromResponses({
    input: [{ type: "function_call", call_id: "c1", name: "shell", arguments: "{not json" }]
  }));
});

test("Responses -> Gemini still accepts a function_call with no arguments", () => {
  const out = toGeminiFromResponses({
    input: [{ type: "function_call", call_id: "c1", name: "shell", arguments: "" }]
  });
  assert.deepEqual(out.contents[0].parts[0].functionCall.args, {});
});

test("Responses -> Gemini refuses arguments that parse to a non-object", () => {
  refusesToolArguments(() => toGeminiFromResponses({
    input: [{ type: "function_call", call_id: "c1", name: "shell", arguments: "42" }]
  }));
});

test("Responses custom_tool_call input is a raw string and stays one", () => {
  const out = toGeminiFromResponses({
    input: [{ type: "custom_tool_call", call_id: "c1", name: "apply_patch", input: "*** Begin Patch" }]
  });
  assert.deepEqual(out.contents[0].parts[0].functionCall.args, { input: "*** Begin Patch" });
});

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

const chatReply = {
  id: "chatcmpl-1",
  object: "chat.completion",
  choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
};
const geminiReply = { candidates: [{ content: { role: "model", parts: [{ text: "ok" }] }, finishReason: "STOP" }] };

const brokenHistory = {
  model: "gemini-2.5-pro",
  messages: [
    { role: "user", content: "list the files" },
    { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "shell", arguments: '{"cmd":' } }] },
    { role: "tool", tool_call_id: "c1", content: "a.txt" }
  ]
};

test("HTTP: malformed arguments fall over from Gemini to an OpenAI-compatible target, raw string intact", async (t) => {
  const geminiUpstream = await startMockUpstream(() => ({ status: 200, body: geminiReply }));
  const groqUpstream = await startMockUpstream(() => ({ status: 200, body: chatReply }));
  const router = await startRouter({
    GEMINI_API_KEYS: "key",
    GEMINI_MODELS: "gemini-2.5-pro",
    GEMINI_BASE_URL: geminiUpstream.baseUrl,
    GROQ_API_KEYS: "key",
    GROQ_MODELS: "llama-3.3-70b",
    GROQ_BASE_URL: groqUpstream.baseUrl,
    TEXT_PRIORITY_MODELS: "gemini/gemini-2.5-pro,groq/llama-3.3-70b"
  });
  t.after(async () => { await router.close(); await geminiUpstream.close(); await groqUpstream.close(); });

  const res = await router.request("/v1/chat/completions", postJson(brokenHistory));
  assert.equal(res.status, 200);

  assert.equal(geminiUpstream.apiRequests.length, 0, "Gemini is never asked to accept arguments it cannot carry");
  const [call] = groqUpstream.apiRequests;
  assert.ok(call, "the OpenAI-compatible target served the request");
  assert.equal(call.body.messages[1].tool_calls[0].function.arguments, '{"cmd":',
    "the raw argument string is replayed verbatim, not emptied");
});

test("HTTP: with only a Gemini target, malformed arguments are a 400 invalid_tool_arguments", async (t) => {
  const geminiUpstream = await startMockUpstream(() => ({ status: 200, body: geminiReply }));
  const router = await startRouter({
    GEMINI_API_KEYS: "key",
    GEMINI_MODELS: "gemini-2.5-pro",
    GEMINI_BASE_URL: geminiUpstream.baseUrl
  });
  t.after(async () => { await router.close(); await geminiUpstream.close(); });

  const res = await router.request("/v1/chat/completions", postJson(brokenHistory));
  const body = await res.json();

  assert.equal(res.status, 400);
  assert.equal(body.error.type, "invalid_tool_arguments");
  assert.equal(geminiUpstream.apiRequests.length, 0);
});
