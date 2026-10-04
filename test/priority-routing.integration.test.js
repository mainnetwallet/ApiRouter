import test from "node:test";
import assert from "node:assert/strict";
import { startMockUpstream } from "../test-helpers/mock-upstream.js";
import { startRouter, postJson } from "../test-helpers/router-harness.js";

const ok = (text) => ({
  status: 200,
  body: {
    id: "c1", object: "chat.completion", created: 0, model: "upstream",
    choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
  }
});
const fail = (status = 429) => ({ status, body: { error: { message: "nope" } } });
const IMAGE = { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } };
const textBody = { model: "A1", max_tokens: 8, messages: [{ role: "user", content: "hi" }] };
// No explicit model: these tests exercise the priority phase itself. (An explicit configured model is
// served first and only matching priority entries apply; see test/audit-fixes.integration.test.js.)
const autoRouted = { max_tokens: 8, messages: textBody.messages };

/** groq (2 keys, A1,A2) + openrouter (1 key, B1,B2); `decide(provider, model, key)` scripts each call. */
async function rig(t, decide, extraEnv = {}) {
  const calls = [];
  const make = (name) => startMockUpstream((req) => {
    const key = String(req.headers.authorization || "").replace("Bearer ", "");
    calls.push(`${name}/${req.body?.model}/${key}`);
    return decide(name, req.body?.model, key);
  });
  const groq = await make("groq");
  const openrouter = await make("openrouter");
  const router = await startRouter({
    GROQ_API_KEYS: "g1,g2", GROQ_MODELS: "A1,A2", GROQ_BASE_URL: groq.baseUrl,
    OPENROUTER_API_KEYS: "o1", OPENROUTER_MODELS: "B1,B2", OPENROUTER_BASE_URL: openrouter.baseUrl,
    ...extraEnv
  });
  t.after(async () => { await router.close(); await groq.close(); await openrouter.close(); });
  return { router, calls, groq, openrouter };
}

const lastRequest = async (router) => (await (await router.request("/api/requests")).json()).entries[0];

test("empty TEXT_PRIORITY_MODELS: normal key-scoped fallback, no priority rows", async (t) => {
  const { router, calls } = await rig(t, (p, m, k) => (k === "g1" ? fail() : ok("done")), { TEXT_PRIORITY_MODELS: "" });
  const res = await router.request("/v1/chat/completions", postJson(textBody));
  assert.equal(res.status, 200);
  // g1 runs its own chain (A1 then A2) before g2 restarts at A1.
  assert.deepEqual(calls, ["groq/A1/g1", "groq/A2/g1", "groq/A1/g2"]);
  const entry = await lastRequest(router);
  assert.ok(entry.attempts.every((a) => a.phase === "fallback"));
});

test("priority interleaves providers in env order and stops on first success", async (t) => {
  const { router, calls } = await rig(t, () => ok("prio"), { TEXT_PRIORITY_MODELS: "openrouter/B2,groq/A1" });
  const res = await router.request("/v1/chat/completions", postJson(autoRouted));
  assert.equal(res.status, 200);
  assert.deepEqual(calls, ["openrouter/B2/o1"], "no further upstream call after the first priority success");
  assert.equal(res.headers.get("x-multi-ai-provider"), "openrouter");
});

test("priority failures fall through to normal fallback; repeats are logged as skips, never called", async (t) => {
  const { router, calls } = await rig(
    t,
    (p, m) => (p === "openrouter" && m === "B2" ? fail() : p === "groq" && m === "A1" ? fail(503) : ok("late")),
    { TEXT_PRIORITY_MODELS: "openrouter/B2,groq/A1" }
  );
  const res = await router.request("/v1/chat/completions", postJson(autoRouted));
  assert.equal(res.status, 200);
  assert.equal(new Set(calls).size, calls.length, "no target is called twice in one request");
  // Priority: B2 (its only key), then ALL keys of groq/A1 (g1, g2). Normal: groq k1 chain A1(skip) A2 -> serves.
  assert.deepEqual(calls, ["openrouter/B2/o1", "groq/A1/g1", "groq/A1/g2", "groq/A2/g1"]);

  const entry = await lastRequest(router);
  const rows = entry.attempts.map((a) => `${a.phase}:${a.provider}/${a.model}/${a.keyIndex}:${a.skipped ? "skipped" : a.status}`);
  assert.deepEqual(rows, [
    "priority:openrouter/B2/0:429", "priority:groq/A1/0:503", "priority:groq/A1/1:503",
    "fallback:groq/A1/0:skipped", "fallback:groq/A2/0:200"
  ]);
  assert.equal(entry.attemptCount, calls.length, "skipped rows are not counted as upstream attempts");
  assert.equal(entry.attempts.find((a) => a.skipped).skipReason, "already_attempted");
});

