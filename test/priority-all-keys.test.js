import test from "node:test";
import assert from "node:assert/strict";
import { buildTargets, VISION_POOL } from "../src/config.js";
import { HealthRegistry } from "../src/health.js";
import { RouteSession, withFallback } from "../src/router.js";
import { buildRoutePlan, parsePriorityModels } from "../src/routing-plan.js";

// Priority is MODEL-centric: one TEXT_PRIORITY_MODELS entry is one provider/model
// group, and EVERY eligible key of it is attempted, in key order, before the
// walk advances to the next configured entry. Exact targets are never repeated
// within a request, sticky leads only the current session, and the configured
// priority order never changes.

const provider = (keys, models) => ({ apiKeys: keys, models, baseUrl: "http://x" });
const gemini = provider(["g1", "g2", "g3"], ["G1", "G2"]);
const groq = provider(["q1", "q2"], ["Q1", "Q2"]);
const openrouter = provider(["o1", "o2", "o3", "o4"], ["O1", "O2"]);
const label = (t) => `${t.provider}/${t.model}/k${t.keyIndex + 1}`;
const mk = () => buildTargets({ gemini, groq, openrouter });
const MIN = 60 * 1000;
const T0 = 1_000_000_000_000;
const PRIO = parsePriorityModels("gemini/G1,groq/Q1,gemini/G2");

/**
 * `outcome(target)` returns undefined (success), a status number, or an error
 * spec { status, skipCooldown?, retryable? }. Returns the real upstream calls.
 */
async function run({ targets = mk(), priority = PRIO, requestedModel = "", outcome = () => undefined, health = new HealthRegistry(), session = new RouteSession(), now = T0 } = {}) {
  const plan = buildRoutePlan({ targets, requestedModel, priority, stickyTargetId: session.validTargetId(now) });
  const calls = [];
  const skips = [];
  let result;
  let error;
  try {
    result = await withFallback(targets, async (target, { phase }) => {
      calls.push(`${phase}:${label(target)}`);
      const spec = outcome(target);
      if (spec === undefined) return target;
      const { status, ...flags } = typeof spec === "number" ? { status: spec } : spec;
      throw Object.assign(new Error(`upstream ${status}`), { status }, flags);
    }, undefined, session, health, {
      plan: plan.steps,
      onSkip: (target, info) => skips.push(`${info.phase}:${label(target)}:${info.reason}`)
    });
  } catch (e) { error = e; }
  return { calls, skips, result, error, plan, health, session };
}

const failing = (...labels) => (target) => (labels.includes(label(target)) ? 503 : undefined);
const find = (label_, targets = mk()) => targets.find((t) => label(t) === label_);
const stick = (session, target, at = T0) => session.saveSuccess(target, new HealthRegistry(), at);
const ids = (calls) => calls.map((c) => c.split(":")[1]);

test("1: gemini key1 fails, key2 succeeds -> key3 is never called", async () => {
  const { calls, result } = await run({ outcome: failing("gemini/G1/k1") });
  assert.deepEqual(calls, ["priority:gemini/G1/k1", "priority:gemini/G1/k2"]);
  assert.equal(label(result), "gemini/G1/k2");
});

test("2: all keys of an entry fail before the next priority entry; no Q1 call precedes a remaining G1 key", async () => {
  const { calls } = await run({ outcome: () => 503 });
  assert.deepEqual(calls.slice(0, 8), [
    "priority:gemini/G1/k1", "priority:gemini/G1/k2", "priority:gemini/G1/k3",
    "priority:groq/Q1/k1", "priority:groq/Q1/k2",
    "priority:gemini/G2/k1", "priority:gemini/G2/k2", "priority:gemini/G2/k3"
  ]);
  assert.equal(calls[8].split(":")[0], "fallback", "normal fallback starts only after every priority entry");
  const firstQ1 = calls.findIndex((c) => c.includes("groq/Q1"));
  const lastG1 = calls.map((c) => c.includes("gemini/G1/")).lastIndexOf(true);
  assert.ok(lastG1 < firstQ1);
});

test("3: G1 k1=503, k2=429, k3=200 -> stop at k3; Q1 and G2 are not called", async () => {
  const outcome = (t) => ({ "gemini/G1/k1": 503, "gemini/G1/k2": 429 })[label(t)];
  const { calls, result } = await run({ outcome });
  assert.deepEqual(calls, ["priority:gemini/G1/k1", "priority:gemini/G1/k2", "priority:gemini/G1/k3"]);
  assert.equal(label(result), "gemini/G1/k3");
  assert.ok(!calls.some((c) => c.includes("Q1") || c.includes("gemini/G2")));
});

