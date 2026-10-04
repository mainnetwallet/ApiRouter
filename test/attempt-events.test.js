import test from "node:test";
import assert from "node:assert/strict";
import { RequestLog, ATTEMPT_STATES } from "../src/observability/request-log.js";
import { startMockUpstream } from "../test-helpers/mock-upstream.js";
import { startRouter, postJson } from "../test-helpers/router-harness.js";

/**
 * ONE REAL UPSTREAM ATTEMPT = ONE NEW LOG EVENT.
 *
 * `requestId` names a client request, `attemptId` names one upstream call. The
 * same provider/model/key called again (same request or a later one) is a new
 * attempt: it is never merged into, or written over, an earlier one.
 */

const T = (provider, keyIndex, model) => ({ provider, keyIndex, model });

/** Run one attempt through the real begin -> start -> finish lifecycle. */
function callOnce(log, startSeq, target, { ok, status, errorMessage = null }) {
  const attemptId = log.startAttempt(startSeq, { ...target, protocol: "openai-chat" });
  log.finishAttempt(attemptId, { ok, status, errorMessage });
  return attemptId;
}

// --- RequestLog: identity -------------------------------------------------

test("1. the same target succeeding on two consecutive requests gives two separate events", () => {
  const log = new RequestLog();
  const target = T("groq", 0, "model-b");

  const r1 = log.begin({ id: "sess", pool: "text" });
  const a1 = callOnce(log, r1, target, { ok: true, status: 200 });
  log.record({ id: "sess", pendingSeq: r1, outcome: "success", httpStatus: 200, attempts: [] });

  const r2 = log.begin({ id: "sess", pool: "text" });
  const a2 = callOnce(log, r2, target, { ok: true, status: 200 });
  log.record({ id: "sess", pendingSeq: r2, outcome: "success", httpStatus: 200, attempts: [] });

  const { entries } = log.listAttempts();
  assert.equal(entries.length, 2);
  assert.notEqual(a1, a2);
  assert.deepEqual(entries.map((e) => e.attemptId), [a1, a2]);
  for (const event of entries) {
    assert.equal(event.state, ATTEMPT_STATES.SUCCESS);
    assert.equal(event.provider, "groq");
    assert.equal(event.keyIndex, 0);
    assert.equal(event.model, "model-b");
  }
});

test("2. the same target failing twice on two consecutive requests gives two separate events", () => {
  const log = new RequestLog();
  const target = T("gemini", 0, "model-a");

  const r1 = log.begin({ id: "sess" });
  const a1 = callOnce(log, r1, target, { ok: false, status: 429 });
  log.record({ id: "sess", pendingSeq: r1, outcome: "failed", httpStatus: 502 });
  const r2 = log.begin({ id: "sess" });
  const a2 = callOnce(log, r2, target, { ok: false, status: 429 });
  log.record({ id: "sess", pendingSeq: r2, outcome: "failed", httpStatus: 502 });

  const { entries } = log.listAttempts();
  assert.equal(entries.length, 2);
  assert.notEqual(a1, a2);
  assert.ok(entries.every((e) => e.state === ATTEMPT_STATES.FAILED && e.status === 429));
});

test("3. one request with several fallback attempts gives one event per attempt", () => {
  const log = new RequestLog();
  const r = log.begin({ id: "sess", pool: "text" });

  const ids = [
    callOnce(log, r, T("gemini", 0, "model-a"), { ok: false, status: 429 }),
    callOnce(log, r, T("gemini", 1, "model-a"), { ok: false, status: 500 }),
    callOnce(log, r, T("groq", 0, "model-b"), { ok: true, status: 200 })
  ];

  const { entries } = log.listAttempts();
  assert.equal(new Set(ids).size, 3);
  assert.deepEqual(entries.map((e) => e.attemptId), ids);
  assert.deepEqual(entries.map((e) => e.status), [429, 500, 200]);
  assert.deepEqual(entries.map((e) => e.callIndex), [1, 2, 3], "Call #1, #2, #3 of the request");
  assert.equal(new Set(entries.map((e) => e.requestId)).size, 1, "all three belong to one request");
});

