import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { HealthRegistry, startHealthMonitor } from "../src/health.js";
import { FALLBACK_MODES, FALLBACK_MODE_INFO, normalizeMode, remembersSuccess } from "../src/fallback-chain.js";
import {
  PHASES,
  buildRoutePlan,
  effectiveOrder,
  resetAutomaticOrderCache,
  routeOrderByPool
} from "../src/fallback-plan.js";
import { RouteSession, STICKY_TTL_MS, withFallback } from "../src/router.js";
import { loadConfig } from "../src/config.js";
import { MANUAL_LIMITS, normalizeManualCycles } from "../src/fallback-chain.js";

const MIN = 60 * 1000;
const t = (provider, model, keyIndex = 0, pool = "text") => ({ provider, model, keyIndex, pool, protocols: ["openai-chat"] });
const entry = (provider, model, extra = {}) => ({ provider, model, keys: null, enabled: true, ...extra });
const fail = (status, extra = {}) => Object.assign(new Error(`boom ${status}`), { status, ...extra });
const label = (target) => `${target.provider}/${target.model}#${target.keyIndex}`;

/**
 * The scenario from the requirements. Provider names repeat on purpose: the
 * manual selection interleaves "gemini" with other providers, and "gemini" also
 * owns an UNSELECTED model (X). The target list is deliberately provider-grouped
 * and puts the unselected models first, so any code that grouped by provider or
 * followed list order instead of the saved order would visibly fail.
 */
const targets = [
  t("gemini", "X", 0), t("gemini", "X", 1),
  t("gemini", "A", 0), t("gemini", "A", 1),
  t("gemini", "C", 0), t("gemini", "C", 1),
  t("gemini", "E", 0), t("gemini", "E", 1),
  t("groq", "B", 0),
  t("mistral", "D", 0),
  t("openrouter", "Y", 0),
  t("cerebras", "Z", 0)
];
const selection = [
  entry("gemini", "A"),
  entry("groq", "B"),
  entry("gemini", "C"),
  entry("mistral", "D"),
  entry("gemini", "E")
];

const MANUAL_ORDER = [
  "gemini/A#0", "gemini/A#1",
  "groq/B#0",
  "gemini/C#0", "gemini/C#1",
  "mistral/D#0",
  "gemini/E#0", "gemini/E#1"
];

let cache = 0;
const plan = (overrides = {}) => {
  resetAutomaticOrderCache();
  return buildRoutePlan({
    targets,
    chain: selection,
    mode: FALLBACK_MODES.MANUAL,
    health: new HealthRegistry(),
    cacheKey: `manual-${(cache += 1)}`,
    ...overrides
  });
};
/** The steps of one phase in one cycle (cycle 1 unless stated; `null` means every cycle). */
const phaseSteps = (p, phase, cycle = 1) => p.steps.filter((step) => step.phase === phase && (cycle === null || step.cycle === cycle));
const labels = (steps) => steps.map((step) => label(step.target));
const models = (steps) => [...new Set(steps.map((step) => `${step.target.provider}/${step.target.model}`))];

// ---------------------------------------------------------------------------
// Mode wiring
// ---------------------------------------------------------------------------

test("Manual Model Selection is a mode of its own, and does not remember a success", () => {
  assert.equal(FALLBACK_MODES.MANUAL, "manual");
  assert.equal(normalizeMode(" Manual "), "manual");
  assert.equal(remembersSuccess("manual"), false);
  assert.ok(FALLBACK_MODE_INFO.some((info) => info.id === "manual" && info.label === "Manual Model Selection"));
  // The three existing modes are still offered, unchanged and in their old order.
  assert.deepEqual(FALLBACK_MODE_INFO.slice(0, 3).map((info) => info.id), ["fixed", "last-success", "auto"]);
});

// ---------------------------------------------------------------------------
// PHASE 1 — the manual selection
// ---------------------------------------------------------------------------

test("phase 1 walks the selection in exactly the saved order, with providers interleaved", () => {
  const first = phaseSteps(plan(), PHASES.MANUAL);
  assert.deepEqual(labels(first), MANUAL_ORDER);
  // Gemini A -> Groq B -> Gemini C -> Mistral D -> Gemini E
  assert.deepEqual(models(first), ["gemini/A", "groq/B", "gemini/C", "mistral/D", "gemini/E"]);
});

test("models of one provider are separate entries and are never grouped, sorted or reordered", () => {
  const first = phaseSteps(plan(), PHASES.MANUAL);
  const providers = models(first).map((id) => id.split("/")[0]);
  assert.deepEqual(providers, ["gemini", "groq", "gemini", "mistral", "gemini"]);

  // Reversing the saved order reverses the walk — nothing sorts the list.
  const reversed = phaseSteps(plan({ chain: [...selection].reverse() }), PHASES.MANUAL);
  assert.deepEqual(models(reversed), ["gemini/E", "mistral/D", "gemini/C", "groq/B", "gemini/A"]);
});

test("every eligible key of a selected model is listed before the next selected model", () => {
  const first = phaseSteps(plan(), PHASES.MANUAL);
  const firstTwo = labels(first).slice(0, 2);
  assert.deepEqual(firstTwo, ["gemini/A#0", "gemini/A#1"]);
  // Contiguity: once a model is left, it does not reappear within the phase.
  const seen = [];
  for (const step of first) {
    const id = `${step.target.provider}/${step.target.model}`;
    if (seen.at(-1) !== id) {
      assert.ok(!seen.includes(id), `${id} reappears inside phase 1`);
      seen.push(id);
    }
  }
});

