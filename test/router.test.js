import test from "node:test";
import assert from "node:assert/strict";
import { buildTargets, isProviderConfigured, loadConfig } from "../src/config.js";
import {
  RouteSession,
  isRetryableStatus,
  withFallback
} from "../src/router.js";
import { HealthRegistry, refreshAllHealth } from "../src/health.js";

test("retryable statuses include quota/rate-limit/server failures", () => {
  for (const code of [402, 408, 429, 500, 502, 503, 504]) {
    assert.equal(isRetryableStatus(code), true);
  }
});

test("401 and 403 are not retryable by default", () => {
  assert.equal(isRetryableStatus(401), false);
  assert.equal(isRetryableStatus(403), false);
});

test("fallback uses best health first and then next best target", async () => {
  const targets = [
    { provider: "a", model: "m1", keyIndex: 0 },
    { provider: "b", model: "m2", keyIndex: 0 },
    { provider: "c", model: "m3", keyIndex: 0 }
  ];
  const health = new HealthRegistry({ cooldownMs: 900000 });
  health.markSuccess(targets[0], {}, Date.now());
  health.markSuccess(targets[1], {}, Date.now());
  health.markSuccess(targets[1], {}, Date.now());
  health.markSuccess(targets[2], {}, Date.now());
  health.markSuccess(targets[2], {}, Date.now());
  health.markSuccess(targets[2], {}, Date.now());

  const tried = [];
  const result = await withFallback(
    targets,
    async (target) => {
      tried.push(target.provider);
      if (target.provider === "c") {
        const e = new Error("quota");
        e.status = 402;
        throw e;
      }
      return target.provider;
    },
    undefined,
    new RouteSession(),
    health
  );

  assert.equal(result, "b");
  assert.deepEqual(tried, ["c", "b"]);
  assert.equal(health.ensure(targets[2]).status, "failed");
  assert.ok(health.ensure(targets[2]).cooldownUntil > Date.now());
});

test("failed key is cooled down without disabling sibling keys", async () => {
  const targets = [
    { provider: "gemini", model: "model-a", keyIndex: 0 },
    { provider: "gemini", model: "model-a", keyIndex: 1 }
  ];
  const health = new HealthRegistry({ cooldownMs: 900000 });
  health.markSuccess(targets[0], {}, Date.now());
  health.markSuccess(targets[1], {}, Date.now());
  health.markSuccess(targets[1], {}, Date.now());

  const result = await withFallback(
    targets,
    async (target) => {
      if (target.keyIndex === 1) return "key2";
      const e = new Error("rate limited");
      e.status = 429;
      throw e;
    },
    undefined,
    new RouteSession(),
    health
  );

  assert.equal(result, "key2");
  assert.equal(health.ensure(targets[0]).status, "failed");
  assert.equal(health.ensure(targets[1]).status, "healthy");
});

test("sticky session starts from the last successful target", async () => {
  const targets = [
    { provider: "a", model: "m1", keyIndex: 0 },
    { provider: "b", model: "m2", keyIndex: 0 },
    { provider: "c", model: "m3", keyIndex: 0 }
  ];
  const health = new HealthRegistry();
  const session = new RouteSession();

  await withFallback(targets, async (target) => target.provider === "b" ? "b" : (() => {
    const e = new Error("fail");
    e.status = 429;
    throw e;
  })(), undefined, session, health);

  // b remains the sticky starting target on the next request.
  const tried = [];
  await withFallback(targets, async (target) => {
    tried.push(target.provider);
    return "ok";
  }, undefined, session, health);

  assert.equal(tried[0], "b");
});

test("provider is invalid when any required field is missing", () => {
  assert.equal(isProviderConfigured({
    apiKeys: ["k"], models: ["m"], baseUrl: "https://x.test"
  }), true);
  assert.equal(isProviderConfigured({
    apiKeys: [], models: ["m"], baseUrl: "https://x.test"
  }), false);
  assert.equal(isProviderConfigured({
    apiKeys: ["k"], models: [], baseUrl: "https://x.test"
  }), false);
  assert.equal(isProviderConfigured({
    apiKeys: ["k"], models: ["m"], baseUrl: ""
  }), false);
});

test("incomplete providers produce no fallback targets", () => {
  const config = loadConfig({
    AGENTROUTER_API_KEYS: "key1,key2",
    AGENTROUTER_MODELS: "model1,model2",
    AGENTROUTER_BASE_URL: "https://example.test",
    GEMINI_API_KEYS: "key",
    GEMINI_MODELS: "",
    GEMINI_BASE_URL: "https://example.test"
  });
  const targets = buildTargets(config.providers);
  assert.equal(targets.some((t) => t.provider === "agentrouter"), true);
  assert.equal(targets.some((t) => t.provider === "gemini"), false);
  assert.equal(targets.length, 4);
});

test("health refresh checks every configured key/model target", async () => {
  const targets = [
    { provider: "a", model: "m1", keyIndex: 0 },
    { provider: "a", model: "m1", keyIndex: 1 },
    { provider: "b", model: "m2", keyIndex: 0 }
  ];
  const checked = [];
  const results = await refreshAllHealth(targets, async (target) => {
    checked.push(targetId(target));
    return { ok: true, status: 200, latencyMs: 10 };
  });

  assert.equal(results.length, 3);
  assert.equal(checked.length, 3);
  assert.equal(new Set(checked).size, 3);
});

function targetId(target) {
  return `${target.provider}:${target.model}:key-${target.keyIndex}`;
}