test("4. the same provider/model/key called again later is a new event, never merged", () => {
  const log = new RequestLog();
  const r = log.begin({ id: "sess" });
  const target = T("groq", 0, "model-b");

  const call3 = callOnce(log, r, target, { ok: true, status: 200 });
  const call4 = callOnce(log, r, target, { ok: true, status: 200 });
  // ... and again from a completely different request.
  const r2 = log.begin({ id: "sess" });
  const call5 = callOnce(log, r2, target, { ok: true, status: 200 });

  const { entries } = log.listAttempts();
  assert.equal(entries.length, 3);
  assert.equal(new Set([call3, call4, call5]).size, 3);
  assert.deepEqual(entries.map((e) => e.callIndex), [1, 2, 1]);
  assert.equal(entries[0].requestId, entries[1].requestId);
  assert.notEqual(entries[1].requestId, entries[2].requestId);
});

test("an attempt id is never a function of the target, the session or the request id", () => {
  const log = new RequestLog();
  const target = T("groq", 0, "model-b");
  const r1 = log.begin({ id: "same-session" });
  const r2 = log.begin({ id: "same-session" });

  const ids = [r1, r1, r2, r2].map((r) => callOnce(log, r, target, { ok: true, status: 200 }));
  const requestIds = new Set(log.listAttempts().entries.map((e) => e.requestId));

  assert.equal(new Set(ids).size, 4, "four calls, four ids");
  assert.equal(requestIds.size, 2, "two requests, even though they share a session id");
  for (const id of ids) {
    assert.ok(!requestIds.has(id), "an attempt id is not a request id");
    assert.ok(!id.includes("groq") && !id.includes("model-b"), "no target in the id");
  }
  assert.ok(log.listAttempts().entries.every((e) => e.sessionId === "same-session"));
});

test("5. text and vision attempts are independent events carrying their pool", () => {
  const log = new RequestLog();
  const target = T("openrouter", 0, "same-model");

  const text = log.begin({ id: "sess", pool: "text" });
  const vision = log.begin({ id: "sess", pool: "vision" });
  const textAttempt = callOnce(log, text, target, { ok: true, status: 200 });
  const visionAttempt = callOnce(log, vision, target, { ok: true, status: 200 });

  const all = log.listAttempts().entries;
  assert.equal(all.length, 2);
  assert.notEqual(textAttempt, visionAttempt);
  assert.deepEqual(all.map((e) => e.pool), ["text", "vision"]);
  assert.deepEqual(log.listAttempts({ pool: "vision" }).entries.map((e) => e.attemptId), [visionAttempt]);
  assert.deepEqual(log.listAttempts({ pool: "text" }).entries.map((e) => e.attemptId), [textAttempt]);
});

// --- RequestLog: lifecycle ------------------------------------------------

test("6. pending -> success/failure updates only that one attempt", () => {
  const log = new RequestLog();
  const r = log.begin({ id: "sess" });
  const first = callOnce(log, r, T("gemini", 0, "m"), { ok: false, status: 429 });
  const firstSnapshot = log.attemptEvents.get(first);

  const second = log.startAttempt(r, { ...T("gemini", 1, "m") });
  assert.equal(log.attemptEvents.get(second).state, ATTEMPT_STATES.CALLING);
  assert.equal(log.attemptEvents.get(second).status, null);

  log.finishAttempt(second, { ok: true, status: 200 });
  assert.equal(log.attemptEvents.get(second).state, ATTEMPT_STATES.SUCCESS);
  assert.equal(log.attemptEvents.get(second).status, 200);
  assert.equal(log.attemptEvents.get(second).attemptId, second, "same attempt, same id");
  assert.equal(log.attemptEvents.get(first), firstSnapshot, "the other attempt is the very same object");
  assert.equal(log.attemptEvents.size, 2, "settling did not create a third event");
});