// ---------------------------------------------------------------------------
// PHASE 2 — everything not selected, by health
// ---------------------------------------------------------------------------

test("phase 2 holds every model that was not selected, and none that was", () => {
  const second = phaseSteps(plan(), PHASES.HEALTH);
  assert.deepEqual(new Set(models(second)), new Set(["gemini/X", "openrouter/Y", "cerebras/Z"]));
  for (const selected of ["gemini/A", "groq/B", "gemini/C", "mistral/D", "gemini/E"]) {
    assert.ok(!models(second).includes(selected), `${selected} was manually selected`);
  }
});

test("an unselected model of a provider that IS in the selection stays eligible in phase 2", () => {
  const second = phaseSteps(plan(), PHASES.HEALTH);
  assert.ok(models(second).includes("gemini/X"), "gemini/X shares a provider with A, C and E but was not selected");
  // Excluding by provider would have dropped it; excluding by model must not.
  assert.deepEqual(labels(second).filter((id) => id.startsWith("gemini/")), ["gemini/X#0", "gemini/X#1"]);
});

test("phase 2 follows the existing health ordering: measured latency, then availability", () => {
  const health = new HealthRegistry();
  health.markSuccess(t("openrouter", "Y", 0), { latencyMs: 40 });
  health.markSuccess(t("cerebras", "Z", 0), { latencyMs: 90 });
  health.markSuccess(t("gemini", "X", 0), { latencyMs: 400 });
  assert.deepEqual(models(phaseSteps(plan({ health }), PHASES.HEALTH)), ["openrouter/Y", "cerebras/Z", "gemini/X"]);

  // A model with every key cooling down drops behind the available ones, whatever its latency.
  health.markFailure(t("openrouter", "Y", 0), 500, { cooldownMs: MIN });
  assert.deepEqual(models(phaseSteps(plan({ health }), PHASES.HEALTH)), ["cerebras/Z", "gemini/X", "openrouter/Y"]);
});

test("an unmeasured router orders phase 2 by configuration order, deterministically", () => {
  const a = labels(phaseSteps(plan(), PHASES.HEALTH));
  const b = labels(phaseSteps(plan(), PHASES.HEALTH));
  assert.deepEqual(a, b);
  assert.deepEqual(a, ["gemini/X#0", "gemini/X#1", "openrouter/Y#0", "cerebras/Z#0"]);
});

test("every key of a fallback model is listed before the next fallback model", () => {
  const second = labels(phaseSteps(plan(), PHASES.HEALTH));
  assert.deepEqual(second.slice(0, 2), ["gemini/X#0", "gemini/X#1"]);
});

test("a parked (disabled) entry and a key the operator excluded never reach phase 2", () => {
  const chain = [
    entry("gemini", "A", { keys: [1] }),     // key 0 deliberately excluded
    entry("groq", "B"),
    entry("gemini", "C", { keys: [9] }),     // narrowed to a key that does not exist
    entry("mistral", "D"),
    entry("gemini", "E", { enabled: false }) // parked
  ];
  const p = plan({ chain });

  const everything = labels(p.steps);
  assert.ok(!everything.includes("gemini/A#0"), "an excluded key is never attempted in any phase");
  assert.ok(everything.includes("gemini/A#1"));
  for (const parked of ["gemini/E#0", "gemini/E#1", "gemini/C#0", "gemini/C#1"]) {
    assert.ok(!everything.includes(parked), `${parked} must stay out of every phase`);
  }
  assert.deepEqual(labels(phaseSteps(p, PHASES.MANUAL)), ["gemini/A#1", "groq/B#0", "mistral/D#0"]);
  assert.deepEqual(new Set(models(phaseSteps(p, PHASES.HEALTH))), new Set(["gemini/X", "openrouter/Y", "cerebras/Z"]));
});

// ---------------------------------------------------------------------------
// PHASE 3 — one final manual pass
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// The repeating Manual -> Health cycle
// ---------------------------------------------------------------------------

const PHASE_TWO_ORDER = ["gemini/X#0", "gemini/X#1", "openrouter/Y#0", "cerebras/Z#0"];
const CYCLE_LEN = MANUAL_ORDER.length + PHASE_TWO_ORDER.length;

/** The plan as `cycle:phase` runs, e.g. ["1:manual-selection", "1:health-fallback", "2:manual-selection", ...]. */
const runs = (p) => p.steps
  .map((step) => `${step.cycle}:${step.phase}`)
  .filter((run, index, all) => run !== all[index - 1]);

