import test from "node:test";
import assert from "node:assert/strict";
import { HealthRegistry } from "../src/health.js";
import { FALLBACK_MODES } from "../src/fallback-chain.js";
import {
  PHASES,
  buildRoutePlan,
  effectiveOrder,
  resetAutomaticOrderCache,
  routeOrderByPool
} from "../src/fallback-plan.js";

const t = (provider, model, keyIndex = 0, pool = "text") => ({
  ...(pool === "vision" ? { id: `vision:${provider}:${model}:key-${keyIndex}` } : {}),
  provider,
  model,
  keyIndex,
  pool,
  protocols: ["openai-chat"]
});

const entries = (...pairs) => pairs.map((pair) => {
  const [provider, model, extra = {}] = Array.isArray(pair) ? pair : [pair.provider, pair.model, pair];
  return { provider, model, keys: null, enabled: true, ...extra };
});

const labels = (steps) => steps.map((step) => `${step.phase}:${step.target.provider}/${step.target.model}#${step.target.keyIndex}`);

/** Targets with two keys each, so "every key before the next model" is visible. */
const twoKeyTargets = [
  t("a", "A", 0), t("a", "A", 1),
  t("b", "B", 0), t("b", "B", 1),
  t("c", "C", 0)
];

// ---------------------------------------------------------------------------
// Configured order
// ---------------------------------------------------------------------------

test("the chain is walked in exactly the saved order", () => {
  resetAutomaticOrderCache();
  const { steps, source } = buildRoutePlan({
    targets: twoKeyTargets,
    chain: entries(["c", "C"], ["a", "A"], ["b", "B"]),
    mode: FALLBACK_MODES.FIXED,
    cacheKey: "exact-order"
  });
  assert.equal(source, "chain");
  assert.deepEqual(labels(steps), [
    "chain:c/C#0", "chain:a/A#0", "chain:a/A#1", "chain:b/B#0", "chain:b/B#1"
  ]);
});

test("every eligible key of a model is tried before the next model", () => {
  resetAutomaticOrderCache();
  const { steps } = buildRoutePlan({
    targets: twoKeyTargets,
    chain: entries(["a", "A"], ["b", "B"]),
    cacheKey: "multi-key"
  });
  assert.deepEqual(labels(steps), ["chain:a/A#0", "chain:a/A#1", "chain:b/B#0", "chain:b/B#1"]);
});

test("an entry naming a model this pool does not serve contributes nothing", () => {
  resetAutomaticOrderCache();
  const { steps, configured } = buildRoutePlan({
    targets: twoKeyTargets,
    chain: entries(["a", "A"], ["ghost", "Gone"], ["b", "B"]),
    cacheKey: "unknown-entry"
  });
  assert.equal(configured, 2);
  assert.deepEqual(labels(steps), ["chain:a/A#0", "chain:a/A#1", "chain:b/B#0", "chain:b/B#1"]);
});

test("a disabled entry keeps its place in the saved order and is not routed to", () => {
  resetAutomaticOrderCache();
  const store = entries(["a", "A"], ["b", "B", { enabled: false }], ["c", "C"]);
  const { steps } = buildRoutePlan({ targets: twoKeyTargets, chain: store, cacheKey: "disabled" });
  assert.deepEqual(labels(steps), ["chain:a/A#0", "chain:a/A#1", "chain:c/C#0"]);

  // Re-enabling restores it in the position the operator left it, not at the end.
  store[1].enabled = true;
  assert.deepEqual(labels(buildRoutePlan({ targets: twoKeyTargets, chain: store, cacheKey: "disabled" }).steps), [
    "chain:a/A#0", "chain:a/A#1", "chain:b/B#0", "chain:b/B#1", "chain:c/C#0"
  ]);
});

test("an entry can be narrowed to specific keys, still in key order", () => {
  resetAutomaticOrderCache();
  const { steps } = buildRoutePlan({
    targets: twoKeyTargets,
    chain: entries(["a", "A", { keys: [1] }], ["b", "B", { keys: [1, 0] }]),
    cacheKey: "narrowed"
  });
  assert.deepEqual(labels(steps), ["chain:a/A#1", "chain:b/B#0", "chain:b/B#1"]);
});

// ---------------------------------------------------------------------------
// Automatic order
// ---------------------------------------------------------------------------

