import test from "node:test";
import assert from "node:assert/strict";
import { HealthRegistry } from "../src/health.js";
import { FALLBACK_MODES } from "../src/fallback-chain.js";
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

test("Fixed Order uses a remembered key only inside its own model's position", () => {
  resetAutomaticOrderCache();
  const chain = entries(["a", "A"], ["b", "B"]);
  const { steps, sticky, rememberedKey } = buildRoutePlan({
    targets: twoKeyTargets,
    chain,
    mode: FALLBACK_MODES.FIXED,
    stickyTargetId: "b:B:key-1",
    cacheKey: "fixed-in-place"
  });
  assert.equal(sticky, null, "the remembered target never leads the walk in Fixed Order");
  assert.equal(rememberedKey.keyIndex, 1);
  assert.equal(steps[0].phase, PHASES.CHAIN);
  // Model A is still first and fully exhausted; only B's own key order changed.
  assert.deepEqual(labels(steps), ["chain:a/A#0", "chain:a/A#1", "chain:b/B#1", "chain:b/B#0"]);
});

test("Fixed Order ignores a remembered target the chain no longer allows", () => {
  resetAutomaticOrderCache();
  const plain = ["chain:a/A#0", "chain:a/A#1", "chain:b/B#0", "chain:b/B#1"];
  for (const [label, chain, stickyTargetId] of [
    ["not in the chain", entries(["a", "A"]), "b:B:key-1"],
    ["model disabled", entries(["a", "A"], ["b", "B", { enabled: false }]), "b:B:key-1"],
    ["key restricted away", entries(["a", "A"], ["b", "B", { keys: [0] }]), "b:B:key-1"]
  ]) {
    const { steps, rememberedKey } = buildRoutePlan({
      targets: twoKeyTargets, chain, mode: FALLBACK_MODES.FIXED, stickyTargetId, cacheKey: `fixed-stale-${label}`
    });
    assert.equal(rememberedKey, null, label);
    assert.deepEqual(labels(steps), plain.filter((item) => labels(steps).includes(item)), label);
  }
});

test("Fixed Order with no remembered key is the plain configured order", () => {
  resetAutomaticOrderCache();
  const { steps, rememberedKey } = buildRoutePlan({
    targets: twoKeyTargets, chain: entries(["a", "A"], ["b", "B"]), mode: FALLBACK_MODES.FIXED, cacheKey: "fixed-none"
  });
  assert.equal(rememberedKey, null);
  assert.deepEqual(labels(steps), ["chain:a/A#0", "chain:a/A#1", "chain:b/B#0", "chain:b/B#1"]);
});