test("the plan repeats Manual -> Health for the configured number of cycles, and then ends", () => {
  const p = plan({ maxCycles: 3 });
  assert.deepEqual(runs(p), [
    "1:manual-selection", "1:health-fallback",
    "2:manual-selection", "2:health-fallback",
    "3:manual-selection", "3:health-fallback"
  ]);
  assert.equal(p.cycles, 3);
  assert.equal(p.steps.length, CYCLE_LEN * 3, "a finite plan: no cycle beyond the last one");
  assert.deepEqual(runs(plan({ maxCycles: 1 })), ["1:manual-selection", "1:health-fallback"]);
  assert.equal(plan({ maxCycles: 2 }).steps.length, CYCLE_LEN * 2);
  assert.equal(plan().cycles, MANUAL_LIMITS.cycles.default, "the default is used when nothing is passed");
  assert.equal(MANUAL_LIMITS.cycles.default, 3);
  // Nothing in the plan is a phase this change retired.
  assert.ok(!("MANUAL_RETRY" in PHASES));
  assert.ok(p.steps.every((step) => step.phase !== "manual-retry"));
});

test("cycle 1 is the first visit; every step of cycle 2 and later is flagged as a bounded repeat", () => {
  const p = plan({ maxCycles: 3 });
  assert.ok(p.steps.filter((step) => step.cycle === 1).every((step) => step.retry === false));
  assert.ok(p.steps.filter((step) => step.cycle >= 2).every((step) => step.retry === true));
});

test("the Manual phase is the same selection, in the same order, with the same key order, in every cycle", () => {
  const p = plan({ maxCycles: 4 });
  for (let cycle = 1; cycle <= 4; cycle += 1) {
    assert.deepEqual(labels(phaseSteps(p, PHASES.MANUAL, cycle)), MANUAL_ORDER, `cycle ${cycle}`);
    assert.deepEqual(
      models(phaseSteps(p, PHASES.MANUAL, cycle)),
      ["gemini/A", "groq/B", "gemini/C", "mistral/D", "gemini/E"],
      `cycle ${cycle}: providers stay interleaved`
    );
  }
});

test("the Health phase holds only unselected models, in the same health order, in every cycle", () => {
  const health = new HealthRegistry();
  health.markSuccess(t("openrouter", "Y", 0), { latencyMs: 40 });
  health.markSuccess(t("cerebras", "Z", 0), { latencyMs: 90 });
  const p = plan({ health, maxCycles: 3 });
  const first = labels(phaseSteps(p, PHASES.HEALTH, 1));
  assert.deepEqual(models(phaseSteps(p, PHASES.HEALTH, 1)), ["openrouter/Y", "cerebras/Z", "gemini/X"]);
  for (let cycle = 1; cycle <= 3; cycle += 1) {
    const health_ = phaseSteps(p, PHASES.HEALTH, cycle);
    assert.deepEqual(labels(health_), first, `cycle ${cycle}: same order as cycle 1`);
    for (const selected of ["gemini/A", "groq/B", "gemini/C", "mistral/D", "gemini/E"]) {
      assert.ok(!models(health_).includes(selected), `cycle ${cycle}: ${selected} was manually selected`);
    }
    assert.ok(models(health_).includes("gemini/X"), `cycle ${cycle}: an unselected model of a selected provider stays`);
  }
});

test("restrictions hold in every cycle: an excluded key and a parked model never appear anywhere", () => {
  const chain = [
    entry("gemini", "A", { keys: [1] }),
    entry("groq", "B"),
    entry("gemini", "C", { keys: [9] }),
    entry("mistral", "D"),
    entry("gemini", "E", { enabled: false })
  ];
  const p = plan({ chain, maxCycles: 3 });
  const all = labels(p.steps);
  for (const forbidden of ["gemini/A#0", "gemini/C#0", "gemini/C#1", "gemini/E#0", "gemini/E#1"]) {
    assert.ok(!all.includes(forbidden), `${forbidden} leaked into the plan`);
  }
  for (let cycle = 1; cycle <= 3; cycle += 1) {
    assert.deepEqual(labels(phaseSteps(p, PHASES.MANUAL, cycle)), ["gemini/A#1", "groq/B#0", "mistral/D#0"]);
  }
});

test("the cycle count is clamped to its allowed range, and an unusable value falls back to the default", () => {
  const { min, max, default: fallback } = MANUAL_LIMITS.cycles;
  assert.equal(normalizeManualCycles(0), min);
  assert.equal(normalizeManualCycles(-4), min);
  assert.equal(normalizeManualCycles(max + 90), max);
  assert.equal(normalizeManualCycles(2), 2);
  for (const bad of [undefined, null, "x", NaN, 2.5]) assert.equal(normalizeManualCycles(bad), fallback, String(bad));
  // An unbounded request cannot build an unbounded plan.
  assert.equal(plan({ maxCycles: 1_000_000 }).steps.length, CYCLE_LEN * max);
});

test("the plan never lists a target twice within one phase of one cycle", () => {
  const dup = [...targets, t("gemini", "A", 0), t("gemini", "X", 1)];
  const p = plan({ targets: dup });
  for (const phase of [PHASES.MANUAL, PHASES.HEALTH]) {
    for (const cycle of [1, 2, 3]) {
      const ids = labels(phaseSteps(p, phase, cycle));
      assert.equal(new Set(ids).size, ids.length, `${phase} cycle ${cycle} has a duplicate`);
    }
  }
});

