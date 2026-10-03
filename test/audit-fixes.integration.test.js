import test from "node:test";
import assert from "node:assert/strict";
import { startMockUpstream } from "../test-helpers/mock-upstream.js";
import { startRouter, postJson } from "../test-helpers/router-harness.js";
import { buildTargets } from "../src/config.js";
import { buildRoutePlan, parsePriorityModels } from "../src/routing-plan.js";

// Regressions from the main-branch audit:
//  - an explicit configured model is never overtaken by a priority entry of another model
//  - a pinned success never becomes the session's sticky target
//  - real-HTTP vision coverage: multi-key priority, exact-key sticky, cooldown, pin

const ok = (text = "ok") => ({
  status: 200,
  body: {
    id: "c1", object: "chat.completion", created: 0, model: "upstream",
    choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
  }
});
const fail = (status = 503) => ({ status, body: { error: { message: "nope" } } });
const IMG = { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } };
const text = { max_tokens: 8, messages: [{ role: "user", content: "hi" }] };
const image = { max_tokens: 8, messages: [{ role: "user", content: [{ type: "text", text: "x" }, IMG] }] };
const sid = (id, extra = {}) => ({ "x-multi-ai-session-id": id, ...extra });
const last = async (r) => (await (await r.request("/api/requests")).json()).entries[0];
const rows = (e) => e.attempts.map((a) => `${a.phase}:${a.provider}/${a.model}/${a.keyIndex}:${a.skipped ? "skipped" : a.status}`);
const post = (r, body, headers) => r.request("/v1/chat/completions", postJson(body, headers));

/** text: groq(q1,q2: Q1) + openrouter(o1: O1); vision: gemini(v1,v2,v3: VG1,VG2) + groq(w1,w2: VQ1). */
async function rig(t, decide, env = {}) {
  const calls = [];
  const mk = (name) => startMockUpstream((req) => {
    const key = String(req.headers.authorization || "").replace("Bearer ", "");
    calls.push(`${name}/${req.body?.model}/${key}`);
    return decide(name, req.body?.model, key);
  });
  const groq = await mk("groq"), openrouter = await mk("openrouter"), vgemini = await mk("vopenrouter"), vgroq = await mk("vgroq");
  const router = await startRouter({
    GROQ_API_KEYS: "q1,q2", GROQ_MODELS: "Q1", GROQ_BASE_URL: groq.baseUrl,
    OPENROUTER_API_KEYS: "o1", OPENROUTER_MODELS: "O1", OPENROUTER_BASE_URL: openrouter.baseUrl,
    OPENROUTER_VISION_API_KEYS: "v1,v2,v3", OPENROUTER_VISION_MODELS: "VG1,VG2", OPENROUTER_VISION_BASE_URL: vgemini.baseUrl,
    GROQ_VISION_API_KEYS: "w1,w2", GROQ_VISION_MODELS: "VQ1", GROQ_VISION_BASE_URL: vgroq.baseUrl,
    ...env
  });
  t.after(async () => { await router.close(); for (const s of [groq, openrouter, vgemini, vgroq]) await s.close(); });
  return { router, calls };
}

// ---- Bug 1: explicit model vs priority ----------------------------------------------------

