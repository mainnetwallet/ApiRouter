import test from "node:test";
import assert from "node:assert/strict";
import { startMockUpstream } from "../test-helpers/mock-upstream.js";
import { startRouter, postJson } from "../test-helpers/router-harness.js";
import { buildTargets } from "../src/config.js";
import { HealthRegistry } from "../src/health.js";
import { RouteSession, withFallback } from "../src/router.js";
import { buildRoutePlan, parsePriorityModels, readPriority } from "../src/routing-plan.js";

// Regression coverage for TEXT_PRIORITY_MODELS / VISION_PRIORITY_MODELS last-success routing.
//
// Root cause (two parts):
//   1. server.js minted a random session id for every request without an
//      x-multi-ai-session-id header. Clients such as Claude Code / Codex / OpenAI SDKs never send
//      that header, so each request started a brand-new session and the last successful
//      provider + model + key was never found again.
//   2. After the sticky target failed, the plan jumped straight to the priority list from its
//      top; the sticky MODEL's remaining keys were only tried if that model happened to be the
//      first priority entry.
//
// Part A drives the real walker (buildRoutePlan + withFallback) deterministically.
// Part B drives the real server over HTTP with NO session header.

// ---------------------------------------------------------------------------------------------
// Part A: plan + walker
// ---------------------------------------------------------------------------------------------

const provider = (keys, models) => ({ apiKeys: keys, models, baseUrl: "http://x" });
const label = (t) => `${t.provider}/${t.model}/k${t.keyIndex + 1}`;
const targets = () => buildTargets({
  gemini: provider(["k1", "k2", "k3"], ["G1", "G2"]),
  groq: provider(["k1", "k2"], ["R1"]),
  mistral: provider(["k1"], ["X1"])
});
const PRIO = parsePriorityModels("gemini/G1,groq/R1");

/** One request, wired exactly like src/server.js. `fail(label)` scripts upstream failures. */
async function request(session, { pool = targets(), priority = PRIO, requestedModel = "", fail = () => false, health = new HealthRegistry() } = {}) {
  const plan = buildRoutePlan({ targets: pool, requestedModel, priority, stickyTargetId: session.validTargetId() });
  const calls = [];
  let result;
  let error;
  try {
    result = await withFallback(pool, async (target, { phase }) => {
      calls.push(`${phase}:${label(target)}`);
      if (fail(label(target))) throw Object.assign(new Error("down"), { status: 503 });
      return target;
    }, undefined, session, health, { plan: plan.steps });
  } catch (e) { error = e; }
  return { calls, result, error };
}
const stickyOf = (session, pool = targets()) => {
  const id = session.validTargetId();
  return pool.map((t) => ({ t, id: new HealthRegistry().key(t) })).find((x) => x.id === id)?.t ?? null;
};
const pick = (provider, model, keyIndex) => targets().find((t) => t.provider === provider && t.model === model && t.keyIndex === keyIndex);
const sticky = (session, target) => session.saveSuccess(target, new HealthRegistry());

test("A1 same model, multiple keys: all keys of the model are tried before the next priority model", async () => {
  const { calls, result } = await request(new RouteSession(), { fail: (l) => l === "gemini/G1/k1" || l === "gemini/G1/k2" });
  assert.deepEqual(calls, ["priority:gemini/G1/k1", "priority:gemini/G1/k2", "priority:gemini/G1/k3"]);
  assert.equal(label(result), "gemini/G1/k3");
});

test("A2 the last successful model AND key lead the next request", async () => {
  const session = new RouteSession();
  await request(session, { fail: (l) => l === "gemini/G1/k1" || l === "gemini/G1/k2" }); // succeeds on G1/k3
  assert.equal(label(stickyOf(session)), "gemini/G1/k3", "the exact key is remembered, not just the model");
  const next = await request(session);
  assert.deepEqual(next.calls, ["sticky:gemini/G1/k3"], "next request: sticky model + key first, and it stops there");
});

test("A3 sticky key fails: the remaining keys of the SAME model come next, in key order", async () => {
  const session = new RouteSession();
  sticky(session, pick("gemini", "G1", 2));
  const { calls, result } = await request(session, { fail: (l) => l === "gemini/G1/k3" });
  assert.deepEqual(calls, ["sticky:gemini/G1/k3", "priority:gemini/G1/k1"]);
  assert.equal(label(result), "gemini/G1/k1");
});

