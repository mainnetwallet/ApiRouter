import test from "node:test";
import assert from "node:assert/strict";
import { startMockUpstream } from "../test-helpers/mock-upstream.js";
import { startRouter, postJson } from "../test-helpers/router-harness.js";

/**
 * A NON-streamed attempt is settled by its BODY, not by its headers.
 *
 * `fetch` resolves on headers, so an upstream 200 used to be logged as a
 * SUCCESS attempt immediately, even when the body then truncated, stalled or
 * could not be parsed - leaving an `ok` attempt row next to a failed request
 * row. The contract pinned here, for both the pass-through path and the
 * translated path:
 *   - complete body            -> attempt ok, request success
 *   - truncated / stalled body -> attempt FAILED (502), request failed, target cooled
 *   - client leaves mid-body   -> attempt FAILED as a client abort (no status),
 *                                 request 499 client_aborted, target NOT cooled
 */

const IDLE_MS = 300;
const chatBody = { model: "m", messages: [{ role: "user", content: "hi" }] };
const anthropicBody = { model: "m", max_tokens: 16, messages: [{ role: "user", content: "hi" }] };
const PARTIAL = '{"id":"c1","choices":[{"index":0,';
const completeReply = {
  status: 200,
  body: {
    id: "c1", object: "chat.completion", created: 0, model: "u",
    choices: [{ index: 0, message: { role: "assistant", content: "served" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
  }
};
const truncated = {
  status: 200,
  headers: { "content-type": "application/json", "content-length": "4096" },
  truncateBody: true,
  partialBody: PARTIAL
};
const stalled = {
  status: 200,
  headers: { "content-type": "application/json", "content-length": "4096" },
  stallBody: true,
  partialBody: PARTIAL
};

const PATHS = [
  { name: "pass-through (OpenAI client -> OpenAI target)", path: "/v1/chat/completions", body: chatBody },
  { name: "translated (Anthropic client -> OpenAI target)", path: "/v1/messages", body: anthropicBody }
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitUntil(predicate, { timeoutMs = 4000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await sleep(20);
  }
  return false;
}
const entries = async (router) => (await (await router.request("/api/requests")).json()).entries;
const healthOf = async (router) => (await router.request("/health")).json();

async function boot(t, script, env = {}) {
  const groq = await startMockUpstream(script);
  const router = await startRouter({
    GROQ_API_KEYS: "k1", GROQ_MODELS: "m", GROQ_BASE_URL: groq.baseUrl,
    STREAM_IDLE_TIMEOUT_MS: String(IDLE_MS),
    ...env
  });
  t.after(async () => { await router.close(); await groq.close(); });
  return { groq, router };
}

for (const { name, path, body } of PATHS) {
  test(`${name}: a complete body settles the attempt as SUCCESS`, async (t) => {
    const { router } = await boot(t, () => completeReply);

    const res = await router.request(path, postJson(body));
    await res.text();
    assert.equal(res.status, 200);

    const [entry] = await entries(router);
    assert.equal(entry.outcome, "success");
    assert.equal(entry.attempts.length, 1);
    assert.equal(entry.attempts[0].ok, true);
    assert.equal(entry.attempts[0].status, 200);
    assert.ok((await healthOf(router)).rankedTargets.some((r) => r.provider === "groq"), "the target stays healthy");
  });

  test(`${name}: a truncated body settles the attempt as FAILED`, async (t) => {
    const { router } = await boot(t, () => truncated);

    const res = await router.request(path, postJson(body));
    await res.text();
    assert.equal(res.status, 502);

    const [entry] = await entries(router);
    assert.equal(entry.outcome, "failed");
    assert.equal(entry.httpStatus, 502);
    assert.equal(entry.attempts.length, 1);
    assert.equal(entry.attempts[0].ok, false, "headers alone never made this attempt a success");
    assert.equal(entry.attempts[0].status, entry.httpStatus, "attempt and request log agree on the status");
    assert.ok(entry.attempts[0].errorMessage, "the failure reason is recorded on the attempt");
    assert.ok(!(await healthOf(router)).rankedTargets.some((r) => r.provider === "groq"), "the target is cooled");
  });

  test(`${name}: a body timeout settles the attempt as FAILED`, async (t) => {
    const { router } = await boot(t, () => stalled);

    const res = await router.request(path, { ...postJson(body), signal: AbortSignal.timeout(5000) });
    await res.text();
    assert.equal(res.status, 502);

    const [entry] = await entries(router);
    assert.equal(entry.outcome, "failed");
    assert.equal(entry.httpStatus, 502);
    assert.equal(entry.attempts.length, 1);
    assert.equal(entry.attempts[0].ok, false);
    assert.equal(entry.attempts[0].status, entry.httpStatus);
    assert.ok(!(await healthOf(router)).rankedTargets.some((r) => r.provider === "groq"), "the stalled target is cooled");
  });

  test(`${name}: a client abort mid-body is client-aborted, not a provider failure`, async (t) => {
    // The idle bound is far above the test, so only the client can end the read.
    const { groq, router } = await boot(t, () => stalled, { STREAM_IDLE_TIMEOUT_MS: "30000" });

    const controller = new AbortController();
    const pending = router.request(path, { ...postJson(body), signal: controller.signal }).catch((error) => error);
    assert.ok(await waitUntil(() => groq.apiRequests.length === 1), "the upstream was reached");
    await sleep(200); // the upstream headers and prefix are in; the body is now being read
    controller.abort();
    await pending;

    assert.ok(await waitUntil(async () => (await entries(router)).length === 1), "the abort was recorded");
    const [entry] = await entries(router);
    assert.equal(entry.outcome, "failed");
    assert.equal(entry.httpStatus, 499);
    assert.equal(entry.errorType, "client_aborted");
    assert.equal(entry.attempts.length, 1);
    assert.equal(entry.attempts[0].ok, false, "never a success attempt");
    assert.equal(entry.attempts[0].status, null, "no provider status is charged for a client that left");
    assert.match(entry.attempts[0].errorMessage, /client disconnected/i);
    const health = await healthOf(router);
    assert.ok(!health.coolingTargets.some((r) => r.provider === "groq"), "a client abort does not cool the provider");
  });
}
