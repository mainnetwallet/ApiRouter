import test from "node:test";
import assert from "node:assert/strict";
import v8 from "node:v8";
import vm from "node:vm";
import { HealthRegistry, healthRegistry, refreshAllHealth, validLatencyMs } from "../src/health.js";
import { FALLBACK_MODES } from "../src/fallback-chain.js";
import {
  automaticGroupIds,
  buildRoutePlan,
  groupLatency,
  groupTargets,
  modelLatency,
  resetAutomaticOrderCache,
  stateLatency
} from "../src/fallback-plan.js";
import { describeRouting } from "../src/observability/router-preview.js";
import { createApi } from "../src/api.js";

/**
 * Regression tests for the ApiRouter audit (six confirmed bugs) plus a
 * characterization of the latency-source policy.
 *
 * Everything here is deterministic: observation times are passed explicitly, the
 * registries are built by hand, and nothing depends on wall-clock timing. Each
 * test names the bug it pins and was written to FAIL against the behaviour the
 * audit described.
 */

const BASE = Math.floor(Date.now() / 30_000) * 30_000 + 1_000;
const PROTOCOL = "openai-chat";

const t = (provider, model, keyIndex = 0, pool = "text") => ({
  ...(pool === "vision" ? { id: `vision:${provider}:${model}:key-${keyIndex}` } : {}),
  provider,
  model,
  keyIndex,
  pool,
  protocols: [PROTOCOL]
});
const entry = (provider, model, extra = {}) => ({ provider, model, keys: null, enabled: true, ...extra });
const names = (steps) => steps.map((step) => `${step.target.provider}/${step.target.model}#${step.target.keyIndex}`);

let clock = 0;
const tick = () => BASE + (clock += 1);

let cacheId = 0;
const freshKey = () => `audit-${(cacheId += 1)}`;

function callApi(handler, pathname, query = "") {
  return new Promise((resolve, reject) => {
    const res = {
      writeHead(status) { this.status = status; },
      end(body) { resolve({ status: this.status, body: body ? JSON.parse(body) : null }); }
    };
    Promise.resolve(handler({ method: "GET", headers: {} }, res, pathname, new URLSearchParams(query))).catch(reject);
  });
}

// ---------------------------------------------------------------------------
// BUG 1 — a health probe must not be recorded as request latency
// ---------------------------------------------------------------------------

test("BUG 1: recordHealthCheck stores probe latency as probeLatencyMs and leaves requestLatencyMs alone", () => {
  const health = new HealthRegistry();
  const a = t("a", "A");

  health.markSuccess(a, { latencyMs: 800 }, tick());                              // a real request
  health.recordHealthCheck(a, { ok: true, status: 200, latencyMs: 90 }, tick());  // then a probe

  const state = health.get("a:A:key-0");
  assert.equal(state.requestLatencyMs, 800, "the request measurement is untouched by the probe");
  assert.equal(state.probeLatencyMs, 90, "the probe measurement is recorded as a probe");
  assert.equal(state.latencyMs, 90, "latencyMs is still the most recent observation of either kind");
  assert.ok(state.probeLatencyAt, "the probe records when it was measured");

  const [row] = health.describe([a]);
  assert.equal(row.requestLatencyMs, 800);
  assert.equal(row.probeLatencyMs, 90);
});

test("BUG 1: the production refresh path (refreshAllHealth -> recordHealthCheck) keeps the two figures apart", async () => {
  // refreshAllHealth drives the module-level registry, so this uses it, with a
  // target id no other test touches. The request is timestamped in the past so
  // the probe's own observation time is the newer one.
  const a = t("refresh-path", "A");
  healthRegistry.markSuccess(a, { latencyMs: 800 }, Date.now() - 60_000);

  const [result] = await refreshAllHealth([a], async () => ({ ok: true, status: 200, latencyMs: 90 }));
  assert.equal(result.state.status, "healthy");

  const live = healthRegistry.get("refresh-path:A:key-0");
  assert.equal(live.requestLatencyMs, 800, "the shipped refresh path leaves the request figure alone");
  assert.equal(live.probeLatencyMs, 90, "and records its own timing as a probe");
  assert.equal(live.latencyMs, 90);
});