test("A4 sticky is on a LOWER priority model: its other keys run before any other priority model", async () => {
  const session = new RouteSession();
  sticky(session, pick("groq", "R1", 1)); // priority #2, key 2
  // gemini/G1 (priority #1) is healthy, but the sticky model R1 must be exhausted first.
  const { calls } = await request(session, { fail: (l) => l === "groq/R1/k2" });
  assert.deepEqual(calls, ["sticky:groq/R1/k2", "priority:groq/R1/k1"]);
});

test("A5 a model is exhausted only after ALL its keys fail; priority then CONTINUES after it, never back before it", async () => {
  const session = new RouteSession();
  sticky(session, pick("groq", "R1", 1)); // priority #2 of "gemini/G1,groq/R1" (the last entry)
  const { calls, result } = await request(session, { fail: (l) => l.startsWith("groq/R1/") });
  assert.deepEqual(calls, [
    "sticky:groq/R1/k2", "priority:groq/R1/k1", // both R1 keys first
    "fallback:gemini/G1/k1"                      // R1 was the last priority model: gemini/G1 (listed BEFORE it) is NOT a priority attempt
  ]);
  assert.ok(!calls.some((c) => c.startsWith("priority:gemini")), "priority never goes back to an entry listed before the sticky model");
  assert.equal(label(result), "gemini/G1/k1");
  assert.equal(label(stickyOf(session)), "gemini/G1/k1", "the new success becomes the sticky target");
});

test("A5b a cooling key of the sticky model is skipped (not called) and the model's next key runs", async () => {
  const session = new RouteSession();
  const health = new HealthRegistry();
  sticky(session, pick("gemini", "G1", 0));
  health.markFailure(pick("gemini", "G1", 0), 503);
  const { calls } = await request(session, { health });
  assert.deepEqual(calls, ["priority:gemini/G1/k2"]);
});

test("A6 all priority models fail: the NORMAL fallback runs and its success is remembered as provider + model + key", async () => {
  const session = new RouteSession();
  const priorityDown = (l) => l.startsWith("gemini/G1/") || l.startsWith("groq/R1/");
  const first = await request(session, { fail: priorityDown });
  assert.deepEqual(first.calls, [
    "priority:gemini/G1/k1", "priority:gemini/G1/k2", "priority:gemini/G1/k3",
    "priority:groq/R1/k1", "priority:groq/R1/k2",
    "fallback:gemini/G2/k1"
  ]);
  assert.equal(label(stickyOf(session)), "gemini/G2/k1");

  const next = await request(session, { fail: priorityDown });
  assert.deepEqual(next.calls, ["sticky:gemini/G2/k1"], "the fallback success leads the next request");
});

test("A6b fallback to another provider is remembered with its provider, model and key", async () => {
  const session = new RouteSession();
  const down = (l) => l.startsWith("gemini/") || l.startsWith("groq/");
  const first = await request(session, { fail: down });
  assert.equal(label(first.result), "mistral/X1/k1");
  assert.equal(label(stickyOf(session)), "mistral/X1/k1");
  assert.deepEqual((await request(session, { fail: down })).calls, ["sticky:mistral/X1/k1"]);
});

test("A6c when everything fails each target is called exactly once", async () => {
  const session = new RouteSession();
  sticky(session, pick("gemini", "G1", 1));
  const { calls, error } = await request(session, { fail: () => true });
  assert.equal(error.status, 502);
  assert.equal(calls.length, 9, "3 gemini/G1 + 3 gemini/G2 + 2 groq/R1 + 1 mistral, once each");
  assert.equal(new Set(calls.map((c) => c.split(":")[1])).size, calls.length);
});

test("A7 an explicitly requested model overrides last-success priority", async () => {
  const session = new RouteSession();
  sticky(session, pick("groq", "R1", 0)); // last success is R1
  const named = await request(session, { requestedModel: "G2" });
  assert.equal(named.calls[0], "fallback:gemini/G2/k1", "the requested model leads, not the sticky R1");
  assert.ok(!named.calls.some((c) => c.includes("groq/R1")));
  // A sticky target that serves the requested model is still honoured.
  const same = new RouteSession();
  sticky(same, pick("gemini", "G2", 2));
  assert.equal((await request(same, { requestedModel: "G2" })).calls[0], "sticky:gemini/G2/k3");
});

