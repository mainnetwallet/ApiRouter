import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { RequestLog, ATTEMPT_STATES } from "../src/observability/request-log.js";
import {
  createJsonUsageTap,
  createSseUsageTap,
  normalizeUsage,
  tapBytes,
  tapEvents,
  usageFrom
} from "../src/usage.js";
import { startMockUpstream } from "../test-helpers/mock-upstream.js";
import { startRouter, postJson } from "../test-helpers/router-harness.js";

/**
 * Token usage of ONE upstream attempt: normalised from what the provider reports
 * (never estimated, never 0 for "unknown"), captured from streams without touching
 * them, and kept apart per attempt.
 */

// --- normalising what a provider reports ---------------------------------

test("usageFrom reads OpenAI chat, Responses, Anthropic and Gemini shapes", () => {
  assert.deepEqual(
    usageFrom({ usage: { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 } }),
    { inputTokens: 12, outputTokens: 5, tokens: 17 }
  );
  assert.deepEqual(
    usageFrom({ usage: { input_tokens: 7, output_tokens: 3, total_tokens: 10 } }),
    { inputTokens: 7, outputTokens: 3, tokens: 10 }
  );
  // Anthropic reports no total: it is input + output, both known.
  assert.deepEqual(
    usageFrom({ usage: { input_tokens: 20, output_tokens: 8 } }),
    { inputTokens: 20, outputTokens: 8, tokens: 28 }
  );
  assert.deepEqual(
    usageFrom({ usageMetadata: { promptTokenCount: 9, candidatesTokenCount: 4, totalTokenCount: 13 } }),
    { inputTokens: 9, outputTokens: 4, tokens: 13 }
  );
});

test("the provider's own total wins over input + output", () => {
  // e.g. a thinking model whose total includes reasoning tokens.
  assert.deepEqual(
    usageFrom({ usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 40 } }),
    { inputTokens: 10, outputTokens: 5, tokens: 40 }
  );
});

test("missing usage is null, never zero; a total is not made up from half the data", () => {
  assert.equal(usageFrom({}), null);
  assert.equal(usageFrom(null), null);
  assert.equal(usageFrom({ usage: null }), null);
  assert.equal(usageFrom({ usage: {} }), null);
  assert.equal(usageFrom({ usage: { prompt_tokens: "12" } }), null, "strings are not counts");
  assert.equal(usageFrom({ usage: { prompt_tokens: -3 } }), null);

  assert.deepEqual(usageFrom({ usage: { prompt_tokens: 12 } }), { inputTokens: 12, outputTokens: null, tokens: null });
  assert.deepEqual(usageFrom({ usage: { input_tokens: 4, output_tokens: 0 } }), { inputTokens: 4, outputTokens: 0, tokens: 4 },
    "a reported zero is a real zero");
  assert.deepEqual(normalizeUsage({}), { inputTokens: null, outputTokens: null, tokens: null });
  assert.deepEqual(normalizeUsage(undefined), { inputTokens: null, outputTokens: null, tokens: null });
});

// --- watching a stream ----------------------------------------------------

const sseEvent = (data) => `data: ${JSON.stringify(data)}\n\n`;
const chatStream = (usage) => [
  sseEvent({ choices: [{ delta: { content: "he" } }], usage: null }),
  sseEvent({ choices: [{ delta: { content: "llo" } }], usage: null }),
  sseEvent({ choices: [{ delta: {}, finish_reason: "stop" }], usage: null }),
  ...(usage ? [sseEvent({ choices: [], usage })] : []),
  "data: [DONE]\n\n"
];

test("the SSE tap finds usage that arrives in the final event only", () => {
  const tap = createSseUsageTap();
  for (const part of chatStream({ prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 })) tap.pushChunk(part);
  tap.end();
  assert.deepEqual(tap.usage, { inputTokens: 100, outputTokens: 50, tokens: 150 });
});

test("the SSE tap reports nothing when the stream carries no usage", () => {
  const tap = createSseUsageTap();
  for (const part of chatStream(null)) tap.pushChunk(part);
  tap.end();
  assert.equal(tap.usage, null);
});