test("BUG 1: latencySource and Automatic ordering follow the intended measurements after a real request then a probe", () => {
  const health = new HealthRegistry();
  const a = t("a", "A");
  const b = t("b", "B");
  const c = t("c", "C");

  health.markSuccess(a, { latencyMs: 800 }, tick());                              // A: slow in real traffic ...
  health.recordHealthCheck(a, { ok: true, status: 200, latencyMs: 90 }, tick());  // ... but a fast probe
  health.markSuccess(b, { latencyMs: 300 }, tick());                              // B: request only
  health.recordHealthCheck(c, { ok: true, status: 200, latencyMs: 200 }, tick()); // C: probe only

  assert.deepEqual(stateLatency(health.get("a:A:key-0")), { latencyMs: 800, source: "request" },
    "A is ordered by its request measurement, labelled as one");
  assert.deepEqual(stateLatency(health.get("c:C:key-0")), { latencyMs: 200, source: "probe" },
    "a probe-only target is labelled as a probe");

  const { steps } = buildRoutePlan({
    targets: [a, b, c], chain: [], mode: FALLBACK_MODES.AUTO, health, now: BASE + 5_000, cacheKey: freshKey()
  });
  // Buggy behaviour put A first (its probe's 90 ms had overwritten the request figure).
  assert.deepEqual(names(steps), ["c/C#0", "b/B#0", "a/A#0"]);
});

test("BUG 1: a probe that arrives first and a request that arrives later still land in their own fields", () => {
  const health = new HealthRegistry();
  const a = t("a", "A");
  health.recordHealthCheck(a, { ok: true, status: 200, latencyMs: 70 }, tick());
  health.markSuccess(a, { latencyMs: 500 }, tick());
  const state = health.get("a:A:key-0");
  assert.equal(state.probeLatencyMs, 70);
  assert.equal(state.requestLatencyMs, 500);
  assert.deepEqual(stateLatency(state), { latencyMs: 500, source: "request" });
});

// ---------------------------------------------------------------------------
// BUG 2 — the catalogue orders a key-restricted entry by its eligible keys only
// ---------------------------------------------------------------------------

for (const pool of ["text", "vision"]) {
  test(`BUG 2 (${pool}): the catalogue reports a key-restricted entry's eligible-key latency, matching the planner`, async () => {
    const k0 = t("a", "A", 0, pool);
    const k1 = t("a", "A", 1, pool);
    const health = new HealthRegistry();
    health.markSuccess(k0, { latencyMs: 50 }, tick());
    health.markSuccess(k1, { latencyMs: 900 }, tick());

    const chain = [entry("a", "A", { keys: [1] })];
    const handler = createApi({
      config: { retryableStatus: [500] },
      targets: [k0, k1],
      health,
      requestLog: { entries: new Map() },
      fallbackChain: { mode: FALLBACK_MODES.AUTO, get: (name) => (name === pool ? chain : []) }
    });

    const fallback = await callApi(handler, "/api/fallback");
    const group = fallback.body.catalogue[pool].find((item) => item.model === "A");
    const preview = await callApi(handler, "/api/router/preview", `protocol=${PROTOCOL}&pool=${pool}`);
    const planned = preview.body.fallbackOrder.find((item) => item.keyIndex === 1);

    assert.equal(group.latencyMs, 900, "only key 1 is eligible, so the model is 900 ms, not 50 ms");
    assert.equal(group.latencySource, "request");
    assert.equal(group.latencyMs, planned.orderLatencyMs, "catalogue == planner/preview");
    assert.equal(group.latencySource, planned.orderLatencySource);

    // Provider-wide health information is not narrowed.
    assert.equal(group.keyStates.length, 2, "both keys are still reported");
    assert.deepEqual(group.keyIndexes, [0, 1]);
    assert.equal(group.measuredLatencyMs, 50, "the provider-wide component figure is unchanged");
  });
}

