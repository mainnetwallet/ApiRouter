import test from "node:test";
import assert from "node:assert/strict";
import { startMockUpstream } from "../test-helpers/mock-upstream.js";
import { startRouter, postJson } from "../test-helpers/router-harness.js";
import {
  rememberSignature,
  signatureFor,
  toGeminiRequest,
  geminiJsonToAnthropic
} from "../src/anthropic-bridge.js";
import { toGeminiFromChat, geminiJsonToChat, streamToChat } from "../src/chat-bridge.js";
import { toGeminiFromResponses, geminiJsonToResponses } from "../src/codex-bridge.js";

/**
 * PHASE 7 - thought signatures are scoped to the request session.
 *
 * Gemini 3 requires the `thoughtSignature` a response carried to be echoed back
 * with the same functionCall. Storage is keyed by tool-call id *and* session, so
 * two unrelated sessions that happen to reuse an id can never exchange a
 * signature. Eviction is an explicit FIFO cap and the store is volatile.
 */

const chatToolTurn = (id) => ({
  messages: [
    { role: "assistant", content: null, tool_calls: [{ id, type: "function", function: { name: "shell", arguments: "{\"cmd\":\"ls\"}" } }] },
    { role: "tool", tool_call_id: id, content: "a.txt" }
  ]
});

test("a signature is only replayed inside the session that received it", () => {
  rememberSignature("call_1", "SIG-A", "session-a");

  const sameSession = toGeminiFromChat(chatToolTurn("call_1"), { sessionId: "session-a" });
  assert.equal(sameSession.contents[0].parts[0].thoughtSignature, "SIG-A");

  const otherSession = toGeminiFromChat(chatToolTurn("call_1"), { sessionId: "session-b" });
  assert.equal(otherSession.contents[0].parts[0].thoughtSignature, undefined,
    "an id collision across sessions must not leak a signature");
});

test("the same tool id in two sessions keeps each session's own signature", () => {
  rememberSignature("call_dup", "SIG-1", "s1");
  rememberSignature("call_dup", "SIG-2", "s2");

  assert.equal(toGeminiFromChat(chatToolTurn("call_dup"), { sessionId: "s1" }).contents[0].parts[0].thoughtSignature, "SIG-1");
  assert.equal(toGeminiFromChat(chatToolTurn("call_dup"), { sessionId: "s2" }).contents[0].parts[0].thoughtSignature, "SIG-2");
});

test("a Gemini response stores its signature under the request's session (chat)", () => {
  geminiJsonToChat({
    candidates: [{ content: { parts: [{ functionCall: { name: "shell", args: {} }, thoughtSignature: "SIG-C" }] } }]
  }, "m", { sessionId: "s-chat" });

  assert.equal(signatureFor("does-not-exist", "s-chat"), undefined);
  const stored = toGeminiFromChat(chatToolTurn("__from_response__"));
  assert.equal(stored.contents[0].parts[0].thoughtSignature, undefined, "no session id means the default session");

  const first = geminiJsonToChat({
    candidates: [{ content: { parts: [{ functionCall: { name: "shell", args: {} }, thoughtSignature: "SIG-C2" }] } }]
  }, "m", { sessionId: "s-chat" });
  const callId = first.choices[0].message.tool_calls[0].id;
  assert.equal(toGeminiFromChat(chatToolTurn(callId), { sessionId: "s-chat" }).contents[0].parts[0].thoughtSignature, "SIG-C2");
  assert.equal(toGeminiFromChat(chatToolTurn(callId), { sessionId: "other" }).contents[0].parts[0].thoughtSignature, undefined);
});

test("the Anthropic bridge isolates signatures by session too", () => {
  geminiJsonToAnthropic({
    candidates: [{ content: { parts: [{ functionCall: { name: "shell", args: {} }, thoughtSignature: "SIG-AN" }] } }]
  }, "m", { sessionId: "anthropic-a" });

  const first = geminiJsonToAnthropic({
    candidates: [{ content: { parts: [{ functionCall: { name: "shell", args: {} }, thoughtSignature: "SIG-AN" }] } }]
  }, "m", { sessionId: "anthropic-a" });
  const toolUseId = first.content[0].id;

  const body = { messages: [
    { role: "assistant", content: [{ type: "tool_use", id: toolUseId, name: "shell", input: {} }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: toolUseId, content: "a.txt" }] }
  ] };
  assert.equal(toGeminiRequest(body, { sessionId: "anthropic-a" }).contents[0].parts[0].thoughtSignature, "SIG-AN");
  assert.equal(toGeminiRequest(body, { sessionId: "anthropic-b" }).contents[0].parts[0].thoughtSignature, undefined);
});

