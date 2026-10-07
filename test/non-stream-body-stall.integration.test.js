import test from "node:test";
import assert from "node:assert/strict";
import { startMockUpstream } from "../test-helpers/mock-upstream.js";
import { startRouter, postJson } from "../test-helpers/router-harness.js";

/**
 * A NON-streamed 200 whose body stalls after the headers.
 *
 * The per-attempt timer only covers time-to-headers; for a streamed response
 * `guardUpstreamStream` then bounds the gap between chunks. The buffered paths
 * (`arrayBuffer()` for a pass-through, `json()` for a translated reply) had no
 * bound of their own, so a provider that sent `200` + headers and then went
 * quiet was only cut off by the HTTP client's hard-coded 5 minute default —
 * ignoring `STREAM_IDLE_TIMEOUT_MS` / `REQUEST_TIMEOUT_MS` entirely and holding
 * the client connection (and its session) open for that long.
 *
 * The contract pinned here: the configured idle bound also applies to buffered
 * bodies; the client gets a prompt, typed 502 and the dead target is cooled.
 */

const IDLE_MS = 300;
const DEADLINE_MS = 5000; // far below the 300s HTTP-client default
const STALLED = {
  status: 200,
  headers: { "content-type": "application/json", "content-length": "4096" },
  stallBody: true,
  partialBody: '{"id":"c1","choices":[{"index":0,'
};
const chatBody = { model: "m", messages: [{ role: "user", content: "hi" }] };
const anthropicBody = { model: "m", max_tokens: 16, messages: [{ role: "user", content: "hi" }] };
const ok = {
  status: 200,
  body: {
    id: "c1", object: "chat.completion", created: 0, model: "u",
    choices: [{ index: 0, message: { role: "assistant", content: "served" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
  }
};
const entries = async (router) => (await (await router.request("/api/requests")).json()).entries;
const healthOf = async (router) => (await router.request("/health")).json();

/** Resolves with the response, or rejects once DEADLINE_MS passes (the hang). */
const withDeadline = (router, path, init) =>
  router.request(path, { ...init, signal: AbortSignal.timeout(DEADLINE_MS) });

test("a stalled pass-through body is cut off by the idle timeout, answered 502 and cools the target", async (t) => {
  const groq = await startMockUpstream(() => STALLED);
  const router = await startRouter({
    GROQ_API_KEYS: "k1", GROQ_MODELS: "m", GROQ_BASE_URL: groq.baseUrl,
    STREAM_IDLE_TIMEOUT_MS: String(IDLE_MS)
  });
  t.after(async () => { await router.close(); await groq.close(); });

  const startedAt = Date.now();
  const res = await withDeadline(router, "/v1/chat/completions", postJson(chatBody));
  const body = await res.json();

  assert.ok(Date.now() - startedAt < DEADLINE_MS, "the idle bound ended the request instead of hanging");
  assert.equal(res.status, 502);
  assert.equal(body.error.type, "upstream_error");

  const [entry] = await entries(router);
  assert.equal(entry.outcome, "failed", "a body that never completed is not a success");
  assert.equal(entry.httpStatus, 502);
  assert.ok(!(await healthOf(router)).rankedTargets.some((r) => r.provider === "groq"), "the stalled target is cooled");
});

test("a stalled translated (Anthropic client -> OpenAI target) body is bounded the same way", async (t) => {
  const groq = await startMockUpstream(() => STALLED);
  const router = await startRouter({
    GROQ_API_KEYS: "k1", GROQ_MODELS: "m", GROQ_BASE_URL: groq.baseUrl,
    STREAM_IDLE_TIMEOUT_MS: String(IDLE_MS)
  });
  t.after(async () => { await router.close(); await groq.close(); });

  const startedAt = Date.now();
  const res = await withDeadline(router, "/v1/messages", postJson(anthropicBody));
  await res.text();

  assert.ok(Date.now() - startedAt < DEADLINE_MS, "the translated buffered read is bounded too");
  assert.equal(res.status, 502);
  const [entry] = await entries(router);
  assert.equal(entry.outcome, "failed");
  assert.ok(!(await healthOf(router)).rankedTargets.some((r) => r.provider === "groq"), "the stalled target is cooled");
});

test("a slow but progressing non-stream body is NOT cut off (the bound is idle time, not total time)", async (t) => {
  // Negative case: the fix must not turn a healthy, merely slow provider into a failure.
  const groq = await startMockUpstream(() => ok);
  const router = await startRouter({
    GROQ_API_KEYS: "k1", GROQ_MODELS: "m", GROQ_BASE_URL: groq.baseUrl,
    STREAM_IDLE_TIMEOUT_MS: String(IDLE_MS)
  });
  t.after(async () => { await router.close(); await groq.close(); });

  const res = await router.request("/v1/chat/completions", postJson(chatBody));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.choices[0].message.content, "served", "the body is forwarded byte for byte");
  const [entry] = await entries(router);
  assert.equal(entry.outcome, "success");
  assert.equal(entry.tokens, 2, "usage is still read from a buffered body");
});

test("STREAM_IDLE_TIMEOUT_MS=0 keeps the unbounded behaviour an operator asked for (no new failure mode)", async (t) => {
  const groq = await startMockUpstream(() => ok);
  const router = await startRouter({
    GROQ_API_KEYS: "k1", GROQ_MODELS: "m", GROQ_BASE_URL: groq.baseUrl,
    STREAM_IDLE_TIMEOUT_MS: "0"
  });
  t.after(async () => { await router.close(); await groq.close(); });

  const res = await router.request("/v1/chat/completions", postJson(chatBody));
  assert.equal(res.status, 200);
  assert.equal((await res.json()).choices[0].message.content, "served");
});

test("the request log records the status the client was actually answered, and classifies it as a provider error", async (t) => {
  // A buffered body that fails after the 200 is answered 502 by the router. The
  // log used to keep the upstream's 200, so the row was invisible to the status
  // filter and fell into a meaningless "http 200" failure bucket.
  const groq = await startMockUpstream(() => STALLED);
  const router = await startRouter({
    GROQ_API_KEYS: "k1", GROQ_MODELS: "m", GROQ_BASE_URL: groq.baseUrl,
    STREAM_IDLE_TIMEOUT_MS: String(IDLE_MS)
  });
  t.after(async () => { await router.close(); await groq.close(); });

  const res = await withDeadline(router, "/v1/chat/completions", postJson(chatBody));
  assert.equal(res.status, 502);
  await res.text();

  const byStatus = await (await router.request("/api/requests?status=502")).json();
  assert.equal(byStatus.entries.length, 1, "the row is found under the status the client saw");
  assert.equal(byStatus.entries[0].httpStatus, 502);
  const upstreamStatus = await (await router.request("/api/requests?status=200")).json();
  assert.equal(upstreamStatus.entries.length, 0, "a failed row is not also filed under the upstream's 200");

  const analytics = await (await router.request("/api/analytics")).json();
  const keys = analytics.breakdowns.errors.map((row) => row.key);
  assert.deepEqual(keys, ["provider error"], "the failure is classified by what the client saw, not as \"http 200\"");
});

test("a client that leaves while a buffered body is stalled is a 499, never a provider failure", async (t) => {
  const groq = await startMockUpstream(() => STALLED);
  const router = await startRouter({
    GROQ_API_KEYS: "k1", GROQ_MODELS: "m", GROQ_BASE_URL: groq.baseUrl,
    STREAM_IDLE_TIMEOUT_MS: "60000" // the idle bound must not be what ends this request
  });
  t.after(async () => { await router.close(); await groq.close(); });

  const controller = new AbortController();
  const pending = router.request("/v1/chat/completions", { ...postJson(chatBody), signal: controller.signal });
  pending.catch(() => {});
  await new Promise((resolve) => setTimeout(resolve, 400)); // headers are in, the body is stalled
  controller.abort();

  let entry = null;
  for (let i = 0; i < 40 && !entry; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    entry = (await entries(router)).find((e) => e.outcome === "failed" && e.errorType === "client_aborted") ?? null;
  }
  assert.ok(entry, "the aborted request was settled in the log");
  assert.equal(entry.httpStatus, 499);
  assert.equal(entry.errorType, "client_aborted");
  assert.ok((await healthOf(router)).rankedTargets.some((r) => r.provider === "groq"), "a client that left is not the provider's fault");
});
