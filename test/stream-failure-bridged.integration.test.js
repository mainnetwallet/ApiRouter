import test from "node:test";
import assert from "node:assert/strict";
import { startMockUpstream } from "../test-helpers/mock-upstream.js";
import { startRouter, postJson } from "../test-helpers/router-harness.js";

/**
 * A *translated* stream (the client protocol differs from the upstream's) that
 * dies after the 200 must be a truncated failure everywhere.
 *
 * The protocol bridges emit their terminal client event and then re-throw, so
 * `pipeline()` rejects. Before that fix the bridges swallowed the upstream
 * error, `pipeline()` resolved, and the request was filed as
 * `outcome: success` / `streamOutcome: completed` while the client had a
 * truncated body. These tests pin the whole lifecycle through the real server:
 * the client keeps its terminal signal, yet the request/attempt outcomes,
 * health, sticky and cooldown all reflect the failure.
 *
 * The 200-then-reset is the mock's `truncateAfter`, so the failure is a real
 * socket death rather than a simulated callback.
 */

const entries = async (router) => (await (await router.request("/api/requests")).json()).entries;
const healthOf = async (router) => (await (await router.request("/health")).json());
const attemptsOf = async (router) => (await (await router.request("/api/attempts")).json()).entries;

/** Reads whatever bytes reached the client, tolerating the truncated socket. */
async function readTolerant(res) {
  const parts = [];
  const reader = res.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(Buffer.from(value).toString("utf8"));
    }
  } catch { /* the upstream died mid-body: assert on what did arrive */ }
  return parts.join("");
}

