import test from "node:test";
import assert from "node:assert/strict";
import { startMockUpstream } from "../test-helpers/mock-upstream.js";
import { startRouter, postJson } from "../test-helpers/router-harness.js";

/**
 * Request-lifecycle invariants.
 *
 *   one incoming HTTP request  ->  exactly ONE top-level requestId
 *   fallback / retry           ->  stays under that requestId, N distinct attemptIds
 *   two incoming HTTP requests ->  two requestIds (never merged, never deduplicated)
 *
 * Every test boots the real src/server.js with MULTIAI_DEBUG_INGRESS=1, so the
 * router's own [INCOMING] / [PROXY_START] / [RECORD] lines are asserted next to
 * the upstream hit counts and the request log.
 */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitUntil(predicate, { timeoutMs = 4000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await sleep(20);
  }
  return false;
}

const chatBody = { model: "m", messages: [{ role: "user", content: "hi" }] };
const chatOk = () => ({
  status: 200,
  body: {
    id: "c1", object: "chat.completion", created: 0, model: "u",
    choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
  }
});
const fail500 = () => ({ status: 500, body: { error: { message: "boom" } } });
const sse = (o) => `data: ${JSON.stringify(o)}\n\n`;
const chatStream = (extra = {}) => ({
  status: 200,
  headers: { "content-type": "text/event-stream" },
  stream: [
    sse({ id: "c", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: "he" } }] }),
    sse({ id: "c", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: "llo" }, finish_reason: "stop" }] }),
    "data: [DONE]\n\n"
  ],
  ...extra
});

/** Boots mocks + router; `providers` is { GROQ: script, ... }. */
async function boot(t, providers, env = {}) {
  const mocks = {};
  const e = { MULTIAI_DEBUG_INGRESS: "1", ...env };
  for (const [id, script] of Object.entries(providers)) {
    const model = env[`${id}_MODELS`] ?? "m";
    mocks[id] = await startMockUpstream(script);
    e[`${id}_API_KEYS`] = "k";
    e[`${id}_MODELS`] = model;
    e[`${id}_BASE_URL`] = mocks[id].baseUrl;
  }
  const router = await startRouter(e);
  t.after(async () => {
    await router.close();
    for (const mock of Object.values(mocks)) await mock.close();
  });

  const lines = (prefix, { path = "/v1/" } = {}) =>
    router.stdout.split("\n").filter((l) => l.startsWith(prefix) && l.includes(path));

  return {
    router,
    mocks,
    incoming: () => lines("[INCOMING]"),
    proxyStarts: () => lines("[PROXY_START]"),
    proxyEnds: () => router.stdout.split("\n").filter((l) => l.startsWith("[PROXY_END]")),
    records: () => router.stdout.split("\n").filter((l) => l.startsWith("[RECORD]")),
    rows: async () => (await (await router.request("/api/requests")).json()).entries,
    attempts: async () => (await (await router.request("/api/attempts")).json()).entries
  };
}

test("1. one incoming POST creates exactly one top-level requestId", async (t) => {
  const h = await boot(t, { GROQ: chatOk });
  const res = await h.router.request("/v1/chat/completions", postJson(chatBody));
  assert.equal(res.status, 200);
  await res.text();

  assert.ok(await waitUntil(async () => (await h.rows()).length === 1));
  const rows = await h.rows();
  assert.equal(rows.length, 1, "one log row");
  assert.equal(res.headers.get("x-multi-ai-request-id"), rows[0].requestId, "the id the client was given is the id that was logged");
  assert.equal(h.incoming().length, 1, "one ingress line");
  assert.equal(h.proxyStarts().length, 1, "one proxy lifecycle");
  assert.equal(h.records().length, 1, "one terminal record");
  assert.ok(h.records()[0].includes("open=true"), "the record closed the lifecycle that begin() opened");
  assert.ok((await h.attempts()).every((a) => a.requestId === rows[0].requestId));
});

test("2. fallback across 3 providers: one requestId, 3 distinct attemptIds", async (t) => {
  const h = await boot(t, { GROQ: fail500, OPENROUTER: fail500, CEREBRAS: chatOk });
  const res = await h.router.request("/v1/chat/completions", postJson(chatBody));
  assert.equal(res.status, 200);
  await res.text();

  assert.ok(await waitUntil(async () => (await h.rows()).length === 1));
  const [row] = await h.rows();
  assert.equal((await h.rows()).length, 1, "fallback never opens a second top-level request");
  const real = row.attempts.filter((a) => !a.skipped);
  assert.equal(real.length, 3);
  assert.equal(new Set(real.map((a) => a.attemptId)).size, 3, "three distinct attemptIds");
  assert.ok(real.every((a) => a.requestId === row.requestId), "every attempt shares the one requestId");
  assert.equal(h.incoming().length, 1);
  assert.equal(h.proxyStarts().length, 1);
  assert.equal(h.records().length, 1);
  for (const id of ["GROQ", "OPENROUTER", "CEREBRAS"]) assert.equal(h.mocks[id].apiRequests.length, 1, `${id} was called once`);
});

