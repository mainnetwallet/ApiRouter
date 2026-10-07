import test from "node:test";
import assert from "node:assert/strict";
import { startMockUpstream } from "../test-helpers/mock-upstream.js";
import { startRouter, postJson } from "../test-helpers/router-harness.js";

/**
 * Upstream response bounds, end to end through a real router process.
 *
 * Size: a chunked body with no Content-Length used to be buffered whole (the
 * "no header" case read as length 0), so a ~400 MB upstream body grew the
 * router by ~1.2 GB. The ceiling is now enforced on the bytes actually read.
 *
 * Time: REQUEST_TIMEOUT_MS only covered time-to-headers; a provider sending a
 * byte every few hundred ms after the headers was never cut off.
 */

const MiB = 1024 * 1024;
const chatBody = { model: "m", messages: [{ role: "user", content: "hi" }] };
const streamBody = { model: "m", stream: true, messages: [{ role: "user", content: "hi" }] };
const anthropicBody = { model: "m", max_tokens: 16, messages: [{ role: "user", content: "hi" }] };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const entries = async (router) => (await (await router.request("/api/requests")).json()).entries;
const healthOf = async (router) => (await router.request("/health")).json();
const drain = async (res) => { try { return await res.text(); } catch { return null; } };
const isRanked = async (router, provider) => (await healthOf(router)).rankedTargets.some((r) => r.provider === provider);

async function waitForEntry(router, predicate, { timeoutMs = 5000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = (await entries(router)).find(predicate);
    if (found) return found;
    await sleep(25);
  }
  return null;
}

const completion = (content) => ({
  id: "c1", object: "chat.completion", created: 0, model: "u",
  choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
});
const ok = (text = "ok") => ({ status: 200, body: completion(text) });

/** A chat completion whose serialised form is exactly `size` bytes. */
function completionOfSize(size) {
  const base = Buffer.byteLength(JSON.stringify(completion("")));
  assert.ok(size > base);
  const text = JSON.stringify(completion("x".repeat(size - base)));
  assert.equal(Buffer.byteLength(text), size);
  return text;
}

/** A chunked (no Content-Length) JSON body of `chunks` x 1 MiB. */
const chunkedJson = (chunks) => ({
  status: 200,
  headers: { "content-type": "application/json" },
  stream: Array.from({ length: chunks }, () => Buffer.alloc(MiB, 0x61))
});

/** `text` delivered `pieces` chunks at a time, `delayMs` apart, as a chunked body. */
function drip(text, { pieces, delayMs, headers = {}, status = 200 }) {
  const size = Math.ceil(text.length / pieces);
  const stream = [];
  for (let i = 0; i < text.length; i += size) stream.push(text.slice(i, i + size));
  return { status, headers: { "content-type": "application/json", ...headers }, stream, delayMs };
}

const SSE_EVENTS = [
  ...Array.from({ length: 8 }, (_, i) => `data: {"id":"c","choices":[{"index":0,"delta":{"content":"t${i}"}}]}\n\n`),
  'data: {"id":"c","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
  "data: [DONE]\n\n"
];
const sseStream = (extra = {}) => ({ status: 200, headers: { "content-type": "text/event-stream" }, stream: SSE_EVENTS, ...extra });

// ---------------------------------------------------------------------------
// Fix #1: bounded upstream bodies
// ---------------------------------------------------------------------------

test("small body: forwarded byte for byte, usage read, success", async (t) => {
  const groq = await startMockUpstream(() => ok("served"));
  const router = await startRouter({ GROQ_API_KEYS: "k1", GROQ_MODELS: "m", GROQ_BASE_URL: groq.baseUrl });
  t.after(async () => { await router.close(); await groq.close(); });

  const res = await router.request("/v1/chat/completions", postJson(chatBody));
  assert.equal(res.status, 200);
  assert.equal((await res.json()).choices[0].message.content, "served");
  const [entry] = await entries(router);
  assert.equal(entry.outcome, "success");
  assert.equal(entry.tokens, 2);
});

test("chunked pass-through body with no Content-Length larger than the inspect cap is still delivered whole", async (t) => {
  // 3 MiB > the 1 MiB usage-inspection cap: inspection is abandoned, the bytes
  // already read are replayed and the rest streams through with backpressure.
  const groq = await startMockUpstream(() => chunkedJson(3));
  const router = await startRouter({ GROQ_API_KEYS: "k1", GROQ_MODELS: "m", GROQ_BASE_URL: groq.baseUrl });
  t.after(async () => { await router.close(); await groq.close(); });

  const res = await router.request("/v1/chat/completions", postJson(chatBody));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-length"), null, "the upstream really was chunked");
  const bytes = Buffer.from(await res.arrayBuffer());
  assert.equal(bytes.length, 3 * MiB, "every byte arrived");
  assert.ok(bytes.every((b) => b === 0x61), "in order and unmodified");
  const [entry] = await entries(router);
  assert.equal(entry.outcome, "success");
});