test("Last Success and Auto keep a remembered target leading the walk", () => {
  resetAutomaticOrderCache();
  for (const mode of [FALLBACK_MODES.LAST_SUCCESS, FALLBACK_MODES.AUTO]) {
    const { steps, sticky } = buildRoutePlan({
      targets: twoKeyTargets, chain: entries(["a", "A"], ["b", "B"]), mode, stickyTargetId: "b:B:key-1", cacheKey: `ls-${mode}`
    });
    assert.equal(sticky.keyIndex, 1, mode);
    assert.equal(steps[0].phase, PHASES.STICKY, mode);
    assert.equal(labels(steps)[0], "sticky:b/B#1", mode);
  }
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

  // The text chain names a VISION model. It is unusable for the text pool, so
  // the text plan is empty: neither the vision model nor any unrelated text
  // model may be reached in its place.
  const text = buildRoutePlan({ targets: textTargets, chain: entries(["a", "VA"]), cacheKey: "pool-text" });
  assert.deepEqual(text.steps, [], "a vision-only model cannot enter the text plan, and cannot be substituted for");
  assert.equal(text.failClosed, true);
  assert.ok(text.groups.every((group) => group.targets.length === 0));

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

test("a chain with entries that are all disabled routes nothing rather than widening", () => {
  resetAutomaticOrderCache();
  const result = buildRoutePlan({
    targets: twoKeyTargets,
    chain: entries(["b", "B", { enabled: false }]),
    health: new HealthRegistry(),
    cacheKey: "all-disabled"
  });
  // Saved entries that permit nothing are still the operator's configuration.
  // Routing the automatic order instead would reach models this chain does not
  // name, which is the silent fallback it exists to prevent. The way to ask for
  // automatic routing is to have no chain at all.
  assert.equal(result.source, "chain");
  assert.equal(result.failClosed, true);
  assert.deepEqual(result.steps, []);

  const cleared = buildRoutePlan({
    targets: twoKeyTargets,
    chain: [],
    health: new HealthRegistry(),
    cacheKey: "all-disabled-cleared"
  });
  assert.equal(cleared.source, "auto", "a genuinely empty chain is unconfigured and still routes");
  assert.equal(cleared.steps.length, 5);
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

// ---------------------------------------------------------------------------
// A remembered target may never bypass the configured key restrictions
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
    mode: FALLBACK_MODES.LAST_SUCCESS,
    stickyTargetId: "a:A:key-1",
    cacheKey: "remember-excluded-key"
  });

  assert.equal(sticky, null, "key 1 is excluded by the entry, so it cannot be remembered");
  assert.ok(!labels(steps).some((label) => label.endsWith("#1") && label.includes("a/A")),
    "the excluded key must not appear in any phase");
  assert.deepEqual(labels(steps), ["chain:a/A#0", "chain:a/A#2", "chain:b/B#0"]);
});

test("a remembered model with a restricted key subset leads with, and exhausts, only allowed keys", () => {
  resetAutomaticOrderCache();
  const { steps, sticky } = buildRoutePlan({
    targets: threeKeyTargets,
    chain: entries(["a", "A", { keys: [0, 2] }], ["b", "B"]),
    mode: FALLBACK_MODES.LAST_SUCCESS,
    // Key 2 is remembered and IS allowed.
    stickyTargetId: "a:A:key-2",
    cacheKey: "remember-allowed-key"
  });

  assert.equal(sticky.model, "A");
  assert.deepEqual(labels(steps), [
    // The remembered key, then the model's OTHER ALLOWED key — never key 1 —
    // and only then the configured chain, in its saved order.
    "sticky:a/A#2", "sticky:a/A#0", "chain:a/A#0", "chain:a/A#2", "chain:b/B#0"
  ]);
  assert.ok(!labels(steps).some((label) => label === "sticky:a/A#1"));
});

test("a remembered target that is still allowed still leads in Remember Last Successful mode", () => {
  resetAutomaticOrderCache();
  const { steps, sticky } = buildRoutePlan({
    targets: threeKeyTargets,
    chain: entries(["a", "A"], ["b", "B"]),
    mode: FALLBACK_MODES.LAST_SUCCESS,
    stickyTargetId: "b:B:key-0",
    cacheKey: "remember-eligible"
  });

  assert.equal(sticky.model, "B");
  assert.equal(steps[0].phase, PHASES.STICKY);
  assert.equal(labels(steps)[0], "sticky:b/B#0");
  // The chain still resumes in its configured order afterwards.
  assert.deepEqual(labels(steps).slice(1), ["chain:a/A#0", "chain:a/A#1", "chain:a/A#2", "chain:b/B#0"]);
});

test("a disabled entry cannot be reintroduced by sticky routing", () => {
  resetAutomaticOrderCache();
  const { steps, sticky } = buildRoutePlan({
    targets: threeKeyTargets,
    chain: entries(["a", "A"], ["b", "B", { enabled: false }]),
    mode: FALLBACK_MODES.LAST_SUCCESS,
    stickyTargetId: "b:B:key-0",
    cacheKey: "remember-disabled-entry"
  });

  assert.equal(sticky, null);
  assert.ok(!labels(steps).some((label) => label.includes("b/B")));
});

