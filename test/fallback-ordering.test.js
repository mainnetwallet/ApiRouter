import test from "node:test";
import assert from "node:assert/strict";
import { HealthRegistry } from "../src/health.js";
import { FALLBACK_MODES } from "../src/fallback-chain.js";
import {
  PHASES,
  buildRoutePlan,
  effectiveOrder,
  groupLatency,
  groupTargets,
  modelLatency,
  resetAutomaticOrderCache,
  routeOrderByPool
} from "../src/fallback-plan.js";
import { describeRouting } from "../src/observability/router-preview.js";
import { RouteSession, withFallback } from "../src/router.js";
import { createApi } from "../src/api.js";

/**
 * Fallback ordering regressions.
 *
 * Manual Model Selection walks the operator's selected models first, in exactly
 * the saved order and whatever their latency, and only then every model that was
 * NOT selected, from the lowest measured latency to the highest, never-measured
 * models last. The router, the preview and the Fallback UI's catalogue must all
 * speak about the same order and the same latency number, for Text and Vision
 * alike, so each of those is pinned here against the one shared planner.
 */

const MIN = 60 * 1000;
const BASE = Math.floor(Date.now() / 30_000) * 30_000 + 1_000;
const PROTOCOL = "openai-chat";

const tid = (pool, provider, model, keyIndex) =>
  (pool === "vision" ? { id: `vision:${provider}:${model}:key-${keyIndex}` } : {});
const t = (provider, model, keyIndex = 0, pool = "text") => ({
  ...tid(pool, provider, model, keyIndex),
  provider,
  model,
  keyIndex,
  pool,
  protocols: [PROTOCOL]
});
const entry = (provider, model, extra = {}) => ({ provider, model, keys: null, enabled: true, ...extra });
const label = (target) => `${target.provider}/${target.model}#${target.keyIndex}`;
const labels = (steps) => steps.map((step) => label(step.target));
const phase = (plan, name) => plan.steps.filter((step) => step.phase === name);
const modelsOf = (steps) => [...new Set(steps.map((step) => `${step.target.provider}/${step.target.model}`))];

let clock = 0;
/** Records a measurement; observation times only ever move forward. */
function measure(health, target, ms, source = "request") {
  clock += 1;
  health.markSuccess(target, { latencyMs: ms, source }, BASE + clock);
}

let cacheId = 0;
function plan(overrides = {}) {
  resetAutomaticOrderCache();
  return buildRoutePlan({
    now: BASE + 5_000,
    cacheKey: `ordering-${(cacheId += 1)}`,
    ...overrides
  });
}

/**
 * One pool's worth of scenario. Provider names repeat on purpose (the selection
 * interleaves "gemini" and "groq"; "gemini" also owns an UNSELECTED model), the
 * list puts unselected models first, and the SELECTED models carry the worst
 * latencies, so any sort that touched them, or followed list order, would show.
 */
function scenario(pool) {
  const targets = [
    t("gemini", "U-slow", 0, pool),
    t("gemini", "U-fast", 0, pool), t("gemini", "U-fast", 1, pool),
    t("openrouter", "U-mid", 0, pool),
    t("cerebras", "U-probe", 0, pool),
    t("mistral", "U-never-1", 0, pool),
    t("sambanova", "U-never-2", 0, pool),
    t("gemini", "S-3", 0, pool), t("gemini", "S-3", 1, pool),
    t("groq", "S-1", 0, pool),
    t("gemini", "S-2", 0, pool)
  ];
  const chain = [entry("groq", "S-1"), entry("gemini", "S-2"), entry("gemini", "S-3")];
  const health = new HealthRegistry();
  const at = (provider, model, key = 0) => targets.find((x) => x.provider === provider && x.model === model && x.keyIndex === key);
  // Selected models: the SLOWEST and the FASTEST of all must not matter.
  measure(health, at("groq", "S-1"), 9_000);
  measure(health, at("gemini", "S-2"), 5);
  measure(health, at("gemini", "S-3"), 4_000);
  // Unselected: deliberately not in latency order in the target list.
  measure(health, at("gemini", "U-slow"), 2_500);
  measure(health, at("openrouter", "U-mid"), 700);
  measure(health, at("gemini", "U-fast", 0), 600);   // key 0 slower than key 1:
  measure(health, at("gemini", "U-fast", 1), 40);    // the MODEL is 40 ms
  measure(health, at("cerebras", "U-probe"), 300, "probe");
  return { targets, chain, health, pool };
}