test("7. a later attempt, or a repeated report, never changes an attempt's final status", () => {
  const log = new RequestLog();
  const r = log.begin({ id: "sess" });
  const first = callOnce(log, r, T("groq", 0, "m"), { ok: false, status: 429, errorMessage: "slow down" });
  const before = JSON.stringify(log.attemptEvents.get(first));

  callOnce(log, r, T("groq", 0, "m"), { ok: true, status: 200 });
  assert.equal(JSON.stringify(log.attemptEvents.get(first)), before, "a later attempt of the same target leaves it alone");

  // Settling it a second time (even with a different outcome) is a no-op.
  assert.equal(log.finishAttempt(first, { ok: true, status: 200 }), log.attemptEvents.get(first));
  assert.equal(JSON.stringify(log.attemptEvents.get(first)), before);

  // A caller that re-sends the attempt list with a rewritten result cannot rewrite it either.
  log.progress(r, {
    attempts: [{ attemptId: first, provider: "groq", model: "m", keyIndex: 0, ok: true, status: 200 }],
    inflight: null
  });
  assert.equal(JSON.stringify(log.attemptEvents.get(first)), before);
  assert.equal(log.pending()[0].attempts[0].status, 429, "and the request's own row agrees with the event");
});

test("events are immutable snapshots: a held event never changes underneath its listener", () => {
  const log = new RequestLog();
  const heard = [];
  log.subscribe(({ type, entry }) => { if (type === "attempt") heard.push(entry); });

  const r = log.begin({ id: "sess" });
  const id = log.startAttempt(r, T("groq", 0, "m"));
  const calling = heard[0];
  log.finishAttempt(id, { ok: true, status: 200 });

  assert.ok(Object.isFrozen(calling));
  assert.equal(calling.state, ATTEMPT_STATES.CALLING, "the earlier snapshot is untouched");
  assert.equal(heard[1].state, ATTEMPT_STATES.SUCCESS);
  assert.equal(heard[1].attemptId, calling.attemptId);
});

test("8. the live stream announces every real attempt as its own event", () => {
  const log = new RequestLog();
  const heard = [];
  log.subscribe(({ type, entry }) => { if (type === "attempt") heard.push(`${entry.attemptId}:${entry.state}`); });

  const target = T("groq", 0, "m");
  const r1 = log.begin({ id: "sess" });
  const a = callOnce(log, r1, target, { ok: true, status: 200 });
  const r2 = log.begin({ id: "sess" });
  const b = callOnce(log, r2, target, { ok: true, status: 200 });

  assert.deepEqual(heard, [`${a}:calling`, `${a}:success`, `${b}:calling`, `${b}:success`]);
});

test("a skipped target is not an upstream attempt and gets no event", () => {
  const log = new RequestLog();
  const r = log.begin({ id: "sess" });
  log.progress(r, { attempts: [{ provider: "groq", model: "m", keyIndex: 0, skipped: true, skipReason: "cooldown", ok: false }], inflight: null });
  callOnce(log, r, T("groq", 1, "m"), { ok: true, status: 200 });

  assert.equal(log.listAttempts().entries.length, 1);
  assert.equal(log.pending()[0].attempts[0].attemptId, null);
});

test("an attempt left on the wire when its request ends is settled, not left calling", () => {
  const log = new RequestLog();
  const r = log.begin({ id: "sess" });
  const id = log.startAttempt(r, T("groq", 0, "m"));
  log.record({ id: "sess", pendingSeq: r, outcome: "failed", httpStatus: 502, errorMessage: "client went away" });

  assert.equal(log.attemptEvents.get(id).state, ATTEMPT_STATES.FAILED);
});

