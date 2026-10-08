import test from "node:test";
import assert from "node:assert/strict";
import { buildTargets, loadConfig, VISION_POOL } from "../src/config.js";
import { HealthRegistry } from "../src/health.js";
import { RouteSession, withFallback } from "../src/router.js";
import { buildRoutePlan, parsePriorityModels, readPriority, routeOrderByPool } from "../src/routing-plan.js";

const provider = (keys, models, extra = {}) => ({ apiKeys: keys, models, baseUrl: "http://x", ...extra });
const gemini = provider(["k1", "k2", "k3"], ["G1", "G2", "G3", "G4"]);
const groq = provider(["k1", "k2", "k3"], ["GR1", "GR2", "GR3", "GR4"]);
const textTargets = () => buildTargets({ gemini, groq });
const label = (t) => `${t.provider}/${t.model}/k${t.keyIndex + 1}`;

/** Runs a plan against a scripted outcome map and returns what was really called. */
async function run({ targets = textTargets(), priority = [], requestedModel = "", fail = () => false, health = new HealthRegistry(), session = new RouteSession(), now = Date.now() } = {}) {
  // Same wiring as src/server.js: sticky only while its TTL is valid.
  const plan = buildRoutePlan({ targets, requestedModel, priority, stickyTargetId: session.validTargetId(now) });
  const calls = [];
  const skips = [];
  let result;
  let error;
  try {
    result = await withFallback(targets, async (target, { phase }) => {
      calls.push(`${phase}:${label(target)}`);
      if (fail(target)) throw Object.assign(new Error("boom"), { status: 429 });
      return target;
    }, undefined, session, health, {
      plan: plan.steps,
      onSkip: (target, info) => skips.push(`${info.phase}:${label(target)}:${info.reason}`)
    });
  } catch (e) { error = e; }
  return { calls, skips, result, error, plan };
}

test("parsePriorityModels keeps order, namespaces by provider and drops junk", () => {
  assert.deepEqual(parsePriorityModels("gemini/G1, groq/GR2 ,gemini/G3"), [
    { provider: "gemini", model: "G1" }, { provider: "groq", model: "GR2" }, { provider: "gemini", model: "G3" }
  ]);
  assert.deepEqual(parsePriorityModels(""), []);
  assert.deepEqual(parsePriorityModels(undefined), []);
  assert.deepEqual(parsePriorityModels("G1,/G2,gemini/,gemini/G1,gemini/G1"), [{ provider: "gemini", model: "G1" }]);
  assert.deepEqual(parsePriorityModels("openrouter/meta/llama-3"), [{ provider: "openrouter", model: "meta/llama-3" }]);
});

test("readPriority: each pool reads only its own list (TEXT_ / VISION_PRIORITY_MODELS)", () => {
  const env = { TEXT_PRIORITY_MODELS: "gemini/G1", VISION_PRIORITY_MODELS: "groq/GR1" };
  assert.deepEqual(readPriority(env, "text"), [{ provider: "gemini", model: "G1" }]);
  assert.deepEqual(readPriority(env, "vision"), [{ provider: "groq", model: "GR1" }]);
  assert.deepEqual(readPriority({}, "text"), []);
  // Empty/unset VISION_PRIORITY_MODELS inherits TEXT_PRIORITY_MODELS (same models, same order);
  // a configured VISION list wins. Text never reads the vision list.
  assert.deepEqual(readPriority({ TEXT_PRIORITY_MODELS: "gemini/G1,groq/GR2" }, "vision"), readPriority({ TEXT_PRIORITY_MODELS: "gemini/G1,groq/GR2" }, "text"));
  assert.deepEqual(readPriority({ TEXT_PRIORITY_MODELS: "gemini/G1", VISION_PRIORITY_MODELS: "  " }, "vision"), [{ provider: "gemini", model: "G1" }]);
  assert.deepEqual(readPriority({ VISION_PRIORITY_MODELS: "groq/GR1" }, "text"), []);
  assert.deepEqual(readPriority({}, "vision"), []);
  assert.deepEqual(loadConfig({ TEXT_PRIORITY_MODELS: "gemini/G1" }).priority.vision, [{ provider: "gemini", model: "G1" }]);
  assert.deepEqual(loadConfig({ PRIORITY_MODELS: "gemini/G1" }).priority.text, []);
});