test("pinned requests ignore priority and stay strict", async (t) => {
  const { router, calls } = await rig(t, () => ok("pinned"), { TEXT_PRIORITY_MODELS: "openrouter/B2" });
  const res = await router.request("/v1/chat/completions", postJson(textBody, { "x-multi-ai-pin-provider": "groq", "x-multi-ai-pin-key-index": "1" }));
  assert.equal(res.status, 200);
  assert.deepEqual(calls, ["groq/A1/g2"]);
});

test("image request with no vision pool is 503 no_vision_route and never touches text or priority", async (t) => {
  const { router, calls } = await rig(t, () => ok("text"), { TEXT_PRIORITY_MODELS: "groq/A1" });
  const res = await router.request("/v1/chat/completions", postJson({
    model: "A1", messages: [{ role: "user", content: [{ type: "text", text: "?" }, { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }] }]
  }));
  assert.equal(res.status, 503);
  assert.equal((await res.json()).error.type, "no_vision_route");
  assert.deepEqual(calls, []);
});

test("vision priority applies only to the vision pool", async (t) => {
  const calls = [];
  const text = await startMockUpstream((req) => { calls.push(`text/${req.body?.model}`); return ok("t"); });
  const vision = await startMockUpstream((req) => { calls.push(`vision/${req.body?.model}`); return ok("v"); });
  const router = await startRouter({
    GROQ_API_KEYS: "g1", GROQ_MODELS: "A1", GROQ_BASE_URL: text.baseUrl,
    OPENROUTER_VISION_API_KEYS: "v1", OPENROUTER_VISION_MODELS: "V1,V2", OPENROUTER_VISION_BASE_URL: vision.baseUrl,
    TEXT_PRIORITY_MODELS: "groq/A1", VISION_PRIORITY_MODELS: "openrouter/V2"
  });
  t.after(async () => { await router.close(); await text.close(); await vision.close(); });

  const v = await router.request("/v1/messages", postJson({ model: "x", max_tokens: 8, messages: [{ role: "user", content: [{ type: "text", text: "?" }, IMAGE] }] }));
  assert.equal(v.status, 200);
  assert.deepEqual(calls, ["vision/V2"], "vision priority V2 first; the text priority entry is ignored");
  const entry = await lastRequest(router);
  assert.equal(entry.pool, "vision");
});

test("the request log never stores credentials", async (t) => {
  const { router } = await rig(t, (p, m, k) => (k === "g1" ? fail() : ok("x")), { TEXT_PRIORITY_MODELS: "groq/A1" });
  await router.request("/v1/chat/completions", postJson(textBody));
  const raw = await (await router.request("/api/requests")).text();
  for (const secret of ["g1", "g2", "o1"]) assert.ok(!raw.includes(`"${secret}"`) && !raw.includes(`Bearer ${secret}`));
});

const upstreamCount = (...mocks) => mocks.reduce((n, m) => n + m.apiRequests.length, 0);


test("exactly one upstream call per request when the first target works; /v1/models is local", async (t) => {
  const { router, calls, groq, openrouter } = await rig(t, () => ok("one"));
  await router.request("/v1/models");
  assert.equal(upstreamCount(groq, openrouter), 0, "/v1/models must not call providers");
  assert.equal((await router.request("/v1/chat/completions", postJson(textBody))).status, 200);
  assert.equal(calls.length, 1);
  assert.equal(upstreamCount(groq, openrouter), 1);
});

test("streaming: a failure before headers falls back sequentially, one call per target", async (t) => {
  const { router, calls } = await rig(t, (p, m, k) => (k === "g1" ? fail() : ok("s")));
  const res = await router.request("/v1/chat/completions", postJson({ ...textBody, stream: true }));
  assert.equal(res.status, 200);
  await res.text();
  assert.deepEqual(calls, ["groq/A1/g1", "groq/A2/g1", "groq/A1/g2"]);
});