test("the two limits are real settings: documented defaults, and an out-of-range value stops startup", () => {
  const config = loadConfig({});
  assert.equal(config.manualMaxCycles, 3);
  assert.equal(config.manualMaxAttempts, 100);
  assert.equal(loadConfig({ MANUAL_MAX_CYCLES: "5", MANUAL_MAX_ATTEMPTS: "40" }).manualMaxCycles, 5);
  assert.equal(loadConfig({ MANUAL_MAX_CYCLES: "5", MANUAL_MAX_ATTEMPTS: "40" }).manualMaxAttempts, 40);
  for (const [name, value] of [
    ["MANUAL_MAX_CYCLES", "0"], ["MANUAL_MAX_CYCLES", "11"], ["MANUAL_MAX_CYCLES", "many"], ["MANUAL_MAX_CYCLES", "2.5"],
    ["MANUAL_MAX_ATTEMPTS", "0"], ["MANUAL_MAX_ATTEMPTS", "1001"], ["MANUAL_MAX_ATTEMPTS", "-1"]
  ]) {
    assert.throws(() => loadConfig({ [name]: value }), new RegExp(`Invalid ${name}`), `${name}=${value}`);
  }
});

// ---------------------------------------------------------------------------
// Where manual routing must NOT apply
// ---------------------------------------------------------------------------

test("with no selection saved, manual mode is the plain automatic order and has no phases", () => {
  const p = plan({ chain: [] });
  assert.equal(p.source, "auto");
  assert.ok(p.steps.every((step) => step.phase === PHASES.AUTO && step.retry !== true && step.cycle === undefined));
});

test("manual mode fails closed when nothing selected can serve the request", () => {
  const p = plan({ chain: [entry("nobody", "Ghost")] });
  assert.equal(p.failClosed, true);
  assert.deepEqual(p.steps, [], "phase 2 must not substitute for a selection that cannot be honoured");
});

test("a pinned request ignores the selection: strict, no phases, no cycles, no retry", () => {
  const pin = [t("mistral", "D", 0)];
  const p = plan({ targets: pin, pinned: true });
  assert.deepEqual(labels(p.steps), ["mistral/D#0"]);
  assert.ok(p.steps.every((step) => step.phase === PHASES.CHAIN && step.retry !== true && step.cycle === undefined));
});

test("manual mode never lets a remembered target lead", () => {
  const p = plan({ stickyTargetId: "gemini:E:key-1" });
  assert.equal(p.sticky, null);
  assert.equal(label(p.steps[0].target), "gemini/A#0");
  assert.ok(p.steps.every((step) => step.phase !== PHASES.STICKY));
});

test("the other modes keep their plans: one pass, no health phase, no cycles", () => {
  for (const mode of [FALLBACK_MODES.FIXED, FALLBACK_MODES.LAST_SUCCESS, FALLBACK_MODES.AUTO]) {
    const p = plan({ mode });
    assert.ok(p.steps.every((step) => step.retry !== true && step.cycle === undefined), `${mode}: no retry steps, no cycles`);
    assert.ok(
      p.steps.every((step) => ![PHASES.MANUAL, PHASES.HEALTH].includes(step.phase)),
      `${mode}: no manual phases`
    );
    assert.deepEqual(new Set(models(p.steps)), new Set(["gemini/A", "groq/B", "gemini/C", "mistral/D", "gemini/E"]),
      `${mode}: only the configured models, never an unselected one`);
  }
  // Fixed Order still walks the saved order, once.
  assert.deepEqual(labels(plan({ mode: FALLBACK_MODES.FIXED }).steps), MANUAL_ORDER);
});

test("text and vision pools stay separate under manual selection", () => {
  const text = [t("p", "T1", 0), t("q", "T2", 0), t("p", "T3", 0)];
  const vision = [t("p", "V1", 0, "vision"), t("q", "V2", 0, "vision")];
  const order = routeOrderByPool([...text, ...vision], {
    mode: FALLBACK_MODES.MANUAL,
    chains: {
      text: [entry("q", "T2"), entry("p", "T1")],
      vision: [entry("q", "V2")]
    },
    health: new HealthRegistry()
  });
  const textOrder = order.filter((target) => target.pool === "text").map(label);
  const visionOrder = order.filter((target) => target.pool === "vision").map(label);
  assert.deepEqual(textOrder, ["q/T2#0", "p/T1#0", "p/T3#0"], "T3 is the text pool's only phase-2 model");
  assert.deepEqual(visionOrder, ["q/V2#0", "p/V1#0"], "no text model leaks into the vision pool");
});

// ---------------------------------------------------------------------------
// The walker over the three phases
// ---------------------------------------------------------------------------

/**
 * Walks a manual plan, recording every call; `behavior(id, count, target)` decides each outcome.
 * `limits` are the walker's own bounds (`maxAttempts`, `maxTargetAttempts`), exactly as the server passes them.
 */
async function walkManual(behavior, { health = new HealthRegistry(), chain = selection, onSkip = null, maxCycles, limits } = {}) {
  const p = plan({ health, chain, ...(maxCycles === undefined ? {} : { maxCycles }) });
  const calls = [];
  const counts = new Map();
  const phases = [];
  const cycles = [];
  let result;
  let error = null;
  try {
    result = await withFallback(
      targets,
      async (target, { phase, cycle }) => {
        const id = label(target);
        const n = (counts.get(id) ?? 0) + 1;
        counts.set(id, n);
        calls.push(id);
        phases.push(phase);
        cycles.push(cycle);
        return behavior(id, n, target);
      },
      new Set([400, 401, 402, 403, 404, 408, 413, 429, 500, 502, 503]),
      new RouteSession(),
      health,
      { plan: p.steps, onSkip, remember: false, ...(limits ?? {}) }
    );
  } catch (caught) {
    error = caught;
  }
  return { calls, counts, phases, cycles, result, error, health, plan: p };
}

