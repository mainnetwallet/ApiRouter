import test from "node:test";
import assert from "node:assert/strict";
import {
  HEALTH_STATES,
  HealthRegistry,
  describeHealth,
  healthRegistry,
  healthState,
  refreshAllHealth,
  startHealthMonitor
} from "../src/health.js";

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const target = (overrides = {}) => ({
  provider: "p", model: "m", keyIndex: 0, protocols: ["openai-chat"], ...overrides
});

// ---------------------------------------------------------------------------
// States
// ---------------------------------------------------------------------------

test("a target starts unknown and becomes healthy or cooldown", () => {
  const registry = new HealthRegistry({ cooldownMs: 60000 });
  const t0 = Date.now();
  const one = target({ model: "one" });

  assert.equal(healthState(registry.ensureTarget(one), t0), HEALTH_STATES.UNKNOWN);

  registry.markSuccess(one, {}, t0);
  assert.equal(healthState(registry.ensureTarget(one), t0), HEALTH_STATES.HEALTHY);

  registry.markFailure(one, 429, {}, t0);
  assert.equal(healthState(registry.ensureTarget(one), t0), HEALTH_STATES.COOLDOWN);
  // Once the cooldown lapses the outcome is visible again.
  assert.equal(healthState(registry.ensureTarget(one), t0 + 60001), HEALTH_STATES.FAILED);
});

test("status reports the outcome while cooldownUntil tracks availability", () => {
  const registry = new HealthRegistry({ cooldownMs: 60000 });
  const t = target();
  const now = Date.now();

  registry.markFailure(t, 503, {}, now);

  // Routing reads these; reporting derives `cooldown` from them.
  assert.equal(registry.ensureTarget(t).status, HEALTH_STATES.FAILED);
  assert.equal(registry.isAvailable(t, now), false);
  assert.equal(registry.isAvailable(t, now + 60001), true);
});

// ---------------------------------------------------------------------------
// Stale observations (cooldown preservation)
// ---------------------------------------------------------------------------

test("an older health-check success cannot clear a newer routing failure", () => {
  const registry = new HealthRegistry({ cooldownMs: 900000 });
  const t = target();

  const probeStartedAt = 1000;
  // The routing failure is observed after the probe started...
  registry.markFailure(t, 429, {}, probeStartedAt + 50);
  const cooldownUntil = registry.ensureTarget(t).cooldownUntil;
  const failures = registry.ensureTarget(t).failures;

  // ...but the slow probe's success lands afterwards and must be ignored.
  registry.recordHealthCheck(t, { ok: true, status: 200 }, probeStartedAt);

  const state = registry.ensureTarget(t);
  assert.equal(state.cooldownUntil, cooldownUntil, "cooldown was cleared by a stale success");
  assert.equal(state.status, HEALTH_STATES.FAILED);
  assert.equal(state.successes, 0, "stale success was counted");
  assert.equal(state.failures, failures);
  assert.equal(state.consecutiveFailures, 1);
  assert.equal(registry.isAvailable(t, probeStartedAt + 60), false);
});

test("an older routing failure cannot overwrite a newer health-check success", () => {
  const registry = new HealthRegistry({ cooldownMs: 900000 });
  const t = target();

  registry.markSuccess(t, {}, 5000);
  registry.markFailure(t, 500, {}, 4000);

  const state = registry.ensureTarget(t);
  assert.equal(state.status, HEALTH_STATES.HEALTHY);
  assert.equal(state.cooldownUntil, 0);
  assert.equal(state.failures, 0);
});

test("a health-check success does NOT cut a routing cooldown short", () => {
  const registry = new HealthRegistry({ cooldownMs: 900000 });
  const t = target();

  registry.markFailure(t, 503, {}, 1000);
  assert.equal(registry.isAvailable(t, 2000), false);

  // The probe only proves the metadata endpoint answers; the chat failure that
  // caused the cooldown may well persist. Only the timer or a real success revives.
  registry.recordHealthCheck(t, { ok: true, status: 200 }, 2000);

  assert.equal(registry.isAvailable(t, 2000), false);
  assert.equal(registry.ensureTarget(t).status, HEALTH_STATES.FAILED);
  assert.equal(registry.ensureTarget(t).cooldownUntil, 1000 + 900000);
});