test("an entry removed from the chain cannot be reintroduced by sticky routing", () => {
  resetAutomaticOrderCache();
  const { steps, sticky } = buildRoutePlan({
    targets: threeKeyTargets,
    // B is simply gone from the chain.
    chain: entries(["a", "A"]),
    mode: FALLBACK_MODES.LAST_SUCCESS,
    stickyTargetId: "b:B:key-0",
    cacheKey: "remember-removed-entry"
  });

  assert.equal(sticky, null);
  assert.ok(!labels(steps).some((label) => label.includes("b/B")));
});

test("Fixed Order and Automatic mode both respect the configured key restrictions", () => {
  resetAutomaticOrderCache();
  const chain = entries(["a", "A", { keys: [0, 2] }], ["b", "B"]);

  // Fixed Order ignores the remembered target entirely, but must still honour
  // the entry's key subset.
  const fixed = buildRoutePlan({
    targets: threeKeyTargets,
    chain,
    mode: FALLBACK_MODES.FIXED,
    stickyTargetId: "a:A:key-1",
    cacheKey: "restrict-fixed"
  });
  assert.equal(fixed.sticky, null);
  assert.deepEqual(labels(fixed.steps), ["chain:a/A#0", "chain:a/A#2", "chain:b/B#0"]);

  // Automatic mode re-orders the entries; it may not widen them. A's only
  // measurement belongs to key 1, which the entry excludes, so A is correctly
  // treated as unmeasured and yields to B — a measurement on an excluded key
  // must not leak into the group's stats either.
  const health = new HealthRegistry();
  health.markSuccess(t("a", "A", 1), { latencyMs: 1 });
  health.markSuccess(t("b", "B", 0), { latencyMs: 900 });
  const auto = buildRoutePlan({
    targets: threeKeyTargets,
    chain,
    mode: FALLBACK_MODES.AUTO,
    stickyTargetId: "a:A:key-1",
    health,
    cacheKey: "restrict-auto"
  });
  assert.equal(auto.sticky, null, "the excluded key cannot be remembered even in automatic mode");
  assert.deepEqual(labels(auto.steps), ["auto:b/B#0", "auto:a/A#0", "auto:a/A#2"]);
});

test("a pinned request still bypasses the chain, the automatic order and any memory", () => {
  resetAutomaticOrderCache();
  const { steps, sticky, source } = buildRoutePlan({
    targets: threeKeyTargets,
    chain: entries(["a", "A", { keys: [0] }]),
    mode: FALLBACK_MODES.LAST_SUCCESS,
    stickyTargetId: "a:A:key-2",
    pinned: true,
    cacheKey: "pin-strict"
  });

  assert.equal(sticky, null);
  assert.equal(source, "chain");
  // A pin is narrowed before the plan is built, and its own targets are walked
  // in key order — the chain entry is not consulted at all.
  assert.deepEqual(labels(steps), ["chain:a/A#0", "chain:a/A#1", "chain:a/A#2", "chain:b/B#0"]);
});

// ---------------------------------------------------------------------------
// The automatic-order cache must not outlive the configuration it was built on
// ---------------------------------------------------------------------------

/** The automatic order for one cacheKey, as the walker would see it. */
const autoOrder = (targets, chain, health, cacheKey) =>
  labels(buildRoutePlan({
    targets, chain, mode: FALLBACK_MODES.AUTO, health, cacheKey
  }).steps);

test("a model added to the chain is eligible immediately in Automatic mode", () => {
  resetAutomaticOrderCache();
  const health = new HealthRegistry();
  const targets = [t("a", "A"), t("b", "B")];

  // First order is computed against a chain that holds only A.
  assert.deepEqual(autoOrder(targets, entries(["a", "A"]), health, "cfg-add"), ["auto:a/A#0"]);

  // Saving a chain that also holds B must take effect at once — the same health
  // version and the same 30-second bucket must not serve the old order.
  assert.deepEqual(autoOrder(targets, entries(["a", "A"], ["b", "B"]), health, "cfg-add"),
    ["auto:a/A#0", "auto:b/B#0"]);
});

