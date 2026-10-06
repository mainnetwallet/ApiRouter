import test from "node:test";
import assert from "node:assert/strict";
import { startMockUpstream } from "../test-helpers/mock-upstream.js";
import { startRouter, postJson } from "../test-helpers/router-harness.js";
import { INVALID_TOOL_ARGUMENTS, parseToolArguments } from "../src/bridge-errors.js";
import { chatJsonToGemini, streamToGemini } from "../src/gemini-bridge.js";
import { openAIJsonToAnthropic } from "../src/anthropic-bridge.js";

/**
 * PHASE 6 (response direction) - a *provider's* malformed tool arguments must
 * never be silently rewritten to `{}`.
 *
 * `chatJsonToGemini` (chat provider -> Gemini client) and
 * `openAIJsonToAnthropic` (chat provider -> Anthropic client) both need a real
 * JSON *object*, and both used to `JSON.parse(...) catch -> {}`. That dropped
 * the model's arguments while still answering 200. They now refuse with a typed
 * `invalid_tool_arguments` error, and the server answers 4xx without cooling
 * the healthy provider for a translation-shape mismatch.
 *
 * Protocols that carry the raw string (Chat, Responses) are untouched: their
 * arguments pass through verbatim.
 */

const expectsInvalidArguments = (error) => {
  assert.equal(error.errorType, INVALID_TOOL_ARGUMENTS, error.message);
  assert.equal(error.status, 400);
  assert.equal(error.retryable, true, "another target can carry the raw string verbatim");
  assert.equal(error.skipCooldown, true, "a translation-shape mismatch is not provider ill health");
  return true;
};

// ------------------------------------------------------- parseToolArguments

test("parseToolArguments passes an object through and treats empty input as no arguments", () => {
  const object = { a: 1, nested: { b: [1, 2, 3] } };
  assert.equal(parseToolArguments(object), object, "an object is returned by reference, untouched");
  assert.deepEqual(parseToolArguments(undefined), {});
  assert.deepEqual(parseToolArguments(null), {});
  assert.deepEqual(parseToolArguments(""), {});
  assert.deepEqual(parseToolArguments("   "), {});
  assert.deepEqual(parseToolArguments("{}"), {});
  assert.deepEqual(parseToolArguments("{\"q\":\"x\"}"), { q: "x" });
  assert.deepEqual(parseToolArguments("{\"q\":{\"deep\":[1,2]}}"), { q: { deep: [1, 2] } });
});

test("parseToolArguments refuses malformed, primitive, null and array arguments", () => {
  const refused = ["{not json", "{\"q\":", "[1,2]", "42", "null", "true", "\"str\"", 42, false];
  for (const value of refused) {
    assert.throws(() => parseToolArguments(value), expectsInvalidArguments, `expected ${String(value)} to be refused`);
  }
});

// ------------------------------------------------------- chat -> Gemini

const chatToolResponse = (args) => ({
  choices: [{
    message: { role: "assistant", content: null, tool_calls: [{ id: "call-1", type: "function", function: { name: "lookup", arguments: args } }] },
    finish_reason: "tool_calls"
  }]
});

test("chat -> Gemini preserves a valid tool call's arguments and id exactly", () => {
  const out = chatJsonToGemini(chatToolResponse("{\"q\":{\"deep\":[1,2]}}"));
  const call = out.candidates[0].content.parts[0].functionCall;
  assert.deepEqual(call.args, { q: { deep: [1, 2] } });
  assert.equal(call.id, "call-1");
  assert.equal(call.name, "lookup");
});

test("chat -> Gemini never replaces malformed arguments with {}", () => {
  assert.throws(() => chatJsonToGemini(chatToolResponse("{not json")), expectsInvalidArguments);
  assert.throws(() => chatJsonToGemini(chatToolResponse("42")), expectsInvalidArguments);
  assert.throws(() => chatJsonToGemini(chatToolResponse("null")), expectsInvalidArguments);
});

test("chat -> Gemini still accepts a tool call with no arguments", () => {
  for (const empty of ["{}", "", undefined]) {
    assert.deepEqual(chatJsonToGemini(chatToolResponse(empty)).candidates[0].content.parts[0].functionCall.args, {});
  }
});

// ------------------------------------------------------- chat -> Anthropic

test("chat -> Anthropic preserves valid arguments and refuses malformed ones", () => {
  const good = openAIJsonToAnthropic(chatToolResponse("{\"q\":1}"), "m");
  const block = good.content.find((b) => b.type === "tool_use");
  assert.deepEqual(block.input, { q: 1 });
  assert.equal(block.id, "call-1");

  assert.throws(() => openAIJsonToAnthropic(chatToolResponse("{oops"), "m"), expectsInvalidArguments);
});

// ------------------------------------------------------- streamed response