test("transport failure (connection refused) advances to the next target", async (t) => {
  const { getFreePort } = await import("../test-helpers/mock-upstream.js");
  const deadPort = await getFreePort();
  const live = await startMockUpstream(() => ok("alive"));
  const router = await startRouter({
    GROQ_API_KEYS: "g1", GROQ_MODELS: "A1", GROQ_BASE_URL: `http://127.0.0.1:${deadPort}`,
    OPENROUTER_API_KEYS: "o1", OPENROUTER_MODELS: "B1", OPENROUTER_BASE_URL: live.baseUrl
  });
  t.after(async () => { await router.close(); await live.close(); });
  const res = await router.request("/v1/chat/completions", postJson(textBody));
  assert.equal(res.status, 200);
  assert.equal(live.apiRequests.length, 1);
  const entry = await lastRequest(router);
  assert.equal(entry.attempts[0].ok, false);
  assert.equal(entry.attempts[0].provider, "groq");
});

test("final status semantics: all-5xx 502, all-400 400, non-retryable 422 stops at once, all-cooling 503", async (t) => {
  let mode = 500;
  const { router, calls } = await rig(t, () => fail(mode));

  assert.equal((await router.request("/v1/chat/completions", postJson(textBody))).status, 502);
  assert.equal(calls.length, 6, "2 groq keys x 2 models + 1 openrouter key x 2 models = 6, each once");

  // Everything is now cooling: 503 and no upstream call.
  calls.length = 0;
  assert.equal((await router.request("/v1/chat/completions", postJson(textBody))).status, 503);
  assert.equal(calls.length, 0);
});

test("all-400 returns the client's 400; a 422 is returned after a single call", async (t) => {
  let mode = 400;
  const { router, calls } = await rig(t, () => ({ status: mode, body: { error: { message: "bad param" } } }));
  const r400 = await router.request("/v1/chat/completions", postJson(textBody));
  assert.equal(r400.status, 400);
  assert.equal(calls.length, 6);
  mode = 422;
  calls.length = 0;
  const r422 = await router.request("/v1/chat/completions", postJson(textBody));
  assert.equal(r422.status, 422);
  assert.equal(calls.length, 1);
});

test("pinned request is strict: no priority, no sticky, never leaves the pinned provider/key", async (t) => {
  const { router, calls } = await rig(t, (p, m) => (m === "A1" ? fail() : ok("pin")), { TEXT_PRIORITY_MODELS: "openrouter/B1" });
  const pin = { "x-multi-ai-pin-provider": "groq", "x-multi-ai-pin-key-index": "1", "x-multi-ai-session-id": "s" };

  // Pinned to a model that fails: the pin is the exact target, so no fallback elsewhere.
  const failed = await router.request("/v1/chat/completions", postJson(textBody, pin));
  assert.equal(failed.status, 502);
  assert.deepEqual(calls, ["groq/A1/g2"]);

  // No model named: the pinned provider/key's own models are eligible, still only that key.
  calls.length = 0;
  const served = await router.request("/v1/chat/completions", postJson({ max_tokens: 8, messages: textBody.messages }, pin));
  assert.equal(served.status, 200);
  assert.ok(calls.length >= 1 && calls.every((c) => c.startsWith("groq/") && c.endsWith("/g2")));
  assert.equal(calls.some((c) => c.startsWith("openrouter/")), false, "priority must not apply to a pinned request");
});

test("requested model leads each provider's per-key chain", async (t) => {
  const { router, calls } = await rig(t, (p, m, k) => (m === "A2" && k === "g1" ? fail() : ok("m")));
  const res = await router.request("/v1/chat/completions", postJson({ ...textBody, model: "A2" }));
  assert.equal(res.status, 200);
  assert.deepEqual(calls, ["groq/A2/g1", "groq/A1/g1"]);
});

test("vision: no valid route is 503 no_vision_route even when text targets are healthy", async (t) => {
  const { router, calls } = await rig(t, () => ok("t"), {
    GEMINI_VISION_API_KEYS: "v1", GEMINI_VISION_MODELS: "GV1" // incomplete: no VISION base URL
  });
  const res = await router.request("/v1/messages", postJson({ model: "x", max_tokens: 8, messages: [{ role: "user", content: [{ type: "text", text: "?" }, IMAGE] }] }));
  assert.equal(res.status, 503);
  assert.equal((await res.json()).error.type, "no_vision_route");
  assert.equal(calls.length, 0);
});

test("/health and /api/health report the real route order, with priority first", async (t) => {
  const { router } = await rig(t, () => ok("h"), { TEXT_PRIORITY_MODELS: "openrouter/B2" });
  const h = await (await router.request("/health")).json();
  assert.deepEqual(h.rankedTargets.slice(0, 3).map((r) => `${r.provider}/${r.model}/${r.keyIndex}`), ["openrouter/B2/0", "groq/A1/0", "groq/A2/0"]);
  const a = await (await router.request("/api/health")).json();
  assert.equal(`${a.ranked[0].provider}/${a.ranked[0].model}`, "openrouter/B2");
});