test("9. the completed request keeps every attempt as an independent entry, same ids as the events", () => {
  const log = new RequestLog();
  const r = log.begin({ id: "sess", pool: "text" });
  const attempts = [];
  for (const [target, ok, status] of [
    [T("gemini", 0, "model-a"), false, 429],
    [T("gemini", 1, "model-a"), false, 500],
    [T("groq", 0, "model-b"), true, 200],
    [T("groq", 0, "model-b"), true, 200]
  ]) {
    const attemptId = log.startAttempt(r, target);
    attempts.push({ attemptId, ...target, ok, status, startedAt: Date.now(), latencyMs: 1 });
    log.finishAttempt(attemptId, { ok, status });
    log.progress(r, { attempts, inflight: null });
  }
  const stored = log.record({ id: "sess", pendingSeq: r, pool: "text", outcome: "success", httpStatus: 200, attempts });

  assert.equal(stored.attempts.length, 4);
  assert.equal(new Set(stored.attempts.map((a) => a.attemptId)).size, 4, "even the two identical targets differ");
  assert.deepEqual(stored.attempts.map((a) => a.attemptId), log.listAttempts().entries.map((e) => e.attemptId));
  assert.deepEqual(stored.attempts.map((a) => a.callIndex), [1, 2, 3, 4]);
  assert.ok(stored.attempts.every((a) => a.requestId === stored.requestId && a.pool === "text"));
  assert.equal(stored.id, "sess", "the session id is untouched");
  assert.notEqual(stored.requestId, stored.id);
});

test("attempts reported without ids (older callers) are registered once with stable ids", () => {
  const log = new RequestLog();
  const r = log.begin({ id: "sess" });
  const list = [{ provider: "groq", model: "m", keyIndex: 0, ok: false, status: 500, startedAt: 1, latencyMs: 5 }];

  log.progress(r, { attempts: list, inflight: null });
  log.progress(r, { attempts: list, inflight: null });
  const stored = log.record({ id: "sess", pendingSeq: r, outcome: "failed", httpStatus: 502, attempts: list });

  assert.equal(log.listAttempts().entries.length, 1, "re-reporting the same attempt never makes a second event");
  assert.equal(stored.attempts[0].attemptId, log.listAttempts().entries[0].attemptId);
});

test("attempt events are returned oldest first, and the store is bounded", () => {
  const log = new RequestLog({ maxAttemptEvents: 3 });
  const r = log.begin({ id: "sess" });
  const ids = [1, 2, 3, 4, 5].map((n) => callOnce(log, r, T("groq", n, "m"), { ok: true, status: 200 }));

  const { entries, total } = log.listAttempts();
  assert.equal(total, 3);
  assert.deepEqual(entries.map((e) => e.attemptId), ids.slice(2), "the oldest were evicted; order is chronological");
  assert.ok(entries.every((e, i) => i === 0 || e.attemptSeq > entries[i - 1].attemptSeq));
  assert.deepEqual(log.listAttempts({ afterSeq: entries[1].attemptSeq }).entries.map((e) => e.attemptId), [ids[4]]);
});

// --- Over HTTP: real requests through the real router ---------------------

const chatReply = (text = "ok") => ({
  id: "chatcmpl-1", object: "chat.completion", created: 0, model: "upstream",
  choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
});
const REPLY = { 200: () => ({ status: 200, body: chatReply() }) };
const chat = { model: "m", messages: [{ role: "user", content: "hi" }] };

/** Scripted by call number, counting only chat calls (not health probes). */
const scripted = (statuses) => {
  let n = 0;
  return () => {
    const status = statuses[Math.min(n, statuses.length - 1)];
    n += 1;
    return status === 200 ? { status, body: chatReply() } : { status, body: { error: { message: "x" } } };
  };
};

const getAttempts = async (router, query = "") => (await (await router.request(`/api/attempts${query}`)).json());

test("HTTP: the same target answering two requests in a row logs two events", async (t) => {
  const groq = await startMockUpstream(REPLY[200]);
  const router = await startRouter({ GROQ_API_KEYS: "k0", GROQ_MODELS: "m", GROQ_BASE_URL: groq.baseUrl });
  t.after(async () => { await router.close(); await groq.close(); });

  assert.equal((await router.request("/v1/chat/completions", postJson(chat))).status, 200);
  const afterFirst = (await getAttempts(router)).entries;
  assert.equal(afterFirst.length, 1);
  const firstSnapshot = JSON.stringify(afterFirst[0]);

  assert.equal((await router.request("/v1/chat/completions", postJson(chat))).status, 200);
  const { entries } = await getAttempts(router);

  assert.equal(entries.length, 2);
  assert.notEqual(entries[0].attemptId, entries[1].attemptId);
  assert.notEqual(entries[0].requestId, entries[1].requestId, "two requests, two request ids");
  assert.equal(entries[0].sessionId, entries[1].sessionId, "...though they share the sticky session");
  assert.deepEqual(
    entries.map((e) => [e.provider, e.keyIndex, e.model, e.state, e.status]),
    [["groq", 0, "m", "success", 200], ["groq", 0, "m", "success", 200]]
  );
  assert.equal(JSON.stringify(entries[0]), firstSnapshot, "the second request did not touch the first event");
  assert.ok(entries[1].attemptSeq > entries[0].attemptSeq);
});