const PHASE_TWO = PHASE_TWO_ORDER;
const everyCycle = (n) => Array.from({ length: n }, () => [...MANUAL_ORDER, ...PHASE_TWO]).flat();
const MANUAL_MAX = MANUAL_LIMITS.cycles.default;

test("Manual fails -> Health fails -> Manual runs again, then Health again, up to the cycle limit", async () => {
  const { calls, error, phases, cycles } = await walkManual(() => { throw fail(500); });
  assert.deepEqual(calls, everyCycle(MANUAL_MAX), "Manual, Health, Manual, Health, Manual, Health");
  assert.equal(error.status, 502);
  const runsSeen = phases
    .map((phase, index) => `${cycles[index]}:${phase}`)
    .filter((run, index, all) => run !== all[index - 1]);
  assert.deepEqual(runsSeen, [
    "1:manual-selection", "1:health-fallback",
    "2:manual-selection", "2:health-fallback",
    "3:manual-selection", "3:health-fallback"
  ], "the walker reports which phase AND which cycle every call belonged to");
});

test("the second Manual phase runs only after the first Health phase failed, the second Health only after the second Manual", async () => {
  const { calls } = await walkManual(() => { throw fail(500); }, { maxCycles: 2 });
  assert.deepEqual(calls.slice(0, MANUAL_ORDER.length), MANUAL_ORDER);
  assert.deepEqual(calls.slice(MANUAL_ORDER.length, CYCLE_LEN), PHASE_TWO);
  assert.deepEqual(calls.slice(CYCLE_LEN, CYCLE_LEN + MANUAL_ORDER.length), MANUAL_ORDER, "Manual again");
  assert.deepEqual(calls.slice(CYCLE_LEN + MANUAL_ORDER.length), PHASE_TWO, "Health again, after the second Manual failed");
  assert.equal(calls.length, CYCLE_LEN * 2);
});

test("every cycle keeps the manual model order and each model's key order", async () => {
  const { calls, cycles } = await walkManual(() => { throw fail(503); });
  for (let cycle = 1; cycle <= MANUAL_MAX; cycle += 1) {
    const inCycle = calls.filter((_, index) => cycles[index] === cycle);
    assert.deepEqual(inCycle.slice(0, MANUAL_ORDER.length), MANUAL_ORDER, `cycle ${cycle}`);
    assert.deepEqual(inCycle.slice(MANUAL_ORDER.length), PHASE_TWO, `cycle ${cycle}: health order is not reshuffled`);
  }
});

test("each target is called at most once per cycle, so at most `cycles` times in a request", async () => {
  const { counts } = await walkManual(() => { throw fail(500); });
  for (const id of [...MANUAL_ORDER, ...PHASE_TWO]) assert.equal(counts.get(id), MANUAL_MAX, `${id}: one call per cycle`);
  assert.equal([...counts.values()].reduce((a, b) => a + b, 0), CYCLE_LEN * MANUAL_MAX, "no infinite loop, no stray duplicates");
});

test("a success in the first Manual phase stops the walk: nothing after it is ever called", async () => {
  const { calls, result } = await walkManual((id) => (id === "mistral/D#0" ? "ok" : (() => { throw fail(500); })()));
  assert.equal(result, "ok");
  assert.deepEqual(calls, ["gemini/A#0", "gemini/A#1", "groq/B#0", "gemini/C#0", "gemini/C#1", "mistral/D#0"]);
});

test("a Health success in cycle 1 stops the walk: no second Manual phase starts", async () => {
  const { calls, result } = await walkManual((id) => (id === "openrouter/Y#0" ? "fallback" : (() => { throw fail(500); })()));
  assert.equal(result, "fallback");
  assert.deepEqual(calls, [...MANUAL_ORDER, "gemini/X#0", "gemini/X#1", "openrouter/Y#0"]);
  assert.ok(!calls.slice(MANUAL_ORDER.length).some((id) => MANUAL_ORDER.includes(id)), "no manual target after the Health phase began");
});

test("a later Manual phase can still recover a target whose first failure was transient, and stops there", async () => {
  const { calls, result, counts } = await walkManual((id, n) => {
    if (id === "gemini/E#1" && n === 2) return "recovered";
    throw fail(503);
  });
  assert.equal(result, "recovered");
  assert.equal(counts.get("gemini/E#1"), 2);
  assert.deepEqual(calls.slice(-MANUAL_ORDER.length), MANUAL_ORDER, "the second Manual phase walked the original order up to the success");
  assert.equal(calls.at(-1), "gemini/E#1", "the success is the last call: nothing further is attempted");
  assert.equal(calls.length, CYCLE_LEN + MANUAL_ORDER.length);
});

test("targets that fail for a non-transient reason are never repeated in a later cycle", async () => {
  const { counts } = await walkManual((id) => {
    if (id === "groq/B#0") throw fail(404);   // the model is gone
    if (id === "mistral/D#0") throw fail(429); // transient: worth a second look
    throw fail(500);
  });
  assert.equal(counts.get("groq/B#0"), 1, "a 404 would only fail the same way again");
  assert.equal(counts.get("mistral/D#0"), MANUAL_MAX, "a 429 is transient and is revisited once per later cycle");
});