test("4: the successful exact key becomes sticky and leads the next same-session request", async () => {
  const session = new RouteSession();
  const health = new HealthRegistry();
  const first = await run({ session, health, outcome: failing("gemini/G1/k1", "gemini/G1/k2") });
  assert.deepEqual(first.calls, ["priority:gemini/G1/k1", "priority:gemini/G1/k2", "priority:gemini/G1/k3"]);
  assert.equal(session.targetId, health.key(find("gemini/G1/k3")), "provider + key + model");

  const second = await run({ session, health, now: Date.now() });
  assert.deepEqual(second.calls, ["sticky:gemini/G1/k3"], "sticky success stops the request");
});

test("5: sticky failure does not repeat the exact target; priority continues with G1 key1, key2, then the next entry", async () => {
  const session = new RouteSession();
  stick(session, find("gemini/G1/k3"));
  const { calls, skips } = await run({ session, outcome: failing("gemini/G1/k3", "gemini/G1/k1", "gemini/G1/k2") });
  // Q1/k1 succeeds, so the walk ends there: sticky, then G1's OTHER keys in key order, then the next entry.
  assert.deepEqual(calls, ["sticky:gemini/G1/k3", "priority:gemini/G1/k1", "priority:gemini/G1/k2", "priority:groq/Q1/k1"]);
  assert.equal(calls.filter((c) => c.endsWith("gemini/G1/k3")).length, 1, "G1/k3 called exactly once");
  assert.ok(skips.includes("priority:gemini/G1/k3:already_attempted"));
});

test("5b: cooled keys are skipped, not retried, when the sticky target fails", async () => {
  const session = new RouteSession();
  const health = new HealthRegistry({ cooldownMs: 15 * MIN });
  const now = Date.now();
  stick(session, find("gemini/G1/k3"), now);
  health.markFailure(find("gemini/G1/k1"), 429, {}, now);
  health.markFailure(find("gemini/G1/k2"), 429, {}, now);
  const { calls, skips } = await run({ session, health, now, outcome: failing("gemini/G1/k3") });
  assert.deepEqual(calls, ["sticky:gemini/G1/k3", "priority:groq/Q1/k1"]);
  assert.ok(skips.includes("priority:gemini/G1/k1:cooldown"));
  assert.ok(skips.includes("priority:gemini/G1/k2:cooldown"));
});

test("6: a different session never inherits another session's sticky target", async () => {
  const sessionA = new RouteSession();
  const health = new HealthRegistry();
  await run({ session: sessionA, health, outcome: failing("gemini/G1/k1", "gemini/G1/k2") });
  assert.equal(sessionA.targetId, health.key(find("gemini/G1/k3")));
  const b = await run({ session: new RouteSession(), health: new HealthRegistry() });
  assert.deepEqual(b.calls, ["priority:gemini/G1/k1"], "session B starts at the first configured priority model/key");
});

test("7: the configured priority order never mutates, whatever succeeded elsewhere", async () => {
  const order = (plan) => [...new Set(plan.steps.filter((s) => s.phase === "priority").map((s) => s.group))];
  const baseline = order(buildRoutePlan({ targets: mk(), priority: PRIO }));
  assert.deepEqual(baseline, ["gemini/G1", "groq/Q1", "gemini/G2"]);

  const session = new RouteSession();
  await run({ session, outcome: failing("gemini/G1/k1", "gemini/G1/k2") });   // G1/k3 succeeds
  await run({ session, now: Date.now(), outcome: failing("gemini/G1/k3") });  // sticky fails, later success
  const fresh = await run({ session: new RouteSession() });
  assert.deepEqual(order(fresh.plan), baseline);
  assert.deepEqual(order(buildRoutePlan({ targets: mk(), priority: PRIO, stickyTargetId: session.targetId })), baseline);
});

test("8: mixed key counts - every eligible key of each priority model, then the next model", async () => {
  const priority = parsePriorityModels("gemini/G1,groq/Q1,openrouter/O1");
  const { calls } = await run({ priority, outcome: () => 503 });
  assert.deepEqual(calls.slice(0, 9), [
    "priority:gemini/G1/k1", "priority:gemini/G1/k2", "priority:gemini/G1/k3",
    "priority:groq/Q1/k1", "priority:groq/Q1/k2",
    "priority:openrouter/O1/k1", "priority:openrouter/O1/k2", "priority:openrouter/O1/k3", "priority:openrouter/O1/k4"
  ]);
  assert.ok(calls.slice(9).every((c) => c.startsWith("fallback:")));
});

test("9: duplicate protection - a priority target met again in normal fallback is never called twice", async () => {
  const targets = mk();
  const { calls, skips } = await run({ targets, outcome: () => 503 });
  assert.equal(new Set(ids(calls)).size, calls.length, "no exact provider + key + model repeated");
  assert.equal(calls.length, targets.length, "every target exactly once");
  assert.ok(skips.includes("fallback:gemini/G1/k1:already_attempted"));
  assert.ok(skips.includes("fallback:gemini/G2/k3:already_attempted"));
});