const SELECTED_ORDER = ["groq/S-1#0", "gemini/S-2#0", "gemini/S-3#0", "gemini/S-3#1"];
const HEALTH_ORDER = [
  "gemini/U-fast#0", "gemini/U-fast#1", // 40 ms (best key)
  "cerebras/U-probe#0",                 // 300 ms (probe)
  "openrouter/U-mid#0",                 // 700 ms
  "gemini/U-slow#0",                    // 2500 ms
  "mistral/U-never-1#0",                // never measured: last, in configuration order
  "sambanova/U-never-2#0"
];

// ---------------------------------------------------------------------------
// 1. Selected models first, in the saved order, whatever their latency
// ---------------------------------------------------------------------------

test("selected models come first in exactly the saved order, regardless of latency", () => {
  const { targets, chain, health } = scenario("text");
  const p = plan({ targets, chain, health });
  assert.deepEqual(labels(phase(p, PHASES.MANUAL)), SELECTED_ORDER);

  // The first batch of the whole walk is the selection; no unselected model leads.
  const firstBatch = p.steps.slice(0, SELECTED_ORDER.length);
  assert.deepEqual(labels(firstBatch), SELECTED_ORDER);
  assert.ok(firstBatch.every((step) => step.phase === PHASES.MANUAL));

  // Reversing the saved order reverses the walk: nothing sorts the selection.
  const reversed = plan({ targets, chain: [...chain].reverse(), health });
  assert.deepEqual(modelsOf(phase(reversed, PHASES.MANUAL)), ["gemini/S-3", "gemini/S-2", "groq/S-1"]);
});

test("the selection keeps its position when its own latency changes", () => {
  const { targets, chain, health } = scenario("text");
  const before = labels(phase(plan({ targets, chain, health }), PHASES.MANUAL));
  measure(health, targets.find((x) => x.model === "S-1"), 1);
  measure(health, targets.find((x) => x.model === "S-2"), 99_000);
  assert.deepEqual(labels(phase(plan({ targets, chain, health }), PHASES.MANUAL)), before);
});

// ---------------------------------------------------------------------------
// 2. Unselected models: ascending latency, unmeasured last
// ---------------------------------------------------------------------------

test("unselected models follow the selection by ascending measured latency, unmeasured last", () => {
  const { targets, chain, health } = scenario("text");
  const p = plan({ targets, chain, health });
  assert.deepEqual(labels(phase(p, PHASES.HEALTH)), HEALTH_ORDER);

  // The model's latency is its best key's, and every key of a model stays together in key order.
  const fast = labels(phase(p, PHASES.HEALTH)).filter((id) => id.startsWith("gemini/U-fast"));
  assert.deepEqual(fast, ["gemini/U-fast#0", "gemini/U-fast#1"]);
});

test("the unselected order is non-decreasing in the number it is sorted on", () => {
  const { targets, chain, health } = scenario("text");
  const p = plan({ targets, chain, health });
  const groups = groupTargets(targets);
  const figures = modelsOf(phase(p, PHASES.HEALTH)).map((id) => groupLatency(groups.get(id), health).latencyMs);
  const measured = figures.filter((value) => value !== null);
  assert.deepEqual(measured, [...measured].sort((a, b) => a - b));
  assert.deepEqual(figures.slice(measured.length), [null, null], "never-measured models come after every measured one");
});

test("a request measurement outranks a probe measurement for the same key, and neither is invented", () => {
  const health = new HealthRegistry();
  measure(health, t("a", "A"), 900, "request");
  measure(health, t("a", "A"), 10, "probe"); // newer, faster probe: does not replace the request figure
  assert.deepEqual(modelLatency([health.get("a:A:key-0")]), { latencyMs: 900, source: "request" });
  assert.deepEqual(modelLatency([health.get("never:seen:key-0")]), { latencyMs: null, source: null });
  assert.deepEqual(modelLatency([]), { latencyMs: null, source: null });
});