test("A8 text and vision keep separate sticky state and separate target pools", async () => {
  const text = buildTargets({ gemini: provider(["t1", "t2"], ["M1"]) });
  const vision = buildTargets({ gemini: provider(["v1", "v2"], ["M1"]) }, "vision");
  const prio = parsePriorityModels("gemini/M1");
  const textSession = new RouteSession();
  const visionSession = new RouteSession();

  await request(textSession, { pool: text, priority: prio, fail: (l) => l === "gemini/M1/k1" });     // text sticky = key 2
  await request(visionSession, { pool: vision, priority: prio });                                   // vision sticky = key 1
  const health = new HealthRegistry();
  assert.equal(textSession.validTargetId(), health.key(text[1]));
  assert.equal(visionSession.validTargetId(), health.key(vision[0]));

  // Each pool leads with its OWN sticky and only ever calls its own pool's targets.
  const t = await request(textSession, { pool: text, priority: prio });
  const v = await request(visionSession, { pool: vision, priority: prio });
  assert.deepEqual(t.calls, ["sticky:gemini/M1/k2"]);
  assert.deepEqual(v.calls, ["sticky:gemini/M1/k1"]);
  assert.ok(text.every((x) => (x.pool ?? "text") === "text") && vision.every((x) => x.pool === "vision"));
  // A text sticky id handed to the vision pool is ignored: vision never routes to a text target.
  const cross = await request(new RouteSession({ targetId: textSession.targetId, expiresAt: Date.now() + 60000 }), { pool: vision, priority: prio });
  assert.ok(!cross.calls.some((c) => c.startsWith("sticky:")));
});

test("A9 VISION_PRIORITY_MODELS empty/unset inherits TEXT_PRIORITY_MODELS; a set list is used as-is", () => {
  const env = { TEXT_PRIORITY_MODELS: "gemini/G1,groq/R1" };
  assert.deepEqual(readPriority(env, "vision"), readPriority(env, "text"));
  assert.deepEqual(readPriority({ ...env, VISION_PRIORITY_MODELS: "" }, "vision"), readPriority(env, "text"));
  assert.deepEqual(readPriority({ ...env, VISION_PRIORITY_MODELS: "groq/R1" }, "vision"), [{ provider: "groq", model: "R1" }]);
});

// ---------------------------------------------------------------------------------------------
// Part B: real server, requests WITHOUT x-multi-ai-session-id (how real clients call it)
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
const textBody = { max_tokens: 8, messages: [{ role: "user", content: "hi" }] };
const imageBody = { max_tokens: 8, messages: [{ role: "user", content: [{ type: "text", text: "x" }, IMG] }] };
const lastEntry = async (router) => (await (await router.request("/api/requests")).json()).entries[0];
const rows = (entry) => entry.attempts.map((a) => `${a.phase}:${a.provider}/${a.model}/${a.keyIndex}:${a.skipped ? "skipped" : a.status}`);

/**
 * text:   groq(a1,a2: M1), openrouter(b1,b2: M2), mistral(c1: M3)
 * vision: groq(w1,w2: M1), openrouter(x1,x2: M2)       (same ids as text on purpose)
 * Upstream names are prefixed t-/v- so a vision request that reaches a text server is visible.
 */
async function rig(t, decide, env = {}) {
  const calls = [];
  const make = (name) => startMockUpstream((req) => {
    const key = String(req.headers.authorization || "").replace("Bearer ", "");
    calls.push(`${name}/${req.body?.model}/${key}`);
    return decide(name, req.body?.model, key);
  });
  const servers = {
    tGroq: await make("t-groq"), tOpenrouter: await make("t-openrouter"), tMistral: await make("t-mistral"),
    vGroq: await make("v-groq"), vOpenrouter: await make("v-openrouter")
  };
  const router = await startRouter({
    GROQ_API_KEYS: "a1,a2", GROQ_MODELS: "M1", GROQ_BASE_URL: servers.tGroq.baseUrl,
    OPENROUTER_API_KEYS: "b1,b2", OPENROUTER_MODELS: "M2", OPENROUTER_BASE_URL: servers.tOpenrouter.baseUrl,
    MISTRAL_API_KEYS: "c1", MISTRAL_MODELS: "M3", MISTRAL_BASE_URL: servers.tMistral.baseUrl,
    GROQ_VISION_API_KEYS: "w1,w2", GROQ_VISION_MODELS: "M1", GROQ_VISION_BASE_URL: servers.vGroq.baseUrl,
    OPENROUTER_VISION_API_KEYS: "x1,x2", OPENROUTER_VISION_MODELS: "M2", OPENROUTER_VISION_BASE_URL: servers.vOpenrouter.baseUrl,
    ...env
  });
  t.after(async () => { await router.close(); for (const s of Object.values(servers)) await s.close(); });
  const send = (body, headers) => router.request("/v1/chat/completions", postJson(body, headers));
  return { router, calls, send };
}