// ============================================================================
// Sticky (15-minute TTL) -> Priority -> Normal, through the real server
// ============================================================================

const noModel = { max_tokens: 8, messages: [{ role: "user", content: "hi" }] };
const SESSION = { "x-multi-ai-session-id": "sticky-http" };
const phases = (entry) => entry.attempts.map((a) => `${a.phase}:${a.provider}/${a.model}/${a.keyIndex}:${a.skipped ? "skipped" : a.status}`);

test("sticky HTTP: success -> next request first; failure -> priority -> normal; new sticky", async (t) => {
  const down = new Set();
  const { router, calls } = await rig(t, (p, m) => (down.has(`${p}/${m}`) ? fail(503) : ok("ok")), { TEXT_PRIORITY_MODELS: "openrouter/B1,openrouter/B2" });

  // Request 1: no sticky yet -> priority first (openrouter/B1 serves) -> becomes sticky.
  assert.equal((await router.request("/v1/chat/completions", postJson(noModel, SESSION))).status, 200);
  assert.deepEqual(calls, ["openrouter/B1/o1"]);

  // Request 2 (Test A): sticky openrouter/B1 is attempted first, and alone.
  calls.length = 0;
  assert.equal((await router.request("/v1/chat/completions", postJson(noModel, SESSION))).status, 200);
  assert.deepEqual(calls, ["openrouter/B1/o1"]);
  assert.equal(phases(await lastRequest(router))[0], "sticky:openrouter/B1/0:200");

  // Request 3 (Test C): sticky fails -> priority (B1 skipped as tried, B2) -> ...
  down.add("openrouter/B1");
  down.add("openrouter/B2");
  calls.length = 0;
  assert.equal((await router.request("/v1/chat/completions", postJson(noModel, SESSION))).status, 200);
  assert.deepEqual(calls, ["openrouter/B1/o1", "openrouter/B2/o1", "groq/A1/g1"], "sticky, then the remaining priority, then normal order");
  assert.deepEqual(phases(await lastRequest(router)), [
    "sticky:openrouter/B1/0:503", "priority:openrouter/B1/0:skipped", "priority:openrouter/B2/0:503", "fallback:groq/A1/0:200"
  ]);

  // Request 4 (Test D): groq/A1/key0 is the NEW sticky and is tried first.
  calls.length = 0;
  assert.equal((await router.request("/v1/chat/completions", postJson(noModel, SESSION))).status, 200);
  assert.deepEqual(calls, ["groq/A1/g1"]);
});

test("sticky HTTP: a sticky target in cooldown is never called; normal fallback continues", async (t) => {
  let phase = 1;
  const { router, calls } = await rig(t, (p, m, k) => {
    if (p !== "groq") return ok("ok");
    if (phase === 1 && m === "A1" && k === "g1") return fail(429);   // S1: A1/g1 fails, cools
    if (phase === 2 && m === "A2" && k === "g1") return fail(429);   // S2: cools S1's sticky target
    return ok("ok");
  });
  const S1 = { "x-multi-ai-session-id": "s1" };
  const S2 = { "x-multi-ai-session-id": "s2" };

  await router.request("/v1/chat/completions", postJson(noModel, S1));   // sticky(S1) = groq/A2/key0
  assert.deepEqual(calls, ["groq/A1/g1", "groq/A2/g1"]);

  phase = 2; calls.length = 0;
  await router.request("/v1/chat/completions", postJson(noModel, S2));   // another session cools groq/A2/key0
  assert.deepEqual(calls, ["groq/A2/g1", "groq/A1/g2"]);

  phase = 3; calls.length = 0;
  const res = await router.request("/v1/chat/completions", postJson(noModel, S1));
  assert.equal(res.status, 200);
  assert.ok(!calls.includes("groq/A2/g1"), "the cooling sticky target must not be called");
  assert.deepEqual(calls, ["groq/A1/g2"]);
  assert.equal(phases(await lastRequest(router))[0], "sticky:groq/A2/0:skipped");
});