test("10: text sticky is never used for vision, and vision priority uses only its own pool", async () => {
  const text = mk();
  const vision = buildTargets({ gemini: provider(["v1", "v2"], ["G1", "GV2"]) }, VISION_POOL);
  const health = new HealthRegistry();
  const textSession = new RouteSession();
  textSession.saveSuccess(find("gemini/G1/k3", text), health, T0);

  const asVision = await run({ targets: vision, session: new RouteSession({ targetId: textSession.targetId, expiresAt: T0 + MIN }), priority: parsePriorityModels("gemini/GV2"), outcome: () => 503 });
  assert.ok(!asVision.calls.some((c) => c.startsWith("sticky:")), "text sticky ignored for vision");
  assert.deepEqual(asVision.calls.slice(0, 2), ["priority:gemini/GV2/k1", "priority:gemini/GV2/k2"]);
  assert.ok(asVision.plan.steps.every((s) => s.target.pool === "vision"));

  const visionSession = new RouteSession();
  visionSession.saveSuccess(vision.find((t) => t.model === "GV2" && t.keyIndex === 1), health, T0);
  const asText = await run({ targets: text, session: new RouteSession({ targetId: visionSession.targetId, expiresAt: T0 + MIN }), outcome: () => 503 });
  assert.ok(!asText.calls.some((c) => c.startsWith("sticky:")), "vision sticky ignored for text");
});

// ---- failure semantics inside a priority group ------------------------------

test("401 on one key cools that key's sibling models but other keys of the entry are still attempted", async () => {
  const health = new HealthRegistry();
  const outcome = (t) => (label(t) === "gemini/G1/k1" ? 401 : undefined);
  const { calls, result } = await run({ health, outcome });
  assert.deepEqual(calls, ["priority:gemini/G1/k1", "priority:gemini/G1/k2"]);
  assert.equal(label(result), "gemini/G1/k2");
  assert.equal(health.isAvailable(find("gemini/G2/k1")), false, "same provider + key, other model: cooled");
  assert.equal(health.isAvailable(find("gemini/G1/k3")), true, "other keys unaffected");
});

test("a key-level failure on key1 does not skip the later G2 entry's other keys", async () => {
  const outcome = (t) => (t.provider === "gemini" && t.keyIndex === 0 ? 402 : t.model === "Q1" ? 503 : t.model === "G1" ? 503 : undefined);
  const { calls, result } = await run({ outcome });
  // G1/k1 -> 402 cools gemini key1 for G2 too; G1/k2,k3 fail, Q1 both fail, G2/k1 skipped (cooled), G2/k2 serves.
  assert.deepEqual(calls, [
    "priority:gemini/G1/k1", "priority:gemini/G1/k2", "priority:gemini/G1/k3",
    "priority:groq/Q1/k1", "priority:groq/Q1/k2", "priority:gemini/G2/k2"
  ]);
  assert.equal(label(result), "gemini/G2/k2");
});

test("generic 400 (skipCooldown) tries the next key and leaves the first key healthy", async () => {
  const health = new HealthRegistry();
  const outcome = (t) => (label(t) === "gemini/G1/k1" ? { status: 400, retryable: true, skipCooldown: true } : undefined);
  const { calls } = await run({ health, outcome });
  assert.deepEqual(calls, ["priority:gemini/G1/k1", "priority:gemini/G1/k2"]);
  assert.equal(health.isAvailable(find("gemini/G1/k1")), true, "a 400 does not block the key");
  assert.equal(health.isAvailable(find("gemini/G1/k3")), true);
});

test("a non-retryable error still aborts the request (no key walk)", async () => {
  const { calls, error } = await run({ outcome: () => 422 });
  assert.deepEqual(calls, ["priority:gemini/G1/k1"]);
  assert.equal(error.status, 422);
});

test("an entirely cooled priority entry is skipped and the walk advances to the next entry", async () => {
  const health = new HealthRegistry({ cooldownMs: 15 * MIN });
  const now = Date.now();
  for (const k of [1, 2, 3]) health.markFailure(find(`gemini/G1/k${k}`), 429, {}, now);
  const { calls, skips } = await run({ health, now });
  assert.deepEqual(calls, ["priority:groq/Q1/k1"]);
  assert.ok(skips.includes("priority:gemini/G1/k3:cooldown"));
});

test("an explicit requested model keeps its normal-order rules; sticky for another model is not used", async () => {
  const session = new RouteSession();
  stick(session, find("groq/Q2/k1"));
  const { calls } = await run({ session, requestedModel: "G2", priority: [], outcome: () => 503 });
  assert.equal(calls[0], "fallback:gemini/G2/k1", "incompatible sticky is not attempted before the requested model");
  assert.ok(!calls.some((c) => c.startsWith("sticky:")));
});