test("a rejected request (400) is never forced through a second time, and still surfaces as a 400", async () => {
  const { calls, error } = await walkManual(() => { throw fail(400); });
  assert.deepEqual(calls, [...MANUAL_ORDER, ...PHASE_TWO], "no later cycle repeats anything: every 400 is a genuine cooldown");
  assert.equal(error.status, 400);
});

test("a credential failure cools the whole key and is never retried or worked around", async () => {
  const { calls, counts } = await walkManual((id) => {
    if (id === "gemini/A#0") throw fail(401);
    throw fail(500);
  });
  assert.equal(counts.get("gemini/A#0"), 1);
  // Key 0 of the provider is cooled for every model, in every phase.
  for (const id of ["gemini/C#0", "gemini/E#0", "gemini/X#0"]) {
    assert.ok(!calls.includes(id), `${id} shares the rejected credential and must be skipped, not retried`);
  }
  // Key 1 is a different credential and is unaffected.
  assert.equal(counts.get("gemini/A#1"), MANUAL_MAX, "a different credential is revisited once per later cycle");
});

test("a cooldown that existed before the request is genuine: never attempted, never forced", async () => {
  const health = new HealthRegistry();
  health.markFailure(t("groq", "B", 0), 500); // already cooling when the request arrives
  const skips = [];
  const { calls } = await walkManual(() => { throw fail(500); }, { health, onSkip: (target, info) => skips.push(`${label(target)}:${info.reason}`) });
  assert.ok(!calls.includes("groq/B#0"), "not attempted in any phase, including the final pass");
  assert.deepEqual(skips.filter((entry) => entry.startsWith("groq/B#0")), ["groq/B#0:cooldown"], "reported once");
});

test("a cooldown someone else refreshed during the request is not looked past either", async () => {
  const health = new HealthRegistry();
  const { counts } = await walkManual((id) => {
    // While phase 2 is running, another request puts gemini/A key 0 on a fresh, longer cooldown.
    if (id === "cerebras/Z#0") health.markFailure(t("gemini", "A", 0), 500, { cooldownMs: 99 * MIN });
    throw fail(500);
  }, { health });
  assert.equal(counts.get("gemini/A#0"), 1, "a genuine, newer cooldown beats the final pass");
  assert.equal(counts.get("gemini/A#1"), MANUAL_MAX, "its sibling key is untouched and revisited once per later cycle");
});

test("when every target is already cooling, nothing is called and the existing 503 is returned", async () => {
  const health = new HealthRegistry();
  for (const target of targets) health.markFailure(target, 500);
  const { calls, error } = await walkManual(() => "never", { health });
  assert.equal(calls.length, 0, "the final pass does not force requests to genuinely ineligible targets");
  assert.equal(error.status, 503);
});

test("a repeated target that fails again gets a fresh cooldown and never exceeds the cycle limit", async () => {
  const health = new HealthRegistry();
  const { counts } = await walkManual(() => { throw fail(502); }, { health });
  for (const id of MANUAL_ORDER) assert.ok(counts.get(id) <= MANUAL_MAX);
  assert.ok(!health.isAvailable(t("gemini", "A", 0)), "the failure is still on record");
});

test("the retry of a target succeeds and clears its cooldown", async () => {
  const health = new HealthRegistry();
  await walkManual((id, n) => {
    if (id === "gemini/A#0" && n === 2) return "ok";
    throw fail(500);
  }, { health });
  assert.ok(health.isAvailable(t("gemini", "A", 0)), "a success is the one thing that ends a cooldown early");
});

test("outside manual mode a duplicate step is still skipped, never retried", async () => {
  const p = buildRoutePlan({ targets, chain: selection, mode: FALLBACK_MODES.FIXED, health: new HealthRegistry(), cacheKey: "dup" });
  const doubled = [...p.steps, ...p.steps];
  const calls = [];
  const skips = [];
  await assert.rejects(withFallback(
    targets,
    async (target) => { calls.push(label(target)); throw fail(500); },
    new Set([500]),
    new RouteSession(),
    new HealthRegistry(),
    { plan: doubled, onSkip: (target, info) => skips.push(info.reason), remember: false }
  ));
  assert.deepEqual(calls, MANUAL_ORDER, "the existing once-per-request rule is untouched");
  assert.ok(skips.includes("already_attempted"));
});

// ---------------------------------------------------------------------------
// Bounds and safety across cycles
// ---------------------------------------------------------------------------