test("3. a successful first provider makes exactly one attempt", async (t) => {
  const h = await boot(t, { GROQ: chatOk, OPENROUTER: chatOk });
  const res = await h.router.request("/v1/chat/completions", postJson(chatBody));
  await res.text();

  assert.ok(await waitUntil(async () => (await h.rows()).length === 1));
  const [row] = await h.rows();
  assert.equal(row.attemptCount, 1);
  assert.equal(row.fallbackCount, 0);
  assert.equal(h.mocks.GROQ.apiRequests.length + h.mocks.OPENROUTER.apiRequests.length, 1, "success ends the chain: only one provider was called");
});

test("4. a provider failure falls back under the SAME requestId", async (t) => {
  const h = await boot(t, { GROQ: fail500, OPENROUTER: chatOk });
  const res = await h.router.request("/v1/chat/completions", postJson(chatBody));
  await res.text();

  assert.ok(await waitUntil(async () => (await h.rows()).length === 1));
  const rows = await h.rows();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].attemptCount, 2);
  assert.equal(rows[0].fallbackCount, 1);
  assert.equal(res.headers.get("x-multi-ai-request-id"), rows[0].requestId);
  const evts = await h.attempts();
  assert.equal(evts.length, 2);
  assert.ok(evts.every((a) => a.requestId === rows[0].requestId));
});

test("5. a target that appears in several routing phases is invoked once", async (t) => {
  // groq/m is listed as a priority entry AND appears again in the normal
  // fallback phase. It fails (retryable 500); the walk must not call it twice.
  const h = await boot(t, { GROQ: fail500, OPENROUTER: chatOk }, { TEXT_PRIORITY_MODELS: "groq/m" });
  const res = await h.router.request("/v1/chat/completions", postJson(chatBody));
  await res.text();

  assert.ok(await waitUntil(async () => (await h.rows()).length === 1));
  assert.equal(h.mocks.GROQ.apiRequests.length, 1, "the repeated target was invoked exactly once");
  assert.equal(h.mocks.OPENROUTER.apiRequests.length, 1);
  const [row] = await h.rows();
  assert.equal(row.attempts.filter((a) => !a.skipped).length, 2);
  assert.ok(row.attempts.some((a) => a.skipped && a.skipReason === "already_attempted"), "the repeat is reported as skipped, not called");
});

test("6. a streaming success does not create another request", async (t) => {
  const h = await boot(t, { GROQ: () => chatStream() });
  const res = await h.router.request("/v1/chat/completions", postJson({ ...chatBody, stream: true }));
  assert.equal(res.status, 200);
  await res.text();

  assert.ok(await waitUntil(async () => (await h.rows()).length >= 1));
  await sleep(200);
  const rows = await h.rows();
  assert.equal(rows.length, 1, "one row after the stream finished");
  assert.equal(rows[0].streamOutcome, "completed");
  assert.equal(h.mocks.GROQ.apiRequests.length, 1, "one upstream call");
  assert.equal(h.proxyStarts().length, 1);
  assert.equal(h.records().length, 1);
});

test("7. a client abort does not restart the request", async (t) => {
  const h = await boot(t, { GROQ: () => chatStream({ delayMs: 250 }), OPENROUTER: chatOk });
  const controller = new AbortController();
  const pending = h.router
    .request("/v1/chat/completions", { ...postJson({ ...chatBody, stream: true }), signal: controller.signal })
    .then((r) => r.text())
    .catch((e) => e.name);
  assert.ok(await waitUntil(() => h.mocks.GROQ.apiRequests.length === 1));
  await sleep(100);
  controller.abort();
  await pending;

  assert.ok(await waitUntil(async () => (await h.rows()).length === 1));
  await sleep(500); // long enough for any (wrongly) restarted request to show up
  assert.equal((await h.rows()).length, 1, "no second request appeared after the abort");
  assert.equal(h.mocks.GROQ.apiRequests.length, 1, "the aborted provider was not re-called");
  assert.equal(h.mocks.OPENROUTER.apiRequests.length, 0, "an abort is not a fallback");
  assert.equal(h.incoming().length, 1);
  assert.equal(h.proxyStarts().length, 1);
});