test("the SSE tap survives every possible chunk boundary, CRLF and split multi-byte text", () => {
  const body = Buffer.from(
    chatStream({ prompt_tokens: 1245, completion_tokens: 387, total_tokens: 1632 }).join("").replace("hello", "héllo ✓").replaceAll("\n", "\r\n")
  );
  for (let cut = 1; cut < body.length; cut += 1) {
    const tap = createSseUsageTap();
    tap.pushChunk(body.subarray(0, cut));
    tap.pushChunk(body.subarray(cut));
    tap.end();
    assert.deepEqual(tap.usage, { inputTokens: 1245, outputTokens: 387, tokens: 1632 }, `split at byte ${cut}`);
  }
  // One byte at a time, the worst case.
  const slow = createSseUsageTap();
  for (const byte of body) slow.pushChunk(Buffer.from([byte]));
  slow.end();
  assert.deepEqual(slow.usage, { inputTokens: 1245, outputTokens: 387, tokens: 1632 });
});

test("Anthropic streams: input from message_start, final output from message_delta", () => {
  const tap = createSseUsageTap();
  tap.pushChunk(`event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { usage: { input_tokens: 25, output_tokens: 1 } } })}\n\n`);
  tap.pushChunk(`event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", delta: { text: "x" } })}\n\n`);
  tap.pushChunk(`event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", usage: { output_tokens: 15 } })}\n\n`);
  tap.end();
  assert.deepEqual(tap.usage, { inputTokens: 25, outputTokens: 15, tokens: 40 });
});

test("Gemini and Responses stream events are understood", () => {
  const gemini = createSseUsageTap();
  gemini.pushChunk(sseEvent({ candidates: [{}], usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 1, totalTokenCount: 6 } }));
  gemini.pushChunk(sseEvent({ candidates: [{}], usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 9, totalTokenCount: 14 } }));
  gemini.end();
  assert.deepEqual(gemini.usage, { inputTokens: 5, outputTokens: 9, tokens: 14 });

  const responses = createSseUsageTap();
  responses.pushChunk(sseEvent({ type: "response.created", response: { usage: null } }));
  responses.pushChunk(sseEvent({ type: "response.completed", response: { usage: { input_tokens: 30, output_tokens: 12, total_tokens: 42 } } }));
  responses.end();
  assert.deepEqual(responses.usage, { inputTokens: 30, outputTokens: 12, tokens: 42 });
});

test("a malformed or oversized event is ignored and memory stays bounded", () => {
  const tap = createSseUsageTap({ maxLineChars: 64 });
  tap.pushChunk("data: {not json usage\n\n");
  tap.pushChunk(`data: ${"x".repeat(500)}`); // an unterminated, oversized line
  tap.pushChunk("y".repeat(500));
  tap.pushChunk(`\n\n${sseEvent({ usage: { prompt_tokens: 2, completion_tokens: 3 } })}`);
  tap.end();
  assert.deepEqual(tap.usage, { inputTokens: 2, outputTokens: 3, tokens: 5 });
});

test("tapBytes and tapEvents hand every chunk on, byte for byte", async () => {
  const chunks = chatStream({ prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 }).map((text) => Buffer.from(text));
  const tap = createSseUsageTap();
  const out = [];
  for await (const chunk of tapBytes(chunks, tap)) out.push(chunk);
  assert.equal(out.length, chunks.length);
  out.forEach((chunk, index) => assert.equal(chunk, chunks[index], "the very same chunk object"));
  assert.deepEqual(tap.usage, { inputTokens: 3, outputTokens: 4, tokens: 7 });

  const events = ['{"a":1}', '{"usage":{"prompt_tokens":1,"completion_tokens":2}}', "[DONE]"];
  const eventTap = createSseUsageTap();
  const seen = [];
  for await (const data of tapEvents(events, eventTap)) seen.push(data);
  assert.deepEqual(seen, events);
  assert.deepEqual(eventTap.usage, { inputTokens: 1, outputTokens: 2, tokens: 3 });
});