test("empty priority: no priority phase, straight to Provider -> Key -> Models", async () => {
  const { calls, plan } = await run({ fail: () => true });
  assert.equal(plan.priorityCount, 0);
  assert.ok(!calls.some((c) => c.startsWith("priority:")));
  assert.deepEqual(calls.slice(0, 5), [
    "fallback:gemini/G1/k1", "fallback:gemini/G2/k1", "fallback:gemini/G3/k1", "fallback:gemini/G4/k1", "fallback:gemini/G1/k2"
  ]);
});

test("key-scoped fallback: each key restarts at its first model, then the next provider", async () => {
  const { calls } = await run({ fail: () => true });
  const expected = [];
  for (const [p, models] of [["gemini", ["G1", "G2", "G3", "G4"]], ["groq", ["GR1", "GR2", "GR3", "GR4"]]]) {
    for (const k of [1, 2, 3]) for (const m of models) expected.push(`fallback:${p}/${m}/k${k}`);
  }
  assert.deepEqual(calls, expected);
  // Never Key1/G4 -> Key2/G4.
  assert.notEqual(calls[4], "fallback:gemini/G4/k2");
});

test("single-key provider moves to the next provider without inventing a key", async () => {
  const targets = buildTargets({ gemini: provider(["only"], ["G1", "G2"]), groq: provider(["a"], ["GR1"]) });
  const { calls } = await run({ targets, fail: () => true });
  assert.deepEqual(calls, ["fallback:gemini/G1/k1", "fallback:gemini/G2/k1", "fallback:groq/GR1/k1"]);
});

test("priority runs in exact env order; each entry tries ALL its keys before the next entry; stops on first success", async () => {
  const priority = parsePriorityModels("gemini/G1,groq/GR2,gemini/G3");
  const first = await run({ priority });
  assert.deepEqual(first.calls, ["priority:gemini/G1/k1"], "stops immediately; no Groq or second Gemini call");

  const second = await run({ priority, fail: (t) => t.provider === "gemini" && t.model === "G1" });
  assert.deepEqual(second.calls, [
    "priority:gemini/G1/k1", "priority:gemini/G1/k2", "priority:gemini/G1/k3", "priority:groq/GR2/k1"
  ], "every G1 key is exhausted before groq/GR2 is touched");
  assert.equal(second.result.provider, "groq");
});

test("all priority fail: normal fallback skips exactly the attempted targets (spec example)", async () => {
  const priority = parsePriorityModels("gemini/G1,groq/GR2,gemini/G3");
  const { calls, skips } = await run({ priority, fail: () => true });
  assert.equal(new Set(calls.map((c) => c.split(":")[1])).size, calls.length, "no target is called twice");
  assert.deepEqual(calls.slice(0, 9), [
    "priority:gemini/G1/k1", "priority:gemini/G1/k2", "priority:gemini/G1/k3",
    "priority:groq/GR2/k1", "priority:groq/GR2/k2", "priority:groq/GR2/k3",
    "priority:gemini/G3/k1", "priority:gemini/G3/k2", "priority:gemini/G3/k3"
  ]);
  const normal = calls.filter((c) => c.startsWith("fallback:"));
  // Every G1 and G3 key was already attempted, so only G2 and G4 remain per Gemini key.
  assert.deepEqual(normal.slice(0, 6), [
    "fallback:gemini/G2/k1", "fallback:gemini/G4/k1", "fallback:gemini/G2/k2", "fallback:gemini/G4/k2",
    "fallback:gemini/G2/k3", "fallback:gemini/G4/k3"
  ]);
  assert.deepEqual(skips.filter((s) => s.startsWith("fallback:gemini")).slice(0, 2), [
    "fallback:gemini/G1/k1:already_attempted", "fallback:gemini/G3/k1:already_attempted"
  ]);
  assert.ok(skips.includes("fallback:groq/GR2/k1:already_attempted"));
  assert.ok(skips.includes("fallback:groq/GR2/k3:already_attempted"));
  assert.equal(calls.length, 24, "every target exactly once");
});

test("priority failure is per request: the next request starts from priority again", async () => {
  const priority = parsePriorityModels("gemini/G1");
  const health = new HealthRegistry({ cooldownMs: 1 });
  await run({ priority, health, fail: (t) => t.model === "G1" });
  await new Promise((r) => setTimeout(r, 5)); // cooldown elapsed
  const next = await run({ priority, health });
  assert.deepEqual(next.calls, ["priority:gemini/G1/k1"]);
});