test("the Responses bridge isolates signatures by session too", () => {
  const first = geminiJsonToResponses({
    candidates: [{ content: { parts: [{ functionCall: { name: "shell", args: {} }, thoughtSignature: "SIG-R" }] } }]
  }, "m", { sessionId: "resp-a" });
  const callId = first.output[0].call_id;

  const body = { input: [
    { type: "function_call", call_id: callId, name: "shell", arguments: "{}" },
    { type: "function_call_output", call_id: callId, output: "a.txt" }
  ] };
  assert.equal(toGeminiFromResponses(body, { sessionId: "resp-a" }).contents[0].parts[0].thoughtSignature, "SIG-R");
  assert.equal(toGeminiFromResponses(body, { sessionId: "resp-b" }).contents[0].parts[0].thoughtSignature, undefined);
});

test("a Gemini stream stores its signature under the converter's session", async () => {
  const events = (async function* () {
    yield JSON.stringify({ candidates: [{ content: { parts: [{ functionCall: { name: "shell", args: {} }, thoughtSignature: "SIG-S" }] } }] });
    yield "[DONE]";
  })();
  const chunks = [];
  for await (const chunk of streamToChat("gemini", events, "m", { sessionId: "stream-a" })) chunks.push(chunk);

  const payload = JSON.parse(chunks.find((c) => c.includes("\"tool_calls\"")).slice("data: ".length));
  const callId = payload.choices[0].delta.tool_calls[0].id;
  assert.equal(signatureFor(callId, "stream-a"), "SIG-S");
  assert.equal(signatureFor(callId, "stream-b"), undefined);
});

test("a missing signature omits thoughtSignature rather than emitting an empty one", () => {
  const out = toGeminiFromChat(chatToolTurn("never-stored"), { sessionId: "empty-session" });
  assert.ok(!("thoughtSignature" in out.contents[0].parts[0]));
});

test("signature eviction is explicit: the oldest entry leaves first, the store stays bounded", () => {
  // The cap is a hard FIFO bound, so inserting the 2001st entry evicts the first.
  for (let i = 0; i < 2000; i += 1) rememberSignature(`evict-${i}`, `v${i}`, "evict-scope");
  assert.equal(signatureFor("evict-0", "evict-scope"), "v0");
  rememberSignature("evict-last", "v-last", "evict-scope");
  assert.equal(signatureFor("evict-0", "evict-scope"), undefined, "oldest entry is evicted first");
  assert.equal(signatureFor("evict-last", "evict-scope"), "v-last");
});

// ---------------------------------------------------------------------------
// HTTP: the same tool id in two sessions on the wire
// ---------------------------------------------------------------------------

const geminiToolReply = {
  candidates: [{ content: { parts: [{ functionCall: { name: "shell", args: { cmd: "ls" } }, thoughtSignature: "SIG-WIRE" }] }, finishReason: "STOP" }]
};
const geminiTextReply = {
  candidates: [{ content: { parts: [{ text: "done" }] }, finishReason: "STOP" }],
  usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 }
};

test("HTTP: a signature captured in one session is not replayed into another", async (t) => {
  let posts = 0;
  const upstream = await startMockUpstream(() => {
    posts += 1;
    return { status: 200, body: posts === 1 ? geminiToolReply : geminiTextReply };
  });
  const router = await startRouter({
    GEMINI_API_KEYS: "key",
    GEMINI_MODELS: "gemini-2.5-pro",
    GEMINI_BASE_URL: upstream.baseUrl
  });
  t.after(async () => { await router.close(); await upstream.close(); });

  const first = await router.request("/v1/messages", postJson({
    model: "gemini-2.5-pro",
    max_tokens: 64,
    messages: [{ role: "user", content: "list the files" }],
    tools: [{ name: "shell", input_schema: { type: "object", properties: { cmd: { type: "string" } } } }]
  }, { "x-multi-ai-session-id": "wire-a" }));
  assert.equal(first.status, 200);
  const firstBody = await first.json();
  const toolUseId = firstBody.content.find((block) => block.type === "tool_use")?.id;
  assert.ok(toolUseId, "the Gemini tool call came back as an Anthropic tool_use");

  const followUp = {
    model: "gemini-2.5-pro",
    max_tokens: 64,
    messages: [
      { role: "user", content: "list the files" },
      { role: "assistant", content: [{ type: "tool_use", id: toolUseId, name: "shell", input: { cmd: "ls" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: toolUseId, content: "a.txt" }] }
    ]
  };

  const sameSession = await router.request("/v1/messages", postJson(followUp, { "x-multi-ai-session-id": "wire-a" }));
  assert.equal(sameSession.status, 200);
  const otherSession = await router.request("/v1/messages", postJson(followUp, { "x-multi-ai-session-id": "wire-b" }));
  assert.equal(otherSession.status, 200);

  const followUps = upstream.apiRequests.filter((call) => JSON.stringify(call.body).includes("functionResponse"));
  assert.equal(followUps.length, 2, "both follow-up turns reached the provider");

  const signatureOf = (call) => call.body.contents
    .flatMap((content) => content.parts)
    .find((part) => part.functionCall)?.thoughtSignature;

  assert.equal(signatureOf(followUps[0]), "SIG-WIRE", "session A echoes the signature it received");
  assert.equal(signatureOf(followUps[1]), undefined, "session B must not receive session A's signature");
});
