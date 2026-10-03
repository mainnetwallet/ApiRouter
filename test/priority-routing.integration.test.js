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

test("empty PRIORITY_MODELS: normal key-scoped fallback, no priority rows", async (t) => {
  const { router, calls } = await rig(t, (p, m, k) => (k === "g1" ? fail() : ok("done")), { PRIORITY_MODELS: "" });
  const res = await router.request("/v1/chat/completions", postJson(textBody));
  assert.equal(res.status, 200);
  // g1 runs its own chain (A1 then A2) before g2 restarts at A1.
  assert.deepEqual(calls, ["groq/A1/g1", "groq/A2/g1", "groq/A1/g2"]);
  const entry = await lastRequest(router);
  assert.ok(entry.attempts.every((a) => a.phase === "fallback"));
});

test("priority interleaves providers in env order and stops on first success", async (t) => {
  const { router, calls } = await rig(t, () => ok("prio"), { PRIORITY_MODELS: "openrouter/B2,groq/A1" });
  const res = await router.request("/v1/chat/completions", postJson(textBody));
  assert.equal(res.status, 200);
  assert.deepEqual(calls, ["openrouter/B2/o1"], "no further upstream call after the first priority success");
  assert.equal(res.headers.get("x-multi-ai-provider"), "openrouter");
});

test("priority failures fall through to normal fallback; repeats are logged as skips, never called", async (t) => {
  const { router, calls } = await rig(
    t,
    (p, m, k) => (p === "openrouter" && m === "B2" ? fail() : p === "groq" && m === "A1" ? fail(503) : ok("late")),
    { PRIORITY_MODELS: "openrouter/B2,groq/A1" }
  );
  const res = await router.request("/v1/chat/completions", postJson(textBody));
  assert.equal(res.status, 200);
  assert.equal(new Set(calls).size, calls.length, "no target is called twice in one request");
  assert.deepEqual(calls.slice(0, 3), ["openrouter/B2/o1", "groq/A1/g1", "groq/A1/g2"]);

  const entry = await lastRequest(router);
  const rows = entry.attempts.map((a) => `${a.phase}:${a.provider}/${a.model}/${a.keyIndex}:${a.skipped ? "skipped" : a.status}`);
  assert.ok(rows.includes("priority:openrouter/B2/0:429"));
  assert.ok(rows.includes("fallback:groq/A1/0:skipped"), "already-attempted target shows as skipped");
  assert.equal(entry.attemptCount, calls.length, "skipped rows are not counted as upstream attempts");
  assert.equal(entry.attempts.filter((a) => a.skipped).every((a) => a.skipReason === "already_attempted" || a.skipReason === "cooldown"), true);
});

test("pinned requests ignore priority and stay strict", async (t) => {
  const { router, calls } = await rig(t, () => ok("pinned"), { PRIORITY_MODELS: "openrouter/B2" });
  const res = await router.request("/v1/chat/completions", postJson(textBody, { "x-multi-ai-pin-provider": "groq", "x-multi-ai-pin-key-index": "1" }));
  assert.equal(res.status, 200);
  assert.deepEqual(calls, ["groq/A1/g2"]);
});

test("image request with no vision pool is 503 no_vision_route and never touches text or priority", async (t) => {
  const { router, calls } = await rig(t, () => ok("text"), { PRIORITY_MODELS: "groq/A1" });
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
    PRIORITY_MODELS: "groq/A1", VISION_PRIORITY_MODELS: "openrouter/V2"
  });
  t.after(async () => { await router.close(); await text.close(); await vision.close(); });

  const v = await router.request("/v1/messages", postJson({ model: "x", max_tokens: 8, messages: [{ role: "user", content: [{ type: "text", text: "?" }, IMAGE] }] }));
  assert.equal(v.status, 200);
  assert.deepEqual(calls, ["vision/V2"], "vision priority V2 first; the text priority entry is ignored");
  const entry = await lastRequest(router);
  assert.equal(entry.pool, "vision");
});

test("the request log never stores credentials", async (t) => {
  const { router } = await rig(t, (p, m, k) => (k === "g1" ? fail() : ok("x")), { PRIORITY_MODELS: "groq/A1" });
  await router.request("/v1/chat/completions", postJson(textBody));
  const raw = await (await router.request("/api/requests")).text();
  for (const secret of ["g1", "g2", "o1"]) assert.ok(!raw.includes(`"${secret}"`) && !raw.includes(`Bearer ${secret}`));
});