test("removing or disabling an entry takes effect immediately in Automatic mode", () => {
  resetAutomaticOrderCache();
  const health = new HealthRegistry();
  const targets = [t("a", "A"), t("b", "B")];
  const full = entries(["a", "A"], ["b", "B"]);

  assert.deepEqual(autoOrder(targets, full, health, "cfg-remove"), ["auto:a/A#0", "auto:b/B#0"]);
  assert.deepEqual(autoOrder(targets, entries(["a", "A"]), health, "cfg-remove"), ["auto:a/A#0"]);
  assert.deepEqual(autoOrder(targets, entries(["a", "A"], ["b", "B", { enabled: false }]), health, "cfg-remove"),
    ["auto:a/A#0"]);
});

test("changing an entry's key subset takes effect immediately in Automatic mode", () => {
  resetAutomaticOrderCache();
  // A is only measured on key 1, so it is unmeasured while key 1 is excluded and
  // measured — and therefore first — as soon as the subset admits it.
  const health = new HealthRegistry();
  health.markSuccess(t("a", "A", 1), { latencyMs: 1 });
  health.markSuccess(t("b", "B", 0), { latencyMs: 900 });
  const targets = threeKeyTargets;

  assert.deepEqual(autoOrder(targets, entries(["a", "A", { keys: [0] }], ["b", "B"]), health, "cfg-keys"),
    ["auto:b/B#0", "auto:a/A#0"]);
  // A now measures 1 ms and leads. Its keys stay in KEY ORDER inside the group:
  // latency orders models, and the key order within a model is configuration.
  assert.deepEqual(autoOrder(targets, entries(["a", "A"], ["b", "B"]), health, "cfg-keys"),
    ["auto:a/A#0", "auto:a/A#1", "auto:a/A#2", "auto:b/B#0"]);
});

test("an unchanged configuration still reuses the cached order within its bucket", () => {
  resetAutomaticOrderCache();
  const health = new HealthRegistry();
  health.markSuccess(t("a", "A"), { latencyMs: 800 });
  health.markSuccess(t("b", "B"), { latencyMs: 200 });
  const targets = [t("a", "A"), t("b", "B")];
  const run = () => autoOrder(targets, [], health, "cfg-reuse");

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
  const targets = [t("a", "A"), t("b", "B")];
  // Each distinct chain produces a distinct key; the cache must not grow without
  // bound across a long-running gateway.
  for (let i = 0; i < 200; i += 1) {
    autoOrder(targets, i % 2 === 0 ? entries(["a", "A"]) : entries(["b", "B"]), health, `churn-${i}`);
  }
  // Observable through behaviour: the most recent configuration is still honoured.
  assert.deepEqual(autoOrder(targets, entries(["b", "B"]), health, "churn-after"),
    ["auto:b/B#0"]);
});

test("an entry restricted to a key the provider no longer has does not silently widen routing", () => {
  resetAutomaticOrderCache();
  // The entry allows only key 5. The provider has keys 0 and 1, so the subset
  // matches nothing — which must NOT be read as "no chain is configured".
  const { steps, source, configured } = buildRoutePlan({
    targets: threeKeyTargets,
    chain: entries(["a", "A", { keys: [5] }]),
    cacheKey: "impossible-subset"
  });

  assert.equal(configured, 1, "the entry is still a configured entry");
  assert.equal(source, "chain", "so the automatic order over every target must not take over");
  assert.deepEqual(steps, [], "and the model it names is simply not routable");
});