test("the JSON tap reads usage from a body delivered in pieces, and gives up past its limit", () => {
  const body = Buffer.from(JSON.stringify({ usage: { prompt_tokens: 8, completion_tokens: 2, total_tokens: 10 } }));
  const tap = createJsonUsageTap({ maxBytes: 1024 });
  tap.pushChunk(body.subarray(0, 11));
  tap.pushChunk(body.subarray(11));
  assert.deepEqual(tap.usage, { inputTokens: 8, outputTokens: 2, tokens: 10 });

  const small = createJsonUsageTap({ maxBytes: 8 });
  small.pushChunk(body);
  assert.equal(small.usage, null);
});

// --- RequestLog: one attempt, one set of figures --------------------------

const target = (provider, keyIndex = 0, model = "m") => ({ provider, keyIndex, model, protocol: "openai-chat" });

test("an attempt gains usage after it settles; its state and timing do not change", () => {
  const log = new RequestLog();
  const seq = log.begin({ id: "s" });
  const attemptId = log.startAttempt(seq, target("groq"));
  assert.deepEqual(
    [log.attemptEvents.get(attemptId).inputTokens, log.attemptEvents.get(attemptId).outputTokens, log.attemptEvents.get(attemptId).tokens],
    [null, null, null]
  );
  log.finishAttempt(attemptId, { ok: true, status: 200 });
  const settled = log.attemptEvents.get(attemptId);

  const heard = [];
  log.subscribe(({ type, entry }) => { if (type === "attempt") heard.push(entry); });
  log.recordAttemptUsage(attemptId, { inputTokens: 100, outputTokens: 50, tokens: 150 });

  const after = log.attemptEvents.get(attemptId);
  assert.deepEqual([after.inputTokens, after.outputTokens, after.tokens], [100, 50, 150]);
  assert.equal(after.state, ATTEMPT_STATES.SUCCESS);
  assert.equal(after.status, 200);
  assert.equal(after.completedAt, settled.completedAt);
  assert.equal(after.latencyMs, settled.latencyMs);
  assert.equal(heard.length, 1, "announced as one new attempt snapshot");
  assert.equal(heard[0].attemptId, attemptId);
  assert.equal(Object.isFrozen(after), true);
  assert.deepEqual([settled.inputTokens, settled.tokens], [null, null], "the earlier snapshot is untouched");
});

test("usage is set once: a later report cannot rewrite it", () => {
  const log = new RequestLog();
  const seq = log.begin({ id: "s" });
  const attemptId = log.startAttempt(seq, target("groq"));
  log.finishAttempt(attemptId, { ok: true, status: 200 });
  log.recordAttemptUsage(attemptId, { inputTokens: 1, outputTokens: 2 });
  log.recordAttemptUsage(attemptId, { inputTokens: 999, outputTokens: 999 });
  const event = log.attemptEvents.get(attemptId);
  assert.deepEqual([event.inputTokens, event.outputTokens, event.tokens], [1, 2, 3]);
});

test("reporting nothing, junk or usage for a running or unknown attempt changes nothing", () => {
  const log = new RequestLog();
  const seq = log.begin({ id: "s" });
  const running = log.startAttempt(seq, target("groq"));
  assert.doesNotThrow(() => log.recordAttemptUsage(running, { inputTokens: 5, outputTokens: 5 }));
  assert.equal(log.attemptEvents.get(running).inputTokens, null, "a running attempt has no usage yet");

  log.finishAttempt(running, { ok: true, status: 200 });
  log.recordAttemptUsage(running, {});
  log.recordAttemptUsage(running, { inputTokens: "7", outputTokens: NaN, tokens: -1 });
  const event = log.attemptEvents.get(running);
  assert.deepEqual([event.inputTokens, event.outputTokens, event.tokens], [null, null, null], "no fabricated zeros");
  assert.equal(log.recordAttemptUsage("att-missing", { inputTokens: 1 }), null);
});