test("a health-check success after the cooldown has elapsed recovers the target", () => {
  const registry = new HealthRegistry({ cooldownMs: 900000 });
  const t = target();

  registry.markFailure(t, 503, {}, 1000);
  registry.recordHealthCheck(t, { ok: true, status: 200 }, 1000 + 900000 + 1);

  assert.equal(registry.isAvailable(t, 1000 + 900000 + 1), true);
  assert.equal(registry.ensureTarget(t).status, HEALTH_STATES.HEALTHY);
  assert.equal(registry.ensureTarget(t).cooldownUntil, 0);
});

test("a real routing success recovers a cooled-down target immediately", () => {
  const registry = new HealthRegistry({ cooldownMs: 900000 });
  const t = target();
  registry.markFailure(t, 503, {}, 1000);
  registry.markSuccess(t, { latencyMs: 5 }, 2000);
  assert.equal(registry.isAvailable(t, 2000), true);
});

test("the first observation is accepted regardless of its timestamp", () => {
  const registry = new HealthRegistry({ cooldownMs: 900000 });
  const t = target();

  registry.markFailure(t, 429, {}, 1);

  assert.equal(registry.ensureTarget(t).status, HEALTH_STATES.FAILED);
  assert.equal(registry.isAvailable(t, 2), false);
});

// ---------------------------------------------------------------------------
// Status / latency / counters
// ---------------------------------------------------------------------------

test("lastStatus records the status actually observed by the health check", () => {
  const registry = new HealthRegistry();
  const t = target();

  registry.recordHealthCheck(t, { ok: true, status: 204 }, Date.now());
  assert.equal(registry.ensureTarget(t).lastStatus, 204);

  const other = target({ model: "other" });
  registry.recordHealthCheck(other, { ok: false, status: 503 }, Date.now());
  assert.equal(registry.ensureTarget(other).lastStatus, 503);
});

test("latency and counters stay consistent across successes and failures", () => {
  const registry = new HealthRegistry({ cooldownMs: 60000 });
  const t = target();
  const now = Date.now();

  registry.markSuccess(t, { latencyMs: 12 }, now);
  assert.equal(registry.ensureTarget(t).latencyMs, 12);
  assert.equal(registry.ensureTarget(t).successes, 1);
  assert.equal(registry.ensureTarget(t).consecutiveFailures, 0);

  registry.markFailure(t, 429, {}, now + 1);
  registry.markFailure(t, 429, {}, now + 2);
  assert.equal(registry.ensureTarget(t).consecutiveFailures, 2);
  assert.equal(registry.ensureTarget(t).failures, 2);
  // A failure does not overwrite the last measured latency.
  assert.equal(registry.ensureTarget(t).latencyMs, 12);

  registry.markSuccess(t, { latencyMs: 30 }, now + 3);
  assert.equal(registry.ensureTarget(t).consecutiveFailures, 0);
  assert.equal(registry.ensureTarget(t).successes, 2);
  assert.equal(registry.ensureTarget(t).latencyMs, 30);
});

test("scores stay deterministic and bounded", () => {
  const registry = new HealthRegistry({ cooldownMs: 60000 });
  const t = target();
  let now = Date.now();

  assert.equal(registry.ensureTarget(t).score, 50);

  registry.markSuccess(t, {}, now);
  let previous = registry.ensureTarget(t).score;
  assert.equal(previous, 62.5);

  // Successes raise the score and never exceed the ceiling.
  for (let i = 0; i < 40; i += 1) {
    registry.markSuccess(t, {}, now += 1);
    const score = registry.ensureTarget(t).score;
    assert.ok(score >= previous, "score decreased after a success");
    assert.ok(score <= 100, "score exceeded the ceiling");
    previous = score;
  }
  assert.ok(previous > 99.9, "score did not converge towards the ceiling");

  // Failures drain it to the floor and never go below.
  for (let i = 0; i < 40; i += 1) {
    registry.markFailure(t, 500, {}, now += 1);
    const score = registry.ensureTarget(t).score;
    assert.ok(score <= previous, "score increased after a failure");
    assert.ok(score >= 0, "score fell below the floor");
    previous = score;
  }
  assert.equal(previous, 0);
});

test("the score is a deterministic function of the observation sequence", () => {
  const replay = () => {
    const registry = new HealthRegistry({ cooldownMs: 60000 });
    const t = target();
    let now = 1000;
    for (const outcome of [1, 1, 0, 1, 0, 0, 0, 1]) {
      if (outcome === 1) registry.markSuccess(t, {}, now += 1);
      else registry.markFailure(t, 500, {}, now += 1);
    }
    return registry.ensureTarget(t).score;
  };

  assert.equal(replay(), replay());
});