test("oversized chunked body (no Content-Length) on a translated reply is rejected: 502, failed, target cooled", async (t) => {
  const groq = await startMockUpstream(() => chunkedJson(6));
  const router = await startRouter({
    GROQ_API_KEYS: "k1", GROQ_MODELS: "m", GROQ_BASE_URL: groq.baseUrl,
    MAX_UPSTREAM_BODY_BYTES: String(2 * MiB)
  });
  t.after(async () => { await router.close(); await groq.close(); });

  const res = await router.request("/v1/messages", postJson(anthropicBody));
  assert.equal(res.status, 502);
  assert.equal((await res.json()).error.type, "upstream_error");
  const [entry] = await entries(router);
  assert.equal(entry.outcome, "failed");
  assert.equal(entry.httpStatus, 502);
  assert.equal(await isRanked(router, "groq"), false, "a provider answering with an unbounded body is cooled");
});

test("a translated body of exactly MAX_UPSTREAM_BODY_BYTES is accepted, one byte over is rejected", async (t) => {
  const LIMIT = 4096;
  for (const [label, size, expected] of [["exact limit", LIMIT, 200], ["one byte over", LIMIT + 1, 502]]) {
    // Both framings: sized (Content-Length) and chunked (none).
    for (const chunked of [false, true]) {
      const text = completionOfSize(size);
      const groq = await startMockUpstream(() => chunked
        ? { status: 200, headers: { "content-type": "application/json" }, stream: [text.slice(0, 1000), text.slice(1000)] }
        : { status: 200, headers: { "content-type": "application/json" }, body: text });
      const router = await startRouter({
        GROQ_API_KEYS: "k1", GROQ_MODELS: "m", GROQ_BASE_URL: groq.baseUrl,
        MAX_UPSTREAM_BODY_BYTES: String(LIMIT)
      });
      try {
        const res = await router.request("/v1/messages", postJson(anthropicBody));
        await drain(res);
        assert.equal(res.status, expected, `${label} (${chunked ? "chunked" : "content-length"})`);
        const [entry] = await entries(router);
        assert.equal(entry.outcome, expected === 200 ? "success" : "failed", label);
      } finally {
        await router.close();
        await groq.close();
      }
    }
  }
});

test("oversized non-2xx body: bounded read, real status kept, and fallback still happens", async (t) => {
  const groq = await startMockUpstream(() => ({
    status: 500,
    headers: { "content-type": "application/json" },
    stream: Array.from({ length: 8 }, () => Buffer.alloc(MiB, 0x62)) // 8 MiB of error body, chunked
  }));
  const healthy = await startMockUpstream(() => ok("fallback"));
  const router = await startRouter({
    GROQ_API_KEYS: "k1", GROQ_MODELS: "m", GROQ_BASE_URL: groq.baseUrl,
    OPENROUTER_API_KEYS: "o1", OPENROUTER_MODELS: "m", OPENROUTER_BASE_URL: healthy.baseUrl
  });
  t.after(async () => { await router.close(); await groq.close(); await healthy.close(); });

  const res = await router.request("/v1/chat/completions", postJson(chatBody));
  assert.equal(res.status, 200, "fell back past the failing provider");
  assert.equal((await res.json()).choices[0].message.content, "fallback");
  const [entry] = await entries(router);
  const failed = entry.attempts.find((a) => a.provider === "groq");
  assert.equal(failed.ok, false);
  assert.equal(failed.status, 500, "the provider's real status is what is recorded");
  assert.ok(failed.errorMessage.length <= 2000, "only the head of the error body is kept");
  assert.equal(await isRanked(router, "groq"), false, "the 500 still cools the target");
});