test("BUG 2: an unrestricted entry, a disabled entry and a model outside the chain still use every key", async () => {
  const health = new HealthRegistry();
  const targets = [];
  for (const model of ["free", "off", "outside"]) {
    const k0 = t("a", model, 0);
    const k1 = t("a", model, 1);
    targets.push(k0, k1);
    health.markSuccess(k0, { latencyMs: 50 }, tick());
    health.markSuccess(k1, { latencyMs: 900 }, tick());
  }
  const chain = [entry("a", "free"), entry("a", "off", { keys: [1], enabled: false })];
  const handler = createApi({
    config: { retryableStatus: [500] }, targets, health, requestLog: { entries: new Map() },
    fallbackChain: { mode: FALLBACK_MODES.MANUAL, get: (name) => (name === "text" ? chain : []) }
  });
  const { body } = await callApi(handler, "/api/fallback");
  const latency = (model) => body.catalogue.text.find((item) => item.model === model).latencyMs;
  assert.equal(latency("free"), 50, "keys: null means every key");
  assert.equal(latency("off"), 50, "the planner does not narrow by a disabled entry");
  assert.equal(latency("outside"), 50, "a model with no entry is ordered over all its keys");
});

test("BUG 2: a restricted entry whose eligible keys were never measured is unmeasured, not borrowed from another key", async () => {
  const k0 = t("a", "A", 0);
  const k1 = t("a", "A", 1);
  const health = new HealthRegistry();
  health.markSuccess(k0, { latencyMs: 50 }, tick()); // measured, but NOT eligible
  health.ensureTarget(k1);                            // eligible, never measured

  const handler = createApi({
    config: { retryableStatus: [500] }, targets: [k0, k1], health, requestLog: { entries: new Map() },
    fallbackChain: { mode: FALLBACK_MODES.AUTO, get: (name) => (name === "text" ? [entry("a", "A", { keys: [1] })] : []) }
  });
  const fallback = await callApi(handler, "/api/fallback");
  const group = fallback.body.catalogue.text.find((item) => item.model === "A");
  const preview = await callApi(handler, "/api/router/preview", `protocol=${PROTOCOL}&pool=text`);

  assert.equal(group.latencyMs, null);
  assert.equal(group.latencySource, null);
  assert.equal(preview.body.fallbackOrder[0].orderLatencyMs, null, "the planner agrees: unmeasured");
});

// ---------------------------------------------------------------------------
// BUG 3 — an excluded key must not inherit another key's ordering latency
// ---------------------------------------------------------------------------

function previewOf({ chain, targets, health, stickyTargetId = null }) {
  resetAutomaticOrderCache();
  return describeRouting({
    targets, health, protocol: PROTOCOL, chain, stickyTargetId, now: BASE + 5_000
  });
}

test("BUG 3: a key excluded by the chain entry has rank null AND no ordering latency", () => {
  const k0 = t("a", "A", 0);
  const k1 = t("a", "A", 1);
  const health = new HealthRegistry();
  health.markSuccess(k0, { latencyMs: 50 }, tick());
  health.markSuccess(k1, { latencyMs: 900 }, tick());

  // Whether the pool has a saved selection or not, the same rule must hold.
  const preview = previewOf({ chain: [entry("a", "A", { keys: [1] })], targets: [k0, k1], health });
  const excluded = preview.candidates.find((item) => item.keyIndex === 0);
  const eligible = preview.candidates.find((item) => item.keyIndex === 1);

  assert.equal(excluded.rank, null, "key 0 is not in the plan");
  assert.equal(excluded.orderLatencyMs, null, "it must not inherit key 1's 900 ms");
  assert.equal(excluded.orderLatencySource, null, "nor its source");

  // Valid preview information for the eligible target is preserved.
  assert.equal(eligible.rank, 1);
  assert.equal(eligible.orderLatencyMs, 900);
  assert.equal(eligible.orderLatencySource, "request");
  assert.equal(preview.selected.orderLatencyMs, 900);
  assert.deepEqual(preview.fallbackOrder.map((item) => item.keyIndex), [1]);
});

test("BUG 3: unrestricted keys of one model still all report the model's single figure, cooling keys included", () => {
  const k0 = t("a", "A", 0);
  const k1 = t("a", "A", 1);
  const health = new HealthRegistry();
  health.markSuccess(k0, { latencyMs: 50 }, tick());
  health.markSuccess(k1, { latencyMs: 900 }, tick());
  health.markFailure(k1, 500, { cooldownMs: 3_600_000 }, tick()); // cooling, but still part of the plan

  const preview = previewOf({ chain: [entry("a", "A")], targets: [k0, k1], health });
  const byKey = new Map(preview.candidates.map((item) => [item.keyIndex, item]));
  assert.equal(byKey.get(0).orderLatencyMs, 50);
  assert.equal(byKey.get(1).orderLatencyMs, 50, "a key in the plan shares its model's figure");
  assert.equal(byKey.get(1).rank, null, "while a cooling key is not walked");
});