// ---------------------------------------------------------------------------
// Passive observations
// ---------------------------------------------------------------------------

test("a passive probe result never fabricates health", () => {
  const registry = new HealthRegistry({ cooldownMs: 60000 });
  const t = target();

  registry.recordHealthCheck(t, {
    ok: null,
    status: 404,
    reason: "probe endpoint not supported (HTTP 404)"
  }, Date.now());

  const state = registry.ensureTarget(t);
  assert.equal(state.status, HEALTH_STATES.UNKNOWN);
  assert.equal(state.successes, 0);
  assert.equal(state.failures, 0);
  assert.equal(state.cooldownUntil, 0);
  assert.equal(state.score, 50);
  assert.equal(state.lastStatus, null);
  assert.match(state.lastReason, /not supported/);
  assert.equal(registry.isAvailable(t), true);
});

test("a passive probe cannot overwrite a newer failure either", () => {
  const registry = new HealthRegistry({ cooldownMs: 60000 });
  const t = target();

  registry.markFailure(t, 429, {}, 5000);
  registry.recordHealthCheck(t, { ok: null, status: 404, reason: "stale" }, 4000);

  assert.equal(registry.ensureTarget(t).lastReason, null);
});

// ---------------------------------------------------------------------------
// Per-target isolation
// ---------------------------------------------------------------------------

test("a failed key does not affect its sibling keys", () => {
  const registry = new HealthRegistry({ cooldownMs: 60000 });
  const key0 = target({ model: "m", keyIndex: 0 });
  const key1 = target({ model: "m", keyIndex: 1 });
  const now = Date.now();

  registry.markFailure(key0, 401, {}, now);

  assert.equal(registry.ensureTarget(key1).status, HEALTH_STATES.UNKNOWN);
  assert.equal(registry.ensureTarget(key1).failures, 0);
  assert.equal(registry.isAvailable(key1, now), true);
  assert.deepEqual(registry.rank([key0, key1], now), [key1]);
});

test("a failed model does not affect another model of the same provider", () => {
  const registry = new HealthRegistry({ cooldownMs: 60000 });
  const a = target({ model: "model-a", keyIndex: 0 });
  const b = target({ model: "model-b", keyIndex: 0 });
  const now = Date.now();

  registry.markFailure(a, 500, {}, now);

  assert.equal(registry.isAvailable(b, now), true);
  assert.equal(registry.ensureTarget(b).status, HEALTH_STATES.UNKNOWN);
});

test("a failed provider does not affect other providers", () => {
  const registry = new HealthRegistry({ cooldownMs: 60000 });
  const a = target({ provider: "alpha" });
  const b = target({ provider: "beta" });
  const now = Date.now();

  registry.markFailure(a, 503, {}, now);

  assert.equal(registry.isAvailable(b, now), true);
});

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

test("describe() reports target detail without credentials and without raw bodies", () => {
  const registry = new HealthRegistry({ cooldownMs: 60000 });
  const t = {
    provider: "groq",
    model: "llama-x",
    keyIndex: 1,
    protocols: ["openai-chat"],
    apiKey: "super-secret-provider-key",
    baseUrl: "https://api.groq.com/openai/v1"
  };
  const now = Date.now();

  registry.markFailure(t, 429, { reason: "rate limited (HTTP 429)" }, now);
  const [entry] = registry.describe([t], now);

  assert.equal(entry.provider, "groq");
  assert.equal(entry.model, "llama-x");
  assert.equal(entry.keyIndex, 1);
  assert.deepEqual(entry.protocols, ["openai-chat"]);
  assert.equal(entry.status, HEALTH_STATES.COOLDOWN);
  assert.equal(entry.lastStatus, 429);
  assert.equal(entry.failures, 1);
  assert.ok(entry.cooldownUntil > now);
  assert.ok(Number.isFinite(entry.score));

  const serialized = JSON.stringify(entry);
  assert.ok(!serialized.includes(t.apiKey), "api key leaked into health report");
  assert.ok(!serialized.includes(t.baseUrl), "base URL leaked into health report");
  assert.equal(entry.apiKey, undefined);
});

