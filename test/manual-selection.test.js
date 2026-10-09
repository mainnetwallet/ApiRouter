import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildRoutePlan } from "../src/routing-plan.js";
import { ManualSelectionStore } from "../src/manual-selection.js";
import { HealthRegistry } from "../src/health.js";
import { RouteSession, withFallback } from "../src/router.js";

const t = (provider, model, keyIndex) => ({ provider, model, keyIndex, pool: "text", protocols: ["openai-chat"] });
const targets = [
  t("a", "A1", 0), t("a", "A1", 1), t("a", "A2", 0), t("a", "A2", 1),
  t("b", "B1", 0), t("b", "B1", 1), t("c", "C1", 0)
];
const ids = (steps) => steps.map((s) => `${s.phase}:${s.target.provider}/${s.target.model}#${s.target.keyIndex}`);

test("manual models lead in saved order, every key of a model before the next", () => {
  const { steps } = buildRoutePlan({
    targets,
    manual: [{ provider: "b", model: "B1" }, { provider: "a", model: "A2" }],
    priority: [{ provider: "c", model: "C1" }]
  });
  assert.deepEqual(ids(steps).slice(0, 7), [
    "manual:b/B1#0", "manual:b/B1#1", "manual:a/A2#0", "manual:a/A2#1",
    "priority:c/C1#0", "fallback:a/A1#0", "fallback:a/A2#0"
  ]);
  assert.equal(steps.filter((s) => s.phase === "manual").length, 4);
});

test("empty manual selection leaves the plan unchanged, sticky included", () => {
  const stickyTargetId = "a:A2:key-1";
  const base = buildRoutePlan({ targets, stickyTargetId: undefined });
  assert.deepEqual(ids(buildRoutePlan({ targets, manual: [] }).steps), ids(base.steps));
  const withSticky = buildRoutePlan({ targets: targets.map((x) => ({ ...x, id: `${x.provider}:${x.model}:key-${x.keyIndex}` })), manual: [], stickyTargetId });
  assert.equal(withSticky.steps[0].phase, "sticky");
});

test("active manual selection is not displaced by sticky", () => {
  const withIds = targets.map((x) => ({ ...x, id: `${x.provider}:${x.model}:key-${x.keyIndex}` }));
  const { steps } = buildRoutePlan({ targets: withIds, manual: [{ provider: "b", model: "B1" }], stickyTargetId: "a:A2:key-1" });
  assert.equal(steps[0].phase, "manual");
  assert.ok(!steps.some((s) => s.phase === "sticky"));
});

test("walker tries every key of a manual model, stops on success, then falls through", async () => {
  const health = new HealthRegistry();
  const withIds = targets.map((x) => ({ ...x, id: `${x.provider}:${x.model}:key-${x.keyIndex}` }));
  const { steps } = buildRoutePlan({ targets: withIds, manual: [{ provider: "b", model: "B1" }, { provider: "a", model: "A2" }] });

  const calls = [];
  const fail = Object.assign(new Error("boom"), { status: 500 });
  const result = await withFallback(withIds, async (target, { phase }) => {
    calls.push(`${phase}:${target.model}#${target.keyIndex}`);
    if (target.model === "B1" || (target.model === "A2" && target.keyIndex === 0)) throw fail;
    return "ok";
  }, new Set([500]), new RouteSession(), health, { plan: steps });
  assert.equal(result, "ok");
  assert.deepEqual(calls, ["manual:B1#0", "manual:B1#1", "manual:A2#0", "manual:A2#1"]);

  // Everything manual fails: execution continues into the normal fallback.
  const health2 = new HealthRegistry();
  const calls2 = [];
  const res2 = await withFallback(withIds, async (target, { phase }) => {
    calls2.push(`${phase}:${target.model}#${target.keyIndex}`);
    if (phase === "manual") throw fail;
    return "fallback-ok";
  }, new Set([500]), new RouteSession(), health2, { plan: steps });
  assert.equal(res2, "fallback-ok");
  assert.equal(calls2.at(-1).startsWith("fallback:"), true);
});

test("store persists across restarts and stores ids only", () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "manual-")), "sel.json");
  const store = new ManualSelectionStore({ file });
  store.set("text", [{ provider: "A", model: "m1", apiKey: "SECRET" }, { provider: "a", model: "m1" }, { provider: "b", model: "m2" }]);
  store.set("vision", [{ provider: "c", model: "v1" }]);
  const reloaded = new ManualSelectionStore({ file });
  assert.deepEqual(reloaded.get("text"), [{ provider: "a", model: "m1" }, { provider: "b", model: "m2" }]);
  assert.deepEqual(reloaded.get("vision"), [{ provider: "c", model: "v1" }]);
  assert.ok(!fs.readFileSync(file, "utf8").includes("SECRET"));
  reloaded.clear("text");
  assert.deepEqual(new ManualSelectionStore({ file }).snapshot(), { text: [], vision: [{ provider: "c", model: "v1" }] });
});
