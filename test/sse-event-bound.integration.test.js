import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { startMockUpstream } from "../test-helpers/mock-upstream.js";
import { startRouter, postJson } from "../test-helpers/router-harness.js";

/**
 * MAX_SSE_EVENT_BYTES end to end: a provider that streams an event and never
 * sends the delimiter is cut off while receiving, the stream is cancelled and
 * the provider is cooled; a client that walks away is not the provider's fault.
 */

const KiB = 1024;
// A translated stream (Anthropic client, OpenAI-style upstream) is the path that parses SSE events;
// a same-protocol pass-through forwards bytes without buffering any event.
const streamBody = { model: "m", stream: true, max_tokens: 16, messages: [{ role: "user", content: "hi" }] };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const entries = async (router) => (await (await router.request("/api/requests")).json()).entries;
const isRanked = async (router, provider) =>
  (await (await router.request("/health")).json()).rankedTargets.some((r) => r.provider === provider);
const drain = async (res) => { try { return await res.text(); } catch { return null; } };

async function waitForEntry(router, predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = (await entries(router)).find(predicate);
    if (found) return found;
    await sleep(25);
  }
  return null;
}

const SSE_EVENTS = [
  ...Array.from({ length: 8 }, (_, i) => `data: {"id":"c","choices":[{"index":0,"delta":{"content":"t${i}"}}]}\n\n`),
  'data: {"id":"c","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
  "data: [DONE]\n\n"
];

const env = (groq, extra = {}) => ({
  GROQ_API_KEYS: "k1", GROQ_MODELS: "m", GROQ_BASE_URL: groq.baseUrl, ...extra
});

test("normal SSE events below the limit stream through and the provider stays healthy", async (t) => {
  const groq = await startMockUpstream(() => ({ status: 200, headers: { "content-type": "text/event-stream" }, stream: SSE_EVENTS }));
  const router = await startRouter(env(groq, { MAX_SSE_EVENT_BYTES: String(4 * KiB) }));
  t.after(async () => { await router.close(); await groq.close(); });

  const res = await router.request("/v1/messages", postJson(streamBody));
  const text = await res.text();
  assert.match(text, /event: message_stop/);
  assert.ok(text.includes("t7"));
  const [entry] = await entries(router);
  assert.equal(entry.outcome, "success");
  assert.equal(entry.streamOutcome, "completed");
  assert.equal(await isRanked(router, "groq"), true);
});

test("oversized incomplete SSE event: stream fails as an upstream fault and the provider is cooled", async (t) => {
  // An event that starts and never ends: 512 x 1 KiB with no blank line.
  const groq = await startMockUpstream(() => ({
    status: 200,
    headers: { "content-type": "text/event-stream" },
    stream: ['data: {"choices":[{"delta":{"content":"', ...Array.from({ length: 512 }, () => "a".repeat(KiB))],
    delayMs: 5
  }));
  const router = await startRouter(env(groq, { MAX_SSE_EVENT_BYTES: String(16 * KiB) }));
  t.after(async () => { await router.close(); await groq.close(); });

  const startedAt = Date.now();
  const res = await router.request("/v1/messages", postJson(streamBody), { signal: AbortSignal.timeout(8000) });
  assert.equal(res.status, 200, "headers were already on the wire");
  await drain(res);
  assert.ok(Date.now() - startedAt < 2000, "cut at the limit, not after the whole 512 KiB event");

  const entry = await waitForEntry(router, (e) => e.outcome === "failed");
  assert.ok(entry, "the attempt is recorded as failed");
  assert.equal(entry.streamOutcome, "truncated");
  assert.notEqual(entry.errorType, "client_aborted");
  assert.equal(await isRanked(router, "groq"), false, "the provider is cooled per existing health behaviour");
});

test("client abort mid-stream is a client abort and the provider stays healthy", async (t) => {
  const groq = await startMockUpstream(() => ({
    status: 200,
    headers: { "content-type": "text/event-stream" },
    stream: Array.from({ length: 60 }, (_, i) => `data: {"id":"c","choices":[{"index":0,"delta":{"content":"t${i}"}}]}\n\n`),
    delayMs: 100
  }));
  const router = await startRouter(env(groq, { MAX_SSE_EVENT_BYTES: String(16 * KiB) }));
  t.after(async () => { await router.close(); await groq.close(); });

  const controller = new AbortController();
  const res = await router.request("/v1/messages", { ...postJson(streamBody), signal: controller.signal });
  assert.equal(res.status, 200);
  const reader = res.body.getReader();
  await reader.read();
  controller.abort();
  reader.cancel().catch(() => {});

  const entry = await waitForEntry(router, (e) => e.outcome === "failed" && e.errorType === "client_aborted");
  assert.ok(entry, "settled as a client abort, not an upstream/size error");
  assert.equal(entry.streamOutcome, "aborted");
  assert.equal(await isRanked(router, "groq"), true, "a client that left is not the provider's fault");
});