test("fallback attempts are isolated: each keeps only its own usage", () => {
  const log = new RequestLog();
  const seq = log.begin({ id: "s" });

  // Attempt 1 failed after reporting usage; attempt 2 answered with its own.
  const a1 = log.startAttempt(seq, target("groq", 0));
  log.finishAttempt(a1, { ok: false, status: 500, errorMessage: "boom", inputTokens: 100, outputTokens: 50 });
  const a2 = log.startAttempt(seq, target("gemini", 1, "g"));
  log.finishAttempt(a2, { ok: true, status: 200 });
  log.recordAttemptUsage(a2, { inputTokens: 200, outputTokens: 80 });

  const one = log.attemptEvents.get(a1);
  const two = log.attemptEvents.get(a2);
  assert.deepEqual([one.inputTokens, one.outputTokens, one.tokens], [100, 50, 150]);
  assert.deepEqual([two.inputTokens, two.outputTokens, two.tokens], [200, 80, 280]);
  assert.equal(one.state, ATTEMPT_STATES.FAILED);
});

test("a failed attempt that reported nothing stays empty while the next one has usage", () => {
  const log = new RequestLog();
  const seq = log.begin({ id: "s" });
  const a1 = log.startAttempt(seq, target("groq", 0));
  log.finishAttempt(a1, { ok: false, status: 429, errorMessage: "rate limited" });
  const a2 = log.startAttempt(seq, target("groq", 1));
  log.finishAttempt(a2, { ok: true, status: 200 });
  log.recordAttemptUsage(a2, { inputTokens: 200, outputTokens: 80, tokens: 280 });

  const one = log.attemptEvents.get(a1);
  assert.deepEqual([one.inputTokens, one.outputTokens, one.tokens], [null, null, null]);
  // Even a late report aimed at the failed attempt cannot be confused with the other one.
  log.recordAttemptUsage(a1, {});
  assert.deepEqual([log.attemptEvents.get(a1).inputTokens, log.attemptEvents.get(a2).inputTokens], [null, 200]);
});

test("the same target called twice keeps separate usage per call", () => {
  const log = new RequestLog();
  const seqA = log.begin({ id: "s" });
  const a = log.startAttempt(seqA, target("groq"));
  log.finishAttempt(a, { ok: true, status: 200 });
  log.recordAttemptUsage(a, { inputTokens: 10, outputTokens: 1 });
  const seqB = log.begin({ id: "s" });
  const b = log.startAttempt(seqB, target("groq"));
  log.finishAttempt(b, { ok: true, status: 200 });

  assert.equal(log.attemptEvents.get(b).inputTokens, null, "the second call did not inherit the first call's usage");
  log.recordAttemptUsage(b, { inputTokens: 20, outputTokens: 2 });
  assert.deepEqual([log.attemptEvents.get(a).tokens, log.attemptEvents.get(b).tokens], [11, 22]);
});

test("usage reaches the request rows that already copied the attempt", () => {
  const log = new RequestLog();
  const seq = log.begin({ id: "s", pool: "text" });
  const attemptId = log.startAttempt(seq, target("groq"));
  log.finishAttempt(attemptId, { ok: true, status: 200 });
  log.progress(seq, {
    attempts: [{ attemptId, provider: "groq", model: "m", keyIndex: 0, ok: true, status: 200 }],
    inflight: null
  });
  const stored = log.record({
    id: "s", pendingSeq: seq, outcome: "success", httpStatus: 200,
    attempts: [{ attemptId, provider: "groq", model: "m", keyIndex: 0, ok: true, status: 200 }]
  });
  assert.equal(stored.attempts[0].inputTokens, null);

  log.recordAttemptUsage(attemptId, { inputTokens: 4, outputTokens: 6 });
  assert.deepEqual(
    [stored.attempts[0].inputTokens, stored.attempts[0].outputTokens, stored.attempts[0].tokens],
    [4, 6, 10]
  );
  assert.equal(log.list().entries[0].attempts[0].tokens, 10);
});