test("a cooling model yields to available ones in the unselected batch, and is never walked", async () => {
  const { targets, chain, health } = scenario("text");
  const fast = targets.filter((x) => x.model === "U-fast");
  for (const target of fast) health.markFailure(target, 500, { cooldownMs: 10 * MIN }, BASE + 3_000);
  const p = plan({ targets, chain, health });
  const order = labels(phase(p, PHASES.HEALTH));
  assert.deepEqual(order.slice(0, 2), ["cerebras/U-probe#0", "openrouter/U-mid#0"]);

  const calls = [];
  await assert.rejects(withFallback(targets, async (target) => {
    calls.push(label(target));
    throw Object.assign(new Error("boom"), { status: 500 });
  }, new Set([500]), new RouteSession(), health, { plan: p.steps }));
  assert.ok(!calls.includes("gemini/U-fast#0") && !calls.includes("gemini/U-fast#1"), "a target in an active cooldown is never called");
});

test("a cooldown that lapses mid-bucket is reflected at once, identically for every caller", () => {
  const { targets, chain, health } = scenario("text");
  const fast = targets.filter((x) => x.model === "U-fast");
  for (const target of fast) health.markFailure(target, 500, { cooldownMs: 4_000 }, BASE + 100);

  const during = plan({ targets, chain, health, now: BASE + 2_000, cacheKey: "shared" });
  assert.notEqual(labels(phase(during, PHASES.HEALTH))[0], "gemini/U-fast#0");

  // Same cache namespace, same health version, same 30 s bucket — later moment.
  const after = buildRoutePlan({ targets, chain, health, now: BASE + 10_000, cacheKey: "shared" });
  resetAutomaticOrderCache();
  const fresh = buildRoutePlan({ targets, chain, health, now: BASE + 10_000, cacheKey: "fresh" });
  assert.deepEqual(labels(phase(after, PHASES.HEALTH)), HEALTH_ORDER);
  assert.deepEqual(labels(phase(after, PHASES.HEALTH)), labels(phase(fresh, PHASES.HEALTH)));
});

// ---------------------------------------------------------------------------
// 3. Text / Vision parity and independence
// ---------------------------------------------------------------------------

test("Text and Vision are ordered by the same logic", () => {
  const text = scenario("text");
  const vision = scenario("vision");
  const textPlan = plan({ ...text });
  const visionPlan = plan({ ...vision });
  assert.deepEqual(labels(textPlan.steps), labels(visionPlan.steps));
  assert.deepEqual(textPlan.steps.map((s) => s.phase), visionPlan.steps.map((s) => s.phase));
  assert.deepEqual(labels(phase(visionPlan, PHASES.MANUAL)), SELECTED_ORDER);
  assert.deepEqual(labels(phase(visionPlan, PHASES.HEALTH)), HEALTH_ORDER);
});

test("Text and Vision keep their own chains, targets and health, even for the same model", () => {
  const targets = [
    t("a", "M1", 0, "text"), t("a", "M2", 0, "text"), t("a", "M3", 0, "text"),
    t("a", "M1", 0, "vision"), t("a", "M2", 0, "vision"), t("a", "M3", 0, "vision")
  ];
  const health = new HealthRegistry();
  // Text: M2 is fastest. Vision: M3 is fastest. Same provider/model names.
  measure(health, targets[0], 300); measure(health, targets[1], 20); measure(health, targets[2], 900);
  measure(health, targets[3], 300); measure(health, targets[4], 900); measure(health, targets[5], 20);
  const chains = { text: [entry("a", "M1")], vision: [] };

  const text = targets.filter((x) => x.pool === "text");
  const vision = targets.filter((x) => x.pool === "vision");
  const textPlan = plan({ targets: text, chain: chains.text, health });
  assert.deepEqual(labels(textPlan.steps.filter((s) => !s.retry)), ["a/M1#0", "a/M2#0", "a/M3#0"]);

  // Vision has no chain, so it is ordered purely automatically — by ITS OWN latencies.
  const visionPlan = plan({ targets: vision, chain: chains.vision, health });
  assert.deepEqual(labels(visionPlan.steps), ["a/M3#0", "a/M1#0", "a/M2#0"]);

  // A failure in Vision never cools Text, and vice versa.
  health.markFailure(vision[2], 500, { cooldownMs: MIN }, BASE + 4_000);
  assert.ok(health.isAvailable(text[2], BASE + 4_500));
  const mixed = routeOrderByPool(targets, { chains, health, now: BASE + 4_500, isEligible: (x) => health.isAvailable(x, BASE + 4_500) });
  assert.deepEqual(mixed.filter((x) => x.pool === "text").map(label), ["a/M1#0", "a/M2#0", "a/M3#0"]);
  assert.deepEqual(mixed.filter((x) => x.pool === "vision").map(label), ["a/M1#0", "a/M2#0"]);
});