/**
 * A provider that writes the given chunks, then holds the connection open for
 * `holdMs` and ends it normally. `state.terminatedEarly` is true when the router
 * dropped the connection before the provider ended it, i.e. the upstream stream
 * was really cancelled rather than just abandoned.
 */
async function startHoldingSseProvider(chunks, holdMs = 1500) {
  const state = { closed: false, serverEnded: false, terminatedEarly: false };
  const server = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      if (req.method === "GET") { res.writeHead(404, { "content-type": "application/json" }); return res.end("{}"); }
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.on("close", () => { state.closed = true; state.terminatedEarly = !state.serverEnded; });
      for (const chunk of chunks) res.write(chunk);
      setTimeout(() => { if (!state.closed) { state.serverEnded = true; res.end(); } }, holdMs);
    });
  });
  await new Promise((resolve) => server.listen(0, "localhost", resolve));
  return {
    state,
    baseUrl: `http://localhost:${server.address().port}`,
    close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); })
  };
}

const waitUntil = async (predicate, timeoutMs = 3000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { if (predicate()) return true; await sleep(20); }
  return predicate();
};

test("an oversized COMPLETE event inside one upstream chunk fails the request, cancels the upstream and cools the provider", async (t) => {
  // 8 KiB against a 2 KiB limit: small enough that the event and its delimiter reach the router in ONE socket
  // read (a bigger event is split by the network, and the old per-chunk check would catch that by accident).
  const bigEvent = `data: {"id":"c","choices":[{"index":0,"delta":{"content":"BIGMARK${"b".repeat(8 * KiB)}"}}]}\n\n`;
  const normal = 'data: {"id":"c","choices":[{"index":0,"delta":{"content":"first"}}]}\n\n';
  // The big event and its delimiter arrive in a single write, so nothing is ever "incomplete" at the limit.
  const groq = await startHoldingSseProvider([normal, bigEvent, "data: [DONE]\n\n"]);
  const router = await startRouter(env(groq, { MAX_SSE_EVENT_BYTES: String(2 * KiB) }));
  t.after(async () => { await router.close(); await groq.close(); });

  const res = await router.request("/v1/messages", postJson(streamBody), { signal: AbortSignal.timeout(8000) });
  assert.equal(res.status, 200, "headers were already on the wire");
  const text = await drain(res);
  assert.ok(!text || !text.includes("BIGMARK"), "the oversized event is not forwarded to the client");
  assert.ok(!text || !/event: message_stop/.test(text), "the stream is not completed normally");

  const entry = await waitForEntry(router, (e) => e.outcome === "failed");
  assert.ok(entry, "the request is recorded as failed");
  assert.equal(entry.streamOutcome, "truncated");
  assert.equal(entry.errorType, "upstream_stream_error");
  assert.notEqual(entry.errorType, "client_aborted");
  assert.equal((await entries(router)).filter((e) => e.outcome === "success").length, 0, "no successful request is recorded");
  assert.equal(await isRanked(router, "groq"), false, "the provider is cooled");

  assert.equal(await waitUntil(() => groq.state.closed), true, "the upstream connection was closed");
  assert.equal(groq.state.terminatedEarly, true, "the router terminated the upstream stream; the provider did not just finish");
});

test("a client abort while an incomplete event is being buffered stays a client abort and does not cool the provider", async (t) => {
  // An event that is still open (well under the limit), trickling in, when the client leaves.
  const groq = await startMockUpstream(() => ({
    status: 200,
    headers: { "content-type": "text/event-stream" },
    stream: ['data: {"choices":[{"delta":{"content":"', ...Array.from({ length: 200 }, () => "a".repeat(32))],
    delayMs: 50
  }));
  const router = await startRouter(env(groq, { MAX_SSE_EVENT_BYTES: String(64 * KiB) }));
  t.after(async () => { await router.close(); await groq.close(); });

  const controller = new AbortController();
  const res = await router.request("/v1/messages", { ...postJson(streamBody), signal: controller.signal });
  assert.equal(res.status, 200);
  await sleep(250); // several chunks of the unfinished event are now buffered
  controller.abort();
  res.body?.cancel().catch(() => {});

  const entry = await waitForEntry(router, (e) => e.outcome === "failed");
  assert.ok(entry);
  assert.equal(entry.errorType, "client_aborted", "not reclassified as an oversized-event upstream fault");
  assert.equal(entry.streamOutcome, "aborted");
  assert.equal(await isRanked(router, "groq"), true, "a client that left is not the provider's fault");
});