test("a priority target in cooldown is skipped, then eligible again after recovery", async () => {
  const priority = parsePriorityModels("gemini/G1,groq/GR1");
  const health = new HealthRegistry({ cooldownMs: 900000 });
  const g1 = textTargets().find((t) => t.provider === "gemini" && t.model === "G1");
  const now = Date.now();
  for (const k of [0, 1, 2]) health.markFailure({ ...g1, keyIndex: k }, 429, {}, now);

  const cooling = await run({ priority, health });
  assert.deepEqual(cooling.calls, ["priority:groq/GR1/k1"]);
  assert.ok(cooling.skips.includes("priority:gemini/G1/k1:cooldown"));

  // Recovery goes through the existing health registry, not a second timer.
  for (const k of [0, 1, 2]) health.markSuccess({ ...g1, keyIndex: k }, {}, now + 1);
  const recovered = await run({ priority, health });
  assert.deepEqual(recovered.calls, ["priority:gemini/G1/k1"]);
});

test("a requested model leads its provider's per-key chain; other providers follow", async () => {
  const { calls } = await run({ requestedModel: "GR3", fail: () => true });
  assert.deepEqual(calls.slice(0, 5), [
    "fallback:groq/GR3/k1", "fallback:groq/GR1/k1", "fallback:groq/GR2/k1", "fallback:groq/GR4/k1", "fallback:groq/GR3/k2"
  ]);
});

test("same model id on two providers is two distinct priority targets", () => {
  const targets = buildTargets({ gemini: provider(["a"], ["X"]), groq: provider(["b"], ["X"]) });
  const { steps } = buildRoutePlan({ targets, priority: parsePriorityModels("groq/X") });
  assert.deepEqual(steps.filter((s) => s.phase === "priority").map((s) => s.target.provider), ["groq"]);
});

test("vision pool: only vision targets are planned, with the same algorithm", async () => {
  const visionTargets = buildTargets({ gemini: provider(["v1", "v2"], ["GV1", "GV2"]) }, VISION_POOL);
  const { calls } = await run({ targets: visionTargets, priority: parsePriorityModels("gemini/GV2,gemini/G1"), fail: () => true });
  assert.ok(calls.every((c) => /GV[12]/.test(c)), "text model G1 can never be reached from the vision pool");
  assert.deepEqual(calls.slice(0, 4), [
    "priority:gemini/GV2/k1", "priority:gemini/GV2/k2", "fallback:gemini/GV1/k1", "fallback:gemini/GV1/k2"
  ]);
  assert.equal(new Set(calls).size, 4);
});

test("a priority entry for a model only the other pool has is ignored, never routed", () => {
  const visionTargets = buildTargets({ gemini: provider(["v1"], ["GV1"]) }, VISION_POOL);
  const { steps, priorityCount } = buildRoutePlan({ targets: visionTargets, priority: parsePriorityModels("gemini/G1") });
  assert.equal(priorityCount, 0);
  assert.ok(steps.every((s) => s.target.pool === "vision"));
});

test("REGRESSION: sticky is a separate leading phase and never edits the normal fallback list", () => {
  const targets = textTargets();
  const health = new HealthRegistry();
  const normalOf = (opts) => buildRoutePlan({ targets, ...opts }).steps.filter((s) => s.phase === "fallback").map((s) => label(s.target));
  const baseline = normalOf({});
  for (const target of [
    targets.find((t) => t.provider === "gemini" && t.model === "G2" && t.keyIndex === 0),
    targets.find((t) => t.provider === "gemini" && t.model === "G4" && t.keyIndex === 2),
    targets.find((t) => t.provider === "groq" && t.model === "GR3")
  ]) {
    const plan = buildRoutePlan({ targets, stickyTargetId: health.key(target), priority: parsePriorityModels("groq/GR1") });
    assert.deepEqual(normalOf({ stickyTargetId: health.key(target) }), baseline, "normal list untouched");
    assert.equal(plan.steps[0].phase, "sticky");
    assert.equal(label(plan.steps[0].target), label(target));
    // The sticky model's own other keys come right after sticky; priority follows them.
    const own = plan.steps.slice(1).filter((s) => s.target.provider === target.provider && s.target.model === target.model && s.phase !== "fallback");
    assert.equal(own.length, 2, "the other two keys of the sticky model directly follow sticky");
    assert.deepEqual(plan.steps.slice(1, 3).map((s) => label(s.target)), own.map((s) => label(s.target)));
    assert.equal(plan.steps[3].phase, "priority", "priority follows the sticky model's keys");
  }
  // Stale ids, another pool's id and unknown ids add no sticky phase.
  for (const id of ["vision:gemini:G1:key-0", "ghost:nothing:key-9", null]) {
    assert.equal(buildRoutePlan({ targets, stickyTargetId: id }).sticky, null);
    assert.equal(buildRoutePlan({ targets, stickyTargetId: id }).steps[0].phase, "fallback");
  }
});