test("the module describeHealth reports configured targets", () => {
  const t = target({ model: "described" });
  const entries = describeHealth([t], Date.now());

  assert.equal(entries.length, 1);
  assert.equal(entries[0].model, "described");
  assert.equal(entries[0].status, HEALTH_STATES.UNKNOWN);
});

// ---------------------------------------------------------------------------
// Refresh cycle
// ---------------------------------------------------------------------------

test("refreshAllHealth uses bounded concurrency and preserves target order", async () => {
  const registryBefore = healthRegistry.states.size;
  const targets = Array.from({ length: 6 }, (_, i) =>
    target({ provider: "conc", model: "model-" + i })
  );

  let inFlight = 0;
  let peak = 0;

  const results = await refreshAllHealth(targets, async () => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await delay(10);
    inFlight -= 1;
    return { ok: true, status: 200 };
  }, { concurrency: 2 });

  assert.equal(results.length, 6);
  assert.deepEqual(results.map((r) => r.target.model), targets.map((t) => t.model));
  assert.ok(peak <= 2, `expected at most 2 concurrent probes, saw ${peak}`);
  assert.equal(peak, 2, "expected the concurrency budget to actually be used");

  for (const t of targets) healthRegistry.states.delete(healthRegistry.key(t));
  assert.equal(healthRegistry.states.size, registryBefore);
});

test("one failing provider does not stop the others", async () => {
  const targets = [
    target({ provider: "iso", model: "good" }),
    target({ provider: "iso", model: "throwing" }),
    target({ provider: "iso", model: "also-good" })
  ];

  const results = await refreshAllHealth(targets, async (t) => {
    if (t.model === "throwing") {
      const error = new Error("connection refused");
      error.status = 503;
      throw error;
    }
    return { ok: true, status: 200 };
  });

  assert.equal(results.length, 3);
  assert.equal(healthRegistry.get("iso:good:key-0").status, HEALTH_STATES.HEALTHY);
  assert.equal(healthRegistry.get("iso:throwing:key-0").status, HEALTH_STATES.FAILED);
  assert.equal(healthRegistry.get("iso:also-good:key-0").status, HEALTH_STATES.HEALTHY);
  assert.equal(results[1].error, "connection refused");

  for (const t of targets) healthRegistry.states.delete(healthRegistry.key(t));
});

test("refreshAllHealth rejects invalid arguments", async () => {
  await assert.rejects(() => refreshAllHealth(null, () => {}), TypeError);
  await assert.rejects(() => refreshAllHealth([], "nope"), TypeError);
});

// ---------------------------------------------------------------------------
// Monitor lifecycle
// ---------------------------------------------------------------------------

test("startHealthMonitor refreshes immediately, repeats, and stops cleanly", async (t) => {
  const targets = [target({ provider: "mon", model: "m" })];
  let runs = 0;

  const stop = startHealthMonitor(targets, async () => {
    runs += 1;
    return { ok: true, status: 200 };
  }, 40);

  t.after(() => {
    stop();
    healthRegistry.states.delete("mon:m:key-0");
  });

  await delay(15);
  assert.ok(runs >= 1, "initial refresh did not run");

  await delay(160);
  assert.ok(runs >= 3, `expected periodic refreshes, saw ${runs}`);

  stop();
  await delay(30);            // let any in-flight cycle settle
  const settled = runs;
  await delay(160);           // several more intervals
  assert.equal(runs, settled, "monitor kept running after shutdown");
});

test("a failing refresh cycle does not reject or stop the monitor", async (t) => {
  const targets = [target({ provider: "monfail", model: "m" })];
  let runs = 0;

  const stop = startHealthMonitor(targets, async () => {
    runs += 1;
    throw new Error("probe exploded");
  }, 30);

  t.after(() => {
    stop();
    healthRegistry.states.delete("monfail:m:key-0");
  });

  await delay(120);

  assert.ok(runs >= 2, `monitor stopped after a failure, saw ${runs}`);
  assert.equal(healthRegistry.get("monfail:m:key-0").status, HEALTH_STATES.FAILED);
});

test("a refresh cycle that throws synchronously is contained", async (t) => {
  const stop = startHealthMonitor([], () => { throw new Error("bad check"); }, 30);
  t.after(() => stop());

  await delay(20);
  // Reaching here without an unhandled rejection is the assertion.
  assert.ok(true);
});