test("BUG 3: in Manual Model Selection a selected model's excluded key gets nothing, other models keep their figures", () => {
  const s0 = t("a", "S", 0);
  const s1 = t("a", "S", 1);
  const u = t("b", "U", 0);
  const health = new HealthRegistry();
  health.markSuccess(s0, { latencyMs: 50 }, tick());
  health.markSuccess(s1, { latencyMs: 900 }, tick());
  health.markSuccess(u, { latencyMs: 120 }, tick());

  const preview = previewOf({
    chain: [entry("a", "S", { keys: [1] })], targets: [s0, s1, u], health
  });
  const find = (model, key) => preview.candidates.find((item) => item.model === model && item.keyIndex === key);
  assert.equal(find("S", 0).orderLatencyMs, null);
  assert.equal(find("S", 1).orderLatencyMs, 900);
  assert.equal(find("U", 0).orderLatencyMs, 120, "an unselected model is untouched");
  assert.equal(find("U", 0).phase, "health-fallback");
});

// ---------------------------------------------------------------------------
// BUG 5 — the automatic-order cache is scoped to its health registry
// ---------------------------------------------------------------------------

function registryWhere(fastModel, targets) {
  // Two operations each, so independent registries sit at the SAME version.
  const health = new HealthRegistry();
  health.markSuccess(targets[0], { latencyMs: fastModel === "A" ? 50 : 900 }, BASE + 1);
  health.markSuccess(targets[1], { latencyMs: fastModel === "A" ? 900 : 50 }, BASE + 2);
  return health;
}

test("BUG 5: two registries with identical versions, cache keys and shape never share an order", () => {
  resetAutomaticOrderCache();
  const targets = [t("a", "A"), t("b", "B")];
  const healthA = registryWhere("A", targets);
  const healthB = registryWhere("B", targets);
  assert.equal(healthA.version, healthB.version, "precondition: the versions collide");

  const groups = [...groupTargets(targets).values()];
  const args = { cacheKey: "shared-key", groups, now: BASE + 5_000 };

  // Alternate callers so each registry is asked both before and after the other.
  assert.deepEqual(automaticGroupIds({ ...args, health: healthA }), ["a/A", "b/B"]);
  assert.deepEqual(automaticGroupIds({ ...args, health: healthB }), ["b/B", "a/A"], "B is not served A's cached order");
  assert.deepEqual(automaticGroupIds({ ...args, health: healthA }), ["a/A", "b/B"], "and A is not served B's");

  // The same holds through the planner, which is what requests use.
  const plan = (health) => names(buildRoutePlan({
    targets, chain: [], mode: FALLBACK_MODES.AUTO, health, now: BASE + 5_000, cacheKey: "shared-key"
  }).steps);
  assert.deepEqual(plan(healthB), ["b/B#0", "a/A#0"]);
  assert.deepEqual(plan(healthA), ["a/A#0", "b/B#0"]);
});

test("BUG 5: repeated requests on one registry still reuse the cached order", () => {
  resetAutomaticOrderCache();
  const targets = [t("a", "A"), t("b", "B")];
  const health = registryWhere("A", targets);
  const groups = [...groupTargets(targets).values()];
  const args = { cacheKey: "reuse", groups, health, now: BASE + 5_000 };

  const first = automaticGroupIds(args);
  assert.equal(automaticGroupIds(args), first, "same registry, same inputs: the very same cached array");

  // A real health change still invalidates immediately.
  health.markSuccess(targets[0], { latencyMs: 2_000 }, BASE + 3);
  assert.notEqual(automaticGroupIds(args), first);
  assert.deepEqual(automaticGroupIds(args), ["b/B", "a/A"]);
});