test("sticky success is still recorded for observability", async () => {
  const session = new RouteSession();
  const { result } = await run({ session, fail: (t) => t.model === "G1" });
  assert.equal(session.targetId, new HealthRegistry().key(result));
});

test("all targets failing returns the existing 502 with sanitized failures", async () => {
  const { error } = await run({ fail: () => true });
  assert.equal(error.status, 502);
  assert.equal(error.failures.length, 24);
});

test("routing preview shows the plan the proxy walks, with phases", async () => {
  const { describeRouting } = await import("../src/observability/router-preview.js");
  const targets = buildTargets({ gemini, groq });
  const config = { retryableStatus: new Set([429]), priority: { text: parsePriorityModels("groq/GR2,gemini/G3"), vision: [] } };
  const health = new HealthRegistry();
  const stickyId = health.key(targets.find((t) => t.provider === "gemini" && t.model === "G4" && t.keyIndex === 2));

  const plain = describeRouting({ targets, config, health, protocol: "openai-chat", model: "" });
  assert.equal(plain.priorityTargets, 2);
  assert.deepEqual(plain.fallbackOrder.slice(0, 5).map((c) => `${c.phase}:${c.provider}/${c.model}/${c.keyIndex}`), [
    "priority:groq/GR2/0", "priority:groq/GR2/1", "priority:groq/GR2/2", "priority:gemini/G3/0", "priority:gemini/G3/1"
  ]);
  const live = await run({ priority: config.priority.text, fail: () => true });
  assert.deepEqual(plain.fallbackOrder.map((c) => `${c.phase}:${c.provider}/${c.model}/k${c.keyIndex + 1}`), live.calls);

  const withSticky = describeRouting({ targets, config, health, protocol: "openai-chat", model: "", stickyTargetId: stickyId });
  assert.deepEqual(withSticky.fallbackOrder.slice(0, 4).map((c) => `${c.phase}:${c.provider}/${c.model}/${c.keyIndex}`), [
    "sticky:gemini/G4/2", "sticky:gemini/G4/0", "sticky:gemini/G4/1", "priority:groq/GR2/0"
  ]);
});

test("priority parsing: whitespace around the slash, case, duplicates and junk", () => {
  assert.deepEqual(parsePriorityModels(" Gemini / G1 ,  groq/GR2 , gemini/G1, ,/x, y/, nothing"), [
    { provider: "gemini", model: "G1" }, { provider: "groq", model: "GR2" }
  ]);
  assert.deepEqual(parsePriorityModels("gemini/G1,groq/GR2"), parsePriorityModels("gemini/G1, groq/GR2"));
});

test("TEXT_ and VISION_PRIORITY_MODELS are independent and keep their order", () => {
  const env = { TEXT_PRIORITY_MODELS: "gemini/model-a,groq/model-b", VISION_PRIORITY_MODELS: "groq/v1,gemini/v2" };
  assert.deepEqual(readPriority(env, "text").map((e) => `${e.provider}/${e.model}`), ["gemini/model-a", "groq/model-b"]);
  assert.deepEqual(readPriority(env, "vision").map((e) => `${e.provider}/${e.model}`), ["groq/v1", "gemini/v2"]);
});

test("priority skips a cooled key (logged) and uses the next eligible key of the same entry", async () => {
  const priority = parsePriorityModels("gemini/G1");
  const health = new HealthRegistry({ cooldownMs: 900000 });
  const g1k1 = textTargets().find((t) => t.provider === "gemini" && t.model === "G1" && t.keyIndex === 0);
  health.markFailure(g1k1, 429, {}, Date.now());
  const { calls, skips } = await run({ priority, health });
  assert.deepEqual(calls, ["priority:gemini/G1/k2"]);
  assert.ok(skips.includes("priority:gemini/G1/k1:cooldown"));
});

test("no normal-fallback target ever precedes a priority target", async () => {
  const { calls } = await run({ priority: parsePriorityModels("groq/GR4,gemini/G2"), fail: () => true });
  const firstFallback = calls.findIndex((c) => c.startsWith("fallback:"));
  assert.ok(calls.slice(0, firstFallback).every((c) => c.startsWith("priority:")));
  assert.ok(calls.slice(firstFallback).every((c) => c.startsWith("fallback:")));
  assert.deepEqual(calls.slice(0, 4), [
    "priority:groq/GR4/k1", "priority:groq/GR4/k2", "priority:groq/GR4/k3", "priority:gemini/G2/k1"
  ]);
});