test("with no chain configured, the order is built from measured latency", () => {
  resetAutomaticOrderCache();
  const health = new HealthRegistry();
  health.markSuccess(t("a", "A"), { latencyMs: 500 });
  health.markSuccess(t("b", "B"), { latencyMs: 100 });
  health.markSuccess(t("c", "C"), { latencyMs: 300 });

  const { steps, source } = buildRoutePlan({ targets: twoKeyTargets, chain: [], health, cacheKey: "auto-latency" });
  assert.equal(source, "auto");
  // Lowest measured latency first; A's two keys stay adjacent.
  assert.deepEqual(labels(steps), [
    "auto:b/B#0", "auto:b/B#1", "auto:c/C#0", "auto:a/A#0", "auto:a/A#1"
  ]);
});

test("a model that has never been measured sorts last, in a deterministic order", () => {
  resetAutomaticOrderCache();
  const health = new HealthRegistry();
  health.markSuccess(t("c", "C"), { latencyMs: 300 });

  const first = buildRoutePlan({ targets: twoKeyTargets, chain: [], health, cacheKey: "auto-unmeasured-1" });
  const second = buildRoutePlan({ targets: twoKeyTargets, chain: [], health, cacheKey: "auto-unmeasured-2" });
  // C is measured and leads; the unmeasured models keep configuration order.
  assert.deepEqual(labels(first.steps), [
    "auto:c/C#0", "auto:a/A#0", "auto:a/A#1", "auto:b/B#0", "auto:b/B#1"
  ]);
  assert.deepEqual(labels(first.steps), labels(second.steps), "the order must be reproducible");
});

test("a probe measurement is used when no request has been timed, and never invented", () => {
  resetAutomaticOrderCache();
  const health = new HealthRegistry();
  health.recordHealthCheck(t("a", "A"), { ok: true, status: 200, latencyMs: 900 }, 1000);
  health.recordHealthCheck(t("b", "B"), { ok: true, status: 200, latencyMs: 200 }, 1000);

  const { steps } = buildRoutePlan({ targets: twoKeyTargets, chain: [], health, cacheKey: "auto-probe" });
  assert.deepEqual(labels(steps).slice(0, 3), ["auto:b/B#0", "auto:b/B#1", "auto:a/A#0"]);

  // A target with no measurement at all reports null, not a fabricated number.
  const plan = buildRoutePlan({ targets: [t("c", "C")], chain: [], health, cacheKey: "auto-none" });
  assert.equal(plan.steps.length, 1);
});

test("a real request measurement outranks a probe measurement", () => {
  resetAutomaticOrderCache();
  const health = new HealthRegistry();
  // A is fast by probe but slow in real traffic; B is the other way round.
  health.recordHealthCheck(t("a", "A"), { ok: true, status: 200, latencyMs: 50 }, 1000);
  health.recordHealthCheck(t("b", "B"), { ok: true, status: 200, latencyMs: 900 }, 1000);
  health.markSuccess(t("a", "A"), { latencyMs: 800 });
  health.markSuccess(t("b", "B"), { latencyMs: 100 });

  const { steps } = buildRoutePlan({ targets: [t("a", "A"), t("b", "B")], chain: [], health, cacheKey: "auto-source" });
  assert.deepEqual(labels(steps), ["auto:b/B#0", "auto:a/A#0"]);
});

test("a model whose every key is cooling yields to a healthy one", () => {
  resetAutomaticOrderCache();
  const health = new HealthRegistry();
  health.markSuccess(t("a", "A", 0), { latencyMs: 100 });
  health.markSuccess(t("a", "A", 1), { latencyMs: 100 });
  health.markSuccess(t("b", "B", 0), { latencyMs: 900 });
  health.markSuccess(t("b", "B", 1), { latencyMs: 900 });
  // Every key of A is cooling; B has never been faster but is available.
  health.markFailure(t("a", "A", 0), 500, { cooldownMs: 60_000 });
  health.markFailure(t("a", "A", 1), 500, { cooldownMs: 60_000 });

  const { steps } = buildRoutePlan({ targets: twoKeyTargets, chain: [], health, cacheKey: "auto-cooldown" });
  const order = labels(steps);
  assert.deepEqual(order.slice(0, 2), ["auto:b/B#0", "auto:b/B#1"]);
  // A stays in the plan so the walk can explain the skip rather than hide it.
  assert.ok(order.includes("auto:a/A#0"));

  const eligible = effectiveOrder(steps, (target) => health.isAvailable(target));
  assert.ok(!eligible.some((step) => step.target.model === "A"), "a cooling target must not be attempted");
});