test("8. Codex Responses translation makes one top-level request and one upstream call", async (t) => {
  const h = await boot(t, { GROQ: chatOk });
  const res = await h.router.request("/v1/responses", postJson({ model: "m", input: "hi" }));
  assert.equal(res.status, 200);
  await res.json();

  assert.ok(await waitUntil(async () => (await h.rows()).length === 1));
  const [row] = await h.rows();
  assert.equal(row.protocol, "openai-responses");
  assert.equal(row.attemptCount, 1);
  assert.equal(h.mocks.GROQ.apiRequests.length, 1, "one translated upstream request");
  assert.equal(h.mocks.GROQ.apiRequests[0].url, "/v1/chat/completions", "translated to the chat protocol");
  assert.equal(h.proxyStarts().length, 1);
  assert.equal(h.records().length, 1);

  // And the streamed Responses form.
  const s = await boot(t, { GROQ: () => chatStream() });
  const sres = await s.router.request("/v1/responses", postJson({ model: "m", input: "hi", stream: true }));
  await sres.text();
  assert.ok(await waitUntil(async () => (await s.rows()).length >= 1));
  await sleep(200);
  assert.equal((await s.rows()).length, 1);
  assert.equal(s.mocks.GROQ.apiRequests.length, 1);
});

test("9. two genuinely separate incoming requests produce two requestIds", async (t) => {
  const h = await boot(t, { GROQ: chatOk });
  const a = await h.router.request("/v1/chat/completions", postJson(chatBody));
  const b = await h.router.request("/v1/chat/completions", postJson({ ...chatBody, messages: [{ role: "user", content: "different" }] }));
  await a.text();
  await b.text();

  assert.ok(await waitUntil(async () => (await h.rows()).length === 2));
  const ids = (await h.rows()).map((r) => r.requestId);
  assert.equal(new Set(ids).size, 2);
  assert.notEqual(a.headers.get("x-multi-ai-request-id"), b.headers.get("x-multi-ai-request-id"));
  assert.equal(h.mocks.GROQ.apiRequests.length, 2);
});

test("10. a client that sends the SAME request twice is logged as two incoming requests, not merged", async (t) => {
  // Identical method, path, body and client request-id header, back to back:
  // the router must not deduplicate. Two ingress lines, two requestIds, two
  // upstream calls. That is what lets [INCOMING] prove the client did it.
  const h = await boot(t, { GROQ: chatOk });
  const headers = { "x-request-id": "client-same-id", "user-agent": "codex-probe/1.0" };
  const [a, b] = await Promise.all([
    h.router.request("/v1/chat/completions", postJson(chatBody, headers)),
    h.router.request("/v1/chat/completions", postJson(chatBody, headers))
  ]);
  await a.text();
  await b.text();

  assert.ok(await waitUntil(async () => (await h.rows()).length === 2));
  assert.equal(h.incoming().length, 2, "two [INCOMING] lines");
  assert.ok(h.incoming().every((l) => l.includes("x-request-id=client-same-id") && l.includes("ua=codex-probe/1.0")), "the ingress line carries the client's own correlation data");
  assert.equal(new Set((await h.rows()).map((r) => r.requestId)).size, 2);
  assert.equal(h.mocks.GROQ.apiRequests.length, 2);
});

test("11. a failure AFTER the terminal record cannot open a second top-level request", async (t) => {
  // A model id with a non-latin1 character makes res.writeHead() throw when the
  // x-multi-ai-model header is written, AFTER the request was recorded as a
  // success. The outer catch used to record the same request again, minting a
  // second requestId (a phantom 502) for one HTTP request and one upstream call.
  const h = await boot(t, { GROQ: chatOk }, { GROQ_MODELS: "modèle→x" });
  const res = await h.router.request("/v1/responses", postJson({ model: "modèle→x", input: "hi" }));
  await res.text().catch(() => "");

  assert.ok(await waitUntil(async () => (await h.rows()).length >= 1));
  await sleep(300);
  const rows = await h.rows();
  assert.equal(h.incoming().length, 1);
  assert.equal(h.mocks.GROQ.apiRequests.length, 1, "one upstream call");
  assert.equal(rows.length, 1, `one incoming request must be one log row, got: ${rows.map((r) => `${r.requestId}/${r.httpStatus}`).join(", ")}`);
  assert.equal(new Set(rows.map((r) => r.requestId)).size, 1);
});