test("sticky HTTP: the 15-minute TTL is real-time based (shortened only to be testable)", async (t) => {
  const { router, calls } = await rig(t, (p, m) => (p === "groq" && m === "A1" ? fail(503) : ok("ok")), {
    TEXT_PRIORITY_MODELS: "openrouter/B2", STICKY_TTL_MS: "500"
  });
  // R1: priority openrouter/B2 serves -> sticky for 500 ms.
  await router.request("/v1/chat/completions", postJson(noModel, SESSION));
  // R2 within TTL: sticky first.
  calls.length = 0;
  await router.request("/v1/chat/completions", postJson(noModel, SESSION));
  assert.deepEqual(calls, ["openrouter/B2/o1"]);
  assert.equal(phases(await lastRequest(router))[0].split(":")[0], "sticky");

  // R3 after expiry: no sticky row; priority is the first phase again.
  await new Promise((r) => setTimeout(r, 650));
  calls.length = 0;
  await router.request("/v1/chat/completions", postJson(noModel, SESSION));
  assert.deepEqual(calls, ["openrouter/B2/o1"]);
  assert.equal(phases(await lastRequest(router))[0].split(":")[0], "priority");
});

test("sticky HTTP: expiry does not skip priority (priority 1 -> priority 2 -> normal)", async (t) => {
  // A generic 400 fails the priority targets without putting them into cooldown,
  // so the second request can really run them again.
  const { router, calls } = await rig(t, (p, m) => (p === "openrouter" ? fail(400) : ok("ok")), {
    TEXT_PRIORITY_MODELS: "openrouter/B1,openrouter/B2", STICKY_TTL_MS: "300"
  });
  await router.request("/v1/chat/completions", postJson(noModel, SESSION)); // groq/A1 becomes sticky after priority fails
  await new Promise((r) => setTimeout(r, 450));
  calls.length = 0;
  await router.request("/v1/chat/completions", postJson(noModel, SESSION));
  assert.deepEqual(calls.slice(0, 2), ["openrouter/B1/o1", "openrouter/B2/o1"], "priority runs first after expiry");
  assert.equal(calls[2], "groq/A1/g1");
  const rows = phases(await lastRequest(router));
  assert.ok(!rows.some((r) => r.startsWith("sticky:")), "the expired sticky is not attempted");
});

test("sticky HTTP: text and vision stickies are isolated, even for the same session id", async (t) => {
  const calls = [];
  const down = new Set();
  const mk = (name) => startMockUpstream((req) => {
    calls.push(`${name}/${req.body?.model}`);
    return down.has(`${name}/${req.body?.model}`) ? fail(503) : ok(name);
  });
  const text = await mk("text");
  const vision = await mk("vision");
  const router = await startRouter({
    GROQ_API_KEYS: "g1", GROQ_MODELS: "T1,T2", GROQ_BASE_URL: text.baseUrl,
    OPENROUTER_VISION_API_KEYS: "v1", OPENROUTER_VISION_MODELS: "V1,V2", OPENROUTER_VISION_BASE_URL: vision.baseUrl
  });
  t.after(async () => { await router.close(); await text.close(); await vision.close(); });
  const imageBody = { max_tokens: 8, messages: [{ role: "user", content: [{ type: "text", text: "?" }, IMAGE] }] };

  down.add("text/T1"); down.add("vision/V1");
  await router.request("/v1/messages", postJson(noModel, SESSION));   // text sticky -> T2
  await router.request("/v1/messages", postJson(imageBody, SESSION)); // vision sticky -> V2
  calls.length = 0;

  await router.request("/v1/messages", postJson(noModel, SESSION));
  assert.deepEqual(calls, ["text/T2"], "text uses its own sticky and never touches vision");
  calls.length = 0;
  await router.request("/v1/messages", postJson(imageBody, SESSION));
  assert.deepEqual(calls, ["vision/V2"], "vision uses its own sticky and never touches text");
});

test("sticky HTTP: a pinned request ignores the session's sticky target", async (t) => {
  const { router, calls } = await rig(t, () => ok("ok"), { TEXT_PRIORITY_MODELS: "openrouter/B1" });
  await router.request("/v1/chat/completions", postJson(noModel, SESSION)); // sticky -> openrouter/B1
  calls.length = 0;
  const res = await router.request("/v1/chat/completions", postJson(noModel, { ...SESSION, "x-multi-ai-pin-provider": "groq", "x-multi-ai-pin-key-index": "1" }));
  assert.equal(res.status, 200);
  assert.ok(calls.length >= 1 && calls.every((c) => c.startsWith("groq/") && c.endsWith("/g2")));
});

test("sticky HTTP: an explicit configured model beats the sticky target", async (t) => {
  const { router, calls } = await rig(t, () => ok("ok"));
  await router.request("/v1/chat/completions", postJson(noModel, SESSION)); // sticky -> groq/A1/key0
  calls.length = 0;
  await router.request("/v1/chat/completions", postJson({ ...textBody, model: "B2" }, SESSION));
  assert.deepEqual(calls, ["openrouter/B2/o1"], "the named model is served, not the sticky target");
});