test("streamToGemini fails the stream when the terminal tool arguments are malformed", async () => {
  async function* events() {
    yield JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "lookup", arguments: "{\"q\":" } }] }, finish_reason: null }] });
    yield JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }] });
    yield "[DONE]";
  }

  const chunks = [];
  let failure = null;
  try {
    for await (const chunk of streamToGemini(events())) chunks.push(chunk);
  } catch (error) {
    failure = error;
  }

  const envelope = chunks.map((chunk) => JSON.parse(chunk.slice(5))).find((payload) => payload.error);
  assert.ok(envelope, "the Gemini client still receives a protocol error envelope");
  assert.equal(envelope.error.code, 400);
  assert.equal(envelope.error.status, "INVALID_ARGUMENT");
  assert.equal(failure?.errorType, INVALID_TOOL_ARGUMENTS, "the stream surfaces the typed error, it does not swallow it");
  assert.equal(failure?.failedAfterHeaders, true, "the failure is marked as post-header");
  assert.equal(failure?.streamCause, "upstream", "it must be classified as a stream failure, not a client abort");
  assert.ok(chunks.every((chunk) => !chunk.includes("\"args\":{}")), "no fabricated empty arguments are emitted");
});

// ------------------------------------------------------- HTTP, non-stream

const chatReply = (args) => ({
  status: 200,
  body: {
    id: "c1", object: "chat.completion", created: 0, model: "u",
    choices: [{
      index: 0,
      message: { role: "assistant", content: null, tool_calls: [{ id: "call-1", type: "function", function: { name: "lookup", arguments: args } }] },
      finish_reason: "tool_calls"
    }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
  }
});

const entries = async (router) => (await (await router.request("/api/requests")).json()).entries;
const healthOf = async (router) => (await (await router.request("/health")).json());

const ask = { contents: [{ role: "user", parts: [{ text: "hi" }] }] };

async function waitForEntry(router) {
  for (let i = 0; i < 100; i += 1) {
    const list = await entries(router);
    if (list.length) return list;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("the request was never recorded");
}

test("HTTP: a Gemini client gets 400 invalid_tool_arguments when the provider's arguments are malformed", async (t) => {
  const groq = await startMockUpstream(() => chatReply("{not json"));
  const router = await startRouter({ GROQ_API_KEYS: "k", GROQ_MODELS: "m", GROQ_BASE_URL: groq.baseUrl });
  t.after(async () => { await router.close(); await groq.close(); });

  const res = await router.request("/v1beta/models/m:generateContent", postJson(ask));
  const body = await res.json();

  assert.equal(res.status, 400, "a translation-shape mismatch is a 4xx, not a gateway error");
  assert.equal(body.error.type, INVALID_TOOL_ARGUMENTS);

  const [entry] = await entries(router);
  assert.equal(entry.outcome, "failed");
  assert.equal(entry.errorType, INVALID_TOOL_ARGUMENTS);

  const health = await healthOf(router);
  assert.ok(
    !health.coolingTargets.some((r) => r.provider === "groq"),
    "a healthy provider is not cooled for arguments it could not represent"
  );
});

test("HTTP: a malformed-argument response does not make the provider sticky", async (t) => {
  const groq = await startMockUpstream(() => chatReply("{not json"));
  const router = await startRouter({ GROQ_API_KEYS: "k", GROQ_MODELS: "m", GROQ_BASE_URL: groq.baseUrl });
  t.after(async () => { await router.close(); await groq.close(); });

  await router.request("/v1beta/models/m:generateContent", postJson(ask, { "x-multi-ai-session-id": "shape1" }));
  await waitForEntry(router);
  const second = await router.request("/v1beta/models/m:generateContent", postJson(ask, { "x-multi-ai-session-id": "shape1" }));
  assert.equal(second.status, 400);

  const latest = (await entries(router)).at(-1);
  assert.ok(!latest.attempts.some((a) => a.phase === "sticky"), "a failed translation never becomes sticky");
});

// ------------------------------------------------------- HTTP, streaming

async function readTolerant(res) {
  const parts = [];
  const reader = res.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(Buffer.from(value).toString("utf8"));
    }
  } catch { /* the server tears the socket down after the failure */ }
  return parts.join("");
}

test("HTTP: a translated streaming response with malformed arguments is truncated, not a success", async (t) => {
  const groq = await startMockUpstream(() => ({
    status: 200,
    headers: { "content-type": "text/event-stream" },
    stream: [
      `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "lookup", arguments: "{\"q\":" } }] }, finish_reason: null }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }] })}\n\n`,
      "data: [DONE]\n\n"
    ]
  }));
  const router = await startRouter({ GROQ_API_KEYS: "k", GROQ_MODELS: "m", GROQ_BASE_URL: groq.baseUrl });
  t.after(async () => { await router.close(); await groq.close(); });

  const res = await router.request(
    "/v1beta/models/m:streamGenerateContent",
    postJson({ ...ask, stream: true }, { "x-multi-ai-session-id": "shape2" })
  );
  assert.equal(res.status, 200, "the headers were already on the wire");

  const raw = await readTolerant(res);
  assert.match(raw, /INVALID_ARGUMENT/, "the Gemini client receives the protocol error envelope");

  const [entry] = await waitForEntry(router);
  assert.equal(entry.outcome, "failed");
  assert.equal(entry.streamOutcome, "truncated");
  assert.equal(entry.errorType, INVALID_TOOL_ARGUMENTS);

  const health = await healthOf(router);
  assert.ok(
    !health.coolingTargets.some((r) => r.provider === "groq"),
    "a translation-shape mismatch does not cool the provider"
  );
});
