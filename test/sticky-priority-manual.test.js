import test from "node:test";
import assert from "node:assert/strict";
import { buildRoutePlan } from "../src/routing-plan.js";
import { HealthRegistry } from "../src/health.js";
import { RouteSession, withFallback } from "../src/router.js";

const t = (provider, model, keyIndex = 0) => ({ provider, model, keyIndex, pool: "text", protocols: ["openai-chat"] });
const sid = (x) => `${x.provider}:${x.model}:key-${x.keyIndex}`;
const label = (steps) => steps.map((s) => `${s.phase}:${s.target.provider}/${s.target.model}#${s.target.keyIndex}`);
const pri = (...pairs) => pairs.map((p) => ({ provider: p[0], model: p[1] }));

const targets = [t("a", "A"), t("b", "B"), t("b", "B", 1), t("c", "C"), t("d", "D")];
const fail500 = () => Object.assign(new Error("boom"), { status: 500 });

test("priority: entries above the sticky model lead the plan again", () => {
  const { steps } = buildRoutePlan({
    targets,
    priority: pri(["a", "A"], ["b", "B"], ["c", "C"], ["d", "D"]),
    stickyTargetId: sid(t("b", "B"))
  });
  assert.deepEqual(label(steps).slice(0, 5), [
    "priority:a/A#0", "sticky:b/B#0", "priority:b/B#1", "priority:c/C#0", "priority:d/D#0"
  ]);
});

test("priority: sticky on the top entry leaves the plan as before", () => {
  const { steps } = buildRoutePlan({
    targets,
    priority: pri(["a", "A"], ["b", "B"]),
    stickyTargetId: sid(t("a", "A"))
  });
  assert.deepEqual(label(steps).slice(0, 3), ["sticky:a/A#0", "priority:b/B#0", "priority:b/B#1"]);
});

test("priority: a higher entry in cooldown is skipped, then retried once recovered", async () => {
  const health = new HealthRegistry();
  const session = new RouteSession();
  const priority = pri(["a", "A"], ["b", "B"]);
  const plan = () => buildRoutePlan({ targets, priority, stickyTargetId: session.validTargetId() }).steps;
  const calls = [];
  let aDown = true;
  const invoke = async (target) => {
    calls.push(target.model);
    if (target.model === "A" && aDown) throw fail500();
    return target.model;
  };
  const run = () => withFallback(targets, invoke, new Set([500]), session, health, { plan: plan() });

  // A fails (cooldown 1 ms for the test), B answers and becomes sticky.
  health.cooldownMs = 1;
  assert.equal(await run(), "B");
  assert.deepEqual(calls, ["A", "B"]);

  // While A cools down, B is used without touching A.
  health.cooldownMs = 60_000;
  health.markFailure(t("a", "A"), 500, { cooldownMs: 60_000 });
  calls.length = 0;
  assert.equal(await run(), "B");
  assert.deepEqual(calls, ["B"]);

  // A recovers and its cooldown ends: it takes traffic back from sticky B.
  health.ensureTarget(t("a", "A")).cooldownUntil = 0;
  aDown = false;
  calls.length = 0;
  assert.equal(await run(), "A");
  assert.deepEqual(calls, ["A"]);
  assert.equal(session.validTargetId(), sid(t("a", "A")));
});

test("manual: sticky leads inside the selection, then the saved order continues", () => {
  const { steps } = buildRoutePlan({
    targets,
    manual: pri(["a", "A"], ["b", "B"], ["c", "C"]),
    stickyTargetId: sid(t("b", "B", 1))
  });
  assert.deepEqual(label(steps).slice(0, 6), [
    "sticky:b/B#1", "sticky:b/B#0", "manual:a/A#0", "manual:b/B#0", "manual:b/B#1", "manual:c/C#0"
  ]);
});

test("manual: a sticky target outside the selection is ignored", () => {
  const { steps } = buildRoutePlan({
    targets,
    manual: pri(["a", "A"], ["b", "B"]),
    stickyTargetId: sid(t("d", "D"))
  });
  assert.equal(steps[0].phase, "manual");
  assert.ok(!steps.some((s) => s.phase === "sticky"));
});

test("manual: the last successful manual model is reused on the next request", async () => {
  const health = new HealthRegistry();
  const session = new RouteSession();
  const manual = pri(["a", "A"], ["b", "B"]);
  const calls = [];
  // A is flaky but its failure is short-lived, so only stickiness keeps B in front.
  const invoke = async (target) => {
    calls.push(target.model);
    if (target.model === "A") throw Object.assign(new Error("flaky"), { status: 500, skipCooldown: true });
    return target.model;
  };
  const run = () => withFallback(targets, invoke, new Set([500]), session, health, {
    plan: buildRoutePlan({ targets, manual, stickyTargetId: session.validTargetId() }).steps
  });

  assert.equal(await run(), "B");
  assert.deepEqual(calls, ["A", "B"]);
  calls.length = 0;
  assert.equal(await run(), "B");
  assert.deepEqual(calls, ["B"]);
});