test("plan: an explicit configured model keeps only priority entries of that model", () => {
  const targets = buildTargets({
    gemini: { apiKeys: ["a", "b"], models: ["G1", "G2"], baseUrl: "http://x" },
    groq: { apiKeys: ["c"], models: ["Q1"], baseUrl: "http://x" }
  });
  const priority = parsePriorityModels("groq/Q1,gemini/G1,gemini/G2");
  const phases = (plan) => plan.steps.filter((s) => s.phase === "priority").map((s) => `${s.target.provider}/${s.target.model}/${s.target.keyIndex}`);

  assert.deepEqual(phases(buildRoutePlan({ targets, priority, requestedModel: "G2" })), ["gemini/G2/0", "gemini/G2/1"],
    "only the G2 entry survives, all its keys, configured order");
  assert.deepEqual(phases(buildRoutePlan({ targets, priority, requestedModel: "" })).slice(0, 3),
    ["groq/Q1/0", "gemini/G1/0", "gemini/G1/1"], "no model: full priority list, unchanged");
  assert.equal(phases(buildRoutePlan({ targets, priority, requestedModel: "totally-unknown" })).length, 5,
    "a model nobody serves is auto-routed with the full priority list");
  // A configured model with no matching priority entry: no priority phase, exact model leads the normal order.
  const none = buildRoutePlan({ targets, priority: parsePriorityModels("groq/Q1"), requestedModel: "G1" });
  assert.equal(none.steps.some((s) => s.phase === "priority"), false);
  assert.equal(`${none.steps[0].target.provider}/${none.steps[0].target.model}`, "gemini/G1");
});

test("HTTP text: an explicit model is served first even when another model is the priority entry", async (t) => {
  const { router, calls } = await rig(t, () => ok(), { PRIORITY_MODELS: "groq/Q1" });
  assert.equal((await post(router, { ...text, model: "O1" }, sid("e1"))).status, 200);
  assert.deepEqual(calls, ["openrouter/O1/o1"], "priority groq/Q1 must not run ahead of the requested O1");
  // Requesting the priority model itself still goes through the priority phase.
  calls.length = 0;
  await post(router, { ...text, model: "Q1" }, sid("e2"));
  assert.deepEqual(calls, ["groq/Q1/q1"]);
  assert.equal(rows(await last(router))[0], "priority:groq/Q1/0:200");
});

test("HTTP vision: an explicit vision model is served first; VISION_PRIORITY_MODELS of another model does not outrank it", async (t) => {
  const { router, calls } = await rig(t, () => ok(), { VISION_PRIORITY_MODELS: "groq/VQ1" });
  assert.equal((await post(router, { ...image, model: "VG2" }, sid("ev"))).status, 200);
  assert.deepEqual(calls, ["vopenrouter/VG2/v1"]);
});

// ---- Bug 2: pin never becomes sticky ---------------------------------------------------------

test("HTTP text: a pinned success is not remembered; the next unpinned request follows priority", async (t) => {
  const { router, calls } = await rig(t, () => ok(), { PRIORITY_MODELS: "groq/Q1" });
  assert.equal((await post(router, text, sid("p1", { "x-multi-ai-pin-provider": "openrouter" }))).status, 200);
  assert.deepEqual(calls, ["openrouter/O1/o1"]);
  calls.length = 0;
  await post(router, text, sid("p1"));
  assert.deepEqual(calls, ["groq/Q1/q1"], "priority first, not the pinned target");
  assert.ok(!rows(await last(router)).some((r) => r.startsWith("sticky:")), "no sticky phase existed for this session");
});

test("HTTP vision: a pinned success is not remembered either", async (t) => {
  const { router, calls } = await rig(t, () => ok(), { VISION_PRIORITY_MODELS: "openrouter/VG1" });
  assert.equal((await post(router, image, sid("pv", { "x-multi-ai-pin-provider": "groq", "x-multi-ai-pin-key-index": "1" }))).status, 200);
  assert.deepEqual(calls, ["vgroq/VQ1/w2"]);
  calls.length = 0;
  await post(router, image, sid("pv"));
  assert.deepEqual(calls, ["vopenrouter/VG1/v1"]);
});

test("a pinned request does not disturb an existing sticky target of the same session", async (t) => {
  const { router, calls } = await rig(t, () => ok(), { PRIORITY_MODELS: "groq/Q1" });
  await post(router, text, sid("keep"));                                          // sticky = groq/Q1/q1
  await post(router, text, sid("keep", { "x-multi-ai-pin-provider": "openrouter" }));
  calls.length = 0;
  await post(router, text, sid("keep"));
  assert.deepEqual(calls, ["groq/Q1/q1"]);
  assert.equal(rows(await last(router))[0], "sticky:groq/Q1/0:200");
});