test("HTTP: a target that fails on two requests in a row logs two failed events", async (t) => {
  // A plain 400 falls back without cooling the target, so the second request calls it again.
  const groq = await startMockUpstream(scripted([400]));
  const router = await startRouter({ GROQ_API_KEYS: "k0", GROQ_MODELS: "m", GROQ_BASE_URL: groq.baseUrl });
  t.after(async () => { await router.close(); await groq.close(); });

  await router.request("/v1/chat/completions", postJson(chat));
  await router.request("/v1/chat/completions", postJson(chat));

  const { entries } = await getAttempts(router);
  assert.equal(groq.apiRequests.length, 2, "the router really called the upstream twice");
  assert.equal(entries.length, 2);
  assert.notEqual(entries[0].attemptId, entries[1].attemptId);
  assert.ok(entries.every((e) => e.state === "failed" && e.status === 400));
});

test("HTTP: a fallback chain in one request logs one event per real attempt, and history agrees", async (t) => {
  const groq = await startMockUpstream(scripted([429, 500, 200]));
  const router = await startRouter({ GROQ_API_KEYS: "k0,k1,k2", GROQ_MODELS: "m", GROQ_BASE_URL: groq.baseUrl });
  t.after(async () => { await router.close(); await groq.close(); });

  assert.equal((await router.request("/v1/chat/completions", postJson(chat))).status, 200);

  const { entries } = await getAttempts(router);
  assert.deepEqual(entries.map((e) => [e.keyIndex, e.status, e.state]), [[0, 429, "failed"], [1, 500, "failed"], [2, 200, "success"]]);
  assert.equal(new Set(entries.map((e) => e.attemptId)).size, 3);
  assert.equal(new Set(entries.map((e) => e.requestId)).size, 1);
  assert.deepEqual(entries.map((e) => e.callIndex), [1, 2, 3]);

  // Historical view: the request's own attempts are the same events, same ids, same order.
  const history = await (await router.request("/api/requests")).json();
  assert.equal(history.entries.length, 1);
  assert.equal(history.entries[0].requestId, entries[0].requestId);
  assert.deepEqual(history.entries[0].attempts.map((a) => a.attemptId), entries.map((e) => e.attemptId));
  assert.deepEqual(history.attempts.map((a) => a.attemptId), entries.map((e) => e.attemptId), "the payload carries the events too");
});

test("HTTP: text and vision attempts are separate events, each tagged with its pool", async (t) => {
  const text = await startMockUpstream(REPLY[200]);
  const vision = await startMockUpstream(REPLY[200]);
  const router = await startRouter({
    GROQ_API_KEYS: "tk", GROQ_MODELS: "text-model", GROQ_BASE_URL: text.baseUrl,
    OPENROUTER_VISION_API_KEYS: "vk", OPENROUTER_VISION_MODELS: "vision-model", OPENROUTER_VISION_BASE_URL: vision.baseUrl
  });
  t.after(async () => { await router.close(); await text.close(); await vision.close(); });

  const image = { model: "any", max_tokens: 32, messages: [{ role: "user", content: [{ type: "text", text: "?" }, { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } }] }] };
  const plain = { model: "any", max_tokens: 32, messages: [{ role: "user", content: "hi" }] };

  await router.request("/v1/messages", postJson(plain));
  await router.request("/v1/messages", postJson(image));
  await router.request("/v1/messages", postJson(image));
  await router.request("/v1/messages", postJson(plain));

  const { entries } = await getAttempts(router);
  assert.deepEqual(entries.map((e) => e.pool), ["text", "vision", "vision", "text"]);
  assert.equal(new Set(entries.map((e) => e.attemptId)).size, 4);
  assert.deepEqual((await getAttempts(router, "?pool=vision")).entries.map((e) => e.provider), ["openrouter", "openrouter"]);
  assert.deepEqual((await getAttempts(router, "?pool=text")).entries.map((e) => e.provider), ["groq", "groq"]);
});

