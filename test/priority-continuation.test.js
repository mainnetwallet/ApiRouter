import test from "node:test";
import assert from "node:assert/strict";
import { startMockUpstream } from "../test-helpers/mock-upstream.js";
import { startRouter, postJson } from "../test-helpers/router-harness.js";
import { buildTargets } from "../src/config.js";
import { HealthRegistry } from "../src/health.js";
import { RouteSession, withFallback } from "../src/router.js";
import { buildRoutePlan, parsePriorityModels } from "../src/routing-plan.js";

// Priority:  A -> B -> C -> D
//
// Bug: with the last success on B, when B's sticky key and all other B keys failed, the router
// went back to the START of the priority list (A) instead of continuing after B.
//
// Required: sticky B -> B's keys (all of them) -> C's keys -> D's keys -> existing normal fallback.
// Entries listed BEFORE the sticky model are never revisited by the priority phase; sticky C means
// C -> D -> fallback. A sticky success stops immediately. Text and vision behave identically and
// keep separate sticky state.
//
// The normal fallback is the existing, unchanged Provider -> Key -> Models list of every target,
// so a target that already lost its priority slot can still only be reached there (phase
// "fallback"), after the whole priority phase is exhausted. Tests below assert exactly that.

// ---------------------------------------------------------------------------------------------
// Part A: plan + walker (deterministic)
// ---------------------------------------------------------------------------------------------

const provider = (keys, models) => ({ apiKeys: keys, models, baseUrl: "http://x" });
const label = (t) => `${t.provider}/${t.model}/k${t.keyIndex + 1}`;

// Priority models A,B,C,D (A and C on "openrouter", B and D on "mistral"), 2 keys each, plus a
// fallback-only model F on "groq". The object order is the normal-fallback provider order
// (groq -> mistral -> openrouter), so the unchanged normal list reaches F BEFORE any priority
// model's provider: a fallback that succeeds does so without touching A, B, C or D again.
const pool = () => buildTargets({
  groq: provider(["k1"], ["F"]),
  mistral: provider(["k1", "k2"], ["B", "D"]),
  openrouter: provider(["k1", "k2"], ["A", "C"])
});
const PRIO = parsePriorityModels("openrouter/A,mistral/B,openrouter/C,mistral/D");
const find = (model, keyIndex) => pool().find((t) => t.model === model && t.keyIndex === keyIndex);

/** One request wired exactly like src/server.js. `fail(label)` scripts upstream failures. */
async function request(session, { priority = PRIO, requestedModel = "", fail = () => false, targets = pool() } = {}) {
  const plan = buildRoutePlan({ targets, requestedModel, priority, stickyTargetId: session.validTargetId() });
  const calls = [];
  let result;
  let error;
  try {
    result = await withFallback(targets, async (target, { phase }) => {
      calls.push(`${phase}:${label(target)}`);
      if (fail(label(target))) throw Object.assign(new Error("down"), { status: 503 });
      return target;
    }, undefined, session, new HealthRegistry(), { plan: plan.steps });
  } catch (e) { error = e; }
  return { calls, result, error, plan };
}
const sticky = (session, target) => session.saveSuccess(target, new HealthRegistry());
const modelDown = (...models) => (l) => models.some((m) => l.split("/")[1] === m);
const isA = (call) => call.split(":")[1].split("/")[1] === "A";

test("A1 sticky = B, all B keys fail: B keys -> C keys -> D keys -> fallback; A is never attempted", async () => {
  const session = new RouteSession();
  sticky(session, find("B", 0));
  const { calls, result } = await request(session, { fail: modelDown("B", "C", "D") });
  assert.deepEqual(calls, [
    "sticky:mistral/B/k1", "priority:mistral/B/k2",           // B: the sticky key, then ALL its other keys
    "priority:openrouter/C/k1", "priority:openrouter/C/k2", // C: all keys
    "priority:mistral/D/k1", "priority:mistral/D/k2",         // D: all keys
    "fallback:groq/F/k1"                              // ALL PRIORITY EXHAUSTED -> normal fallback
  ]);
  assert.equal(label(result), "groq/F/k1");
  assert.ok(!calls.some(isA), "A is not attempted at all on this path");
});