test("oversized non-2xx body with no fallback fails cleanly with a small answer, not a crash", async (t) => {
  const groq = await startMockUpstream(() => ({
    status: 500,
    headers: { "content-type": "application/json" },
    stream: Array.from({ length: 8 }, () => Buffer.alloc(MiB, 0x62))
  }));
  const router = await startRouter({ GROQ_API_KEYS: "k1", GROQ_MODELS: "m", GROQ_BASE_URL: groq.baseUrl });
  t.after(async () => { await router.close(); await groq.close(); });

  const startedAt = Date.now();
  const res = await router.request("/v1/chat/completions", postJson(chatBody));
  const text = await res.text();
  // Same answer as before this change: every target failed, so the router says 502.
  assert.equal(res.status, 502);
  assert.ok(text.length < 8 * 1024, `the client was not sent the upstream's error body (${text.length} chars)`);
  assert.ok(Date.now() - startedAt < 10_000);
  const [entry] = await entries(router);
  assert.equal(entry.attempts[0].status, 500, "the provider's real status is what is recorded");
});

test("client abort while an oversized body is being read is a 499 and never a provider failure", async (t) => {
  // A slow, endless-looking body: 1 KiB every 50 ms. The client leaves part way.
  const groq = await startMockUpstream(() => ({
    status: 200,
    headers: { "content-type": "application/json" },
    stream: Array.from({ length: 400 }, () => "x".repeat(1024)),
    delayMs: 50
  }));
  const router = await startRouter({
    GROQ_API_KEYS: "k1", GROQ_MODELS: "m", GROQ_BASE_URL: groq.baseUrl,
    MAX_UPSTREAM_BODY_BYTES: String(MiB)
  });
  t.after(async () => { await router.close(); await groq.close(); });

  const controller = new AbortController();
  const pending = router.request("/v1/messages", { ...postJson(anthropicBody), signal: controller.signal });
  pending.catch(() => {});
  await sleep(400);
  controller.abort();

  const entry = await waitForEntry(router, (e) => e.outcome === "failed" && e.errorType === "client_aborted");
  assert.ok(entry, "the abort was settled as a client abort, not a size or upstream error");
  assert.equal(entry.httpStatus, 499);
  assert.equal(await isRanked(router, "groq"), true, "a client that left is not the provider's fault");
});

// ---------------------------------------------------------------------------
// Fix #2: a real total deadline, separate from connect and idle
// ---------------------------------------------------------------------------

test("slow non-stream body: REQUEST_TIMEOUT_MS is a total deadline even though every gap is within the idle bound", async (t) => {
  // 1 byte-ish piece every 100 ms for 4 s. The idle bound is 60 s, so only the
  // total deadline (800 ms) can stop it.
  const text = JSON.stringify(completion("y".repeat(200)));
  const groq = await startMockUpstream(() => drip(text, { pieces: 40, delayMs: 100 }));
  const router = await startRouter({
    GROQ_API_KEYS: "k1", GROQ_MODELS: "m", GROQ_BASE_URL: groq.baseUrl,
    REQUEST_TIMEOUT_MS: "800", STREAM_IDLE_TIMEOUT_MS: "60000"
  });
  t.after(async () => { await router.close(); await groq.close(); });

  const startedAt = Date.now();
  const res = await router.request("/v1/chat/completions", postJson(chatBody), { signal: AbortSignal.timeout(8000) });
  await drain(res);
  const took = Date.now() - startedAt;
  assert.ok(took < 3000, `cut off near the deadline, not after the whole body (${took} ms)`);
  assert.equal(res.status, 502);
  const [entry] = await entries(router);
  assert.equal(entry.outcome, "failed");
  assert.equal(await isRanked(router, "groq"), false, "a provider that cannot finish in time is cooled");
});

test("slow translated non-stream body is held to the same total deadline", async (t) => {
  const text = JSON.stringify(completion("y".repeat(200)));
  const groq = await startMockUpstream(() => drip(text, { pieces: 40, delayMs: 100 }));
  const router = await startRouter({
    GROQ_API_KEYS: "k1", GROQ_MODELS: "m", GROQ_BASE_URL: groq.baseUrl,
    REQUEST_TIMEOUT_MS: "800", STREAM_IDLE_TIMEOUT_MS: "60000"
  });
  t.after(async () => { await router.close(); await groq.close(); });

  const startedAt = Date.now();
  const res = await router.request("/v1/messages", postJson(anthropicBody), { signal: AbortSignal.timeout(8000) });
  await drain(res);
  assert.ok(Date.now() - startedAt < 3000);
  assert.equal(res.status, 502);
});