// ---- Vision real-HTTP coverage gaps -------------------------------------------------------------

test("HTTP vision: G1 key1 fail, key2 fail, key3 ok -> next same-session request is exactly key3", async (t) => {
  const { router, calls } = await rig(t, (n, m, k) => (n === "vopenrouter" && (k === "v1" || k === "v2") ? fail() : ok()), {
    VISION_PRIORITY_MODELS: "openrouter/VG1,groq/VQ1,openrouter/VG2"
  });
  assert.equal((await post(router, image, sid("v"))).status, 200);
  assert.deepEqual(calls, ["vopenrouter/VG1/v1", "vopenrouter/VG1/v2", "vopenrouter/VG1/v3"], "VQ1 and VG2 never called");
  calls.length = 0;
  assert.equal((await post(router, image, sid("v"))).status, 200);
  assert.deepEqual(calls, ["vopenrouter/VG1/v3"]);
  assert.equal(rows(await last(router))[0], "sticky:openrouter/VG1/2:200");
  // Another session does not inherit the sticky: it starts in the priority phase. v1 and v2 are cooling
  // down in the shared health registry (they failed 503), so they are skipped, not called.
  calls.length = 0;
  await post(router, image, sid("v-other"));
  const other = rows(await last(router));
  assert.ok(!other.some((r) => r.startsWith("sticky:")), "no sticky for another session");
  assert.deepEqual(other.slice(0, 3), ["priority:openrouter/VG1/0:skipped", "priority:openrouter/VG1/1:skipped", "priority:openrouter/VG1/2:200"]);
});

test("HTTP vision: sticky fails -> not repeated; cooled keys skipped, then the next entry; text pool untouched", async (t) => {
  let sticky = false;
  const { router, calls } = await rig(t, (n, m, k) => {
    if (n === "vopenrouter" && (k === "v1" || k === "v2")) return fail();
    if (sticky && n === "vopenrouter" && k === "v3") return fail();
    return ok();
  }, { VISION_PRIORITY_MODELS: "openrouter/VG1,groq/VQ1" });
  await post(router, image, sid("vs"));                  // sticky -> VG1/v3
  sticky = true;
  calls.length = 0;
  assert.equal((await post(router, image, sid("vs"))).status, 200);
  // v1/v2 failed in request 1 and are cooling down, so they are skipped (health rules), not retried.
  assert.deepEqual(calls, ["vopenrouter/VG1/v3", "vgroq/VQ1/w1"]);
  const skipped = rows(await last(router)).filter((r) => r.endsWith(":skipped"));
  assert.ok(skipped.includes("priority:openrouter/VG1/0:skipped") && skipped.includes("priority:openrouter/VG1/1:skipped"));
  assert.equal(new Set(calls).size, calls.length, "no exact target twice");
  assert.ok(calls.every((c) => c.startsWith("v")), "never the text pool");
});

test("HTTP vision: a key in cooldown is skipped, not called, while its sibling keys are still tried", async (t) => {
  let phase = 1;
  const { router, calls } = await rig(t, (n, m, k) => (phase === 1 && n === "vopenrouter" && m === "VG1" && k === "v1" ? fail(429) : ok()), {
    VISION_PRIORITY_MODELS: "openrouter/VG1"
  });
  await post(router, image, sid("c1"));                  // v1 -> 429 (cooldown), v2 serves
  phase = 2;
  calls.length = 0;
  await post(router, image, sid("c2"));                  // new session: v1 is cooling and must not be called
  assert.deepEqual(calls, ["vopenrouter/VG1/v2"]);
  assert.ok(rows(await last(router)).includes("priority:openrouter/VG1/0:skipped"));
});