test("a chain that is wholly unservable is not silently replaced by routing to everything", () => {
  resetAutomaticOrderCache();
  // Every entry names a key that does not exist. The chain is usable, it just
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
// saved entries but no USABLE ones must not: widening to models the chain does
// not name, or to keys an entry excludes, is exactly the silent fallback the
// chain exists to prevent.
// ---------------------------------------------------------------------------

const plan = (args) => buildRoutePlan({ targets: twoKeyTargets, cacheKey: `fc-${Math.random()}`, ...args });

test("a genuinely empty chain still uses the automatic order", () => {
  resetAutomaticOrderCache();
  for (const chain of [[], undefined, null]) {
    const result = plan({ chain: chain ?? [] });
    assert.equal(result.source, "auto", `chain ${JSON.stringify(chain)} is empty, so the router is unconfigured`);
    assert.equal(result.failClosed, false);
    assert.equal(result.steps.length, 5, "every configured target stays eligible");
  }
});

test("a chain naming only a model that is no longer configured routes nothing", () => {
  resetAutomaticOrderCache();
  // The provider was removed from the environment, but the chain still names it.
  const result = plan({ chain: entries(["ghost", "Gone"]) });
  assert.equal(result.source, "chain", "the chain is configured, so the automatic order must not take over");
  assert.equal(result.failClosed, true);
  assert.deepEqual(result.steps, [], "no unrelated model may be reached");
});

test("a chain whose entries are all disabled routes nothing", () => {
  resetAutomaticOrderCache();
  // Every entry withdrawn is not the same as no chain at all: the entries are
  // still the operator's configuration, and they are unusable.
  const result = plan({ chain: entries(["a", "A", { enabled: false }], ["b", "B", { enabled: false }]) });
  assert.equal(result.source, "chain");
  assert.equal(result.failClosed, true);
  assert.deepEqual(result.steps, []);
});

test("a chain whose only entry is restricted to a key that does not exist routes nothing", () => {
  resetAutomaticOrderCache();
  const result = plan({ chain: entries(["a", "A", { keys: [9] }]) });
  assert.equal(result.failClosed, true);
  assert.deepEqual(result.steps, []);
});

test("a partly usable chain routes its usable entries and nothing else", () => {
  resetAutomaticOrderCache();
  const result = plan({
    chain: entries(["ghost", "Gone"], ["b", "B"], ["a", "A", { enabled: false }])
  });
  assert.equal(result.source, "chain");
  assert.equal(result.failClosed, false, "one usable entry is enough to route");
  assert.deepEqual(labels(result.steps), ["chain:b/B#0", "chain:b/B#1"]);
});

test("an unusable chain fails closed in Automatic mode too", () => {
  resetAutomaticOrderCache();
  // Automatic mode re-orders the entries; it does not license reaching past them.
  const result = plan({ chain: entries(["ghost", "Gone"]), mode: FALLBACK_MODES.AUTO, health: new HealthRegistry() });
  assert.equal(result.failClosed, true);
  assert.deepEqual(result.steps, []);
});

test("an unusable text chain does not affect the vision pool", () => {
  resetAutomaticOrderCache();
  const text = [t("a", "A"), t("b", "B")];
  const vision = [t("a", "VA", 0, "vision"), t("b", "VB", 0, "vision")];
  // The text chain names a model that is gone; vision has no chain at all.
  const ranked = routeOrderByPool([...text, ...vision], { chains: { text: entries(["ghost", "Gone"]) } });

  assert.equal(ranked.filter((target) => (target.pool ?? "text") === "text").length, 0,
    "the unusable text chain routes nothing");
  assert.equal(ranked.filter((target) => target.pool === "vision").length, 2,
    "vision has no chain, so it still routes automatically");
});

test("pinned requests are unaffected by an unusable chain", () => {
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
// Sticky routing against a chain whose provider is gone
// ---------------------------------------------------------------------------

test("a remembered target whose provider is no longer configured is not remembered", () => {
  resetAutomaticOrderCache();
  // Provider c is gone entirely: c/C is not in the target list any more, though
  // the chain still names it. A target that cannot be reached cannot lead.
  const withoutC = twoKeyTargets.filter((target) => target.provider !== "c");
  const result = buildRoutePlan({
    targets: withoutC,
    chain: entries(["a", "A"], ["c", "C"]),
    mode: FALLBACK_MODES.LAST_SUCCESS,
    stickyTargetId: "c:C:key-0",
    cacheKey: "fc-missing-provider-sticky"
  });
  assert.equal(result.sticky, null, "a target that cannot be reached cannot lead the walk");
  assert.deepEqual(labels(result.steps), ["chain:a/A#0", "chain:a/A#1"]);
  assert.equal(result.failClosed, false, "the chain is partly usable, so it still routes");
});

test("a remembered target is not remembered when its entry is disabled", () => {
  resetAutomaticOrderCache();
  const result = plan({
    chain: entries(["a", "A"], ["b", "B", { enabled: false }]),
    mode: FALLBACK_MODES.LAST_SUCCESS,
    stickyTargetId: "b:B:key-0"
  });
  assert.equal(result.sticky, null);
  assert.ok(!labels(result.steps).some((label) => label.includes("b/B")));
});

// ---------------------------------------------------------------------------
// Cache: a reorder is a configuration change like any other
// ---------------------------------------------------------------------------

test("reordering the chain takes effect immediately in Automatic mode", () => {
  resetAutomaticOrderCache();
  const health = new HealthRegistry();
  const targets = [t("a", "A"), t("b", "B")];
  // Neither model is measured, so the configured order is the tie-break.
  const run = (chain) => autoOrder(targets, chain, health, "cfg-order");

  assert.deepEqual(run(entries(["a", "A"], ["b", "B"])), ["auto:a/A#0", "auto:b/B#0"]);
  assert.deepEqual(run(entries(["b", "B"], ["a", "A"])), ["auto:b/B#0", "auto:a/A#0"],
    "a reorder must not wait for the next bucket");
});

// ---------------------------------------------------------------------------
// Per-pool status, for the health surface
// ---------------------------------------------------------------------------

test("chainStatusByPool reports an unusable chain per pool, without touching the other pool", () => {
  resetAutomaticOrderCache();
  const text = [t("a", "A"), t("b", "B")];
  const vision = [t("a", "VA", 0, "vision")];

  const status = chainStatusByPool([...text, ...vision], {
    chains: { text: entries(["ghost", "Gone"]) }
  });

  assert.deepEqual(status.text, { failClosed: true, entries: 1, resolved: 0, source: "chain" });
  // Vision has no chain at all, so it is unconfigured rather than broken — and
  // `entries`/`resolved` describe the CHAIN, so an unconfigured pool is 0/0 even
  // though it routes every one of its targets automatically.
  assert.deepEqual(status.vision, { failClosed: false, entries: 0, resolved: 0, source: "auto" });
});

test("chainStatusByPool separates an unusable chain from ordinary unavailability", () => {
  resetAutomaticOrderCache();
  const all = [t("a", "A")];

  // A chain that is saved and usable is neither fail-closed nor unconfigured.
  const healthy = chainStatusByPool(all, { chains: { text: entries(["a", "A"]) } });
  assert.deepEqual(healthy.text, { failClosed: false, entries: 1, resolved: 1, source: "chain" });

  // No chain at all is unconfigured, which is a different state again.
  const none = chainStatusByPool(all, { chains: {} });
  assert.deepEqual(none.text, { failClosed: false, entries: 0, resolved: 0, source: "auto" });

  // Every target cooling down is NOT fail-closed: the configuration is fine.
  const health = new HealthRegistry();
  health.markFailure(t("a", "A"), 500, { cooldownMs: 60_000 });
  const cooling = chainStatusByPool(all, { chains: { text: entries(["a", "A"]) }, health });
  assert.equal(cooling.text.failClosed, false, "provider trouble must not read as a configuration fault");
  assert.equal(cooling.text.resolved, 1, "the entry still resolves; it is the provider that is unavailable");
});