// ---------------------------------------------------------------------------
// 4. Preview and router describe the same order and the same numbers
// ---------------------------------------------------------------------------

for (const pool of ["text", "vision"]) {
  test(`${pool}: the preview lists the order the plan, and the walker, actually use`, async () => {
    const { targets, chain, health } = scenario(pool);
    const now = BASE + 5_000;
    const common = { targets, chain, health, now };

    resetAutomaticOrderCache();
    const p = buildRoutePlan({ ...common, cacheKey: `pool:${pool}` });
    const planned = effectiveOrder(p.steps, (target) => health.isAvailable(target, now)).map((step) => label(step.target));

    resetAutomaticOrderCache();
    const preview = describeRouting({ targets, health, protocol: PROTOCOL, pool, chain, now });
    assert.deepEqual(preview.fallbackOrder.map(label), planned, "preview == plan");
    assert.deepEqual(planned, [...SELECTED_ORDER, ...HEALTH_ORDER]);

    // The walker's first attempts, in order, against that same plan.
    const calls = [];
    await assert.rejects(withFallback(targets, async (target) => {
      calls.push(label(target));
      throw Object.assign(new Error("boom"), { status: 500 });
    }, new Set([500]), new RouteSession(), health, { plan: p.steps }));
    assert.deepEqual([...new Set(calls)], planned, "walker == preview");
    assert.equal(new Set(calls).size, targets.length, "every target is reached; there is no arbitrary cap");

    // The number shown next to each model is the number it was sorted on.
    const groups = groupTargets(targets);
    for (const item of preview.fallbackOrder) {
      const expected = groupLatency(groups.get(`${item.provider}/${item.model}`), health);
      assert.equal(item.orderLatencyMs, expected.latencyMs, `${label(item)} shows its ordering latency`);
      assert.equal(item.orderLatencySource, expected.source);
    }
    const unselected = preview.fallbackOrder.filter((item) => item.phase === PHASES.HEALTH);
    const shown = unselected.map((item) => item.orderLatencyMs);
    const measured = shown.filter((value) => value !== null);
    assert.deepEqual(measured, [...measured].sort((a, b) => a - b), "displayed latencies ascend");
    assert.deepEqual(shown.slice(measured.length).filter((v) => v !== null), [], "unmeasured models are last");
    assert.ok(preview.fallbackOrder.slice(0, SELECTED_ORDER.length).every((item) => item.phase === PHASES.MANUAL));
  });

  test(`${pool}: cooling targets are left out of the preview and never called`, async () => {
    const { targets, chain, health } = scenario(pool);
    const now = BASE + 5_000;
    const cooling = targets.find((x) => x.model === "S-2");
    health.markFailure(cooling, 500, { cooldownMs: 10 * MIN }, BASE + 4_000);

    resetAutomaticOrderCache();
    const preview = describeRouting({ targets, health, protocol: PROTOCOL, pool, chain, now });
    assert.ok(!preview.fallbackOrder.map(label).includes(label(cooling)));

    resetAutomaticOrderCache();
    const p = buildRoutePlan({ targets, chain, health, now, cacheKey: `pool:${pool}` });
    const calls = [];
    await assert.rejects(withFallback(targets, async (target) => {
      calls.push(label(target));
      throw Object.assign(new Error("boom"), { status: 500 });
    }, new Set([500]), new RouteSession(), health, { plan: p.steps }));
    assert.ok(!calls.includes(label(cooling)), "an active cooldown is never called, in any round");
    assert.deepEqual([...new Set(calls)], preview.fallbackOrder.map(label));
  });
}

// ---------------------------------------------------------------------------
// 5. The model catalogue shows the number the router sorts on
// ---------------------------------------------------------------------------

function callApi(handler, pathname, query = "") {
  return new Promise((resolve, reject) => {
    const res = {
      writeHead(status) { this.status = status; },
      end(body) { resolve({ status: this.status, body: body ? JSON.parse(body) : null }); }
    };
    Promise.resolve(handler({ method: "GET", headers: {} }, res, pathname, new URLSearchParams(query))).catch(reject);
  });
}

test("health describe reports the request and probe latency the router orders by", () => {
  const health = new HealthRegistry();
  const target = t("a", "A");
  measure(health, target, 800, "request");
  measure(health, target, 90, "probe");
  const [row] = health.describe([target]);
  assert.equal(row.requestLatencyMs, 800);
  assert.equal(row.probeLatencyMs, 90);
  assert.equal(row.latencyMs, 90, "the latest observation is still reported as before");
  assert.deepEqual(health.describe([t("b", "B")])[0].requestLatencyMs, null);
});

