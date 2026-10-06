import test from "node:test";
import assert from "node:assert/strict";
import { startMockUpstream } from "../test-helpers/mock-upstream.js";
import { startRouter, postJson } from "../test-helpers/router-harness.js";

/**
 * A 200 that only carried headers is NOT a success.
 *
 * `fetch` resolves on the response headers, so the old code marked the target
 * healthy, saved it as the session's sticky target and logged `outcome: success`
 * before a single body byte reached the client. If the provider then reset the
 * stream, the operator saw a healthy provider and a successful request while the
 * client had received a truncated body. These tests pin the real lifecycle: the
 * outcome is only known once the body has been delivered.
 */

const SSE = [
  'data: {"id":"c","choices":[{"index":0,"delta":{"content":"hello"}}]}\n\n',
  'data: {"id":"c","choices":[{"index":0,"delta":{"content":" world"},"finish_reason":"stop"}]}\n\n',
  "data: [DONE]\n\n"
];
const streamBody = { model: "m", stream: true, messages: [{ role: "user", content: "hi" }] };
const plainBody = { model: "m", messages: [{ role: "user", content: "hi" }] };
const ok = (text = "ok") => ({
  status: 200,
  body: {
    id: "c1", object: "chat.completion", created: 0, model: "u",
    choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
  }
});
const entries = async (router) => (await (await router.request("/api/requests")).json()).entries;
const healthOf = async (router) => (await (await router.request("/health")).json());
const drain = async (res) => { try { await res.text(); } catch { /* the stream died; that is the point */ } };

test("a stream reset after the 200 cools the target, is not a success, and is not sticky", async (t) => {
  const groq = await startMockUpstream(() => ({
    status: 200, headers: { "content-type": "text/event-stream" }, stream: SSE, truncateAfter: 1
  }));
  const healthy = await startMockUpstream(() => ok("served"));
  const router = await startRouter({
    GROQ_API_KEYS: "k1", GROQ_MODELS: "m", GROQ_BASE_URL: groq.baseUrl,
    OPENROUTER_API_KEYS: "o1", OPENROUTER_MODELS: "m", OPENROUTER_BASE_URL: healthy.baseUrl
  });
  t.after(async () => { await router.close(); await groq.close(); await healthy.close(); });

  const res = await router.request("/v1/chat/completions", postJson(streamBody, { "x-multi-ai-session-id": "s1" }));
  assert.equal(res.status, 200, "the headers were already on the wire");
  await drain(res);

  const [entry] = await entries(router);
  assert.equal(entry.finalProvider, "groq");
  assert.equal(entry.outcome, "failed", "a truncated body is not a success");
  assert.equal(entry.streamOutcome, "truncated");

  const health = await healthOf(router);
  assert.ok(!health.rankedTargets.some((r) => r.provider === "groq"), "the dead target is not eligible");
  assert.ok(
    health.coolingTargets.some((r) => r.provider === "groq" && r.cooldownUntil > Date.now()),
    "the target entered cooldown"
  );

  // The same session must NOT resume a sticky target: no success was ever committed.
  const second = await router.request("/v1/chat/completions", postJson(plainBody, { "x-multi-ai-session-id": "s1" }));
  assert.equal(second.status, 200);
  const [latest] = await entries(router);
  assert.equal(latest.finalProvider, "openrouter", "routing moved past the cooled target");
  assert.ok(!latest.attempts.some((a) => a.phase === "sticky"), "a truncated stream is never sticky");
  assert.ok(latest.attempts.some((a) => a.skipped && a.skipReason === "cooldown"), "the cooled target was skipped");
});

test("a stream that goes idle after the headers fails over on the idle timeout", async (t) => {
  const groq = await startMockUpstream(() => ({
    status: 200, headers: { "content-type": "text/event-stream" }, stream: SSE, stallAfter: 1
  }));
  const router = await startRouter({
    GROQ_API_KEYS: "k1", GROQ_MODELS: "m", GROQ_BASE_URL: groq.baseUrl,
    STREAM_IDLE_TIMEOUT_MS: "250"
  });
  t.after(async () => { await router.close(); await groq.close(); });

  const startedAt = Date.now();
  const res = await router.request("/v1/chat/completions", postJson(streamBody));
  assert.equal(res.status, 200);
  await drain(res);
  assert.ok(Date.now() - startedAt < 5000, "the idle bound ended the request instead of hanging");

  const [entry] = await entries(router);
  assert.equal(entry.outcome, "failed");
  assert.equal(entry.streamOutcome, "truncated", "an idle upstream is an upstream fault");
  assert.ok(!(await healthOf(router)).rankedTargets.some((r) => r.provider === "groq"), "an idle stream cools the target");
});

test("a completed stream is a success and does become sticky", async (t) => {
  // The other side of the same lifecycle: the fix must not turn healthy
  // streams into failures. The first request completes and sticks; the second,
  // in the same session, is served by the sticky target and succeeds.
  const groq = await startMockUpstream(() => ({
    status: 200, headers: { "content-type": "text/event-stream" }, stream: SSE
  }));
  const router = await startRouter({ GROQ_API_KEYS: "k1", GROQ_MODELS: "m", GROQ_BASE_URL: groq.baseUrl });
  t.after(async () => { await router.close(); await groq.close(); });

  const first = await router.request("/v1/chat/completions", postJson(streamBody, { "x-multi-ai-session-id": "s2" }));
  assert.match(await first.text(), /\[DONE\]/);
  const [entry] = await entries(router);
  assert.equal(entry.outcome, "success");
  assert.equal(entry.streamOutcome, "completed");

  const second = await router.request("/v1/chat/completions", postJson(streamBody, { "x-multi-ai-session-id": "s2" }));
  await second.text();
  const [latest] = await entries(router);
  assert.equal(latest.attempts[0].phase, "sticky", "the completed stream became the sticky target");
});