test("A2 sticky = B, B fails, C succeeds: attempts stop at C; neither A nor D is touched", async () => {
  const session = new RouteSession();
  sticky(session, find("B", 1));
  const { calls } = await request(session, { fail: modelDown("B") });
  assert.deepEqual(calls, ["sticky:mistral/B/k2", "priority:mistral/B/k1", "priority:openrouter/C/k1"]);
});

test("A3 sticky = B, B and C fail, D succeeds: B keys -> C keys -> D", async () => {
  const session = new RouteSession();
  sticky(session, find("B", 0));
  const { calls } = await request(session, { fail: modelDown("B", "C") });
  assert.deepEqual(calls, [
    "sticky:mistral/B/k1", "priority:mistral/B/k2",
    "priority:openrouter/C/k1", "priority:openrouter/C/k2",
    "priority:mistral/D/k1"
  ]);
  assert.ok(!calls.some(isA));
});

test("A4 sticky = C, C fails: C keys -> D keys -> fallback; A and B are never attempted", async () => {
  const session = new RouteSession();
  sticky(session, find("C", 0));
  const { calls, result } = await request(session, { fail: modelDown("C", "D") });
  assert.deepEqual(calls, [
    "sticky:openrouter/C/k1", "priority:openrouter/C/k2",
    "priority:mistral/D/k1", "priority:mistral/D/k2",
    "fallback:groq/F/k1"
  ]);
  assert.equal(label(result), "groq/F/k1");
  assert.ok(!calls.some((c) => ["A", "B"].includes(c.split(":")[1].split("/")[1])), "A and B are never attempted");
});

test("A5 the sticky model itself succeeding stops immediately (no other key, no other model)", async () => {
  for (const [model, keyIndex] of [["B", 0], ["B", 1], ["C", 1], ["D", 0]]) {
    const session = new RouteSession();
    sticky(session, find(model, keyIndex));
    const { calls } = await request(session);
    assert.deepEqual(calls, [`sticky:${label(find(model, keyIndex))}`], `${model} key ${keyIndex + 1}`);
  }
});

test("A6 the sticky key fails -> ALL eligible keys of that SAME model are tried before anything else", async () => {
  const session = new RouteSession();
  sticky(session, find("B", 0));
  const { calls } = await request(session, { fail: (l) => l === "mistral/B/k1" });
  assert.deepEqual(calls, ["sticky:mistral/B/k1", "priority:mistral/B/k2"], "B's other key succeeds; C is not reached");
});

test("A7 priority exhaustion hands over to the existing fallback; the fallback success becomes sticky", async () => {
  const session = new RouteSession();
  sticky(session, find("B", 0));
  const first = await request(session, { fail: modelDown("B", "C", "D") });
  assert.equal(label(first.result), "groq/F/k1");
  // Next request: that exact fallback target leads. If it fails the priority list restarts from
  // the top, because a fallback target has no position in the priority list.
  const second = await request(session, { fail: modelDown("F") });
  assert.deepEqual(second.calls, ["sticky:groq/F/k1", "priority:openrouter/A/k1"]);
});

test("A8 when EVERYTHING fails, A appears only inside the normal fallback, after all priority steps; no repeats", async () => {
  const session = new RouteSession();
  sticky(session, find("B", 0));
  const { calls, error } = await request(session, { fail: () => true });
  assert.equal(error.status, 502);
  const phasesOfA = calls.filter(isA).map((c) => c.split(":")[0]);
  assert.deepEqual(phasesOfA, ["fallback", "fallback"], "A is only ever a fallback attempt (existing normal list), never a priority one");
  assert.ok(calls.indexOf(calls.find(isA)) > calls.lastIndexOf("priority:mistral/D/k2"), "A comes only after the whole priority phase");
  assert.equal(new Set(calls.map((c) => c.split(":")[1])).size, calls.length, "every target is called at most once");
});