test("a request recorded after the usage arrived carries it too", () => {
  const log = new RequestLog();
  const seq = log.begin({ id: "s" });
  const attemptId = log.startAttempt(seq, target("groq"));
  log.finishAttempt(attemptId, { ok: true, status: 200 });
  log.recordAttemptUsage(attemptId, { inputTokens: 3, outputTokens: 4 });
  const stored = log.record({
    id: "s", pendingSeq: seq, outcome: "success", httpStatus: 200,
    attempts: [{ attemptId, provider: "groq", model: "m", keyIndex: 0, ok: true, status: 200 }]
  });
  assert.deepEqual([stored.attempts[0].inputTokens, stored.attempts[0].outputTokens, stored.attempts[0].tokens], [3, 4, 7]);
});

// --- through the real server ----------------------------------------------

const chat = { model: "m", messages: [{ role: "user", content: "hi" }] };
const chatBody = (usage) => ({
  id: "chatcmpl-1", object: "chat.completion", created: 0, model: "upstream",
  choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
  ...(usage ? { usage } : {})
});

const attemptsOf = async (router) => (await (await router.request("/api/attempts")).json()).entries;

/** Usage lands after the response body is delivered, so poll briefly for it. */
async function attemptsWhen(router, ready, { timeoutMs = 4000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let entries = await attemptsOf(router);
  while (!ready(entries) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    entries = await attemptsOf(router);
  }
  return entries;
}

const figures = (event) => [event.inputTokens, event.outputTokens, event.tokens];

async function rig(t, script, env = {}) {
  const upstream = await startMockUpstream(script);
  const router = await startRouter({ GROQ_API_KEYS: "k0,k1", GROQ_MODELS: "m", GROQ_BASE_URL: upstream.baseUrl, ...env });
  t.after(async () => { await router.close(); await upstream.close(); });
  return { upstream, router };
}

test("HTTP A: a successful non-streaming request reports its provider's usage", async (t) => {
  const { router } = await rig(t, () => ({ status: 200, body: chatBody({ prompt_tokens: 1245, completion_tokens: 387, total_tokens: 1632 }) }));
  const res = await router.request("/v1/chat/completions", postJson(chat));
  assert.equal(res.status, 200);
  await res.json();

  const [event] = await attemptsWhen(router, (list) => list[0]?.inputTokens !== null && list[0]?.inputTokens !== undefined);
  assert.deepEqual(figures(event), [1245, 387, 1632]);
  assert.equal(event.state, "success");
  assert.equal(event.status, 200);

  const history = (await (await router.request("/api/requests")).json()).entries[0];
  assert.deepEqual(
    [history.attempts[0].inputTokens, history.attempts[0].outputTokens, history.attempts[0].tokens],
    [1245, 387, 1632],
    "the request history shows the same attempt figures"
  );
});

test("HTTP B: a successful request without usage has no figures, not zeros", async (t) => {
  const { router } = await rig(t, () => ({ status: 200, body: chatBody(null) }));
  assert.equal((await router.request("/v1/chat/completions", postJson(chat))).status, 200);
  const [event] = await attemptsOf(router);
  assert.deepEqual(figures(event), [null, null, null]);
});

test("HTTP C: a failed request has no usage to show", async (t) => {
  const { router } = await rig(t, () => ({ status: 500, body: { error: { message: "down" } } }), { GROQ_API_KEYS: "k0" });
  const res = await router.request("/v1/chat/completions", postJson(chat));
  assert.ok(res.status >= 400);
  const entries = await attemptsOf(router);
  assert.ok(entries.length >= 1);
  for (const event of entries) {
    assert.equal(event.state, "failed");
    assert.deepEqual(figures(event), [null, null, null]);
  }
});

test("HTTP E: a fallback attempt never inherits usage from the attempt before it", async (t) => {
  let call = 0;
  const { router } = await rig(t, () => {
    call += 1;
    return call === 1
      ? { status: 500, body: { error: { message: "first key failed", usage: { prompt_tokens: 7777, completion_tokens: 7777, total_tokens: 15554 } } } }
      : { status: 200, body: chatBody({ prompt_tokens: 200, completion_tokens: 80, total_tokens: 280 }) };
  });
  assert.equal((await router.request("/v1/chat/completions", postJson(chat))).status, 200);

  const entries = await attemptsWhen(router, (list) => list.length >= 2 && list[1].inputTokens !== null);
  assert.equal(entries.length, 2);
  assert.equal(entries[0].state, "failed");
  assert.deepEqual(figures(entries[0]), [null, null, null], "the failed attempt shows nothing");
  assert.equal(entries[1].state, "success");
  assert.deepEqual(figures(entries[1]), [200, 80, 280]);
  assert.notEqual(entries[0].attemptId, entries[1].attemptId);
});

test("HTTP E2: two requests to the same target keep their own figures", async (t) => {
  let call = 0;
  const { router } = await rig(t, () => {
    call += 1;
    return { status: 200, body: chatBody(call === 1 ? { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 } : { prompt_tokens: 200, completion_tokens: 80, total_tokens: 280 }) };
  }, { GROQ_API_KEYS: "k0" });
  await (await router.request("/v1/chat/completions", postJson(chat))).json();
  await (await router.request("/v1/chat/completions", postJson(chat))).json();
  const entries = await attemptsWhen(router, (list) => list.length >= 2 && list.every((e) => e.tokens !== null));
  assert.deepEqual(entries.map(figures), [[100, 50, 150], [200, 80, 280]]);
});

const streamedChat = (usage) => chatStream(usage);

test("HTTP F/H: a streamed response is forwarded byte for byte and its usage is captured", async (t) => {
  const chunks = streamedChat({ prompt_tokens: 321, completion_tokens: 123, total_tokens: 444 });
  const { router } = await rig(t, () => ({ status: 200, headers: { "content-type": "text/event-stream" }, stream: chunks, delayMs: 5 }));

  const res = await router.request("/v1/chat/completions", postJson({ ...chat, stream: true, stream_options: { include_usage: true } }));
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /text\/event-stream/);
  assert.equal(await res.text(), chunks.join(""), "the client received exactly the upstream bytes");

  const [event] = await attemptsWhen(router, (list) => list[0]?.tokens !== null && list[0]?.tokens !== undefined);
  assert.deepEqual(figures(event), [321, 123, 444]);
  assert.equal(event.state, "success");
});