test("slow non-stream body that finishes before the deadline is served normally", async (t) => {
  const text = JSON.stringify(completion("fine"));
  const groq = await startMockUpstream(() => drip(text, { pieces: 8, delayMs: 40 })); // ~320 ms
  const router = await startRouter({
    GROQ_API_KEYS: "k1", GROQ_MODELS: "m", GROQ_BASE_URL: groq.baseUrl,
    REQUEST_TIMEOUT_MS: "3000"
  });
  t.after(async () => { await router.close(); await groq.close(); });

  const res = await router.request("/v1/chat/completions", postJson(chatBody));
  assert.equal(res.status, 200);
  assert.equal((await res.json()).choices[0].message.content, "fine");
  assert.equal((await entries(router))[0].outcome, "success");
});

test("timeout after headers: a body that stalls is cut at the total deadline even with the idle bound effectively off", async (t) => {
  const groq = await startMockUpstream(() => ({
    status: 200,
    headers: { "content-type": "application/json", "content-length": "4096" },
    stallBody: true,
    partialBody: '{"id":"c1",'
  }));
  const router = await startRouter({
    GROQ_API_KEYS: "k1", GROQ_MODELS: "m", GROQ_BASE_URL: groq.baseUrl,
    REQUEST_TIMEOUT_MS: "500", STREAM_IDLE_TIMEOUT_MS: "0"
  });
  t.after(async () => { await router.close(); await groq.close(); });

  const startedAt = Date.now();
  const res = await router.request("/v1/chat/completions", postJson(chatBody), { signal: AbortSignal.timeout(8000) });
  await drain(res);
  assert.ok(Date.now() - startedAt < 3000, "STREAM_IDLE_TIMEOUT_MS=0 no longer means 'wait forever'");
  assert.equal(res.status, 502);
  assert.equal(await isRanked(router, "groq"), false);
});

test("slow stream: STREAM_TOTAL_TIMEOUT_MS ends a stream that keeps trickling, and the provider is cooled", async (t) => {
  const groq = await startMockUpstream(() => ({
    status: 200,
    headers: { "content-type": "text/event-stream" },
    stream: Array.from({ length: 60 }, (_, i) => `data: {"id":"c","choices":[{"index":0,"delta":{"content":"t${i}"}}]}\n\n`),
    delayMs: 100
  }));
  const router = await startRouter({
    GROQ_API_KEYS: "k1", GROQ_MODELS: "m", GROQ_BASE_URL: groq.baseUrl,
    STREAM_TOTAL_TIMEOUT_MS: "700", STREAM_IDLE_TIMEOUT_MS: "60000"
  });
  t.after(async () => { await router.close(); await groq.close(); });

  const startedAt = Date.now();
  const res = await router.request("/v1/chat/completions", postJson(streamBody), { signal: AbortSignal.timeout(8000) });
  assert.equal(res.status, 200, "headers were already on the wire");
  await drain(res);
  assert.ok(Date.now() - startedAt < 4000, "the 6 s stream was cut near the deadline");

  const entry = await waitForEntry(router, (e) => e.outcome === "failed");
  assert.ok(entry);
  assert.equal(entry.streamOutcome, "truncated");
  assert.equal(await isRanked(router, "groq"), false);
});

test("normal stream before the deadline: a stream longer than REQUEST_TIMEOUT_MS is NOT cut off", async (t) => {
  // ~1 s of streaming against REQUEST_TIMEOUT_MS=400: REQUEST_TIMEOUT_MS bounds
  // time-to-headers for a stream, not its lifetime. No short stream timeout was added.
  const groq = await startMockUpstream(() => sseStream({ delayMs: 100 }));
  const router = await startRouter({
    GROQ_API_KEYS: "k1", GROQ_MODELS: "m", GROQ_BASE_URL: groq.baseUrl,
    REQUEST_TIMEOUT_MS: "400"
  });
  t.after(async () => { await router.close(); await groq.close(); });

  const res = await router.request("/v1/chat/completions", postJson(streamBody));
  const text = await res.text();
  assert.match(text, /\[DONE\]/, "the whole stream was delivered");
  assert.ok(text.includes("t7"));
  const [entry] = await entries(router);
  assert.equal(entry.outcome, "success");
  assert.equal(entry.streamOutcome, "completed");
  assert.equal(await isRanked(router, "groq"), true);
});

test("a fast stream is untouched by a tiny STREAM_TOTAL_TIMEOUT_MS only if it finishes inside it", async (t) => {
  const groq = await startMockUpstream(() => sseStream());
  const router = await startRouter({
    GROQ_API_KEYS: "k1", GROQ_MODELS: "m", GROQ_BASE_URL: groq.baseUrl,
    STREAM_TOTAL_TIMEOUT_MS: "5000"
  });
  t.after(async () => { await router.close(); await groq.close(); });

  const res = await router.request("/v1/chat/completions", postJson(streamBody));
  assert.match(await res.text(), /\[DONE\]/);
  assert.equal((await entries(router))[0].streamOutcome, "completed");
});