for (const pool of ["text", "vision"]) {
  test(`${pool}: /api/fallback and /api/router/preview agree on every model's latency`, async () => {
    const { targets, chain, health } = scenario(pool);
    const chainStore = {
      mode: FALLBACK_MODES.MANUAL,
      get: (name) => (name === pool ? chain : [])
    };
    const handler = createApi({
      config: { retryableStatus: [500] },
      targets,
      health,
      requestLog: { entries: new Map() },
      fallbackChain: chainStore
    });

    const fallback = await callApi(handler, "/api/fallback");
    assert.equal(fallback.status, 200);
    const catalogue = new Map(fallback.body.catalogue[pool].map((group) => [`${group.provider}/${group.model}`, group]));

    const preview = await callApi(handler, "/api/router/preview", `protocol=${PROTOCOL}&pool=${pool}`);
    assert.equal(preview.status, 200);
    assert.deepEqual(preview.body.fallbackOrder.map(label), [...SELECTED_ORDER, ...HEALTH_ORDER]);

    for (const item of preview.body.fallbackOrder) {
      const group = catalogue.get(`${item.provider}/${item.model}`);
      assert.equal(group.latencyMs, item.orderLatencyMs, `${item.provider}/${item.model}: catalogue == preview`);
      assert.equal(group.latencySource, item.orderLatencySource);
    }
    // Previously every model reported "not measured" here.
    assert.equal(catalogue.get("gemini/U-fast").latencyMs, 40);
    assert.equal(catalogue.get("cerebras/U-probe").latencySource, "probe");
    assert.equal(catalogue.get("mistral/U-never-1").latencyMs, null);
  });
}

// ---------------------------------------------------------------------------
// 6. The derived modes: a saved selection is manual, an empty one is automatic
// ---------------------------------------------------------------------------

test("a saved selection is walked whatever the latency, and a remembered target leads", () => {
  const { targets, chain, health } = scenario("text");
  const p = plan({ targets, chain, health });
  assert.deepEqual(labels(phase(p, PHASES.MANUAL)), SELECTED_ORDER);

  // A remembered SELECTED target leads with its own key, then its own remaining
  // keys, then the rest of the selection in its saved order.
  const remembered = plan({ targets, chain, health, stickyTargetId: "gemini:S-3:key-1" });
  assert.deepEqual(labels(remembered.steps.slice(0, 4)),
    ["gemini/S-3#1", "gemini/S-3#0", "groq/S-1#0", "gemini/S-2#0"]);
  assert.equal(remembered.steps[0].phase, PHASES.STICKY);
});

test("an empty selection is the automatic order, unmeasured last", () => {
  const { targets, health } = scenario("text");
  const p = plan({ targets, chain: [], health });
  // With nothing selected, EVERY model is ordered by its measured latency, and
  // the never-measured ones come last in configuration order.
  assert.deepEqual(modelsOf(p.steps), [
    "gemini/S-2", "gemini/U-fast", "cerebras/U-probe", "openrouter/U-mid",
    "gemini/U-slow", "gemini/S-3", "groq/S-1", "mistral/U-never-1", "sambanova/U-never-2"
  ]);
  assert.ok(p.steps.every((step) => step.phase === PHASES.AUTO), "an empty selection has only the automatic phase");
});

test("API-key restrictions and order hold in the selected and the unselected batch", () => {
  const { targets, chain, health } = scenario("text");
  const restricted = [entry("groq", "S-1"), entry("gemini", "S-2"), entry("gemini", "S-3", { keys: [1] })];
  const p = plan({ targets, chain: restricted, health });
  assert.deepEqual(labels(phase(p, PHASES.MANUAL)), ["groq/S-1#0", "gemini/S-2#0", "gemini/S-3#1"]);
  assert.ok(!labels(p.steps).includes("gemini/S-3#0"), "an excluded key never leaks into the unselected batch");
  assert.deepEqual(labels(phase(p, PHASES.HEALTH)), HEALTH_ORDER);
});

test("an unconfigured pool still falls back to the automatic order", () => {
  const { targets, health } = scenario("text");
  const p = plan({ targets, chain: [], health });
  assert.equal(p.source, "auto");
  assert.equal(labels(p.steps)[0], "gemini/S-2#0");
});