test("K x M: one target per key and model, key-major deterministic order", () => {
  const t = buildTargets({ gemini });
  assert.equal(t.length, 12);
  assert.equal(new Set(t.map((x) => new HealthRegistry().key(x))).size, 12);
  const { steps } = buildRoutePlan({ targets: t });
  assert.deepEqual(steps.map((s) => `k${s.target.keyIndex + 1}${s.target.model}`),
    ["k1G1","k1G2","k1G3","k1G4","k2G1","k2G2","k2G3","k2G4","k3G1","k3G2","k3G3","k3G4"]);
});

test("incomplete vision provider is not active (keys without base URL / models)", () => {
  const cfg = loadConfig({
    GEMINI_VISION_API_KEYS: "v1", GEMINI_VISION_MODELS: "GV1",                       // no base URL
    GROQ_VISION_API_KEYS: "v2", GROQ_VISION_BASE_URL: "http://x",                     // no models
    MISTRAL_VISION_MODELS: "m", MISTRAL_VISION_BASE_URL: "http://x"                  // no keys
  });
  assert.equal(buildTargets(cfg.visionProviders, VISION_POOL).length, 0);
  // Generic (non-vision) settings never leak into the vision pool.
  const generic = loadConfig({ GEMINI_API_KEYS: "k", GEMINI_MODELS: "G1", GEMINI_BASE_URL: "http://x" });
  assert.equal(buildTargets(generic.visionProviders, VISION_POOL).length, 0);
  assert.equal(buildTargets(generic.providers).length, 1);
});

test("routeOrderByPool is the deterministic order and ignores health score", () => {
  const targets = textTargets();
  const health = new HealthRegistry();
  // Make the LAST target the healthiest by score: ranking would put it first.
  const last = targets.at(-1);
  for (let i = 0; i < 5; i += 1) health.markSuccess(last, {}, Date.now() + i);
  const order = routeOrderByPool(targets, { text: parsePriorityModels("groq/GR2") }, (t) => health.isAvailable(t));
  assert.deepEqual(order.slice(0, 4).map(label), ["groq/GR2/k1", "groq/GR2/k2", "groq/GR2/k3", "gemini/G1/k1"]);
  assert.notEqual(label(order[0]), label(last));
});

// ---- error classification and key-level cooldown ---------------------------

async function runStatuses(statusFor, { targets = textTargets(), health = new HealthRegistry(), priority = [] } = {}) {
  const plan = buildRoutePlan({ targets, priority });
  const calls = [];
  let error;
  try {
    await withFallback(targets, async (target) => {
      calls.push(label(target));
      const spec = statusFor(target, calls.length);
      if (!spec) return target;
      throw Object.assign(new Error("e"), typeof spec === "number" ? { status: spec } : spec);
    }, undefined, new RouteSession(), health, { plan: plan.steps });
  } catch (e) { error = e; }
  return { calls, error, health, targets };
}

for (const status of [401, 402, 403]) {
  test(`${status} cools the failing key's sibling models only, then moves to the next key`, async () => {
    const { calls, health, targets } = await runStatuses((t) => (t.provider === "gemini" && t.keyIndex === 0 ? status : null));
    // G1/k1 fails; G2..G4 on k1 are skipped (cooled); k2 restarts at G1 and serves.
    assert.deepEqual(calls, ["gemini/G1/k1", "gemini/G1/k2"]);
    const state = (model, keyIndex) => health.get(health.key(targets.find((t) => t.provider === "gemini" && t.model === model && t.keyIndex === keyIndex)));
    for (const model of ["G1", "G2", "G3", "G4"]) assert.equal(state(model, 0).failures, 1, `${model}/k1 marked once`);
    for (const model of ["G1", "G2", "G3", "G4"]) assert.equal(health.isAvailable(targets.find((t) => t.provider === "gemini" && t.model === model && t.keyIndex === 1)), true, "other keys unaffected");
    assert.equal(health.isAvailable(targets.find((t) => t.provider === "groq" && t.keyIndex === 0)), true, "other providers unaffected");
  });
}

test("key-level cooldown never double-marks siblings when priority repeats targets", async () => {
  const { health, targets } = await runStatuses((t) => (t.keyIndex === 0 && t.provider === "gemini" ? 401 : null), {
    priority: parsePriorityModels("gemini/G1,gemini/G2")
  });
  const g3 = targets.find((t) => t.provider === "gemini" && t.model === "G3" && t.keyIndex === 0);
  assert.equal(health.get(health.key(g3)).failures, 1);
});