test("STREAM_TOTAL_TIMEOUT_MS=0 disables the absolute stream deadline", async (t) => {
  const groq = await startMockUpstream(() => sseStream({ delayMs: 100 }));
  const router = await startRouter({
    GROQ_API_KEYS: "k1", GROQ_MODELS: "m", GROQ_BASE_URL: groq.baseUrl,
    STREAM_TOTAL_TIMEOUT_MS: "0", REQUEST_TIMEOUT_MS: "400"
  });
  t.after(async () => { await router.close(); await groq.close(); });

  const res = await router.request("/v1/chat/completions", postJson(streamBody));
  assert.match(await res.text(), /\[DONE\]/);
  assert.equal((await entries(router))[0].outcome, "success");
});

test("client abort during a slow stream is a client abort and does not penalise the provider", async (t) => {
  const groq = await startMockUpstream(() => ({
    status: 200,
    headers: { "content-type": "text/event-stream" },
    stream: Array.from({ length: 100 }, (_, i) => `data: {"id":"c","choices":[{"index":0,"delta":{"content":"t${i}"}}]}\n\n`),
    delayMs: 100
  }));
  const router = await startRouter({
    GROQ_API_KEYS: "k1", GROQ_MODELS: "m", GROQ_BASE_URL: groq.baseUrl,
    STREAM_TOTAL_TIMEOUT_MS: "60000"
  });
  t.after(async () => { await router.close(); await groq.close(); });

  const controller = new AbortController();
  const res = await router.request("/v1/chat/completions", { ...postJson(streamBody), signal: controller.signal });
  assert.equal(res.status, 200);
  const reader = res.body.getReader();
  await reader.read();
  controller.abort();
  await reader.read().catch(() => {});

  const entry = await waitForEntry(router, (e) => e.outcome === "failed");
  assert.ok(entry, "the aborted stream was settled");
  assert.equal(entry.errorType, "client_aborted");
  assert.equal(entry.streamOutcome, "aborted");
  assert.equal(await isRanked(router, "groq"), true, "a client that walked away is not the provider's fault");
});

test("client abort during a slow non-stream body, with a total deadline configured, is still a 499", async (t) => {
  const text = JSON.stringify(completion("y".repeat(400)));
  const groq = await startMockUpstream(() => drip(text, { pieces: 80, delayMs: 100 }));
  const router = await startRouter({
    GROQ_API_KEYS: "k1", GROQ_MODELS: "m", GROQ_BASE_URL: groq.baseUrl,
    REQUEST_TIMEOUT_MS: "30000"
  });
  t.after(async () => { await router.close(); await groq.close(); });

  const controller = new AbortController();
  const pending = router.request("/v1/chat/completions", { ...postJson(chatBody), signal: controller.signal });
  pending.catch(() => {});
  await sleep(400);
  controller.abort();

  const entry = await waitForEntry(router, (e) => e.outcome === "failed" && e.errorType === "client_aborted");
  assert.ok(entry);
  assert.equal(entry.httpStatus, 499);
  assert.equal(await isRanked(router, "groq"), true);
});

test("a non-2xx body that trickles past the deadline still yields the provider's real status and falls back", async (t) => {
  const groq = await startMockUpstream(() => drip("e".repeat(400), { pieces: 40, delayMs: 100, status: 503 }));
  const healthy = await startMockUpstream(() => ok("fallback"));
  const router = await startRouter({
    GROQ_API_KEYS: "k1", GROQ_MODELS: "m", GROQ_BASE_URL: groq.baseUrl,
    OPENROUTER_API_KEYS: "o1", OPENROUTER_MODELS: "m", OPENROUTER_BASE_URL: healthy.baseUrl,
    REQUEST_TIMEOUT_MS: "600", STREAM_IDLE_TIMEOUT_MS: "60000"
  });
  t.after(async () => { await router.close(); await groq.close(); await healthy.close(); });

  const startedAt = Date.now();
  const res = await router.request("/v1/chat/completions", postJson(chatBody), { signal: AbortSignal.timeout(8000) });
  assert.equal(res.status, 200);
  assert.ok(Date.now() - startedAt < 3000, "the 4 s error body did not hold the walk");
  const [entry] = await entries(router);
  assert.equal(entry.attempts.find((a) => a.provider === "groq").status, 503);
});