test("BUG 5: a registry's cache is bounded, and discarding the registry frees it", async () => {
  resetAutomaticOrderCache();
  const targets = [t("a", "A"), t("b", "B")];
  const groups = [...groupTargets(targets).values()];

  // Bounded: far more distinct keys than the limit never breaks an answer, and the oldest are evicted.
  const health = registryWhere("A", targets);
  const first = automaticGroupIds({ cacheKey: "k-0", groups, health, now: BASE + 5_000 });
  for (let i = 1; i < 200; i += 1) {
    assert.deepEqual(automaticGroupIds({ cacheKey: `k-${i}`, groups, health, now: BASE + 5_000 }), ["a/A", "b/B"]);
  }
  const again = automaticGroupIds({ cacheKey: "k-0", groups, health, now: BASE + 5_000 });
  assert.notEqual(again, first, "the earliest entry was evicted rather than kept forever");
  assert.deepEqual(again, first);

  // No leak: a registry that is dropped is collectable, cache and all.
  v8.setFlagsFromString("--expose-gc");
  const gc = vm.runInNewContext("gc");
  let ref;
  (() => {
    const scoped = registryWhere("B", targets);
    automaticGroupIds({ cacheKey: "leak-check", groups, health: scoped, now: BASE + 5_000 });
    ref = new WeakRef(scoped);
  })();
  for (let attempt = 0; attempt < 10 && ref.deref() !== undefined; attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve));
    gc();
  }
  assert.equal(ref.deref(), undefined, "the per-registry cache does not keep a discarded registry alive");
});

test("BUG 5: callers with no registry still get a correct, stable order", () => {
  resetAutomaticOrderCache();
  const groups = [...groupTargets([t("a", "A"), t("b", "B")]).values()];
  const args = { cacheKey: "no-health", groups, health: null, now: BASE + 5_000 };
  assert.deepEqual(automaticGroupIds(args), ["a/A", "b/B"], "configuration order when nothing is measured");
  assert.equal(automaticGroupIds(args), automaticGroupIds(args));
});

// ---------------------------------------------------------------------------
// BUG 6 — zero, negative and non-finite latencies are not measurements
// ---------------------------------------------------------------------------

const INVALID = [
  ["zero", 0], ["negative zero", -0], ["negative", -5], ["tiny negative", -0.001],
  ["NaN", NaN], ["Infinity", Infinity], ["-Infinity", -Infinity],
  ["numeric string", "40"], ["empty string", ""], ["null", null], ["undefined", undefined],
  ["boolean", true], ["array", [40]], ["object", { valueOf: () => 40 }]
];
const VALID = [["whole ms", 40], ["sub-millisecond", 0.4], ["large", 120_000]];

test("BUG 6: validLatencyMs accepts only finite numbers greater than zero, without coercion", () => {
  for (const [label, value] of VALID) assert.equal(validLatencyMs(value), value, label);
  for (const [label, value] of INVALID) assert.equal(validLatencyMs(value), null, label);
});

test("BUG 6: an unusable latency recorded by markSuccess changes no latency field, but the success still counts", () => {
  for (const [label, value] of INVALID) {
    const health = new HealthRegistry();
    const a = t("a", "A");
    health.markSuccess(a, { latencyMs: 300 }, tick());
    health.markSuccess(a, { latencyMs: value }, tick());
    const state = health.get("a:A:key-0");
    assert.equal(state.requestLatencyMs, 300, `${label}: the earlier real figure survives`);
    assert.equal(state.latencyMs, 300, `${label}: and so does the displayed latest figure`);
    assert.equal(state.successes, 2, `${label}: the success is still recorded`);
    assert.equal(state.status, "healthy");

    const fresh = new HealthRegistry();
    fresh.markSuccess(a, { latencyMs: value }, tick());
    const never = fresh.get("a:A:key-0");
    assert.equal(never.requestLatencyMs, null, `${label}: nothing is invented for a never-measured target`);
    assert.equal(never.latencyMs, null);
  }
});

test("BUG 6: the same rule applies to probes recorded through recordHealthCheck", () => {
  for (const [label, value] of INVALID) {
    const health = new HealthRegistry();
    const a = t("a", "A");
    health.recordHealthCheck(a, { ok: true, status: 200, latencyMs: value }, tick());
    const [row] = health.describe([a]);
    assert.equal(row.probeLatencyMs, null, label);
    assert.equal(row.requestLatencyMs, null, label);
  }
});