test("404 / 429 / 5xx are retryable and cool only the failing target", async () => {
  for (const status of [404, 408, 429, 500, 502, 503, 504, 520, 529]) {
    const { calls, health, targets } = await runStatuses((t) => (t.model === "G1" && t.keyIndex === 0 && t.provider === "gemini" ? status : null));
    assert.deepEqual(calls, ["gemini/G1/k1", "gemini/G2/k1"], `status ${status}`);
    assert.equal(health.isAvailable(targets.find((t) => t.model === "G2" && t.keyIndex === 0 && t.provider === "gemini")), true);
    assert.equal(health.isAvailable(targets.find((t) => t.model === "G1" && t.keyIndex === 0 && t.provider === "gemini")), false);
  }
});

test("non-retryable status (422) stops the walk immediately", async () => {
  const { calls, error } = await runStatuses(() => 422);
  assert.equal(calls.length, 1);
  assert.equal(error.status, 422);
});

test("generic 400 falls through without cooling anyone; all-400 returns 400", async () => {
  const { calls, error, health, targets } = await runStatuses(() => ({ status: 400, retryable: true, skipCooldown: true }));
  assert.equal(calls.length, 24);
  assert.equal(error.status, 400);
  assert.ok(targets.every((t) => health.isAvailable(t)), "nobody cooled by a request-specific 400");
});

test("model-rejection 400 is retryable and DOES cool that target", async () => {
  const { calls, health, targets } = await runStatuses((t) => (t.model === "G1" && t.keyIndex === 0 && t.provider === "gemini" ? { status: 400, retryable: true } : null));
  assert.deepEqual(calls, ["gemini/G1/k1", "gemini/G2/k1"]);
  assert.equal(health.isAvailable(targets[0]), false);
});

test("413 is retryable and cools the target briefly (60s), not 15 minutes", async () => {
  const before = Date.now();
  const { calls, health, targets } = await runStatuses((t) => (t.model === "G1" && t.keyIndex === 0 && t.provider === "gemini" ? { status: 413, retryable: true } : null));
  assert.deepEqual(calls, ["gemini/G1/k1", "gemini/G2/k1"]);
  const until = health.get(health.key(targets[0])).cooldownUntil;
  assert.ok(until - before <= 61000 && until - before >= 59000, `cooldown was ${until - before}ms`);
});

test("transport failure (no HTTP status) advances to the next target", async () => {
  const { calls } = await runStatuses((t) => (t.model === "G1" && t.keyIndex === 0 && t.provider === "gemini" ? { retryable: true } : null));
  assert.deepEqual(calls, ["gemini/G1/k1", "gemini/G2/k1"]);
});

test("all targets cooling: 503 and no upstream call", async () => {
  const health = new HealthRegistry({ cooldownMs: 900000 });
  const targets = textTargets();
  for (const t of targets) health.markFailure(t, 500, {}, Date.now());
  const { calls, error } = await runStatuses(() => null, { health });
  assert.equal(calls.length, 0);
  assert.equal(error.status, 503);
});

test("no targets at all: 503", async () => {
  const { error } = await runStatuses(() => null, { targets: [] });
  assert.equal(error.status, 503);
});

// =============================================================================
// Sticky -> Priority -> Normal  (tests A-H)
// =============================================================================

const MIN = 60 * 1000;
const PRIO = parsePriorityModels("gemini/G1,groq/GR2");
const phaseOf = (call) => call.split(":")[0];
const T0 = 1_000_000_000_000;

/** One request, with the session's sticky target and TTL handled like production. */
async function request(session, opts = {}) {
  const now = opts.now ?? T0;
  const out = await run({ ...opts, session, now });
  return out;
}
/** Records a success exactly as walkPlan does, at a controlled time. */
function stick(session, target, at = T0) { session.saveSuccess(target, new HealthRegistry(), at); }
const pick = (provider, model, keyIndex = 0, targets = textTargets()) => targets.find((t) => t.provider === provider && t.model === model && t.keyIndex === keyIndex);

test("A: sticky success - the next request attempts that target first", async () => {
  const session = new RouteSession();
  const first = await request(session, { fail: (t) => !(t.provider === "groq" && t.model === "GR3") });
  assert.equal(first.result.model, "GR3");
  assert.ok(session.targetId && session.expiresAt > Date.now());
  const second = await request(session, { now: Date.now() });
  assert.deepEqual(second.calls, ["sticky:groq/GR3/k1"], "sticky first, and it succeeds, so nothing else is called");
});

