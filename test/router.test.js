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
import { fallbackGroups } from "../src/observability/route-select.js";
import { describeRouting } from "../src/observability/router-preview.js";

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
// Exact-model-first routing
// ---------------------------------------------------------------------------

const target = (provider, model) => ({ provider, model, keyIndex: 0, protocols: ["openai-chat"] });

/** The selection shape every bridge selector returns, for a request for `model`. */
function selectionFor(targets, model) {
  const exact = targets.filter((t) => t.model === model);
  const rest = targets.filter((t) => t.model !== model);
  return {
    modelMatched: exact.length > 0,
    compatible: targets,
    exact,
    selected: exact.length > 0 ? [...exact, ...rest] : targets
  };
}

/**
 * Drives `withFallback` exactly as `src/server.js` does: the selector's `selected`
 * list is passed as the candidate set and `fallbackGroups(selection)` as the
 * tier plan.
 */
async function route(selection, { health, session = new RouteSession(), invoke } = {}) {
  const attempted = [];
  const result = await withFallback(
    selection.selected,
    invoke ?? (async (t) => {
      attempted.push(`${t.provider}:${t.model}`);
      return { target: t };
    }),
    new Set([500, 429, 502, 503, 504, 408, 402]),
    session,
    health,
    { groups: fallbackGroups(selection) }
  );
  return { attempted, result };
}

test("A: an available exact match is tried before a higher-scored fallback model", async () => {
  const exact = target("p1", "model-A");
  const fallback = target("p2", "model-B");
  const health = new HealthRegistry();
  // A failed once and has since left cooldown: it is available, but scores 25
  // against the untouched fallback's 50.
  health.markFailure(exact, 500, { cooldownMs: -1 });

  assert.ok(health.isAvailable(exact), "the exact target must be available for this to prove anything");
  assert.ok(
    health.ensureTarget(exact).score < health.ensureTarget(fallback).score,
    "the fallback must out-score the exact match for this test to mean anything"
  );

  const { attempted } = await route(selectionFor([exact, fallback], "model-A"), { health });

  assert.deepEqual(attempted, ["p1:model-A"]);
});

test("B: a sticky fallback target does not preempt an available exact match", async () => {
  const exact = target("p1", "model-A");
  const fallback = target("p2", "model-B");
  const health = new HealthRegistry();
  health.markSuccess(fallback, {}); // healthy *and* the session's last success
  const session = new RouteSession({ targetId: health.key(fallback) });

  const { attempted } = await route(selectionFor([exact, fallback], "model-A"), { health, session });

  assert.deepEqual(attempted, ["p1:model-A"]);
});

test("C: health ranking still orders the targets inside the exact-match group", async () => {
  const slow = target("p1", "model-A");
  const fast = target("p2", "model-A");
  const fallback = target("p3", "model-B");
  const health = new HealthRegistry();
  health.markSuccess(fast, {}); // 62.5 against the others' 50

  const { attempted } = await route(selectionFor([slow, fast, fallback], "model-A"), { health });

  assert.deepEqual(attempted, ["p2:model-A"]);
});

test("D: a different model is attempted only after every exact target has failed", async () => {
  const exactOne = target("p1", "model-A");
  const exactTwo = target("p2", "model-A");
  const fallback = target("p3", "model-B");
  const health = new HealthRegistry();
  // The fallback is the healthiest target of the three; it still must wait for
  // both exact matches.
  health.markSuccess(fallback, {});
  const attempted = [];

  const { result } = await route(selectionFor([exactOne, exactTwo, fallback], "model-A"), {
    health,
    invoke: async (t) => {
      attempted.push(`${t.provider}:${t.model}`);
      if (t.model === "model-A") {
        const error = new Error("upstream is busy");
        error.status = 500;
        throw error;
      }
      return { target: t };
    }
  });

  assert.deepEqual(attempted, ["p1:model-A", "p2:model-A", "p3:model-B"]);
  assert.equal(result.target.model, "model-B");
  // Both exact targets burned a failure and were cooled down; the fallback was not.
  assert.equal(health.isAvailable(exactOne), false);
  assert.equal(health.isAvailable(exactTwo), false);
  assert.equal(health.isAvailable(fallback), true);
});

test("E: the routing preview shows the order the runtime actually walks", async () => {
  const exact = target("p1", "model-A");
  const fallback = target("p2", "model-B");
  const health = new HealthRegistry();
  health.markFailure(exact, 500, { cooldownMs: -1 });
  health.markSuccess(fallback, {});
  const session = new RouteSession({ targetId: health.key(fallback) });

  const selection = selectionFor([exact, fallback], "model-A");
  const { attempted } = await route(selection, { health, session });

  const preview = describeRouting({
    targets: selection.compatible,
    health,
    protocol: "openai-chat",
    model: "model-A",
    stickyTargetId: health.key(fallback)
  });

  assert.deepEqual(attempted, ["p1:model-A"]);
  // The preview queues the exact match first and only then the fallback — the
  // same order the runtime walks. It is a superset of `attempted`, which stops
  // at the first success.
  assert.equal(preview.fallbackOrder[0].provider, "p1");
  assert.deepEqual(
    preview.fallbackOrder.map((c) => `${c.provider}:${c.model}`).slice(0, attempted.length),
    attempted
  );
  assert.equal(preview.selected.provider, "p1");
});

test("a cooled-down exact match yields to the fallback tier", async () => {
  const exact = target("p1", "model-A");
  const fallback = target("p2", "model-B");
  const health = new HealthRegistry();
  health.markFailure(exact, 500); // full cooldown: unavailable right now

  const { attempted } = await route(selectionFor([exact, fallback], "model-A"), { health });

  assert.deepEqual(attempted, ["p2:model-B"]);
});

test("with groups omitted, the whole target list is one tier", async () => {
  const a = target("p1", "model-A");
  const b = target("p2", "model-B");
  const health = new HealthRegistry();
  health.markFailure(a, 500, { cooldownMs: -1 });

  const attempted = [];
  await withFallback([a, b], async (t) => { attempted.push(t.model); return {}; }, new Set([500]), new RouteSession(), health);

  // No grouping was requested, so ranking alone decides — the pre-grouping behaviour.
  assert.deepEqual(attempted, ["model-B"]);
});