/** Reads the SSE stream into a list of { event, data }. */
async function openStream(router) {
  const res = await router.request("/api/requests/stream");
  const events = [];
  const decoder = new TextDecoder();
  let buffer = "";
  (async () => {
    for await (const chunk of res.body) {
      buffer += decoder.decode(chunk, { stream: true });
      let end;
      while ((end = buffer.indexOf("\n\n")) !== -1) {
        const block = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const event = /^event: (.*)$/m.exec(block)?.[1];
        const data = /^data: (.*)$/m.exec(block)?.[1];
        if (event && data) events.push({ event, data: JSON.parse(data) });
      }
    }
  })().catch(() => {});
  return { events, close: () => res.body?.cancel().catch(() => {}) };
}

const until = async (check, ms = 4000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await check()) return; await new Promise((r) => setTimeout(r, 15)); }
  throw new Error("condition not met in time");
};

test("HTTP: the SSE stream emits a new attempt event for every real attempt", async (t) => {
  const groq = await startMockUpstream(scripted([429, 200]));
  const router = await startRouter({ GROQ_API_KEYS: "k0,k1", GROQ_MODELS: "m", GROQ_BASE_URL: groq.baseUrl });
  const stream = await openStream(router);
  t.after(async () => { await stream.close(); await router.close(); await groq.close(); });
  await until(() => stream.events.some((e) => e.event === "snapshot"));

  // Request 1: key 0 -> 429, key 1 -> 200. Request 2: the sticky target answers again.
  await router.request("/v1/chat/completions", postJson(chat));
  await router.request("/v1/chat/completions", postJson(chat));
  await until(() => stream.events.filter((e) => e.event === "attempt" && e.data.state !== "calling").length >= 3);

  const pushed = stream.events.filter((e) => e.event === "attempt").map((e) => e.data);
  const ids = [...new Set(pushed.map((e) => e.attemptId))];
  assert.equal(ids.length, 3, "three real upstream calls, three attempt ids");

  for (const id of ids) {
    const states = pushed.filter((e) => e.attemptId === id).map((e) => e.state);
    assert.equal(states[0], "calling", "each attempt first appears on the wire");
    assert.equal(states.length, 2, "and is settled exactly once");
    assert.notEqual(states[1], "calling");
  }
  const last = ids.map((id) => pushed.filter((e) => e.attemptId === id).at(-1));
  assert.deepEqual(last.map((e) => [e.keyIndex, e.status]), [[0, 429], [1, 200], [1, 200]]);
  assert.equal(new Set(last.map((e) => e.requestId)).size, 2);
  assert.ok(last.every((e) => e.pool === "text"));
});

test("HTTP: a late-joining stream client gets the same attempt events in its snapshot", async (t) => {
  const groq = await startMockUpstream(REPLY[200]);
  const router = await startRouter({ GROQ_API_KEYS: "k0", GROQ_MODELS: "m", GROQ_BASE_URL: groq.baseUrl });
  t.after(async () => { await router.close(); await groq.close(); });

  await router.request("/v1/chat/completions", postJson(chat));
  await router.request("/v1/chat/completions", postJson(chat));

  const stream = await openStream(router);
  t.after(() => stream.close());
  await until(() => stream.events.some((e) => e.event === "snapshot"));

  const snapshot = stream.events.find((e) => e.event === "snapshot").data;
  const live = (await getAttempts(router)).entries;
  assert.equal(snapshot.attempts.length, 2);
  assert.deepEqual(snapshot.attempts.map((a) => a.attemptId), live.map((a) => a.attemptId));
});
