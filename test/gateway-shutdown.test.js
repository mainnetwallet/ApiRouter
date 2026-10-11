import test from "node:test";
import assert from "node:assert/strict";
import { startMockUpstream } from "../test-helpers/mock-upstream.js";
import { startRouter, postJson } from "../test-helpers/router-harness.js";
import { GatewayState } from "../src/gateway-state.js";

const chat = JSON.stringify({ model: "m", messages: [{ role: "user", content: "hi" }] });

test("GatewayState pauses and resumes", () => {
  const state = new GatewayState();
  assert.equal(state.snapshot().state, "running");
  assert.equal(state.pause("x", 1000).paused, true);
  assert.equal(state.snapshot(4000).pausedForMs, 3000);
  assert.equal(state.resume().state, "running");
});

test("shutdown blocks every upstream call and resume restores routing", async () => {
  const mock = await startMockUpstream(() => ({ status: 200, body: { choices: [{ message: { role: "assistant", content: "ok" } }] } }));
  const router = await startRouter({
    GROQ_API_KEYS: "k0",
    GROQ_MODELS: "m",
    GROQ_BASE_URL: `${mock.baseUrl}/v1`
  });
  try {
    const before = await router.request("/v1/chat/completions", postJson(chat));
    assert.equal(before.status, 200);

    const shut = await router.request("/api/gateway/shutdown", { method: "POST" });
    assert.equal(shut.status, 200);
    assert.equal((await shut.json()).state, "paused");

    const upstreamBefore = mock.requests.length;
    const blocked = await router.request("/v1/chat/completions", postJson(chat));
    assert.equal(blocked.status, 503);
    assert.equal((await blocked.json()).error.type, "gateway_paused");
    const refresh = await router.request("/api/health/refresh", { method: "POST" });
    assert.equal(refresh.status, 409);
    assert.equal(mock.requests.length, upstreamBefore, "an upstream call happened while paused");

    // The admin API stays reachable and reports the state.
    const status = await (await router.request("/api/gateway")).json();
    assert.equal(status.paused, true);
    assert.equal((await (await router.request("/api/system")).json()).gateway.paused, true);

    const resumed = await router.request("/api/gateway/resume", { method: "POST" });
    assert.equal((await resumed.json()).state, "running");
    const after = await router.request("/v1/chat/completions", postJson(chat));
    assert.equal(after.status, 200);
  } finally {
    await router.close();
    await mock.close();
  }
});

test("shutdown during a fallback walk stops the next upstream attempt", async () => {
  let router;
  let upstreamCalls = 0;
  const mock = await startMockUpstream(() => {
    upstreamCalls += 1;
    // The operator hits Shutdown while the first attempt is still in flight;
    // that attempt then fails, so the router would normally try the next key.
    void router.request("/api/gateway/shutdown", { method: "POST" });
    return { status: 500, afterMs: 300, body: { error: { message: "boom" } } };
  });
  router = await startRouter({
    GROQ_API_KEYS: "k0,k1",
    GROQ_MODELS: "m",
    GROQ_BASE_URL: `${mock.baseUrl}/v1`
  });
  try {
    const res = await router.request("/v1/chat/completions", postJson(chat));
    assert.equal(res.status, 503);
    assert.equal((await res.json()).error.type, "gateway_paused");
    assert.equal(upstreamCalls, 1, "fallback must not try another key after shutdown");
  } finally {
    await router.close();
    await mock.close();
  }
});

test("a running health cycle stops between targets once told to", async () => {
  const { refreshAllHealth } = await import("../src/health.js");
  let stop = false;
  const checked = [];
  const targets = [{ id: "a" }, { id: "b" }, { id: "c" }];
  await refreshAllHealth(
    targets,
    async (t) => { checked.push(t.id); stop = true; return { ok: true }; },
    { concurrency: 1, shouldStop: () => stop }
  );
  assert.deepEqual(checked, ["a"]);
});