test("HTTP G: a stream without usage shows no figures", async (t) => {
  const chunks = streamedChat(null);
  const { router } = await rig(t, () => ({ status: 200, headers: { "content-type": "text/event-stream" }, stream: chunks, delayMs: 5 }));
  const res = await router.request("/v1/chat/completions", postJson({ ...chat, stream: true }));
  assert.equal(await res.text(), chunks.join(""));
  await new Promise((resolve) => setTimeout(resolve, 150));
  const [event] = await attemptsOf(router);
  assert.deepEqual(figures(event), [null, null, null]);
});

test("HTTP I: usage split across network chunks is still found, and the bytes are unchanged", async (t) => {
  const whole = streamedChat({ prompt_tokens: 1245, completion_tokens: 387, total_tokens: 1632 }).join("");
  // Cut inside the usage JSON, inside a key, and inside the blank line that ends an event.
  const cuts = [whole.indexOf('"usage":{"prompt') + 12, whole.indexOf("completion_tokens") + 5, whole.indexOf("\n\ndata: [DONE]") + 1];
  const pieces = [];
  let from = 0;
  for (const cut of [...cuts].sort((a, b) => a - b)) { pieces.push(whole.slice(from, cut)); from = cut; }
  pieces.push(whole.slice(from));
  assert.equal(pieces.join(""), whole);

  const { router } = await rig(t, () => ({ status: 200, headers: { "content-type": "text/event-stream" }, stream: pieces, delayMs: 25 }));
  const res = await router.request("/v1/chat/completions", postJson({ ...chat, stream: true }));
  assert.equal(await res.text(), whole);
  const [event] = await attemptsWhen(router, (list) => list[0]?.tokens !== null && list[0]?.tokens !== undefined);
  assert.deepEqual(figures(event), [1245, 387, 1632]);
});