test("B1 ROOT CAUSE: requests with no session header share the last success (model + key) on the next request", async (t) => {
  const { router, calls, send } = await rig(t, (p, m, k) => (p === "t-groq" && k === "a1" ? fail(503) : ok()),
    { TEXT_PRIORITY_MODELS: "groq/M1,openrouter/M2" });
  assert.equal((await send(textBody)).status, 200);
  assert.deepEqual(calls, ["t-groq/M1/a1", "t-groq/M1/a2"], "request 1: a1 fails, the same model's key a2 succeeds");

  calls.length = 0;
  assert.equal((await send(textBody)).status, 200);
  assert.deepEqual(calls, ["t-groq/M1/a2"], "request 2 (still no header): last successful model + key first, nothing else called");
  assert.equal(rows(await lastEntry(router))[0], "sticky:groq/M1/1:200");
});

test("B2 text priority over HTTP: sticky key fails -> same model's other key -> next priority model -> normal fallback", async (t) => {
  const down = new Set();
  const { router, calls, send } = await rig(t, (p, m, k) => (down.has(`${p}/${m}/${k}`) || down.has(`${p}/${m}`) ? fail(503) : ok()),
    { TEXT_PRIORITY_MODELS: "groq/M1,openrouter/M2" });
  await send(textBody);                       // t-groq/M1/a1 -> sticky
  down.add("t-groq/M1/a1");
  calls.length = 0;
  await send(textBody);                       // sticky a1 fails -> a2 (same model) succeeds; openrouter never touched
  assert.deepEqual(calls, ["t-groq/M1/a1", "t-groq/M1/a2"]);

  down.add("t-groq/M1/a2");
  calls.length = 0;
  await send(textBody);                       // a2 (sticky) fails; a1 is cooling -> model exhausted -> next priority model
  assert.deepEqual(calls, ["t-groq/M1/a2", "t-openrouter/M2/b1"]);

  down.add("t-openrouter/M2");                // both priority models now down
  calls.length = 0;
  await send(textBody);                       // sticky b1 fails -> b2 -> normal fallback reaches mistral
  assert.deepEqual(calls, ["t-openrouter/M2/b1", "t-openrouter/M2/b2", "t-mistral/M3/c1"]);
  assert.equal(rows(await lastEntry(router)).pop(), "fallback:mistral/M3/0:200");

  calls.length = 0;
  await send(textBody);                       // the fallback success is remembered: provider + model + key first
  assert.deepEqual(calls, ["t-mistral/M3/c1"]);
  assert.equal(rows(await lastEntry(router))[0], "sticky:mistral/M3/0:200");
});

test("B3 vision inherits TEXT_PRIORITY_MODELS order, keeps its own sticky, and never touches text targets", async (t) => {
  const down = new Set();
  const { router, calls, send } = await rig(t, (p, m, k) => (down.has(`${p}/${m}/${k}`) ? fail(503) : ok()),
    { TEXT_PRIORITY_MODELS: "openrouter/M2,groq/M1" }); // VISION_PRIORITY_MODELS deliberately unset

  await send(textBody);
  await send(imageBody);
  assert.deepEqual(calls, ["t-openrouter/M2/b1", "v-openrouter/M2/x1"], "both pools start at the inherited first entry, each in its own pool");

  down.add("v-openrouter/M2/x1");
  calls.length = 0;
  await send(imageBody);                      // vision sticky x1 fails -> x2 (same vision model)
  assert.deepEqual(calls, ["v-openrouter/M2/x1", "v-openrouter/M2/x2"]);

  calls.length = 0;
  await send(textBody);                       // the text sticky is untouched by anything vision did
  await send(imageBody);                      // and vision keeps its own
  assert.deepEqual(calls, ["t-openrouter/M2/b1", "v-openrouter/M2/x2"]);
  assert.ok(!calls.slice(0, 1).some((c) => c.startsWith("v-")) && !calls.slice(1).some((c) => c.startsWith("t-")),
    "text requests only reach text servers, image requests only vision servers");
  assert.equal(rows(await lastEntry(router))[0], "sticky:openrouter/M2/1:200");
});

test("B4 an explicit model overrides the last-success target over HTTP", async (t) => {
  const { calls, send } = await rig(t, () => ok(), { TEXT_PRIORITY_MODELS: "groq/M1,openrouter/M2" });
  await send(textBody);                       // sticky = t-groq/M1/a1
  calls.length = 0;
  await send({ ...textBody, model: "M2" });
  assert.deepEqual(calls, ["t-openrouter/M2/b1"], "the requested model is served first, not the sticky groq/M1");
});
