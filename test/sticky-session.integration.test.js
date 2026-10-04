import test from "node:test";
import assert from "node:assert/strict";
import { startMockUpstream } from "../test-helpers/mock-upstream.js";
import { startRouter, postJson } from "../test-helpers/router-harness.js";

// Same-session sticky behavior, through the real server:
//   Priority success => THAT session's STICKY target (provider + key + model),
//   never a global promotion and never a reorder of the configured priority list.

const ok = (text = "ok") => ({
  status: 200,
  body: {
    id: "c1", object: "chat.completion", created: 0, model: "upstream",
    choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
  }
});
const fail = (status = 503) => ({ status, body: { error: { message: "nope" } } });
const noModel = { max_tokens: 8, messages: [{ role: "user", content: "hi" }] };
const sid = (id) => ({ "x-multi-ai-session-id": id });
const lastRequest = async (router) => (await (await router.request("/api/requests")).json()).entries[0];
const phases = (entry) => entry.attempts.map((a) => `${a.phase}:${a.provider}/${a.model}/${a.keyIndex}:${a.skipped ? "skipped" : a.status}`);

/**
 * providerA (keys a1,a2; models A1,A2), providerB (key b1; models B1,B2),
 * providerC (key c1; model C1). `decide(provider, model, key)` scripts each call.
 * Providers are real, supported ids (groq / openrouter / gemini) so the router config is genuine.
 */
async function rig(t, decide, extraEnv = {}) {
  const calls = [];
  const make = (name) => startMockUpstream((req) => {
    const key = String(req.headers.authorization || "").replace("Bearer ", "");
    calls.push(`${name}/${req.body?.model}/${key}`);
    return decide(name, req.body?.model, key);
  });
  const groq = await make("groq");
  const openrouter = await make("openrouter");
  const mistral = await make("mistral");
  const router = await startRouter({
    GROQ_API_KEYS: "a1,a2", GROQ_MODELS: "A1,A2", GROQ_BASE_URL: groq.baseUrl,
    OPENROUTER_API_KEYS: "b1", OPENROUTER_MODELS: "B1,B2", OPENROUTER_BASE_URL: openrouter.baseUrl,
    MISTRAL_API_KEYS: "c1", MISTRAL_MODELS: "C1", MISTRAL_BASE_URL: mistral.baseUrl,
    ...extraEnv
  });
  t.after(async () => { await router.close(); await groq.close(); await openrouter.close(); await mistral.close(); });
  return { router, calls };
}

const send = (router, headers) => router.request("/v1/chat/completions", postJson(noModel, headers));

test("1: priority success becomes sticky - two requests, same target, exactly two upstream calls", async (t) => {
  const { router, calls } = await rig(t, () => ok(), { TEXT_PRIORITY_MODELS: "groq/A1,openrouter/B1" });
  assert.equal((await send(router, sid("s-1"))).status, 200);
  assert.equal((await send(router, sid("s-1"))).status, 200);
  assert.deepEqual(calls, ["groq/A1/a1", "groq/A1/a1"]);
  assert.equal(phases(await lastRequest(router))[0], "sticky:groq/A1/0:200");
});

test("2: sticky failure -> priority (sticky itself not repeated) -> next priority succeeds", async (t) => {
  const down = new Set();
  const { router, calls } = await rig(t, (p, m) => (down.has(`${p}/${m}`) ? fail(503) : ok()), { TEXT_PRIORITY_MODELS: "groq/A1,openrouter/B1" });
  await send(router, sid("s-2"));                       // groq/A1/a1 succeeds -> sticky
  down.add("groq/A1");
  calls.length = 0;
  assert.equal((await send(router, sid("s-2"))).status, 200);
  // sticky a1 fails (not repeated); priority group groq/A1 continues with its other key a2; then B1.
  assert.deepEqual(calls, ["groq/A1/a1", "groq/A1/a2", "openrouter/B1/b1"]);
  const rows = phases(await lastRequest(router));
  assert.equal(rows[0], "sticky:groq/A1/0:503");
  assert.equal(rows[rows.length - 1], "priority:openrouter/B1/0:200");
  assert.equal(new Set(calls).size, calls.length, "no exact target is called twice in one request");
});