test("HTTP J: a client that disconnects mid-stream still stops the upstream", async (t) => {
  let upstreamClosed = false;
  let writes = 0;
  const upstream = http.createServer((req, res) => {
    req.resume();
    if (req.method !== "POST") { res.writeHead(404); return res.end("{}"); }
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.on("close", () => { upstreamClosed = true; });
    const timer = setInterval(() => {
      writes += 1;
      res.write(sseEvent({ choices: [{ delta: { content: "tick" } }], usage: null }));
    }, 15);
    res.on("close", () => clearInterval(timer));
  });
  await new Promise((resolve) => upstream.listen(0, "localhost", resolve));
  const router = await startRouter({
    GROQ_API_KEYS: "k0", GROQ_MODELS: "m", GROQ_BASE_URL: `http://localhost:${upstream.address().port}`
  });
  t.after(async () => { await router.close(); await new Promise((resolve) => { upstream.closeAllConnections?.(); upstream.close(resolve); }); });

  const controller = new AbortController();
  const res = await router.request("/v1/chat/completions", { ...postJson({ ...chat, stream: true }), signal: controller.signal });
  assert.equal(res.status, 200);
  const reader = res.body.getReader();
  const first = await reader.read();
  assert.ok(first.value?.length > 0, "data was flowing");
  controller.abort();
  await reader.cancel().catch(() => {});

  const deadline = Date.now() + 4000;
  while (!upstreamClosed && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(upstreamClosed, true, "the upstream connection was torn down");
  const writesAtClose = writes;
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(writes, writesAtClose, "nothing keeps pulling from the upstream after the client left");

  const [event] = await attemptsOf(router);
  assert.deepEqual(figures(event), [null, null, null], "no usage was reported, so none is shown");
  // The gateway is still healthy afterwards.
  assert.equal((await router.request("/health")).status, 200);
});

test("HTTP: a translated (Claude Code) stream records the upstream usage and asks for it", async (t) => {
  const chunks = [
    sseEvent({ choices: [{ delta: { content: "po" } }] }),
    sseEvent({ choices: [{ delta: { content: "ng" } }] }),
    sseEvent({ choices: [{ delta: {}, finish_reason: "stop" }] }),
    sseEvent({ choices: [], usage: { prompt_tokens: 60, completion_tokens: 9, total_tokens: 69 } }),
    "data: [DONE]\n\n"
  ];
  const bridged = await startMockUpstream(() => ({ status: 200, headers: { "content-type": "text/event-stream" }, stream: chunks }));
  const bridgedRouter = await startRouter({ GROQ_API_KEYS: "k0", GROQ_MODELS: "llama-x", GROQ_BASE_URL: `${bridged.baseUrl}/v1` });
  t.after(async () => { await bridgedRouter.close(); await bridged.close(); });

  const res = await bridgedRouter.request("/v1/messages", postJson({
    model: "claude", max_tokens: 100, stream: true, messages: [{ role: "user", content: "ping" }]
  }));
  assert.equal(res.status, 200);
  assert.match(await res.text(), /message_stop/);
  assert.deepEqual(bridged.apiRequests[0].body.stream_options, { include_usage: true });

  const [event] = await attemptsWhen(bridgedRouter, (list) => list[0]?.tokens !== null && list[0]?.tokens !== undefined);
  assert.deepEqual(figures(event), [60, 9, 69]);
});

test("HTTP: a translated non-streaming reply records the upstream usage", async (t) => {
  const bridged = await startMockUpstream(() => ({ status: 200, body: chatBody({ prompt_tokens: 14, completion_tokens: 6, total_tokens: 20 }) }));
  const router = await startRouter({ GROQ_API_KEYS: "k0", GROQ_MODELS: "llama-x", GROQ_BASE_URL: `${bridged.baseUrl}/v1` });
  t.after(async () => { await router.close(); await bridged.close(); });

  const res = await router.request("/v1/messages", postJson({ model: "claude", max_tokens: 100, messages: [{ role: "user", content: "ping" }] }));
  assert.equal(res.status, 200);
  await res.json();
  const [event] = await attemptsWhen(router, (list) => list[0]?.tokens !== null && list[0]?.tokens !== undefined);
  assert.deepEqual(figures(event), [14, 6, 20]);
});