test("B: sticky lasts 15 minutes from the success, then priority starts first", async () => {
  const session = new RouteSession();
  stick(session, pick("groq", "GR3"), T0);
  assert.equal(session.expiresAt, T0 + 15 * MIN);

  const within = await request(session, { now: T0 + 15 * MIN - 1, priority: PRIO });
  assert.equal(within.calls[0], "sticky:groq/GR3/k1");

  // (fresh session: a success inside the TTL window legitimately refreshes it)
  const expired = new RouteSession();
  stick(expired, pick("groq", "GR3"), T0);
  const after = await request(expired, { now: T0 + 15 * MIN, priority: PRIO, fail: () => true });
  assert.ok(!after.calls.some((c) => c.startsWith("sticky:")), "expired sticky is never called");
  assert.equal(after.calls[0], "priority:gemini/G1/k1", "priority is the first phase after expiry");
  assert.equal(expired.validTargetId(T0 + 15 * MIN), null, "expired sticky is cleared");
});

test("C: sticky fails -> priority 1 -> priority 2 -> normal fallback, with no repeats", async () => {
  const session = new RouteSession();
  stick(session, pick("groq", "GR3"));
  const { calls, skips } = await request(session, { priority: PRIO, fail: () => true });
  assert.deepEqual(calls.slice(0, 9), [
    "sticky:groq/GR3/k1",
    // the sticky MODEL's remaining keys come before any priority entry
    "sticky:groq/GR3/k2", "sticky:groq/GR3/k3",
    "priority:gemini/G1/k1", "priority:gemini/G1/k2", "priority:gemini/G1/k3",
    "priority:groq/GR2/k1", "priority:groq/GR2/k2", "priority:groq/GR2/k3"
  ]);
  assert.equal(phaseOf(calls[9]), "fallback");
  assert.equal(calls.length, 24, "every target exactly once");
  assert.equal(new Set(calls.map((c) => c.split(":")[1])).size, 24);
  assert.ok(skips.includes("fallback:groq/GR3/k1:already_attempted"), "failed sticky is not retried in the same request");
});

test("D: a new success becomes sticky with a fresh 15-minute TTL", async () => {
  const session = new RouteSession();
  stick(session, pick("gemini", "G2"), T0);
  const later = T0 + 10 * MIN;
  const { result, calls } = await request(session, {
    now: later, priority: parsePriorityModels("gemini/G1"),
    fail: (t) => !(t.provider === "groq" && t.model === "GR1")
  });
  assert.equal(calls[0], "sticky:gemini/G2/k1");
  assert.equal(label(result), "groq/GR1/k1");
  // withFallback stamps the real clock, so assert against it.
  assert.equal(session.targetId, new HealthRegistry().key(result));
  assert.ok(session.expiresAt - Date.now() <= 15 * MIN && session.expiresAt - Date.now() > 15 * MIN - 5000);
});

test("E: a sticky key in cooldown is not called; the sticky model's next key runs, then priority", async () => {
  const session = new RouteSession();
  const health = new HealthRegistry({ cooldownMs: 900000 });
  const sticky = pick("groq", "GR3");
  stick(session, sticky, Date.now());
  health.markFailure(sticky, 429, {}, Date.now());
  const { calls, skips } = await request(session, { health, priority: PRIO, now: Date.now() });
  assert.deepEqual(calls, ["sticky:groq/GR3/k2"]);
  assert.ok(skips.includes("sticky:groq/GR3/k1:cooldown"));
  assert.ok(!calls.some((c) => c.includes("groq/GR3/k1")));
});

test("F: normal fallback order is Provider -> Key -> Model, unchanged by a sticky phase", async () => {
  const targets = buildTargets({ a: provider(["k1", "k2"], ["M1", "M2", "M3"]), b: provider(["k1"], ["M1", "M2"]) });
  const expected = [
    "a/M1/k1", "a/M2/k1", "a/M3/k1", "a/M1/k2", "a/M2/k2", "a/M3/k2", "b/M1/k1", "b/M2/k1"
  ];
  const plain = await run({ targets, fail: () => true });
  assert.deepEqual(plain.calls.map((c) => c.split(":")[1]), expected);

  const session = new RouteSession();
  stick(session, targets.find((t) => t.provider === "a" && t.model === "M2" && t.keyIndex === 1));
  const sticky = await request(session, { targets, fail: () => true });
  assert.equal(sticky.calls[0], "sticky:a/M2/k2");
  // The sticky model's other key is next; the rest is the same normal list, minus what was already attempted.
  assert.equal(sticky.calls[1], "sticky:a/M2/k1");
  assert.deepEqual(sticky.calls.slice(2).map((c) => c.split(":")[1]), expected.filter((x) => x !== "a/M2/k2" && x !== "a/M2/k1"));
});

