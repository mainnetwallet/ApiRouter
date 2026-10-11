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
