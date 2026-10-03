import test from "node:test";
import assert from "node:assert/strict";
import { buildTargets, loadConfig, VISION_POOL } from "../src/config.js";
import { HealthRegistry } from "../src/health.js";
import { RouteSession, withFallback } from "../src/router.js";
import { buildRoutePlan, parsePriorityModels, readPriority } from "../src/routing-plan.js";

const provider = (keys, models, extra = {}) => ({ apiKeys: keys, models, baseUrl: "http://x", ...extra });
const gemini = provider(["k1", "k2", "k3"], ["G1", "G2", "G3", "G4"]);
const groq = provider(["k1", "k2", "k3"], ["GR1", "GR2", "GR3", "GR4"]);
const textTargets = () => buildTargets({ gemini, groq });
const label = (t) => `${t.provider}/${t.model}/k${t.keyIndex + 1}`;

/** Runs a plan against a scripted outcome map and returns what was really called. */
async function run({ targets = textTargets(), priority = [], requestedModel = "", fail = () => false, health = new HealthRegistry(), session = new RouteSession() } = {}) {
  const plan = buildRoutePlan({ targets, requestedModel, priority, stickyTargetId: session.targetId });
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

test("readPriority: pool-specific lists win, otherwise the shared list applies", () => {
  const env = { PRIORITY_MODELS: "gemini/G1", VISION_PRIORITY_MODELS: "groq/GR1" };
  assert.deepEqual(readPriority(env, "text"), [{ provider: "gemini", model: "G1" }]);
  assert.deepEqual(readPriority(env, "vision"), [{ provider: "groq", model: "GR1" }]);
  assert.deepEqual(readPriority({}, "text"), []);
  assert.deepEqual(loadConfig({ PRIORITY_MODELS: "gemini/G1" }).priority.vision, [{ provider: "gemini", model: "G1" }]);
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

test("priority runs in exact env order, interleaving providers, and stops on first success", async () => {
  const priority = parsePriorityModels("gemini/G1,groq/GR2,gemini/G3");
  const first = await run({ priority });
  assert.deepEqual(first.calls, ["priority:gemini/G1/k1"], "stops immediately; no Groq or second Gemini call");

  const second = await run({ priority, fail: (t) => t.provider === "gemini" && t.model === "G1" });
  assert.deepEqual(second.calls, ["priority:gemini/G1/k1", "priority:gemini/G1/k2", "priority:gemini/G1/k3", "priority:groq/GR2/k1"]);
  assert.equal(second.result.provider, "groq");
});

test("all priority fail: normal fallback never repeats an attempted target, and logs the skip", async () => {
  const priority = parsePriorityModels("gemini/G1,groq/GR2,gemini/G3");
  const { calls, skips } = await run({ priority, fail: () => true });
  assert.equal(new Set(calls.map((c) => c.split(":")[1])).size, calls.length, "no target is called twice");
  // Key-scoped: key1 of Gemini runs G2 and G4 (G1, G3 already attempted) before key2 starts at G1... which was also a priority attempt.
  const normal = calls.filter((c) => c.startsWith("fallback:"));
  assert.deepEqual(normal.slice(0, 2), ["fallback:gemini/G2/k1", "fallback:gemini/G4/k1"]);
  assert.ok(skips.includes("fallback:gemini/G1/k1:already_attempted"));
  assert.ok(skips.includes("fallback:groq/GR2/k1:already_attempted"));
  // Exact total: every target exactly once.
  assert.equal(calls.length, 24);
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
  assert.deepEqual(calls.slice(0, 2), ["priority:gemini/GV2/k1", "priority:gemini/GV2/k2"]);
  assert.equal(new Set(calls).size, 4);
});

test("a priority entry for a model only the other pool has is ignored, never routed", () => {
  const visionTargets = buildTargets({ gemini: provider(["v1"], ["GV1"]) }, VISION_POOL);
  const { steps, priorityCount } = buildRoutePlan({ targets: visionTargets, priority: parsePriorityModels("gemini/G1") });
  assert.equal(priorityCount, 0);
  assert.ok(steps.every((s) => s.target.pool === "vision"));
});

test("sticky target leads the normal phase but never beats priority", async () => {
  const targets = textTargets();
  const sticky = targets.find((t) => t.provider === "gemini" && t.model === "G3" && t.keyIndex === 0);
  const session = new RouteSession({ targetId: new HealthRegistry().key(sticky) });
  const plain = await run({ session });
  assert.equal(plain.calls[0], "fallback:gemini/G3/k1");
  const withPriority = await run({ session: new RouteSession({ targetId: new HealthRegistry().key(sticky) }), priority: parsePriorityModels("groq/GR1") });
  assert.equal(withPriority.calls[0], "priority:groq/GR1/k1");
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
  const preview = describeRouting({ targets, config, health: new HealthRegistry(), protocol: "openai-chat", model: "" });
  assert.equal(preview.priorityTargets, 6);
  assert.deepEqual(preview.fallbackOrder.slice(0, 4).map((c) => `${c.phase}:${c.provider}/${c.model}/${c.keyIndex}`), [
    "priority:groq/GR2/0", "priority:groq/GR2/1", "priority:groq/GR2/2", "priority:gemini/G3/0"
  ]);
  const normal = preview.fallbackOrder.filter((c) => c.phase === "fallback").slice(0, 2);
  assert.deepEqual(normal.map((c) => `${c.model}/${c.keyIndex}`), ["G1/0", "G2/0"]);
});