test("A9 no sticky (new/expired session): the full priority list still starts at A", async () => {
  const { calls } = await request(new RouteSession(), { fail: modelDown("A", "B") });
  assert.deepEqual(calls.slice(0, 5), [
    "priority:openrouter/A/k1", "priority:openrouter/A/k2",
    "priority:mistral/B/k1", "priority:mistral/B/k2",
    "priority:openrouter/C/k1"
  ]);
});

test("A10 the priority list itself is not mutated, only resumed: the plan after sticky B is B, C, D", () => {
  const session = new RouteSession();
  sticky(session, find("B", 0));
  const plan = buildRoutePlan({ targets: pool(), priority: PRIO, stickyTargetId: session.validTargetId() });
  const priorityGroups = [...new Set(plan.steps.filter((s) => s.phase === "priority").map((s) => s.group))];
  assert.deepEqual(priorityGroups, ["mistral/B", "openrouter/C", "mistral/D"]);
  assert.equal(plan.priorityCount, 4, "the configured list still has four entries");
  const fresh = buildRoutePlan({ targets: pool(), priority: PRIO });
  assert.deepEqual([...new Set(fresh.steps.filter((s) => s.phase === "priority").map((s) => s.group))], ["openrouter/A", "mistral/B", "openrouter/C", "mistral/D"]);
});

test("A11 an explicit model still overrides sticky and priority (unchanged)", async () => {
  const session = new RouteSession();
  sticky(session, find("B", 0));
  const { calls } = await request(session, { requestedModel: "C" });
  // The requested model C leads (not the sticky B); it succeeds, so that is the only call.
  assert.equal(calls.length, 1);
  assert.ok(calls[0].endsWith("openrouter/C/k1"), calls[0]);
});

test("A12 text and vision resume independently from their OWN sticky model", async () => {
  const text = pool();
  const vision = buildTargets({
    groq: provider(["v1"], ["F"]),
    mistral: provider(["v1", "v2"], ["B", "D"]),
    openrouter: provider(["v1", "v2"], ["A", "C"])
  }, "vision");
  const textSession = new RouteSession();
  const visionSession = new RouteSession();
  const health = new HealthRegistry();
  textSession.saveSuccess(text.find((t) => t.model === "B" && t.keyIndex === 0), health);
  visionSession.saveSuccess(vision.find((t) => t.model === "C" && t.keyIndex === 0), health);

  const t = await request(textSession, { targets: text, fail: modelDown("B", "C", "D") });
  const v = await request(visionSession, { targets: vision, fail: modelDown("C", "D") });
  assert.deepEqual(t.calls.slice(0, 6), [
    "sticky:mistral/B/k1", "priority:mistral/B/k2", "priority:openrouter/C/k1", "priority:openrouter/C/k2", "priority:mistral/D/k1", "priority:mistral/D/k2"
  ]);
  assert.deepEqual(v.calls.slice(0, 5), [
    "sticky:openrouter/C/k1", "priority:openrouter/C/k2", "priority:mistral/D/k1", "priority:mistral/D/k2", "fallback:groq/F/k1"
  ]);
  assert.ok(!t.calls.some(isA) && !v.calls.some(isA));
  assert.ok(vision.every((x) => x.pool === "vision") && text.every((x) => (x.pool ?? "text") === "text"));
});

// ---------------------------------------------------------------------------------------------
// Part B: real server over HTTP, text AND vision
// ---------------------------------------------------------------------------------------------