test("G: text and vision stickies are isolated", async () => {
  const text = textTargets();
  const vision = buildTargets({ gemini: provider(["v1"], ["G1", "GV2"]) }, VISION_POOL);
  const health = new HealthRegistry();
  const textSession = new RouteSession();
  const visionSession = new RouteSession();
  textSession.saveSuccess(pick("groq", "GR3"), health, T0);
  visionSession.saveSuccess(vision.find((t) => t.model === "GV2"), health, T0);

  // A text sticky id is not a vision target (and vice versa): ignored, no sticky phase.
  const crossVision = await run({ targets: vision, session: new RouteSession({ targetId: textSession.targetId, expiresAt: T0 + MIN }), now: T0 });
  assert.ok(!crossVision.calls.some((c) => c.startsWith("sticky:")));
  const crossText = await run({ targets: text, session: new RouteSession({ targetId: visionSession.targetId, expiresAt: T0 + MIN }), now: T0 });
  assert.ok(!crossText.calls.some((c) => c.startsWith("sticky:")));

  // Each pool's own sticky works for its own pool.
  assert.equal((await run({ targets: vision, session: visionSession, now: T0 })).calls[0], "sticky:gemini/GV2/k1");
  assert.equal((await run({ targets: text, session: textSession, now: T0 })).calls[0], "sticky:groq/GR3/k1");
});

test("H: after sticky expiry priority is NOT skipped: P1 -> P2 -> normal", async () => {
  const session = new RouteSession();
  stick(session, pick("groq", "GR3"), T0);
  const { calls } = await request(session, { now: T0 + 16 * MIN, priority: PRIO, fail: () => true });
  assert.deepEqual(calls.slice(0, 6), [
    "priority:gemini/G1/k1", "priority:gemini/G1/k2", "priority:gemini/G1/k3",
    "priority:groq/GR2/k1", "priority:groq/GR2/k2", "priority:groq/GR2/k3"
  ]);
  assert.equal(phaseOf(calls[6]), "fallback");
  assert.ok(calls.every((c) => !c.startsWith("sticky:")));
});

test("sticky does not override an explicit, configured model choice", async () => {
  const fresh = () => { const x = new RouteSession(); stick(x, pick("groq", "GR3"), T0); return x; };
  // Client names G2 (configured): a sticky serving a different model is not used.
  const named = await request(fresh(), { requestedModel: "G2", now: T0 + MIN });
  assert.equal(named.calls[0], "fallback:gemini/G2/k1");
  // Client names the sticky's own model: it is honoured.
  const own = await request(fresh(), { requestedModel: "GR3", now: T0 + MIN });
  assert.equal(own.calls[0], "sticky:groq/GR3/k1");
  // Unknown model (auto-routed): sticky applies.
  const unknown = await request(fresh(), { requestedModel: "totally-unknown", now: T0 + MIN });
  assert.equal(unknown.calls[0], "sticky:groq/GR3/k1");
});

test("a sticky target removed from config or filtered out by protocol is ignored", async () => {
  const session = new RouteSession({ targetId: "groq:GONE:key-0", expiresAt: T0 + MIN });
  const { calls } = await request(session, { priority: PRIO, now: T0 });
  assert.equal(calls[0], "priority:gemini/G1/k1");
});

test("RouteSession TTL: timestamp based, no timer, refreshed by each success", () => {
  const s = new RouteSession();
  const h = new HealthRegistry();
  const t = pick("gemini", "G1");
  assert.equal(s.validTargetId(T0), null);
  s.saveSuccess(t, h, T0);
  assert.equal(s.validTargetId(T0 + 14 * MIN), h.key(t));
  s.saveSuccess(t, h, T0 + 14 * MIN);                         // refresh
  assert.equal(s.validTargetId(T0 + 28 * MIN), h.key(t), "TTL restarted from the latest success");
  assert.equal(s.validTargetId(T0 + 29 * MIN), null);
  assert.equal(new RouteSession({ targetId: "x" }).validTargetId(T0), null, "an un-timestamped sticky is not trusted");
});
