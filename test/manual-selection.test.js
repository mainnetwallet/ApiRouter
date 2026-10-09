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
const phaseSteps = (p, phase) => p.steps.filter((step) => step.phase === phase);
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

test("phase 3 is the same selection in the same order, flagged as the one bounded retry", () => {
  const p = plan();
  const last = phaseSteps(p, PHASES.MANUAL_RETRY);
  assert.deepEqual(labels(last), MANUAL_ORDER);
  assert.ok(last.every((step) => step.retry === true));
  assert.ok(p.steps.filter((step) => step.phase !== PHASES.MANUAL_RETRY).every((step) => step.retry !== true));

  // The plan is exactly phase 1, then phase 2, then phase 3 — and no fourth phase.
  assert.deepEqual([...new Set(p.steps.map((step) => step.phase))], [PHASES.MANUAL, PHASES.HEALTH, PHASES.MANUAL_RETRY]);
  assert.equal(p.steps.length, MANUAL_ORDER.length * 2 + 4);
});

test("the plan never lists a target twice within one phase", () => {
  const dup = [...targets, t("gemini", "A", 0), t("gemini", "X", 1)];
  const p = plan({ targets: dup });
  for (const phase of [PHASES.MANUAL, PHASES.HEALTH, PHASES.MANUAL_RETRY]) {
    const ids = labels(phaseSteps(p, phase));
    assert.equal(new Set(ids).size, ids.length, `${phase} has a duplicate`);
  }
});

// ---------------------------------------------------------------------------
// Where manual routing must NOT apply
// ---------------------------------------------------------------------------

test("with no selection saved, manual mode is the plain automatic order and has no phases", () => {
  const p = plan({ chain: [] });
  assert.equal(p.source, "auto");
  assert.ok(p.steps.every((step) => step.phase === PHASES.AUTO && step.retry !== true));
});

test("manual mode fails closed when nothing selected can serve the request", () => {
  const p = plan({ chain: [entry("nobody", "Ghost")] });
  assert.equal(p.failClosed, true);
  assert.deepEqual(p.steps, [], "phase 2 must not substitute for a selection that cannot be honoured");
});

test("a pinned request ignores the selection: strict, no phases, no retry", () => {
  const pin = [t("mistral", "D", 0)];
  const p = plan({ targets: pin, pinned: true });
  assert.deepEqual(labels(p.steps), ["mistral/D#0"]);
  assert.ok(p.steps.every((step) => step.phase === PHASES.CHAIN && step.retry !== true));
});

test("manual mode never lets a remembered target lead", () => {
  const p = plan({ stickyTargetId: "gemini:E:key-1" });
  assert.equal(p.sticky, null);
  assert.equal(label(p.steps[0].target), "gemini/A#0");
  assert.ok(p.steps.every((step) => step.phase !== PHASES.STICKY));
});