const ok = () => ({
  status: 200,
  body: {
    id: "c1", object: "chat.completion", created: 0, model: "upstream",
    choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
  }
});
const fail = (status = 503) => ({ status, body: { error: { message: "nope" } } });
const IMG = { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } };
const BODIES = {
  text: { max_tokens: 8, messages: [{ role: "user", content: "hi" }] },
  vision: { max_tokens: 8, messages: [{ role: "user", content: [{ type: "text", text: "x" }, IMG] }] }
};
const rowsOf = async (router) => (await (await router.request("/api/requests")).json()).entries[0].attempts
  .map((a) => `${a.phase}:${a.provider}/${a.model}/${a.keyIndex}:${a.skipped ? "skipped" : a.status}`);

/**
 * Both pools serve the SAME models so VISION_PRIORITY_MODELS can be left unset (it inherits):
 *   openrouter: keys o1,o2 -> A, C      mistral: keys g1,g2 -> B, D      groq: key f1 -> F (fallback only)
 * Upstream names carry a t-/v- prefix, so a vision request reaching a text server is visible.
 */
async function rig(t, decide) {
  const calls = [];
  const make = (name) => startMockUpstream((req) => {
    const key = String(req.headers.authorization || "").replace("Bearer ", "");
    calls.push(`${name}/${req.body?.model}/${key}`);
    return decide(name, req.body?.model, key);
  });
  const s = {
    tOr: await make("t-openrouter"), tGroq: await make("t-groq"), tMistral: await make("t-mistral"),
    vOr: await make("v-openrouter"), vGroq: await make("v-groq"), vMistral: await make("v-mistral")
  };
  const router = await startRouter({
    OPENROUTER_API_KEYS: "o1,o2", OPENROUTER_MODELS: "A,C", OPENROUTER_BASE_URL: s.tOr.baseUrl,
    MISTRAL_API_KEYS: "g1,g2", MISTRAL_MODELS: "B,D", MISTRAL_BASE_URL: s.tMistral.baseUrl,
    GROQ_API_KEYS: "f1", GROQ_MODELS: "F", GROQ_BASE_URL: s.tGroq.baseUrl,
    OPENROUTER_VISION_API_KEYS: "o1,o2", OPENROUTER_VISION_MODELS: "A,C", OPENROUTER_VISION_BASE_URL: s.vOr.baseUrl,
    MISTRAL_VISION_API_KEYS: "g1,g2", MISTRAL_VISION_MODELS: "B,D", MISTRAL_VISION_BASE_URL: s.vMistral.baseUrl,
    GROQ_VISION_API_KEYS: "f1", GROQ_VISION_MODELS: "F", GROQ_VISION_BASE_URL: s.vGroq.baseUrl,
    TEXT_PRIORITY_MODELS: "openrouter/A,mistral/B,openrouter/C,mistral/D"   // VISION_PRIORITY_MODELS unset => inherits
  });
  t.after(async () => { await router.close(); for (const server of Object.values(s)) await server.close(); });
  const send = (pool, extra = {}, headers) => router.request("/v1/chat/completions", postJson({ ...BODIES[pool], ...extra }, headers));
  /** Makes `model` the last success via an explicit-model request, so A stays healthy and untried. */
  const establish = async (pool, model) => {
    assert.equal((await send(pool, { model })).status, 200);
    calls.length = 0;
  };
  return { router, calls, send, establish };
}

// Each scenario needs the sticky model to succeed once (becoming sticky) and then start failing,
// so the upstream is switchable.
function switchable(pool) {
  const p = pool === "text" ? "t" : "v";
  const down = new Set();
  return {
    down,
    decide: (name, model) => (name.startsWith(p + "-") && down.has(model) ? fail() : ok())
  };
}