test("3: priority order is never mutated - a new session still starts at the first configured entry", async (t) => {
  const { router, calls } = await rig(t, () => ok(), { TEXT_PRIORITY_MODELS: "groq/A1,openrouter/B1,mistral/C1" });
  await send(router, sid("order-x"));                    // A1 succeeds (first priority)
  await send(router, sid("order-x"));                    // sticky A1
  calls.length = 0;
  // A brand-new session must go A1 first, not whatever another session last used.
  assert.equal((await send(router, sid("order-new"))).status, 200);
  assert.deepEqual(calls, ["groq/A1/a1"]);
});

test("3b: after a later priority entry succeeds for one session, other sessions still start at priority[0]", async (t) => {
  // A generic 400 fails the attempt without cooling the target, so groq/A1 stays eligible.
  let a1Rejects = true;
  const { router, calls } = await rig(t, (p, m) => (a1Rejects && p === "groq" && m === "A1" ? fail(400) : ok()), {
    TEXT_PRIORITY_MODELS: "groq/A1,openrouter/B1,mistral/C1"
  });
  await send(router, sid("promo-1"));                    // every A1 key rejects, B1 succeeds -> sticky for promo-1 only
  assert.deepEqual(calls, ["groq/A1/a1", "groq/A1/a2", "openrouter/B1/b1"]);
  a1Rejects = false;
  calls.length = 0;
  await send(router, sid("promo-1"));
  assert.deepEqual(calls, ["openrouter/B1/b1"], "promo-1 itself is sticky to B1");
  calls.length = 0;
  await send(router, sid("promo-2"));
  assert.deepEqual(calls, ["groq/A1/a1"], "priority[0] is still first for a different session; the list was not reordered");
});

test("4: a different session never inherits another session's sticky target", async (t) => {
  let a1Rejects = true;
  const { router, calls } = await rig(t, (p, m) => (a1Rejects && p === "groq" && m === "A1" ? fail(400) : ok()), { TEXT_PRIORITY_MODELS: "" });
  await send(router, sid("iso-1"));                      // A1/a1 rejects, A2/a1 succeeds -> sticky for iso-1
  assert.deepEqual(calls, ["groq/A1/a1", "groq/A2/a1"]);
  a1Rejects = false;
  calls.length = 0;
  await send(router, sid("iso-1"));
  assert.deepEqual(calls, ["groq/A2/a1"], "iso-1 reuses its own sticky");
  calls.length = 0;
  await send(router, sid("iso-2"));
  assert.deepEqual(calls, ["groq/A1/a1"], "iso-2 starts from the normal order, not iso-1's sticky target");
  assert.ok(!phases(await lastRequest(router)).some((p) => p.startsWith("sticky:")));
});

test("4b: a request without a session id gets a fresh session each time (no shared sticky)", async (t) => {
  const down = new Set(["groq/A1"]);
  const { router } = await rig(t, (p, m) => (down.has(`${p}/${m}`) ? fail(503) : ok()), { TEXT_PRIORITY_MODELS: "" });
  await send(router);                                    // anonymous request establishes nothing reusable
  down.clear();
  await send(router);
  const entry = await lastRequest(router);
  assert.ok(!phases(entry).some((p) => p.startsWith("sticky:")));
});

test("response x-multi-ai-session-id, reused by the client, activates sticky on the next request", async (t) => {
  const { router, calls } = await rig(t, () => ok(), { TEXT_PRIORITY_MODELS: "openrouter/B2" });
  const first = await send(router);
  const id = first.headers.get("x-multi-ai-session-id");
  assert.ok(id, "server issues a session id");
  calls.length = 0;
  await send(router, sid(id));
  assert.equal(phases(await lastRequest(router))[0], "sticky:openrouter/B2/0:200");
  assert.deepEqual(calls, ["openrouter/B2/b1"]);
});