test("one cooling key does not push a model out of the order while another key can still serve", () => {
  resetAutomaticOrderCache();
  const health = new HealthRegistry();
  health.markSuccess(t("a", "A", 0), { latencyMs: 100 });
  health.markSuccess(t("b", "B", 0), { latencyMs: 900 });
  health.markFailure(t("a", "A", 0), 500, { cooldownMs: 60_000 });

  const { steps } = buildRoutePlan({
    targets: [t("a", "A", 0), t("a", "A", 1), t("b", "B", 0)],
    chain: [],
    health,
    cacheKey: "auto-partial-cooldown"
  });
  // A is still a candidate: its second key is eligible.
  assert.deepEqual(labels(steps), ["auto:a/A#0", "auto:a/A#1", "auto:b/B#0"]);
  const eligible = effectiveOrder(steps, (target) => health.isAvailable(target)).map((step) => labels([step])[0]);
  assert.deepEqual(eligible, ["auto:a/A#1", "auto:b/B#0"], "the cooling key is skipped, its sibling is not");
});

test("the automatic order is recomputed when health actually changes", () => {
  resetAutomaticOrderCache();
  const health = new HealthRegistry();
  health.markSuccess(t("a", "A"), { latencyMs: 800 });
  health.markSuccess(t("b", "B"), { latencyMs: 200 });
  assert.deepEqual(
    labels(buildRoutePlan({ targets: [t("a", "A"), t("b", "B")], chain: [], health, cacheKey: "auto-change" }).steps),
    ["auto:b/B#0", "auto:a/A#0"]
  );

  // A gets faster: the order must follow the measurement, not a cached one.
  health.markSuccess(t("a", "A"), { latencyMs: 20 });
  assert.deepEqual(
    labels(buildRoutePlan({ targets: [t("a", "A"), t("b", "B")], chain: [], health, cacheKey: "auto-change" }).steps),
    ["auto:a/A#0", "auto:b/B#0"]
  );
});

// ---------------------------------------------------------------------------
// Custom order vs automatic sorting
// ---------------------------------------------------------------------------

test("no health or latency measurement can reorder a configured chain", () => {
  resetAutomaticOrderCache();
  const health = new HealthRegistry();
  // B is the fastest and healthiest by every signal there is.
  health.markSuccess(t("b", "B"), { latencyMs: 10 });
  health.markFailure(t("a", "A"), 500, { cooldownMs: 0 });
  health.markSuccess(t("c", "C"), { latencyMs: 5000 });

  const chain = entries(["c", "C"], ["a", "A"], ["b", "B"]);
  for (const mode of [FALLBACK_MODES.FIXED, FALLBACK_MODES.LAST_SUCCESS]) {
    const { steps, source } = buildRoutePlan({ targets: twoKeyTargets, chain, mode, health, cacheKey: `no-reorder-${mode}` });
    assert.equal(source, "chain", `${mode} must follow the configured order`);
    assert.deepEqual(labels(steps), [
      "chain:c/C#0", "chain:a/A#0", "chain:a/A#1", "chain:b/B#0", "chain:b/B#1"
    ]);
  }
});

test("the automatic mode is an explicit opt-in that does reorder the chain", () => {
  resetAutomaticOrderCache();
  const health = new HealthRegistry();
  health.markSuccess(t("b", "B"), { latencyMs: 10 });
  health.markSuccess(t("a", "A"), { latencyMs: 900 });

  const chain = entries(["a", "A"], ["b", "B"]);
  const { steps, source, configured } = buildRoutePlan({
    targets: twoKeyTargets, chain, mode: FALLBACK_MODES.AUTO, health, cacheKey: "auto-optin"
  });
  assert.equal(source, "auto");
  assert.equal(configured, 2, "the chain still decides which models are candidates");
  assert.deepEqual(labels(steps), ["auto:b/B#0", "auto:b/B#1", "auto:a/A#0", "auto:a/A#1"]);
});

// ---------------------------------------------------------------------------
// Remember Last Successful
// ---------------------------------------------------------------------------

test("Remember Last Successful leads with the remembered target, then the chain resumes", () => {
  resetAutomaticOrderCache();
  const chain = entries(["a", "A"], ["b", "B"], ["c", "C"]);
  const { steps, sticky } = buildRoutePlan({
    targets: twoKeyTargets,
    chain,
    mode: FALLBACK_MODES.LAST_SUCCESS,
    stickyTargetId: "b:B:key-1",
    cacheKey: "remember-lead"
  });

  // The remembered KEY is first, then the rest of its own model, then the chain.
  assert.deepEqual(labels(steps), [
    "sticky:b/B#1", "sticky:b/B#0", "chain:a/A#0", "chain:a/A#1", "chain:b/B#0", "chain:b/B#1", "chain:c/C#0"
  ]);
  assert.equal(sticky.model, "B");
});