for (const pool of ["text", "vision"]) {
  const p = pool === "text" ? "t" : "v";

  test(`B2 [${pool}] sticky = B, all B keys fail -> B keys, C keys, D keys, then the normal fallback; A never attempted`, async (t) => {
    const sw = switchable(pool);
    const { router, calls, send, establish } = await rig(t, sw.decide);
    await establish(pool, "B");                              // last success = B + g1; A is healthy and untried
    sw.down.add("B"); sw.down.add("C"); sw.down.add("D");
    assert.equal((await send(pool)).status, 200);
    assert.deepEqual(calls, [
      `${p}-mistral/B/g1`, `${p}-mistral/B/g2`,                    // B: sticky key, then every other B key
      `${p}-openrouter/C/o1`, `${p}-openrouter/C/o2`,        // C: all keys
      `${p}-mistral/D/g1`, `${p}-mistral/D/g2`,                    // D: all keys
      `${p}-groq/F/f1`                                    // existing normal fallback
    ]);
    assert.ok(!calls.some((c) => c.includes("/A/")), "A must never be attempted");
    const rows = await rowsOf(router);
    assert.equal(rows[0], "sticky:mistral/B/0:503");
    assert.equal(rows.filter((r) => r.startsWith("priority:openrouter/A")).length, 0, "no priority attempt (or skip) row for A");
    assert.equal(rows[rows.length - 1], "fallback:groq/F/0:200");
  });

  test(`B3 [${pool}] sticky = B, B fails, C succeeds: B keys then C; A and D untouched`, async (t) => {
    const sw = switchable(pool);
    const { calls, send, establish } = await rig(t, sw.decide);
    await establish(pool, "B");
    sw.down.add("B");
    assert.equal((await send(pool)).status, 200);
    assert.deepEqual(calls, [`${p}-mistral/B/g1`, `${p}-mistral/B/g2`, `${p}-openrouter/C/o1`]);
  });

  test(`B4 [${pool}] sticky = C, C fails: C keys -> D keys -> fallback; A and B never attempted`, async (t) => {
    const sw = switchable(pool);
    const { router, calls, send, establish } = await rig(t, sw.decide);
    await establish(pool, "C");
    sw.down.add("C"); sw.down.add("D");
    assert.equal((await send(pool)).status, 200);
    assert.deepEqual(calls, [
      `${p}-openrouter/C/o1`, `${p}-openrouter/C/o2`,
      `${p}-mistral/D/g1`, `${p}-mistral/D/g2`,
      `${p}-groq/F/f1`
    ]);
    assert.ok(!calls.some((c) => c.includes("/A/") || c.includes("/B/")), "A and B must never be attempted");
    assert.equal((await rowsOf(router))[0], "sticky:openrouter/C/0:503");
  });

  test(`B5 [${pool}] the sticky model succeeding stops immediately`, async (t) => {
    const sw = switchable(pool);
    const { calls, send, establish } = await rig(t, sw.decide);
    await establish(pool, "B");
    assert.equal((await send(pool)).status, 200);
    assert.deepEqual(calls, [`${p}-mistral/B/g1`]);
  });
}

test("B6 text and vision keep separate sticky state while resuming from different models", async (t) => {
  const down = new Set();
  const { calls, send, establish } = await rig(t, (name, model) => (down.has(`${name.slice(0, 1)}:${model}`) ? fail() : ok()));
  await establish("text", "B");      // text sticky  = mistral/B/g1
  await establish("vision", "C");    // vision sticky = openrouter/C/o1
  down.add("t:B"); down.add("t:C"); down.add("t:D");
  down.add("v:C"); down.add("v:D");

  assert.equal((await send("text")).status, 200);
  assert.deepEqual(calls.splice(0), ["t-mistral/B/g1", "t-mistral/B/g2", "t-openrouter/C/o1", "t-openrouter/C/o2", "t-mistral/D/g1", "t-mistral/D/g2", "t-groq/F/f1"]);
  assert.equal((await send("vision")).status, 200);
  assert.deepEqual(calls.splice(0), ["v-openrouter/C/o1", "v-openrouter/C/o2", "v-mistral/D/g1", "v-mistral/D/g2", "v-groq/F/f1"]);
  assert.ok(!calls.some((c) => c.includes("/A/")));
});