test("a success in a later cycle ends the request on the spot: no further attempt of any kind", async () => {
  // Succeeds on the third visit to the last Health model: the very last call of the whole plan.
  const { calls, result, counts } = await walkManual((id, n) => {
    if (id === "cerebras/Z#0" && n === 3) return "late";
    throw fail(500);
  });
  assert.equal(result, "late");
  assert.equal(calls.at(-1), "cerebras/Z#0");
  assert.equal(calls.length, CYCLE_LEN * MANUAL_MAX);

  // And a success in the middle of cycle 2's Manual phase leaves everything after it untouched.
  const early = await walkManual((id, n) => {
    if (id === "mistral/D#0" && n === 2) return "mid";
    throw fail(500);
  });
  assert.equal(early.result, "mid");
  assert.equal(early.calls.at(-1), "mistral/D#0");
  assert.equal(early.calls.length, CYCLE_LEN + MANUAL_ORDER.indexOf("mistral/D#0") + 1);
  assert.equal(early.counts.get("gemini/E#0") ?? 0, 1, "gemini/E#0 was not reached in cycle 2");
  assert.equal(early.counts.get("cerebras/Z#0"), 1, "the second Health phase never started");
});

test("a total attempt budget stops the walk at exactly that many upstream calls", async () => {
  const { calls, error } = await walkManual(() => { throw fail(500); }, { limits: { maxAttempts: 10 } });
  assert.equal(calls.length, 10);
  assert.deepEqual(calls, everyCycle(1).slice(0, 10), "the budget ends the walk in plan order, mid-cycle if it must");
  assert.equal(error.status, 502, "the existing error: All routing targets failed");
  assert.equal(error.message, "All routing targets failed");
  assert.equal(error.attemptBudgetExhausted, true);
  assert.equal(error.failures.length, 10);

  const spanning = await walkManual(() => { throw fail(500); }, { limits: { maxAttempts: CYCLE_LEN + 3 } });
  assert.equal(spanning.calls.length, CYCLE_LEN + 3, "the budget is for the whole request, across cycles");
  assert.deepEqual(spanning.calls.slice(CYCLE_LEN), MANUAL_ORDER.slice(0, 3));

  // A budget larger than the plan changes nothing and is not reported as exhausted.
  const roomy = await walkManual(() => { throw fail(500); }, { limits: { maxAttempts: 10_000 } });
  assert.equal(roomy.calls.length, CYCLE_LEN * MANUAL_MAX);
  assert.equal(roomy.error.attemptBudgetExhausted, undefined);
});

test("a per-target cap bounds how often one target may be called, whatever the plan lists", async () => {
  const skips = [];
  const { counts } = await walkManual(() => { throw fail(500); }, {
    limits: { maxTargetAttempts: 2 },
    onSkip: (target, info) => skips.push(`${label(target)}:${info.reason}`)
  });
  for (const id of [...MANUAL_ORDER, ...PHASE_TWO]) assert.equal(counts.get(id), 2, id);
  assert.ok(skips.includes("gemini/A#0:retry_limit"), "the refused third visit is explained, not silent");
});

test("the cycle limit bounds the walk: one cycle means one pass and no repeat", async () => {
  const one = await walkManual(() => { throw fail(500); }, { maxCycles: 1 });
  assert.deepEqual(one.calls, everyCycle(1));
  const five = await walkManual(() => { throw fail(500); }, { maxCycles: 5 });
  assert.equal(five.calls.length, CYCLE_LEN * 5);
  assert.deepEqual(five.calls, everyCycle(5));
});

test("a repeat never looks past a cooldown that existed before the request, in any cycle", async () => {
  const health = new HealthRegistry();
  health.markFailure(t("groq", "B", 0), 500);
  health.markFailure(t("cerebras", "Z", 0), 429);
  const skips = [];
  const { calls } = await walkManual(() => { throw fail(500); }, {
    health,
    onSkip: (target, info) => skips.push(`${label(target)}:${info.reason}:${info.cycle}`)
  });
  assert.ok(!calls.includes("groq/B#0") && !calls.includes("cerebras/Z#0"), "neither is ever attempted, in any of the cycles");
  assert.deepEqual(skips.filter((entry) => entry.startsWith("groq/B#0")), ["groq/B#0:cooldown:1"], "reported once, not once per cycle");
  assert.equal(calls.length, (CYCLE_LEN - 2) * MANUAL_MAX, "every other target is still visited once per cycle");
});

test("a credential failure is never repeated, even if something clears the key's cooldown mid-request", async () => {
  const health = new HealthRegistry();
  const { calls, counts } = await walkManual((id) => {
    if (id === "gemini/A#0") throw fail(401);
    // End of cycle 1: another request (or a probe) clears the cooldown this request's 401 put on the
    // rejected key's other models. Cycle 2 must still not send them anything.
    if (id === "cerebras/Z#0") {
      for (const sibling of [t("gemini", "C", 0), t("gemini", "E", 0), t("gemini", "X", 0), t("gemini", "A", 0)]) {
        health.markSuccess(sibling, { source: "probe" });
      }
    }
    throw fail(500);
  }, { health });
  assert.equal(counts.get("gemini/A#0"), 1, "the rejected credential is not retried, though its cooldown is gone");
  for (const sibling of ["gemini/C#0", "gemini/E#0", "gemini/X#0"]) {
    assert.ok(!calls.includes(sibling), `${sibling} shares the rejected key: never attempted, never repeated`);
  }
  assert.equal(counts.get("gemini/A#1"), MANUAL_MAX, "the other key is a different credential and is revisited per cycle");
});

test("402 and 403 are credential-level too: never repeated in a later cycle", async () => {
  for (const status of [402, 403]) {
    const { counts } = await walkManual((id) => {
      if (id === "groq/B#0") throw fail(status);
      throw fail(500);
    });
    assert.equal(counts.get("groq/B#0"), 1, `${status}`);
  }
});

