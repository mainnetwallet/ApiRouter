import test from "node:test";
import assert from "node:assert/strict";
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