const okJson = () => ({
  status: 200,
  body: {
    id: "c1", object: "chat.completion", created: 0, model: "u",
    choices: [{ index: 0, message: { role: "assistant", content: "served" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
  }
});

/** Polls until the request log has an entry (an abort is recorded asynchronously). */
async function waitForEntry(router) {
  for (let i = 0; i < 100; i += 1) {
    const list = await entries(router);
    if (list.length) return list;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("the request was never recorded");
}

test("a translated chat->Gemini stream that dies after the 200 is truncated, not a success", async (t) => {
  const geminiSse = [
    `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: "po" }] } }] })}\n\n`,
    `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: "ng" }] }, finishReason: "STOP" }] })}\n\n`
  ];
  const gemini = await startMockUpstream(() => ({
    status: 200, headers: { "content-type": "text/event-stream" }, stream: geminiSse, truncateAfter: 1
  }));
  const backup = await startMockUpstream(() => okJson());
  const router = await startRouter({
    GEMINI_API_KEYS: "gk", GEMINI_MODELS: "gemini-flash", GEMINI_BASE_URL: gemini.baseUrl,
    GROQ_API_KEYS: "k1", GROQ_MODELS: "m", GROQ_BASE_URL: backup.baseUrl
  });
  t.after(async () => { await router.close(); await gemini.close(); await backup.close(); });

  const body = { model: "gemini-flash", stream: true, messages: [{ role: "user", content: "hi" }] };
  const res = await router.request("/v1/chat/completions", postJson(body, { "x-multi-ai-session-id": "bg1" }));
  assert.equal(res.status, 200, "the headers were already on the wire");
  assert.equal(res.headers.get("x-multi-ai-provider"), "gemini");

  const raw = await readTolerant(res);
  // The client still gets the translated text plus the protocol's error event
  // and terminator, so a client watching for [DONE] is not left hanging.
  assert.match(raw, /"content":"po"/);
  assert.match(raw, /"type":"upstream_error"/);
  assert.ok(raw.trimEnd().endsWith("data: [DONE]"), "the translated stream still ends with [DONE]");

  const [entry] = await entries(router);
  assert.equal(entry.finalProvider, "gemini");
  assert.equal(entry.outcome, "failed", "a truncated translated body is not a success");
  assert.equal(entry.streamOutcome, "truncated");
  assert.equal(entry.attemptCount, 1);

  const [attempt] = await attemptsOf(router);
  assert.equal(attempt.provider, "gemini");
  assert.equal(attempt.state, "failed", "the upstream attempt is a failure, not an accepted 200");
  assert.equal(attempt.ok, false);

  const health = await healthOf(router);
  assert.ok(!health.rankedTargets.some((r) => r.provider === "gemini"), "the dead target is not healthy");
  assert.ok(
    health.coolingTargets.some((r) => r.provider === "gemini" && r.cooldownUntil > Date.now()),
    "the target entered cooldown"
  );

  // The same session must NOT resume a sticky target: no success was committed.
  const second = await router.request("/v1/chat/completions", postJson(
    { model: "gemini-flash", messages: [{ role: "user", content: "hi" }] },
    { "x-multi-ai-session-id": "bg1" }
  ));
  assert.equal(second.status, 200);
  const [latest] = await entries(router);
  assert.equal(latest.finalProvider, "groq", "routing moved past the cooled, un-sticky target");
  assert.ok(!latest.attempts.some((a) => a.phase === "sticky"), "a truncated translated stream is never sticky");
});

test("a translated Responses->chat stream that dies after the 200 is truncated, not a success", async (t) => {
  const sseChunks = [
    `data: ${JSON.stringify({ choices: [{ delta: { content: "po" } }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ delta: { content: "ng" }, finish_reason: "stop" }] })}\n\n`
  ];
  const groq = await startMockUpstream(() => ({
    status: 200, headers: { "content-type": "text/event-stream" }, stream: sseChunks, truncateAfter: 1
  }));
  const router = await startRouter({ GROQ_API_KEYS: "g-key", GROQ_MODELS: "llama-x", GROQ_BASE_URL: groq.baseUrl + "/v1" });
  t.after(async () => { await router.close(); await groq.close(); });

  const res = await router.request("/v1/responses", postJson(
    { model: "gpt-5-codex", input: "hi", stream: true },
    { "x-multi-ai-session-id": "br1" }
  ));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("x-multi-ai-provider"), "groq");

  const raw = await readTolerant(res);
  // The Responses bridge still delivers the terminal response.failed event.
  assert.match(raw, /"delta":"po"/);
  assert.match(raw, /event: response\.failed/);
  assert.match(raw, /"status":"failed"/);

  const [entry] = await entries(router);
  assert.equal(entry.protocol, "openai-responses");
  assert.equal(entry.outcome, "failed", "a truncated translated Responses body is not a success");
  assert.equal(entry.streamOutcome, "truncated");

  const [attempt] = await attemptsOf(router);
  assert.equal(attempt.provider, "groq");
  assert.equal(attempt.state, "failed");
  assert.equal(attempt.ok, false);

  const health = await healthOf(router);
  assert.ok(!health.rankedTargets.some((r) => r.provider === "groq"), "the dead target is not healthy");
  assert.ok(health.coolingTargets.some((r) => r.provider === "groq" && r.cooldownUntil > Date.now()), "the target entered cooldown");
});

test("a completed translated stream is still a success and does become sticky", async (t) => {
  // The other side of the lifecycle: the fix must not turn a healthy translated
  // stream into a failure. The first request completes and sticks; the second,
  // in the same session, is served by the sticky target.
  const geminiSse = [
    `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: "po" }] } }] })}\n\n`,
    `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: "ng" }] }, finishReason: "STOP" }] })}\n\n`
  ];
  const gemini = await startMockUpstream(() => ({
    status: 200, headers: { "content-type": "text/event-stream" }, stream: geminiSse
  }));
  const router = await startRouter({ GEMINI_API_KEYS: "gk", GEMINI_MODELS: "gemini-flash", GEMINI_BASE_URL: gemini.baseUrl });
  t.after(async () => { await router.close(); await gemini.close(); });

  const first = await router.request("/v1/chat/completions", postJson(
    { model: "gemini-flash", stream: true, messages: [{ role: "user", content: "hi" }] },
    { "x-multi-ai-session-id": "bs1" }
  ));
  assert.equal(first.status, 200);
  assert.match(await first.text(), /\[DONE\]/);
  const [entry] = await entries(router);
  assert.equal(entry.outcome, "success");
  assert.equal(entry.streamOutcome, "completed");
  assert.equal(entry.attempts[0].ok, true, "a delivered translated stream is an accepted attempt");

  const second = await router.request("/v1/chat/completions", postJson(
    { model: "gemini-flash", stream: true, messages: [{ role: "user", content: "hi" }] },
    { "x-multi-ai-session-id": "bs1" }
  ));
  await second.text();
  const [latest] = await entries(router);
  assert.equal(latest.attempts[0].phase, "sticky", "the completed translated stream became the sticky target");
});

test("a client abort on a translated stream is 'aborted', not truncated, and never cools the provider", async (t) => {
  // A client that walks away mid-stream is not a provider fault: the re-throw
  // must preserve the "client" cause so the target is not cooled and the record
  // stays distinct from an upstream truncation.
  const geminiSse = [
    `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: "po" }] } }] })}\n\n`,
    `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: "ng" }] }, finishReason: "STOP" }] })}\n\n`
  ];
  const gemini = await startMockUpstream(() => ({
    status: 200, headers: { "content-type": "text/event-stream" }, stream: geminiSse, stallAfter: 1
  }));
  const router = await startRouter({
    GEMINI_API_KEYS: "gk", GEMINI_MODELS: "gemini-flash", GEMINI_BASE_URL: gemini.baseUrl,
    // Long enough that only the client abort can end the request.
    STREAM_IDLE_TIMEOUT_MS: "60000"
  });
  t.after(async () => { await router.close(); await gemini.close(); });

  const controller = new AbortController();
  const res = await router.request("/v1/chat/completions", {
    ...postJson(
      { model: "gemini-flash", stream: true, messages: [{ role: "user", content: "hi" }] },
      { "x-multi-ai-session-id": "ba1" }
    ),
    signal: controller.signal
  });
  assert.equal(res.status, 200);

  const reader = res.body.getReader();
  await reader.read();        // the first translated chunk reached the client
  controller.abort();         // the client walks away mid-stream
  try { for (;;) { const { done } = await reader.read(); if (done) break; } } catch { /* aborted */ }

  const [entry] = await waitForEntry(router);
  assert.equal(entry.finalProvider, "gemini");
  assert.equal(entry.outcome, "failed");
  assert.equal(entry.streamOutcome, "aborted", "a client abort is not an upstream truncation");
  assert.equal(entry.errorType, "client_aborted");

  const health = await healthOf(router);
  assert.ok(!health.coolingTargets.some((r) => r.provider === "gemini"), "an aborted attempt is not cooled");
  assert.ok(health.rankedTargets.some((r) => r.provider === "gemini"), "the aborted target stays eligible");
});
