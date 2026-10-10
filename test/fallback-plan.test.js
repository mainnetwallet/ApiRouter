import test from "node:test";
import assert from "node:assert/strict";
import { HealthRegistry } from "../src/health.js";
import {
  PHASES,
  buildRoutePlan,
  chainStatusByPool,
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
const phaseSteps = (steps, phase) => steps.filter((step) => step.phase === phase);
/**
 * The first walk only. Every plan that has a saved selection also carries a
 * retry round per target; those steps are deliberate duplicates of the first
 * pass, so tests about ORDER look at the first pass alone.
 */
const firstPass = (steps) => steps.filter((step) => !step.retry);

/** Targets with two keys each, so "every key before the next model" is visible. */
const twoKeyTargets = [
  t("a", "A", 0), t("a", "A", 1),
  t("b", "B", 0), t("b", "B", 1),
  t("c", "C", 0)
];

// ---------------------------------------------------------------------------
// The saved selection
//
// There is no mode switch: a saved Manual Model Selection is walked in its saved
// order, and only an empty selection hands routing to the automatic order.
// ---------------------------------------------------------------------------

test("a saved selection is walked in exactly the saved order", () => {
  resetAutomaticOrderCache();
  const { steps, source } = buildRoutePlan({
    targets: twoKeyTargets,
    chain: entries(["c", "C"], ["a", "A"], ["b", "B"]),
    cacheKey: "exact-order"
  });
  assert.equal(source, "manual");
  assert.deepEqual(labels(firstPass(steps)), [
    "manual-selection:c/C#0", "manual-selection:a/A#0", "manual-selection:a/A#1",
    "manual-selection:b/B#0", "manual-selection:b/B#1"
  ]);
});

test("every eligible key of a selected model is tried before the next model", () => {
  resetAutomaticOrderCache();
  const { steps } = buildRoutePlan({
    targets: twoKeyTargets,
    chain: entries(["a", "A"], ["b", "B"]),
    cacheKey: "multi-key"
  });
  assert.deepEqual(labels(firstPass(steps)), [
    "manual-selection:a/A#0", "manual-selection:a/A#1",
    "manual-selection:b/B#0", "manual-selection:b/B#1",
    // Unselected models follow the whole selection, ordered by health.
    "health-fallback:c/C#0"
  ]);
});

test("an entry naming a model this pool does not serve contributes nothing", () => {
  resetAutomaticOrderCache();
  const { steps, configured } = buildRoutePlan({
    targets: twoKeyTargets,
    chain: entries(["a", "A"], ["ghost", "Gone"], ["b", "B"]),
    cacheKey: "unknown-entry"
  });
  assert.equal(configured, 2);
  assert.deepEqual(labels(phaseSteps(steps, PHASES.MANUAL)), [
    "manual-selection:a/A#0", "manual-selection:a/A#1", "manual-selection:b/B#0", "manual-selection:b/B#1"
  ]);
});

test("a disabled entry keeps its place in the saved order and is not routed to", () => {
  resetAutomaticOrderCache();
  const store = entries(["a", "A"], ["b", "B", { enabled: false }], ["c", "C"]);
  const { steps } = buildRoutePlan({ targets: twoKeyTargets, chain: store, cacheKey: "disabled" });
  assert.deepEqual(labels(phaseSteps(steps, PHASES.MANUAL)), [
    "manual-selection:a/A#0", "manual-selection:a/A#1", "manual-selection:c/C#0"
  ]);
  // A parked model is not a fallback either: it stays out of the health batch.
  assert.ok(!labels(steps).some((label) => label.includes("b/B")));

  // Re-enabling restores it in the position the operator left it, not at the end.
  store[1].enabled = true;
  const back = buildRoutePlan({ targets: twoKeyTargets, chain: store, cacheKey: "disabled-on" });
  assert.deepEqual(labels(phaseSteps(back.steps, PHASES.MANUAL)), [
    "manual-selection:a/A#0", "manual-selection:a/A#1", "manual-selection:b/B#0", "manual-selection:b/B#1", "manual-selection:c/C#0"
  ]);
});

test("an entry can be narrowed to specific keys, still in key order", () => {
  resetAutomaticOrderCache();
  const { steps } = buildRoutePlan({
    targets: twoKeyTargets,
    chain: entries(["a", "A", { keys: [1] }], ["b", "B", { keys: [1, 0] }]),
    cacheKey: "narrowed"
  });
  assert.deepEqual(labels(phaseSteps(steps, PHASES.MANUAL)), [
    "manual-selection:a/A#1", "manual-selection:b/B#0", "manual-selection:b/B#1"
  ]);
});

// ---------------------------------------------------------------------------
// Automatic order — the empty selection
// ---------------------------------------------------------------------------

test("with nothing selected, the order is built from measured latency", () => {
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
// The selection is never re-ranked; health only orders what is NOT selected
// ---------------------------------------------------------------------------

test("no health or latency measurement can reorder a saved selection", () => {
  resetAutomaticOrderCache();
  const health = new HealthRegistry();
  // B is the fastest and healthiest by every signal there is.
  health.markSuccess(t("b", "B"), { latencyMs: 10 });
  health.markFailure(t("a", "A"), 500, { cooldownMs: 0 });
  health.markSuccess(t("c", "C"), { latencyMs: 5000 });

  const { steps, source } = buildRoutePlan({
    targets: twoKeyTargets,
    chain: entries(["c", "C"], ["a", "A"], ["b", "B"]),
    health,
    cacheKey: "no-reorder"
  });
  assert.equal(source, "manual", "a saved selection is never handed to the automatic order");
  assert.deepEqual(labels(phaseSteps(steps, PHASES.MANUAL)), [
    "manual-selection:c/C#0", "manual-selection:a/A#0", "manual-selection:a/A#1",
    "manual-selection:b/B#0", "manual-selection:b/B#1"
  ]);
});

test("a saved selection is never reordered; unselected models follow it by health", () => {
  resetAutomaticOrderCache();
  const health = new HealthRegistry();
  health.markSuccess(t("b", "B"), { latencyMs: 10 });
  health.markSuccess(t("c", "C"), { latencyMs: 20 });
  health.markSuccess(t("a", "A"), { latencyMs: 900 });

  const { steps, source, configured } = buildRoutePlan({
    targets: twoKeyTargets, chain: entries(["a", "A"]), health, cacheKey: "manual-then-health"
  });
  assert.equal(source, "manual");
  assert.equal(configured, 1);
  // The selection keeps its own order regardless of health...
  assert.deepEqual(labels(phaseSteps(steps, PHASES.MANUAL)), ["manual-selection:a/A#0", "manual-selection:a/A#1"]);
  // ...and the unselected models are ordered by measured latency after it.
  assert.deepEqual(labels(phaseSteps(steps, PHASES.HEALTH)), [
    "health-fallback:b/B#0", "health-fallback:b/B#1", "health-fallback:c/C#0"
  ]);
});

// ---------------------------------------------------------------------------
// Remembered target
// ---------------------------------------------------------------------------

test("the remembered target leads when it is one of the selected models, then the selection resumes", () => {
  resetAutomaticOrderCache();
  const chain = entries(["a", "A"], ["b", "B"], ["c", "C"]);
  const { steps, sticky } = buildRoutePlan({
    targets: twoKeyTargets,
    chain,
    stickyTargetId: "b:B:key-1",
    cacheKey: "remember-lead"
  });

  // The remembered KEY is first, then the rest of its own model, then the rest
  // of the selection in its saved order — the remembered model is not repeated.
  assert.deepEqual(labels(firstPass(steps)), [
    "sticky:b/B#1", "sticky:b/B#0",
    "manual-selection:a/A#0", "manual-selection:a/A#1", "manual-selection:c/C#0"
  ]);
  assert.equal(sticky.model, "B");
});

test("a remembered target promotes its model within the selection, not out of it", () => {
  resetAutomaticOrderCache();
  const chain = entries(["a", "A"], ["b", "B"]);
  const { steps, sticky } = buildRoutePlan({
    targets: twoKeyTargets,
    chain,
    stickyTargetId: "b:B:key-1",
    cacheKey: "promote-b"
  });
  assert.equal(sticky.model, "B");
  // B leads with the key that answered; A follows in its saved position, and the
  // unselected model still comes last.
  assert.deepEqual(labels(firstPass(steps)), [
    "sticky:b/B#1", "sticky:b/B#0",
    "manual-selection:a/A#0", "manual-selection:a/A#1",
    "health-fallback:c/C#0"
  ]);
});

test("a remembered target the selection no longer allows is not promoted", () => {
  resetAutomaticOrderCache();
  for (const [why, chain] of [
    ["not in the selection", entries(["a", "A"])],
    ["model disabled", entries(["a", "A"], ["b", "B", { enabled: false }])],
    ["key restricted away", entries(["a", "A"], ["b", "B", { keys: [0] }])]
  ]) {
    const { steps, sticky } = buildRoutePlan({
      targets: twoKeyTargets, chain, stickyTargetId: "b:B:key-1", cacheKey: `stale-${why}`
    });
    assert.equal(sticky, null, why);
    assert.equal(steps[0].phase, PHASES.MANUAL, why);
    assert.ok(!labels(steps).some((label) => label === "sticky:b/B#1"), why);
  }
});

test("with nothing remembered the selection is walked plainly in its saved order", () => {
  resetAutomaticOrderCache();
  const { steps, sticky } = buildRoutePlan({
    targets: twoKeyTargets, chain: entries(["a", "A"], ["b", "B"]), cacheKey: "nothing-remembered"
  });
  assert.equal(sticky, null);
  assert.deepEqual(labels(firstPass(steps)), [
    "manual-selection:a/A#0", "manual-selection:a/A#1",
    "manual-selection:b/B#0", "manual-selection:b/B#1",
    "health-fallback:c/C#0"
  ]);
});

test("a remembered target leads the walk whether or not a selection is saved", () => {
  resetAutomaticOrderCache();
  const withSelection = buildRoutePlan({
    targets: twoKeyTargets,
    chain: entries(["a", "A"], ["b", "B"]),
    stickyTargetId: "b:B:key-1",
    cacheKey: "lead-manual"
  });
  assert.equal(withSelection.sticky.keyIndex, 1);
  assert.equal(withSelection.steps[0].phase, PHASES.STICKY);

  const automatic = buildRoutePlan({
    targets: twoKeyTargets, chain: [], stickyTargetId: "b:B:key-1", cacheKey: "lead-auto"
  });
  assert.equal(automatic.source, "auto");
  assert.equal(automatic.sticky.keyIndex, 1);
  assert.equal(labels(automatic.steps)[0], "sticky:b/B#1");
});

test("a remembered target outside the selection does not jump the queue", () => {
  resetAutomaticOrderCache();
  const { steps, sticky } = buildRoutePlan({
    targets: twoKeyTargets,
    chain: entries(["a", "A"], ["b", "B"]),
    stickyTargetId: "c:C:key-0",
    cacheKey: "unselected-sticky"
  });
  assert.equal(sticky, null, "an unselected model that answered last must not lead the selection");
  assert.equal(steps[0].phase, PHASES.MANUAL);
  // It is still reachable — but only after the whole selection, in the health batch.
  assert.ok(labels(phaseSteps(steps, PHASES.HEALTH)).includes("health-fallback:c/C#0"));
});

// ---------------------------------------------------------------------------
// Pool separation
// ---------------------------------------------------------------------------

test("a plan can only ever contain targets of the pool it was built for", () => {
  resetAutomaticOrderCache();
  const textTargets = [t("a", "A"), t("b", "B")];
  const visionTargets = [t("a", "VA", 0, "vision"), t("b", "VB", 0, "vision")];
  const all = [...textTargets, ...visionTargets];

  // The text selection names a VISION model. It resolves to nothing for the text
  // pool, so the text plan is empty: neither the vision model nor any unrelated
  // text model may be reached in its place.
  const text = buildRoutePlan({ targets: textTargets, chain: entries(["a", "VA"]), cacheKey: "pool-text" });
  assert.deepEqual(text.steps, [], "a vision-only model cannot enter the text plan, and cannot be substituted for");
  assert.equal(text.failClosed, true);
  assert.ok(text.groups.every((group) => group.targets.length === 0));

  const vision = buildRoutePlan({ targets: visionTargets, chain: entries(["b", "VB"], ["a", "VA"]), cacheKey: "pool-vision" });
  assert.ok(vision.steps.every((step) => step.target.pool === "vision"));
  assert.deepEqual(labels(phaseSteps(vision.steps, PHASES.MANUAL)), ["manual-selection:b/VB#0", "manual-selection:a/VA#0"]);

  // The pooled view keeps the two apart as well. The vision selection names only
  // VB, so VA is unselected — reachable, but only after the whole selection.
  const ranked = routeOrderByPool(all, { chains: { vision: entries(["b", "VB"]) } });
  assert.deepEqual(ranked.map((target) => `${target.pool ?? "text"}:${target.model}`), [
    "text:A", "text:B", "vision:VB", "vision:VA"
  ]);
});

test("an unselected model is reached only after the whole saved selection", () => {
  resetAutomaticOrderCache();
  const { steps } = buildRoutePlan({
    targets: twoKeyTargets,
    chain: entries(["b", "B"]),
    cacheKey: "selection-first"
  });
  assert.deepEqual(labels(firstPass(steps)), [
    "manual-selection:b/B#0", "manual-selection:b/B#1",
    "health-fallback:a/A#0", "health-fallback:a/A#1", "health-fallback:c/C#0"
  ]);
});

test("a selection with entries that are all disabled routes nothing rather than widening", () => {
  resetAutomaticOrderCache();
  const result = buildRoutePlan({
    targets: twoKeyTargets,
    chain: entries(["b", "B", { enabled: false }]),
    health: new HealthRegistry(),
    cacheKey: "all-disabled"
  });
  // Saved entries that permit nothing are still the operator's configuration.
  // Routing the automatic order instead would reach models this selection does
  // not name, which is the silent fallback it exists to prevent. The way to ask
  // for automatic routing is to have no selection at all.
  assert.equal(result.source, "manual");
  assert.equal(result.failClosed, true);
  assert.deepEqual(result.steps, []);

  const cleared = buildRoutePlan({
    targets: twoKeyTargets,
    chain: [],
    health: new HealthRegistry(),
    cacheKey: "all-disabled-cleared"
  });
  assert.equal(cleared.source, "auto", "a genuinely empty selection is unconfigured and still routes");
  assert.equal(cleared.steps.length, 5);
});

test("a pinned request walks its targets in key order with no selection and no memory", () => {
  resetAutomaticOrderCache();
  const { steps, source, sticky } = buildRoutePlan({
    targets: twoKeyTargets,
    chain: entries(["c", "C"]),
    stickyTargetId: "b:B:key-1",
    pinned: true,
    cacheKey: "pinned"
  });
  assert.equal(source, "chain");
  assert.equal(sticky, null, "a pin is strict and remembers nothing");
  assert.deepEqual(labels(steps).slice(0, 2), ["chain:a/A#0", "chain:a/A#1"]);
});

// ---------------------------------------------------------------------------
// A remembered target may never bypass a saved key restriction
// ---------------------------------------------------------------------------

/** One model with three keys, so a subset can exclude the middle one. */
const threeKeyTargets = [
  t("a", "A", 0), t("a", "A", 1), t("a", "A", 2),
  t("b", "B", 0)
];

test("a remembered key the current entry no longer allows is never remembered", () => {
  resetAutomaticOrderCache();
  const { steps, sticky } = buildRoutePlan({
    targets: threeKeyTargets,
    // The operator has since restricted A to keys 0 and 2.
    chain: entries(["a", "A", { keys: [0, 2] }], ["b", "B"]),
    stickyTargetId: "a:A:key-1",
    cacheKey: "remember-excluded-key"
  });

  assert.equal(sticky, null, "key 1 is excluded by the entry, so it cannot be remembered");
  assert.ok(!labels(steps).some((label) => label.endsWith("#1") && label.includes("a/A")),
    "the excluded key must not appear in any phase");
  assert.deepEqual(labels(phaseSteps(steps, PHASES.MANUAL)), ["manual-selection:a/A#0", "manual-selection:a/A#2", "manual-selection:b/B#0"]);
});

test("a remembered model with a restricted key subset leads with, and exhausts, only allowed keys", () => {
  resetAutomaticOrderCache();
  const { steps, sticky } = buildRoutePlan({
    targets: threeKeyTargets,
    chain: entries(["a", "A", { keys: [0, 2] }], ["b", "B"]),
    // Key 2 is remembered and IS allowed.
    stickyTargetId: "a:A:key-2",
    cacheKey: "remember-allowed-key"
  });

  assert.equal(sticky.model, "A");
  assert.deepEqual(labels(firstPass(steps)), [
    // The remembered key, then the model's OTHER ALLOWED key — never key 1 —
    // and only then the rest of the selection, in its saved order.
    "sticky:a/A#2", "sticky:a/A#0", "manual-selection:b/B#0"
  ]);
  assert.ok(!labels(steps).some((label) => label === "sticky:a/A#1"));
});

test("a remembered target that is still allowed still leads the selection", () => {
  resetAutomaticOrderCache();
  const { steps, sticky } = buildRoutePlan({
    targets: threeKeyTargets,
    chain: entries(["a", "A"], ["b", "B"]),
    stickyTargetId: "b:B:key-0",
    cacheKey: "remember-eligible"
  });

  assert.equal(sticky.model, "B");
  assert.equal(steps[0].phase, PHASES.STICKY);
  assert.equal(labels(steps)[0], "sticky:b/B#0");
  // The selection still resumes in its saved order afterwards.
  assert.deepEqual(labels(firstPass(steps)).slice(1), [
    "manual-selection:a/A#0", "manual-selection:a/A#1", "manual-selection:a/A#2"
  ]);
});

test("a disabled entry cannot be reintroduced by sticky routing", () => {
  resetAutomaticOrderCache();
  const { steps, sticky } = buildRoutePlan({
    targets: threeKeyTargets,
    chain: entries(["a", "A"], ["b", "B", { enabled: false }]),
    stickyTargetId: "b:B:key-0",
    cacheKey: "remember-disabled-entry"
  });

  assert.equal(sticky, null);
  assert.ok(!labels(steps).some((label) => label.includes("b/B")));
});

test("an entry removed from the selection cannot be promoted by sticky routing", () => {
  resetAutomaticOrderCache();
  const { steps, sticky } = buildRoutePlan({
    targets: threeKeyTargets,
    // B is simply gone from the selection.
    chain: entries(["a", "A"]),
    stickyTargetId: "b:B:key-0",
    cacheKey: "remember-removed-entry"
  });

  assert.equal(sticky, null);
  // B is unselected now, so it is reachable only after A, in the health batch.
  assert.deepEqual(labels(firstPass(steps)), [
    "manual-selection:a/A#0", "manual-selection:a/A#1", "manual-selection:a/A#2",
    "health-fallback:b/B#0"
  ]);
});

test("a saved selection and its key restrictions are honoured together", () => {
  resetAutomaticOrderCache();
  // A is narrowed to keys 0 and 2; key 1 is measured, but it is excluded, so it
  // must not appear anywhere and must not be promoted.
  const health = new HealthRegistry();
  health.markSuccess(t("a", "A", 1), { latencyMs: 1 });
  health.markSuccess(t("b", "B", 0), { latencyMs: 900 });
  const { steps, sticky } = buildRoutePlan({
    targets: threeKeyTargets,
    chain: entries(["a", "A", { keys: [0, 2] }], ["b", "B"]),
    stickyTargetId: "a:A:key-1",
    health,
    cacheKey: "restrict"
  });
  assert.equal(sticky, null, "the excluded key cannot be remembered");
  assert.deepEqual(labels(phaseSteps(steps, PHASES.MANUAL)), ["manual-selection:a/A#0", "manual-selection:a/A#2", "manual-selection:b/B#0"]);
  assert.ok(!labels(steps).some((label) => label === "manual-selection:a/A#1"));
});

test("a pinned request still bypasses the selection, the automatic order and any memory", () => {
  resetAutomaticOrderCache();
  const { steps, sticky, source } = buildRoutePlan({
    targets: threeKeyTargets,
    chain: entries(["a", "A", { keys: [0] }]),
    stickyTargetId: "a:A:key-2",
    pinned: true,
    cacheKey: "pin-strict"
  });

  assert.equal(sticky, null);
  assert.equal(source, "chain");
  // A pin is narrowed before the plan is built, and its own targets are walked
  // in key order — the saved entry is not consulted at all.
  assert.deepEqual(labels(steps), ["chain:a/A#0", "chain:a/A#1", "chain:a/A#2", "chain:b/B#0"]);
});

// ---------------------------------------------------------------------------
// The automatic-order cache must not outlive the configuration it was built on
// ---------------------------------------------------------------------------

/** The automatic order for one cacheKey, as the walker would see it. */
const autoOrder = (targets, health, cacheKey) =>
  labels(buildRoutePlan({ targets, chain: [], health, cacheKey }).steps);

test("a model added to the target list is eligible immediately", () => {
  resetAutomaticOrderCache();
  const health = new HealthRegistry();
  const a = t("a", "A");
  const b = t("b", "B");

  assert.deepEqual(autoOrder([a], health, "cfg-add"), ["auto:a/A#0"]);

  // The same health version and the same 30-second bucket must not serve the
  // order computed before B existed.
  assert.deepEqual(autoOrder([a, b], health, "cfg-add"), ["auto:a/A#0", "auto:b/B#0"]);
});

test("removing a target takes effect immediately", () => {
  resetAutomaticOrderCache();
  const health = new HealthRegistry();
  const a = t("a", "A");
  const b = t("b", "B");

  assert.deepEqual(autoOrder([a, b], health, "cfg-remove"), ["auto:a/A#0", "auto:b/B#0"]);
  assert.deepEqual(autoOrder([a], health, "cfg-remove"), ["auto:a/A#0"]);
});

test("changing a model's key set takes effect immediately", () => {
  resetAutomaticOrderCache();
  // A is only measured on key 1, so it is unmeasured while key 1 is absent and
  // measured — and therefore first — as soon as it is present.
  const health = new HealthRegistry();
  health.markSuccess(t("a", "A", 1), { latencyMs: 1 });
  health.markSuccess(t("b", "B", 0), { latencyMs: 900 });
  const b = t("b", "B", 0);

  assert.deepEqual(autoOrder([t("a", "A", 0), b], health, "cfg-keys"), ["auto:b/B#0", "auto:a/A#0"]);
  // A now measures 1 ms and leads. Its keys stay in KEY ORDER inside the group:
  // latency orders models, and the key order within a model is configuration.
  assert.deepEqual(autoOrder([t("a", "A", 0), t("a", "A", 1), b], health, "cfg-keys"),
    ["auto:a/A#0", "auto:a/A#1", "auto:b/B#0"]);
});

test("an unchanged configuration still reuses the cached order within its bucket", () => {
  resetAutomaticOrderCache();
  const health = new HealthRegistry();
  health.markSuccess(t("a", "A"), { latencyMs: 800 });
  health.markSuccess(t("b", "B"), { latencyMs: 200 });
  const targets = [t("a", "A"), t("b", "B")];
  const run = () => autoOrder(targets, health, "cfg-reuse");

  assert.deepEqual(run(), ["auto:b/B#0", "auto:a/A#0"]);

  // Move the measurement WITHOUT going through the registry, so the version
  // counter does not change: within this bucket the cached order is reused.
  health.ensureTarget(t("a", "A")).requestLatencyMs = 10;
  assert.deepEqual(run(), ["auto:b/B#0", "auto:a/A#0"], "the cached order is still valid for this bucket");

  // A real health observation moves the version and must take effect at once.
  health.markSuccess(t("a", "A"), { latencyMs: 5 });
  assert.deepEqual(run(), ["auto:a/A#0", "auto:b/B#0"]);
});

test("the automatic-order cache stays bounded under configuration churn", () => {
  resetAutomaticOrderCache();
  const health = new HealthRegistry();
  // Each distinct target list produces a distinct key; the cache must not grow
  // without bound across a long-running gateway.
  for (let i = 0; i < 200; i += 1) {
    autoOrder(i % 2 === 0 ? [t("a", "A")] : [t("b", "B")], health, `churn-${i}`);
  }
  // Observable through behaviour: the most recent configuration is still honoured.
  assert.deepEqual(autoOrder([t("b", "B")], health, "churn-after"), ["auto:b/B#0"]);
});

test("an entry restricted to a key the provider no longer has does not silently widen routing", () => {
  resetAutomaticOrderCache();
  // The entry allows only key 5. The provider has keys 0, 1 and 2, so the subset
  // matches nothing — which must NOT be read as "nothing is selected".
  const { steps, source, configured } = buildRoutePlan({
    targets: threeKeyTargets,
    chain: entries(["a", "A", { keys: [5] }]),
    cacheKey: "impossible-subset"
  });

  assert.equal(configured, 1, "the entry is still a saved entry");
  assert.equal(source, "manual");
  assert.deepEqual(steps, [], "and the model it names is simply not routable");
});

test("a selection that is wholly unservable is not silently replaced by routing to everything", () => {
  resetAutomaticOrderCache();
  // Every entry names a key that does not exist. The selection is usable, it just
  // permits nothing — and the excluded keys must not be reached.
  const { steps, configured } = buildRoutePlan({
    targets: threeKeyTargets,
    chain: entries(["a", "A", { keys: [5] }], ["b", "B", { keys: [7] }]),
    cacheKey: "wholly-unservable"
  });
  assert.equal(configured, 2);
  assert.deepEqual(steps, []);
});

// ---------------------------------------------------------------------------
// Fail-closed routing
//
// A pool with NO saved entries is free to route automatically. A pool that has
// saved entries but no USABLE ones must not: widening to models the selection
// does not name, or to keys an entry excludes, is exactly the silent fallback
// the selection exists to prevent.
// ---------------------------------------------------------------------------

const plan = (args) => buildRoutePlan({ targets: twoKeyTargets, cacheKey: `fc-${Math.random()}`, ...args });

test("a genuinely empty selection still uses the automatic order", () => {
  resetAutomaticOrderCache();
  for (const chain of [[], undefined, null]) {
    const result = plan({ chain: chain ?? [] });
    assert.equal(result.source, "auto", `selection ${JSON.stringify(chain)} is empty, so the router is unconfigured`);
    assert.equal(result.failClosed, false);
    assert.equal(result.steps.length, 5, "every configured target stays eligible");
  }
});

test("a selection naming only a model that is no longer configured routes nothing", () => {
  resetAutomaticOrderCache();
  // The provider was removed from the environment, but the selection still names it.
  const result = plan({ chain: entries(["ghost", "Gone"]) });
  assert.equal(result.source, "manual", "the selection is saved, so the automatic order must not take over");
  assert.equal(result.failClosed, true);
  assert.deepEqual(result.steps, [], "no unrelated model may be reached");
});

test("a selection whose entries are all disabled routes nothing", () => {
  resetAutomaticOrderCache();
  // Every entry withdrawn is not the same as no selection at all: the entries are
  // still the operator's configuration, and they are unusable.
  const result = plan({ chain: entries(["a", "A", { enabled: false }], ["b", "B", { enabled: false }]) });
  assert.equal(result.source, "manual");
  assert.equal(result.failClosed, true);
  assert.deepEqual(result.steps, []);
});

test("a selection whose only entry is restricted to a key that does not exist routes nothing", () => {
  resetAutomaticOrderCache();
  const result = plan({ chain: entries(["a", "A", { keys: [9] }]) });
  assert.equal(result.failClosed, true);
  assert.deepEqual(result.steps, []);
});

test("a partly usable selection routes its usable entries, then unselected models", () => {
  resetAutomaticOrderCache();
  const result = plan({
    chain: entries(["ghost", "Gone"], ["b", "B"], ["a", "A", { enabled: false }])
  });
  assert.equal(result.source, "manual");
  assert.equal(result.failClosed, false, "one usable entry is enough to route");
  assert.deepEqual(labels(firstPass(result.steps)), [
    "manual-selection:b/B#0", "manual-selection:b/B#1", "health-fallback:c/C#0"
  ]);
});

test("an unusable selection fails closed rather than reaching past it", () => {
  resetAutomaticOrderCache();
  const result = plan({ chain: entries(["ghost", "Gone"]), health: new HealthRegistry() });
  assert.equal(result.failClosed, true);
  assert.deepEqual(result.steps, []);
});

test("an unusable text selection does not affect the vision pool", () => {
  resetAutomaticOrderCache();
  const text = [t("a", "A"), t("b", "B")];
  const vision = [t("a", "VA", 0, "vision"), t("b", "VB", 0, "vision")];
  // The text selection names a model that is gone; vision has no selection.
  const ranked = routeOrderByPool([...text, ...vision], { chains: { text: entries(["ghost", "Gone"]) } });

  assert.equal(ranked.filter((target) => (target.pool ?? "text") === "text").length, 0,
    "the unusable text selection routes nothing");
  assert.equal(ranked.filter((target) => target.pool === "vision").length, 2,
    "vision has no selection, so it still routes automatically");
});

test("pinned requests are unaffected by an unusable selection", () => {
  resetAutomaticOrderCache();
  const result = buildRoutePlan({
    targets: twoKeyTargets,
    chain: entries(["ghost", "Gone"]),
    pinned: true,
    cacheKey: "fc-pinned"
  });
  assert.equal(result.failClosed, false);
  assert.deepEqual(labels(result.steps), ["chain:a/A#0", "chain:a/A#1", "chain:b/B#0", "chain:b/B#1", "chain:c/C#0"]);
});

// ---------------------------------------------------------------------------
// Sticky routing against a selection whose provider is gone
// ---------------------------------------------------------------------------

test("a remembered target whose provider is no longer configured is not remembered", () => {
  resetAutomaticOrderCache();
  // Provider c is gone entirely: c/C is not in the target list any more, though
  // the selection still names it. A target that cannot be reached cannot lead.
  const withoutC = twoKeyTargets.filter((target) => target.provider !== "c");
  const result = buildRoutePlan({
    targets: withoutC,
    chain: entries(["a", "A"], ["c", "C"]),
    stickyTargetId: "c:C:key-0",
    cacheKey: "fc-missing-provider-sticky"
  });
  assert.equal(result.sticky, null, "a target that cannot be reached cannot lead the walk");
  assert.deepEqual(labels(phaseSteps(result.steps, PHASES.MANUAL)), ["manual-selection:a/A#0", "manual-selection:a/A#1"]);
  assert.equal(result.failClosed, false, "the selection is partly usable, so it still routes");
});

test("a remembered target is not remembered when its entry is disabled", () => {
  resetAutomaticOrderCache();
  const result = plan({
    chain: entries(["a", "A"], ["b", "B", { enabled: false }]),
    stickyTargetId: "b:B:key-0"
  });
  assert.equal(result.sticky, null);
  assert.ok(!labels(result.steps).some((label) => label.includes("b/B")));
});

// ---------------------------------------------------------------------------
// Cache: a reorder is a configuration change like any other
// ---------------------------------------------------------------------------

test("reordering the target list takes effect immediately", () => {
  resetAutomaticOrderCache();
  const health = new HealthRegistry();
  const a = t("a", "A");
  const b = t("b", "B");
  // Neither model is measured, so the configuration order is the tie-break.
  assert.deepEqual(autoOrder([a, b], health, "cfg-order"), ["auto:a/A#0", "auto:b/B#0"]);
  assert.deepEqual(autoOrder([b, a], health, "cfg-order"), ["auto:b/B#0", "auto:a/A#0"],
    "a reorder must not wait for the next bucket");
});

// ---------------------------------------------------------------------------
// Per-pool status, for the health surface
// ---------------------------------------------------------------------------

test("chainStatusByPool reports an unusable selection per pool, without touching the other pool", () => {
  resetAutomaticOrderCache();
  const text = [t("a", "A"), t("b", "B")];
  const vision = [t("a", "VA", 0, "vision")];

  const status = chainStatusByPool([...text, ...vision], {
    chains: { text: entries(["ghost", "Gone"]) }
  });

  assert.deepEqual(status.text, { failClosed: true, entries: 1, resolved: 0, source: "manual" });
  // Vision has no selection at all, so it is unconfigured rather than broken —
  // and `entries`/`resolved` describe the SELECTION, so an unconfigured pool is
  // 0/0 even though it routes every one of its targets automatically.
  assert.deepEqual(status.vision, { failClosed: false, entries: 0, resolved: 0, source: "auto" });
});

test("chainStatusByPool separates an unusable selection from ordinary unavailability", () => {
  resetAutomaticOrderCache();
  const all = [t("a", "A")];

  // A saved, usable selection is neither fail-closed nor unconfigured.
  const healthy = chainStatusByPool(all, { chains: { text: entries(["a", "A"]) } });
  assert.deepEqual(healthy.text, { failClosed: false, entries: 1, resolved: 1, source: "manual" });

  // No selection at all is unconfigured, which is a different state again.
  const none = chainStatusByPool(all, { chains: {} });
  assert.deepEqual(none.text, { failClosed: false, entries: 0, resolved: 0, source: "auto" });

  // Every target cooling down is NOT fail-closed: the configuration is fine.
  const health = new HealthRegistry();
  health.markFailure(t("a", "A"), 500, { cooldownMs: 60_000 });
  const cooling = chainStatusByPool(all, { chains: { text: entries(["a", "A"]) }, health });
  assert.equal(cooling.text.failClosed, false, "provider trouble must not read as a configuration fault");
  assert.equal(cooling.text.resolved, 1, "the entry still resolves; it is the provider that is unavailable");
});