test("5: sticky TTL expiry returns the session to Priority -> Fallback", async (t) => {
  const { router, calls } = await rig(t, () => ok(), { TEXT_PRIORITY_MODELS: "groq/A1,openrouter/B1", STICKY_TTL_MS: "400" });
  await send(router, sid("ttl"));
  calls.length = 0;
  await send(router, sid("ttl"));
  assert.equal(phases(await lastRequest(router))[0].split(":")[0], "sticky");
  await new Promise((r) => setTimeout(r, 600));
  calls.length = 0;
  await send(router, sid("ttl"));
  const entry = await lastRequest(router);
  assert.ok(!phases(entry).some((p) => p.startsWith("sticky:")), "expired sticky is not attempted");
  assert.equal(phases(entry)[0].split(":")[0], "priority");
});

test("6: sticky success stops routing - no priority or fallback call is made", async (t) => {
  const { router, calls } = await rig(t, () => ok(), { TEXT_PRIORITY_MODELS: "groq/A1,openrouter/B1" });
  await send(router, sid("stop"));
  calls.length = 0;
  await send(router, sid("stop"));
  assert.deepEqual(calls, ["groq/A1/a1"]);
  const entry = await lastRequest(router);
  assert.equal(entry.attempts.length, 1, "exactly one attempt row, so no skipped/extra rows either");
});

test("7: the exact key is remembered - key2 is never preferred over the sticky key1 for the same model", async (t) => {
  // Key a1 rejects once (generic 400: no cooldown), so a2 serves A1 and becomes sticky.
  let a1Rejects = true;
  const { router, calls } = await rig(t, (p, m, k) => (a1Rejects && p === "groq" && k === "a1" ? fail(400) : ok()), { TEXT_PRIORITY_MODELS: "" });
  await send(router, sid("key"));
  assert.deepEqual(calls, ["groq/A1/a1", "groq/A2/a1", "groq/A1/a2"]);
  a1Rejects = false;                                     // a1 is healthy again: the normal order would start there
  calls.length = 0;
  await send(router, sid("key"));
  assert.deepEqual(calls, ["groq/A1/a2"], "same-session request starts at exactly provider + key + model");
  assert.equal(phases(await lastRequest(router))[0], "sticky:groq/A1/1:200");
  calls.length = 0;
  await send(router, sid("key-other"));
  assert.deepEqual(calls, ["groq/A1/a1"], "another session is unaffected and uses the normal order");
});

test("8: pools are isolated - a text sticky is never used for a vision request", async (t) => {
  const { router, calls } = await rig(t, () => ok(), { TEXT_PRIORITY_MODELS: "openrouter/B1" });
  await send(router, sid("pool"));                       // text sticky = openrouter/B1
  calls.length = 0;
  const image = { max_tokens: 8, messages: [{ role: "user", content: [
    { type: "text", text: "what is this" },
    { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }
  ] }] };
  const res = await router.request("/v1/chat/completions", postJson(image, sid("pool")));
  // No vision target is configured, so the request never reaches the text pool's sticky target.
  assert.equal(res.status, 503);
  assert.deepEqual(calls, [], "the text sticky target is not called for a vision request");
});

test("model-centric priority over HTTP: every key of the entry, then stop; the winning key becomes sticky", async (t) => {
  const { router, calls } = await rig(t, (p, m, k) => (p === "groq" && k === "a1" ? fail(503) : ok()), { TEXT_PRIORITY_MODELS: "groq/A1,openrouter/B1" });
  assert.equal((await send(router, sid("mc"))).status, 200);
  assert.deepEqual(calls, ["groq/A1/a1", "groq/A1/a2"], "key a2 is tried before any other priority entry; openrouter/B1 is never called");
  calls.length = 0;
  assert.equal((await send(router, sid("mc"))).status, 200);
  assert.deepEqual(calls, ["groq/A1/a2"], "next same-session request: exactly the remembered key");
  assert.equal(phases(await lastRequest(router))[0], "sticky:groq/A1/1:200");
});