test("the other modes keep their plans: no health phase, no final pass", () => {
  for (const mode of [FALLBACK_MODES.FIXED, FALLBACK_MODES.LAST_SUCCESS, FALLBACK_MODES.AUTO]) {
    const p = plan({ mode });
    assert.ok(p.steps.every((step) => step.retry !== true), `${mode}: no retry steps`);
    assert.ok(
      p.steps.every((step) => ![PHASES.MANUAL, PHASES.HEALTH, PHASES.MANUAL_RETRY].includes(step.phase)),
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

/** Walks a manual plan, recording every call; `behavior(id, count)` decides each outcome. */
async function walkManual(behavior, { health = new HealthRegistry(), chain = selection, onSkip = null } = {}) {
  const p = plan({ health, chain });
  const calls = [];
  const counts = new Map();
  const phases = [];
  let result;
  let error = null;
  try {
    result = await withFallback(
      targets,
      async (target, { phase }) => {
        const id = label(target);
        const n = (counts.get(id) ?? 0) + 1;
        counts.set(id, n);
        calls.push(id);
        phases.push(phase);
        return behavior(id, n, target);
      },
      new Set([400, 401, 402, 403, 404, 408, 413, 429, 500, 502, 503]),
      new RouteSession(),
      health,
      { plan: p.steps, onSkip, remember: false }
    );
  } catch (caught) {
    error = caught;
  }
  return { calls, counts, phases, result, error, health };
}

const PHASE_TWO = ["gemini/X#0", "gemini/X#1", "openrouter/Y#0", "cerebras/Z#0"];

test("all three phases run in order when everything fails with a transient error", async () => {
  const { calls, error, phases } = await walkManual(() => { throw fail(500); });
  assert.deepEqual(calls, [...MANUAL_ORDER, ...PHASE_TWO, ...MANUAL_ORDER]);
  assert.equal(error.status, 502);
  assert.deepEqual(
    [...new Set(phases)],
    [PHASES.MANUAL, PHASES.HEALTH, PHASES.MANUAL_RETRY],
    "the walker reports which phase every call belonged to"
  );
});

test("the final pass is bounded: each manual target is called at most twice, every other at most once", async () => {
  const { counts } = await walkManual(() => { throw fail(500); });
  for (const id of MANUAL_ORDER) assert.equal(counts.get(id), 2, `${id}: first pass + one retry`);
  for (const id of PHASE_TWO) assert.equal(counts.get(id), 1, `${id}: tried once`);
  assert.equal([...counts.values()].reduce((a, b) => a + b, 0), 20, "no infinite loop, no stray duplicates");
});

test("a success in phase 1 stops the walk: phase 2 and 3 are never reached", async () => {
  const { calls, result } = await walkManual((id) => (id === "mistral/D#0" ? "ok" : (() => { throw fail(500); })()));
  assert.equal(result, "ok");
  assert.deepEqual(calls, ["gemini/A#0", "gemini/A#1", "groq/B#0", "gemini/C#0", "gemini/C#1", "mistral/D#0"]);
});

test("phase 2 starts only after the whole selection failed, and phase 3 only after phase 2 did", async () => {
  const { calls, result } = await walkManual((id) => (id === "openrouter/Y#0" ? "fallback" : (() => { throw fail(500); })()));
  assert.equal(result, "fallback");
  assert.deepEqual(calls, [...MANUAL_ORDER, "gemini/X#0", "gemini/X#1", "openrouter/Y#0"]);
  assert.ok(!calls.slice(MANUAL_ORDER.length).some((id) => MANUAL_ORDER.includes(id)), "no manual target before phase 2 ends");
});

test("the final pass can still recover a target whose first failure was transient", async () => {
  const { calls, result, counts } = await walkManual((id, n) => {
    if (id === "gemini/E#1" && n === 2) return "recovered";
    throw fail(503);
  });
  assert.equal(result, "recovered");
  assert.equal(counts.get("gemini/E#1"), 2);
  assert.deepEqual(calls.slice(-MANUAL_ORDER.length), MANUAL_ORDER, "phase 3 walked the original order up to the success");
});

test("targets that fail for a non-transient reason are not retried in the final pass", async () => {
  const { counts } = await walkManual((id) => {
    if (id === "groq/B#0") throw fail(404);   // the model is gone
    if (id === "mistral/D#0") throw fail(429); // transient: worth a second look
    throw fail(500);
  });
  assert.equal(counts.get("groq/B#0"), 1, "a 404 would only fail the same way again");
  assert.equal(counts.get("mistral/D#0"), 2, "a 429 is transient and gets its one retry");
});

test("a rejected request (400) is never forced through a second time, and still surfaces as a 400", async () => {
  const { calls, error } = await walkManual(() => { throw fail(400); });
  assert.deepEqual(calls, [...MANUAL_ORDER, ...PHASE_TWO], "phase 3 retries nothing: every 400 is a genuine cooldown");
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
  assert.equal(counts.get("gemini/A#1"), 2);
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
  assert.equal(counts.get("gemini/A#1"), 2, "its sibling key is untouched and retried once");
});

test("when every target is already cooling, nothing is called and the existing 503 is returned", async () => {
  const health = new HealthRegistry();
  for (const target of targets) health.markFailure(target, 500);
  const { calls, error } = await walkManual(() => "never", { health });
  assert.equal(calls.length, 0, "the final pass does not force requests to genuinely ineligible targets");
  assert.equal(error.status, 503);
});

test("a retried target that fails again gets a fresh cooldown and is not called a third time", async () => {
  const health = new HealthRegistry();
  const { counts } = await walkManual(() => { throw fail(502); }, { health });
  for (const id of MANUAL_ORDER) assert.ok(counts.get(id) <= 2);
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
