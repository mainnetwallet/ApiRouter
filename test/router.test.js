import test from "node:test";
import assert from "node:assert/strict";
import { buildTargets, isProviderConfigured, loadConfig } from "../src/config.js";
import {
  RouteSession,
  SessionStore,
  isRetryableStatus,
  withFallback
} from "../src/router.js";
import { HealthRegistry, refreshAllHealth, healthRegistry } from "../src/health.js";

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
  assert.equal(health.ensureTarget(targets[2]).status, "failed");
  assert.ok(health.ensureTarget(targets[2]).cooldownUntil > Date.now());
});

test("failed key is cooled down without disabling sibling keys", async () => {
  const targets = [
    { provider: "gemini", model: "model-a", keyIndex: 0 },
    { provider: "gemini", model: "model-a", keyIndex: 1 }
  ];
  const health = new HealthRegistry({ cooldownMs: 900000 });
  // Rank key-0 first so the failing key is the one the router reaches first.
  health.markSuccess(targets[0], {}, Date.now());
  health.markSuccess(targets[0], {}, Date.now());
  health.markSuccess(targets[1], {}, Date.now());

  const tried = [];
  const result = await withFallback(
    targets,
    async (target) => {
      tried.push(target.keyIndex);
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
  assert.deepEqual(tried, [0, 1]);
  assert.equal(health.ensureTarget(targets[0]).status, "failed");
  assert.equal(health.ensureTarget(targets[1]).status, "healthy");
  // The failed key is cooled down, but its sibling stays routable.
  assert.equal(health.isAvailable(targets[0]), false);
  assert.equal(health.isAvailable(targets[1]), true);
  assert.ok(health.ensureTarget(targets[0]).cooldownUntil > Date.now());
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

  assert.equal(tried[0], "b");});

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

// Regression: the sticky target was used as the loop's *starting index*, so a
// failing sticky target abandoned every better-ranked healthy target and the
// request failed with 502 while usable targets remained.
test("a failing sticky target does not abandon better-ranked healthy targets", async () => {
  const targets = [
    { provider: "a", model: "m1", keyIndex: 0 },
    { provider: "b", model: "m2", keyIndex: 0 },
    { provider: "c", model: "m3", keyIndex: 0 }
  ];
  const health = new HealthRegistry({ cooldownMs: 900000 });

  // a and b end up ranked above c.
  health.markSuccess(targets[0], {}, Date.now());
  health.markSuccess(targets[0], {}, Date.now());
  health.markSuccess(targets[0], {}, Date.now());
  health.markSuccess(targets[1], {}, Date.now());
  health.markSuccess(targets[1], {}, Date.now());
  health.markSuccess(targets[2], {}, Date.now());

  assert.deepEqual(health.rank(targets).map((t) => t.provider), ["a", "b", "c"]);

  // c was the last successful target for this session.
  const session = new RouteSession();
  session.saveSuccess(targets[2], health);

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
    session,
    health
  );

  assert.equal(result, "a");
  assert.deepEqual(tried, ["c", "a"]);
});

test("routing never retries a target that already failed in the same request", async () => {
  const targets = [
    { provider: "a", model: "m1", keyIndex: 0 },
    { provider: "b", model: "m2", keyIndex: 0 }
  ];
  const health = new HealthRegistry({ cooldownMs: 900000 });

  const tried = [];
  await withFallback(
    targets,
    async (target) => {
      tried.push(target.provider);
      const e = new Error("nope");
      e.status = 503;
      throw e;
    },
    undefined,
    new RouteSession(),
    health
  ).catch(() => {});

  assert.deepEqual(tried, ["a", "b"]);
  assert.equal(new Set(tried).size, tried.length);
});

test("a non-retryable failure stops routing immediately", async () => {
  const targets = [
    { provider: "a", model: "m1", keyIndex: 0 },
    { provider: "b", model: "m2", keyIndex: 0 }
  ];
  const health = new HealthRegistry({ cooldownMs: 900000 });
  const session = new RouteSession();

  const tried = [];
  await assert.rejects(
    () => withFallback(
      targets,
      async (target) => {
        tried.push(target.provider);
        const e = new Error("unauthorized");
        e.status = 401;
        throw e;
      },
      undefined,
      session,
      health
    ),
    (error) => error.status === 401
  );

  assert.deepEqual(tried, ["a"]);
  // A non-retryable failure must not cool the target down.
  assert.equal(health.isAvailable(targets[0]), true);
});

test("cooldown expiry makes a target routable again", async () => {
  const target = { provider: "a", model: "m1", keyIndex: 0 };
  const health = new HealthRegistry({ cooldownMs: 1000 });
  const t0 = Date.now();

  health.markFailure(target, 429, {}, t0);
  assert.equal(health.isAvailable(target, t0 + 500), false);
  assert.equal(health.isAvailable(target, t0 + 1500), true);
});

test("ranking excludes cooled-down targets but keeps sibling keys", () => {
  const key0 = { provider: "gemini", model: "m", keyIndex: 0 };
  const key1 = { provider: "gemini", model: "m", keyIndex: 1 };
  const health = new HealthRegistry({ cooldownMs: 60000 });

  health.markFailure(key0, 429);

  assert.deepEqual(health.rank([key0, key1]), [key1]);
  assert.equal(health.isAvailable(key1), true);
});

test("health refreshes recover a cooled-down target", async (t) => {
  const target = { provider: "probe", model: "recover", keyIndex: 0 };
  t.after(() => healthRegistry.states.delete("probe:recover:key-0"));

  healthRegistry.markFailure(target, 503);
  assert.equal(healthRegistry.isAvailable(target), false);

  await refreshAllHealth([target], async () => ({ ok: true, status: 200 }));

  assert.equal(healthRegistry.isAvailable(target), true);
  assert.equal(healthRegistry.get("probe:recover:key-0").status, "healthy");
});

test("a failed health check records the provider status", async (t) => {
  const target = { provider: "probe", model: "down", keyIndex: 0 };
  t.after(() => healthRegistry.states.delete("probe:down:key-0"));

  await refreshAllHealth([target], async () => ({ ok: false, status: 500 }));

  const state = healthRegistry.get("probe:down:key-0");
  assert.equal(state.status, "failed");
  assert.equal(state.lastStatus, 500);
});

test("a health check that throws cools the target down", async (t) => {
  t.after(() => healthRegistry.states.delete("probe:throwing:key-0"));

  const target = { provider: "probe", model: "throwing", keyIndex: 0 };
  const results = await refreshAllHealth([target], async () => {
    const error = new Error("connection refused");
    error.status = 503;
    throw error;
  });

  assert.equal(results[0].error, "connection refused");
  assert.equal(healthRegistry.get("probe:throwing:key-0").status, "failed");
  assert.equal(healthRegistry.get("probe:throwing:key-0").lastStatus, 503);
});

test("session store bounds client-supplied sessions and evicts the least recent", () => {
  const store = new SessionStore({ maxEntries: 2 });

  store.set("a", { id: "a" });
  store.set("b", { id: "b" });

  // Touch "a" so "b" becomes the least recently used entry.
  assert.deepEqual(store.get("a"), { id: "a" });

  store.set("c", { id: "c" });

  assert.equal(store.size, 2);
  assert.deepEqual(store.get("a"), { id: "a" });
  assert.equal(store.get("b"), null);
  assert.deepEqual(store.get("c"), { id: "c" });
});

test("session store is empty until a session is used", () => {
  const store = new SessionStore();
  assert.equal(store.get("missing"), null);
  assert.equal(store.size, 0);
});

function targetId(target) {
  return `${target.provider}:${target.model}:key-${target.keyIndex}`;
}

// ---------------------------------------------------------------------------
// Known gap: exact-model preference is not guaranteed at runtime
// ---------------------------------------------------------------------------

/**
 * `selectGeminiTargets` (like the other bridges' selectors) returns the exact
 * model match first, and `describeRouting` reports that order. `withFallback`
 * does not preserve it: it re-ranks by health score, and a sticky session can
 * promote an older target ahead of it. A target that failed once and has since
 * left cooldown sits at score 25 while an untouched target sits at 50, so the
 * request is served by the wrong model even though the exact match is available.
 *
 * Marked `todo` because this is a routing-policy decision, not a defect in the
 * bridge: fixing it means either ranking exact matches ahead of score or
 * dropping the "exact match is tried first" promise. Either way it changes
 * behaviour for every client protocol, so it needs a product call.
 */
test("an available exact model match is tried first even when a fallback scores higher", { todo: true }, async () => {
  const exact = { provider: "p1", model: "model-A", keyIndex: 0, protocols: ["openai-chat"] };
  const other = { provider: "p2", model: "model-B", keyIndex: 0, protocols: ["openai-chat"] };

  const health = new HealthRegistry();
  health.markFailure(exact, 500, { cooldownMs: -1 }); // failed once; cooldown has elapsed

  const attempted = [];
  await withFallback(
    [exact, other],
    async (target) => { attempted.push(target.model); return {}; },
    new Set([500]),
    new RouteSession(),
    health
  );

  assert.equal(attempted[0], "model-A");
});