test("a target that refused the request without a cooldown (skipCooldown) is not repeated either", async () => {
  const { counts, health } = await walkManual((id) => {
    if (id === "groq/B#0") throw fail(400, { retryable: true, skipCooldown: true });
    throw fail(500);
  });
  assert.equal(counts.get("groq/B#0"), 1, "it was never cooled, so only the retry policy keeps it from being forced again");
  assert.ok(health.isAvailable(t("groq", "B", 0)), "and it is not marked unhealthy");
  assert.equal(counts.get("mistral/D#0"), MANUAL_MAX);
});

test("a cycle in which nothing could be called ends the walk instead of spinning", async () => {
  const skips = [];
  const { calls, error } = await walkManual(() => { throw fail(400); }, { onSkip: (_target, info) => skips.push(info.reason) });
  assert.equal(calls.length, CYCLE_LEN, "cycle 1 called everything; cycles 2 and 3 had nothing eligible");
  assert.equal(error.status, 400);
  assert.ok(skips.length <= CYCLE_LEN, "skips are reported once per target, not once per cycle");
});

test("when nothing at all can be called the existing 503 is returned, with no calls and no budget used", async () => {
  const health = new HealthRegistry();
  for (const target of targets) health.markFailure(target, 500);
  const { calls, error } = await walkManual(() => "never", { health, limits: { maxAttempts: 5 } });
  assert.equal(calls.length, 0);
  assert.equal(error.status, 503);
  assert.equal(error.attemptBudgetExhausted, undefined);
});

test("without limits the walker is bounded by the finite plan alone, as every other mode relies on", async () => {
  const p = buildRoutePlan({ targets, chain: selection, mode: FALLBACK_MODES.FIXED, health: new HealthRegistry(), cacheKey: "plain" });
  const calls = [];
  await assert.rejects(withFallback(
    targets,
    async (target, info) => { calls.push([label(target), info.cycle]); throw fail(500); },
    new Set([500]),
    new RouteSession(),
    new HealthRegistry(),
    { plan: p.steps, remember: false }
  ));
  assert.deepEqual(calls.map(([id]) => id), MANUAL_ORDER, "Fixed Order: one pass, in the saved order");
  assert.ok(calls.every(([, cycle]) => cycle === null), "no cycle outside Manual Model Selection");
});

test("effectiveOrder shows each target once, in phase order", () => {
  const order = effectiveOrder(plan().steps);
  assert.deepEqual(order.map((step) => label(step.target)), [...MANUAL_ORDER, ...PHASE_TWO]);
});

// ---------------------------------------------------------------------------
// Health and cooldown timing — each constant tested on its own
// ---------------------------------------------------------------------------

test("the default model cooldown is exactly 12 minutes", () => {
  const registry = new HealthRegistry();
  assert.equal(registry.cooldownMs, 12 * MIN);
  const now = 1_000_000;
  registry.markFailure(t("a", "A"), 500, {}, now);
  assert.equal(registry.get("a:A:key-0").cooldownUntil, now + 12 * MIN);
});

test("a custom cooldown override still wins, per registry and per failure", () => {
  const registry = new HealthRegistry({ cooldownMs: 5_000 });
  registry.markFailure(t("a", "A"), 500, {}, 1_000);
  assert.equal(registry.get("a:A:key-0").cooldownUntil, 6_000);
  registry.markFailure(t("a", "B"), 500, { cooldownMs: 42 }, 1_000);
  assert.equal(registry.get("a:B:key-0").cooldownUntil, 1_042);
});

test("status-specific cooldowns are unchanged: 400 is 8 minutes, 408 is 1 minute, 413 is 5 minutes", async () => {
  const cases = [[400, 8 * MIN], [408, 1 * MIN], [413, 5 * MIN], [500, 12 * MIN]];
  for (const [status, expected] of cases) {
    const health = new HealthRegistry();
    const target = t("solo", `M${status}`);
    const before = Date.now();
    await assert.rejects(withFallback(
      [target],
      async () => { throw fail(status); },
      new Set([status]),
      new RouteSession(),
      health,
      { remember: false }
    ));
    const after = Date.now();
    const until = health.get(health.key(target)).cooldownUntil;
    assert.ok(until >= before + expected && until <= after + expected, `${status}: expected ${expected}ms, got ${until - before}ms`);
  }
});

test("the automatic health-check interval is exactly 12 minutes, independent of the cooldown", async () => {
  mock.timers.enable({ apis: ["setInterval"] });
  try {
    let cycles = 0;
    const check = async () => { cycles += 1; return { ok: true, status: 200, latencyMs: 1 }; };
    const stop = startHealthMonitor([t("a", "A")], check);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(cycles, 1, "one cycle runs immediately");

    mock.timers.tick(12 * MIN - 1);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(cycles, 1, "nothing runs before 12 minutes");

    mock.timers.tick(1);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(cycles, 2, "the next cycle runs at exactly 12 minutes");
    stop();
  } finally {
    mock.timers.reset();
  }
});

test("the remembered-session TTL is a separate setting and is still 20 minutes", () => {
  assert.equal(STICKY_TTL_MS, 20 * MIN);
  assert.equal(new RouteSession().ttlMs, 20 * MIN);
});