test("Fixed Order ignores a remembered target entirely", () => {
  resetAutomaticOrderCache();
  const chain = entries(["a", "A"], ["b", "B"]);
  const { steps, sticky } = buildRoutePlan({
    targets: twoKeyTargets,
    chain,
    mode: FALLBACK_MODES.FIXED,
    stickyTargetId: "b:B:key-1",
    cacheKey: "fixed-ignores"
  });
  assert.equal(sticky, null);
  assert.equal(steps[0].phase, PHASES.CHAIN);
  assert.deepEqual(labels(steps), ["chain:a/A#0", "chain:a/A#1", "chain:b/B#0", "chain:b/B#1"]);
});

test("a remembered target the chain no longer contains is ignored", () => {
  resetAutomaticOrderCache();
  const { steps, sticky } = buildRoutePlan({
    targets: twoKeyTargets,
    chain: entries(["a", "A"], ["b", "B"]),
    mode: FALLBACK_MODES.LAST_SUCCESS,
    stickyTargetId: "c:C:key-0",
    cacheKey: "stale-sticky"
  });
  assert.equal(sticky, null);
  assert.equal(steps[0].phase, PHASES.CHAIN);
});

// ---------------------------------------------------------------------------
// Pool separation
// ---------------------------------------------------------------------------

test("a plan can only ever contain targets of the pool it was built for", () => {
  resetAutomaticOrderCache();
  const textTargets = [t("a", "A"), t("b", "B")];
  const visionTargets = [t("a", "VA", 0, "vision"), t("b", "VB", 0, "vision")];
  const all = [...textTargets, ...visionTargets];

  const text = buildRoutePlan({ targets: textTargets, chain: entries(["a", "VA"]), cacheKey: "pool-text" });
  assert.ok(text.steps.every((step) => (step.target.pool ?? "text") === "text"));
  assert.deepEqual(labels(text.steps), ["auto:a/A#0", "auto:b/B#0"], "a vision-only model cannot enter the text plan");

  const vision = buildRoutePlan({ targets: visionTargets, chain: entries(["b", "VB"], ["a", "VA"]), cacheKey: "pool-vision" });
  assert.ok(vision.steps.every((step) => step.target.pool === "vision"));
  assert.deepEqual(labels(vision.steps), ["chain:b/VB#0", "chain:a/VA#0"]);

  // The pooled view keeps the two apart as well. The vision chain names only
  // VB, and a configured chain is the COMPLETE order for its pool: VA is left
  // out deliberately, because routing to a model the operator did not put in
  // the chain would be a routing path overriding the configured order.
  const ranked = routeOrderByPool(all, { chains: { vision: entries(["b", "VB"]) } });
  assert.deepEqual(ranked.map((target) => `${target.pool ?? "text"}:${target.model}`), [
    "text:A", "text:B", "vision:VB"
  ]);
});

test("an unlisted model is not routed to while its pool has a configured chain", () => {
  resetAutomaticOrderCache();
  const { steps } = buildRoutePlan({
    targets: twoKeyTargets,
    chain: entries(["b", "B"]),
    cacheKey: "chain-is-complete"
  });
  assert.deepEqual(labels(steps), ["chain:b/B#0", "chain:b/B#1"]);
});

test("a chain with every entry disabled falls back to the automatic order", () => {
  resetAutomaticOrderCache();
  const { steps, source } = buildRoutePlan({
    targets: twoKeyTargets,
    chain: entries(["b", "B", { enabled: false }]),
    health: new HealthRegistry(),
    cacheKey: "all-disabled"
  });
  // Nothing is configured that can be walked, so the router is in the same
  // position as an unconfigured one — it must still route.
  assert.equal(source, "auto");
  assert.equal(steps.length, 5);
});

test("a pinned request walks its targets in key order with no chain and no memory", () => {
  resetAutomaticOrderCache();
  const { steps, source, sticky } = buildRoutePlan({
    targets: twoKeyTargets,
    chain: entries(["c", "C"]),
    mode: FALLBACK_MODES.LAST_SUCCESS,
    stickyTargetId: "b:B:key-1",
    pinned: true,
    cacheKey: "pinned"
  });
  assert.equal(source, "chain");
  assert.equal(sticky, null, "a pin is strict and remembers nothing");
  assert.deepEqual(labels(steps).slice(0, 2), ["chain:a/A#0", "chain:a/A#1"]);
});