test("BUG 6: stateLatency treats an unusable figure as absent, with precedence otherwise unchanged", () => {
  for (const [label, bad] of INVALID) {
    assert.deepEqual(stateLatency({ requestLatencyMs: bad, probeLatencyMs: bad }), { latencyMs: null, source: null }, label);
    // An unusable request figure falls through to a usable probe figure, exactly as an absent one does.
    assert.deepEqual(stateLatency({ requestLatencyMs: bad, probeLatencyMs: 70 }), { latencyMs: 70, source: "probe" }, label);
    assert.deepEqual(stateLatency({ requestLatencyMs: 70, probeLatencyMs: bad }), { latencyMs: 70, source: "request" }, label);
  }
  // Unchanged: a usable request figure still beats a faster usable probe on the same key.
  assert.deepEqual(stateLatency({ requestLatencyMs: 900, probeLatencyMs: 10 }), { latencyMs: 900, source: "request" });
});

test("BUG 6: a zero or negative measurement can no longer sort a model ahead of a valid one", () => {
  const health = new HealthRegistry();
  const bogus = t("a", "Bogus");
  const real = t("b", "Real");
  const unmeasured = t("c", "Never");
  health.markSuccess(bogus, { latencyMs: 0 }, tick());
  health.markSuccess(real, { latencyMs: 120 }, tick());
  health.ensureTarget(unmeasured);

  const order = (targets) => names(buildRoutePlan({
    targets, chain: [], mode: FALLBACK_MODES.AUTO, health, now: BASE + 5_000, cacheKey: freshKey()
  }).steps);
  // The buggy order was a/Bogus first (0 < 120). Now the valid measurement leads.
  assert.deepEqual(order([bogus, real, unmeasured]), ["b/Real#0", "a/Bogus#0", "c/Never#0"]);

  const negative = new HealthRegistry();
  negative.markSuccess(bogus, { latencyMs: -50 }, tick());
  negative.markSuccess(real, { latencyMs: 120 }, tick());
  assert.deepEqual(
    names(buildRoutePlan({ targets: [bogus, real], chain: [], mode: FALLBACK_MODES.AUTO, health: negative, now: BASE + 5_000, cacheKey: freshKey() }).steps),
    ["b/Real#0", "a/Bogus#0"]
  );
});

test("BUG 6: modelLatency and groupLatency ignore unusable per-key figures", () => {
  assert.deepEqual(
    modelLatency([{ requestLatencyMs: 0 }, { requestLatencyMs: -1 }, { requestLatencyMs: 250 }]),
    { latencyMs: 250, source: "request" }
  );
  assert.deepEqual(modelLatency([{ requestLatencyMs: 0 }, { probeLatencyMs: -3 }]), { latencyMs: null, source: null });

  const health = new HealthRegistry();
  const k0 = t("a", "A", 0);
  const k1 = t("a", "A", 1);
  health.markSuccess(k0, { latencyMs: 0 }, tick());
  health.markSuccess(k1, { latencyMs: 400 }, tick());
  assert.deepEqual(groupLatency({ targets: [k0, k1] }, health), { latencyMs: 400, source: "request" });
});

test("BUG 6: a state mutated directly to hold an unusable figure is still read as unmeasured", () => {
  const health = new HealthRegistry();
  const a = t("a", "A");
  health.ensureTarget(a).requestLatencyMs = 0;
  health.ensureTarget(a).probeLatencyMs = -9;
  const [row] = health.describe([a]);
  assert.equal(row.requestLatencyMs, null);
  assert.equal(row.probeLatencyMs, null);
});

test("BUG 6: a probe that reports an unusable latency is timed by the refresh itself, never recorded as 0 or below", async () => {
  for (const reported of [0, -4, NaN, "9", null]) {
    const a = t("zero-probe", `m-${String(reported)}`);
    await refreshAllHealth([a], async () => ({ ok: true, status: 200, latencyMs: reported }));
    const state = healthRegistry.get(`zero-probe:m-${String(reported)}:key-0`);
    // The refresh times the probe itself when the reported figure is unusable. That
    // wall-clock delta can legitimately be 0 on a fast loopback, in which case it is
    // not recorded either. What must never happen is a figure <= 0 in ANY field, or
    // a probe showing up as a request measurement.
    for (const field of ["probeLatencyMs", "requestLatencyMs", "latencyMs"]) {
      assert.ok(state[field] === null || state[field] > 0, `reported ${String(reported)}: ${field} is never <= 0`);
    }
    assert.equal(state.requestLatencyMs, null, `reported ${String(reported)}: a probe is never a request measurement`);
    assert.equal(state.status, "healthy");
  }
});

