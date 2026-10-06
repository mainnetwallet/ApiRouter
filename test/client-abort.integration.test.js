import test from "node:test";
import assert from "node:assert/strict";
import { startMockUpstream } from "../test-helpers/mock-upstream.js";
import { startRouter, postJson } from "../test-helpers/router-harness.js";

/**
 * A client that walks away ends the walk.
 *
 * Before the abort wiring the proxy only noticed a disconnect between plan
 * steps, so an aborted request kept invoking providers - spending quota for a
 * response nobody could receive - and an aborted in-flight attempt was charged
 * to the provider as a failure.
 */

const body = { model: "m", messages: [{ role: "user", content: "hi" }] };
const chatOk = () => ({
  status: 200,
  body: {
    id: "c1", object: "chat.completion", created: 0, model: "u",
    choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
  }
});

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
const healthOf = async (router) => (await (await router.request("/health")).json());

test("aborting an in-flight attempt stops the walk and is not a provider failure", async (t) => {
  const groq = await startMockUpstream(() => ({ hang: true }));
  const openrouter = await startMockUpstream(() => chatOk());
  const router = await startRouter({
    GROQ_API_KEYS: "k1", GROQ_MODELS: "m", GROQ_BASE_URL: groq.baseUrl,
    OPENROUTER_API_KEYS: "o1", OPENROUTER_MODELS: "m", OPENROUTER_BASE_URL: openrouter.baseUrl
  });
  t.after(async () => { await router.close(); await groq.close(); await openrouter.close(); });

  const controller = new AbortController();
  const pending = router.request("/v1/chat/completions", { ...postJson(body), signal: controller.signal }).catch((error) => error);
  assert.ok(await waitUntil(() => groq.apiRequests.length === 1), "the first target was called");
  controller.abort();
  await pending;

  assert.ok(await waitUntil(async () => (await entries(router)).length === 1), "the abort was recorded");
  assert.equal(openrouter.apiRequests.length, 0, "no further target was invoked after the client left");
  const [entry] = await entries(router);
  assert.equal(entry.httpStatus, 499);
  assert.equal(entry.outcome, "failed");
  assert.equal(entry.errorType, "client_aborted");
  assert.ok(!(await healthOf(router)).coolingTargets.some((r) => r.provider === "groq"), "an aborted attempt is not cooled");
});

test("an abort during fallback does not reach the next provider", async (t) => {
  // groq answers 500 (a real, cooling failure), openrouter hangs, cerebras must
  // never be called because the client leaves while openrouter is in flight.
  const groq = await startMockUpstream(() => ({ status: 500, body: { error: { message: "boom" } } }));
  const openrouter = await startMockUpstream(() => ({ hang: true }));
  const cerebras = await startMockUpstream(() => chatOk());
  const router = await startRouter({
    GROQ_API_KEYS: "k1", GROQ_MODELS: "m", GROQ_BASE_URL: groq.baseUrl,
    OPENROUTER_API_KEYS: "o1", OPENROUTER_MODELS: "m", OPENROUTER_BASE_URL: openrouter.baseUrl,
    CEREBRAS_API_KEYS: "c1", CEREBRAS_MODELS: "m", CEREBRAS_BASE_URL: cerebras.baseUrl
  });
  t.after(async () => { await router.close(); await groq.close(); await openrouter.close(); await cerebras.close(); });

  const controller = new AbortController();
  const pending = router.request("/v1/chat/completions", { ...postJson(body), signal: controller.signal }).catch((error) => error);
  assert.ok(await waitUntil(() => openrouter.apiRequests.length === 1), "the walk reached the second target");
  controller.abort();
  await pending;

  assert.ok(await waitUntil(async () => (await entries(router)).length === 1), "the abort was recorded");
  assert.equal(cerebras.apiRequests.length, 0, "the client left, so the third provider was never called");
  const [entry] = await entries(router);
  assert.equal(entry.httpStatus, 499);
  assert.equal(entry.errorType, "client_aborted");

  const health = await healthOf(router);
  assert.ok(health.coolingTargets.some((r) => r.provider === "groq"), "the real 500 still cooled its target");
  assert.ok(health.rankedTargets.some((r) => r.provider === "openrouter"), "the aborted target stays eligible");
});