// ---------------------------------------------------------------------------
// BUG 4 (UI) — the backend half of the contract its wording relies on
// ---------------------------------------------------------------------------

test("BUG 4 contract: the preview's phases say exactly where latency decided a position", () => {
  // The UI says "ordered by latency" only for phases auto / health-fallback / health-retry
  // (ui/src/lib/fallbackChain.js LATENCY_ORDERED_PHASES). That is only honest if the
  // planner really sorts by latency in those phases and in no others, so pin it here.
  const slow = t("a", "Slow");
  const mid = t("b", "Mid");
  const fast = t("c", "Fast");
  const health = new HealthRegistry();
  health.markSuccess(slow, { latencyMs: 900 }, tick());
  health.markSuccess(mid, { latencyMs: 400 }, tick());
  health.markSuccess(fast, { latencyMs: 40 }, tick());
  const targets = [slow, mid, fast];
  const chain = [entry("a", "Slow"), entry("b", "Mid"), entry("c", "Fast")];
  const phases = (preview) => preview.fallbackOrder.map((item) => `${item.model}:${item.phase}`);

  // A saved selection: the saved order wins whatever the latency, so every step is
  // `manual-selection` — latency decided none of these positions.
  assert.deepEqual(
    phases(previewOf({ chain, targets, health })),
    ["Slow:manual-selection", "Mid:manual-selection", "Fast:manual-selection"]
  );

  // No selection: sorted by latency (`auto`); a remembered target leads as `sticky`,
  // not as a latency win.
  assert.deepEqual(
    phases(previewOf({ chain: [], targets, health })),
    ["Fast:auto", "Mid:auto", "Slow:auto"]
  );
  assert.deepEqual(
    phases(previewOf({ chain: [], targets, health, stickyTargetId: "a:Slow:key-0" })),
    ["Slow:sticky", "Fast:auto", "Mid:auto"]
  );

  // A partly-selected pool: the selected model keeps its saved place; only the
  // unselected batch is latency-ordered (`health-fallback`).
  assert.deepEqual(
    phases(previewOf({ chain: [entry("a", "Slow")], targets, health })),
    ["Slow:manual-selection", "Fast:health-fallback", "Mid:health-fallback"]
  );
});

// ---------------------------------------------------------------------------
// LATENCY POLICY — characterization of the CURRENT rule (intentionally unchanged)
// ---------------------------------------------------------------------------

test("POLICY (current, unchanged): per key a request beats a probe; per model the LOWEST per-key figure wins, across sources", () => {
  const health = new HealthRegistry();
  const k0 = t("a", "A", 0);
  const k1 = t("a", "A", 1);

  health.markSuccess(k0, { latencyMs: 400 }, tick());                              // key 0: a real request, 400 ms
  health.recordHealthCheck(k1, { ok: true, status: 200, latencyMs: 100 }, tick()); // key 1: probe only, 100 ms

  // The probe figure of one key beats the request figure of another key. This is
  // the documented-in-code rule (see `stateLatency` / `modelLatency`); changing it
  // is a policy decision and must be made deliberately, not as a side effect.
  assert.deepEqual(modelLatency([health.get("a:A:key-0"), health.get("a:A:key-1")]), { latencyMs: 100, source: "probe" });
  assert.deepEqual(groupLatency({ targets: [k0, k1] }, health), { latencyMs: 100, source: "probe" });

  // On an exact tie the request-measured figure is the name that is reported.
  const tie = new HealthRegistry();
  tie.markSuccess(k0, { latencyMs: 100 }, tick());
  tie.recordHealthCheck(k1, { ok: true, status: 200, latencyMs: 100 }, tick());
  assert.deepEqual(groupLatency({ targets: [k0, k1] }, tie), { latencyMs: 100, source: "request" });
});
