import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startMockUpstream } from "../test-helpers/mock-upstream.js";
import { startRouter, postJson } from "../test-helpers/router-harness.js";
import { OneModelStore, KeyPacer, withOneModel } from "../src/one-model.js";
import { HealthRegistry } from "../src/health.js";

const ok = (model) => ({
  status: 200,
  body: { id: "x", object: "chat.completion", model, choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" }] }
});
const down = { status: 500, body: { error: "down" } };
const chat = (router) => router.request("/v1/chat/completions", postJson({ model: "anything", messages: [{ role: "user", content: "hello" }] }));
const posts = (mock) => mock.requests.filter((record) => record.method === "POST");
const put = (router, route, body) => router.request(route, {
  method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body)
});
const setOneModel = (router, body) => put(router, "/api/one-model", body);
const authOf = (record) => String(record.headers?.authorization ?? "");

// groq has two keys (g0, g1); mistral has one. COOLDOWN is short so tests stay fast.
async function start({ groqScript, mistralScript, cooldownMs = 600, maxWaitMs = 5000 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "one-model-"));
  const groq = await startMockUpstream(groqScript ?? (() => ok("m1")));
  const mistral = await startMockUpstream(mistralScript ?? (() => ok("m2")));
  const router = await startRouter({
    GROQ_API_KEYS: "g0,g1", GROQ_MODELS: "m1", GROQ_BASE_URL: `${groq.baseUrl}/v1`,
    MISTRAL_API_KEYS: "s0", MISTRAL_MODELS: "m2", MISTRAL_BASE_URL: `${mistral.baseUrl}/v1`,
    FALLBACK_CHAIN_FILE: path.join(dir, "fallback-chain.json"),
    DISABLED_MODELS_FILE: path.join(dir, "disabled-models.json"),
    ONE_MODEL_FILE: path.join(dir, "one-model.json"),
    ONE_MODEL_COOLDOWN_MS: String(cooldownMs),
    ONE_MODEL_MAX_WAIT_MS: String(maxWaitMs)
  });
  const stop = async () => { await router.close(); await groq.close(); await mistral.close(); };
  return { router, groq, mistral, dir, stop };
}

test("one model: only the chosen model is ever called, even when it fails", async () => {
  const { router, groq, mistral, stop } = await start({ groqScript: () => down, cooldownMs: 100, maxWaitMs: 2000 });
  try {
    assert.equal((await setOneModel(router, { enabled: true, provider: "groq", model: "m1" })).status, 200);
    const res = await chat(router);
    assert.notEqual(res.status, 200, "no other provider rescues the request");
    assert.equal(posts(mistral).length, 0, "no other provider is ever called");
    assert.equal(posts(groq).length, 2, "both keys of the chosen model were tried, once each");
  } finally { await stop(); }
});

test("one model: a failed key hands over to the next key, which answers", async () => {
  let calls = 0;
  const { router, groq, mistral, stop } = await start({
    groqScript: () => { calls += 1; return calls === 1 ? down : ok("m1"); }
  });
  try {
    assert.equal((await setOneModel(router, { enabled: true, provider: "groq", model: "m1" })).status, 200);
    const res = await chat(router);
    assert.equal(res.status, 200);
    assert.equal(posts(groq).length, 2);
    assert.match(authOf(posts(groq)[0]), /g0/, "key 0 first");
    assert.match(authOf(posts(groq)[1]), /g1/, "then key 1");
    assert.equal(posts(mistral).length, 0);
  } finally { await stop(); }
});

test("one model: a key cools the moment it is called, so calls rotate across keys", async () => {
  const { router, groq, stop } = await start({ cooldownMs: 800 });
  try {
    assert.equal((await setOneModel(router, { enabled: true, provider: "groq", model: "m1" })).status, 200);
    assert.equal((await chat(router)).status, 200);
    assert.equal((await chat(router)).status, 200);
    const used = posts(groq).map((record) => authOf(record));
    assert.match(used[0], /g0/);
    assert.match(used[1], /g1/, "key 0 was cooling after its (successful) call, so key 1 served the second");

    const state = await (await router.request("/api/one-model")).json();
    assert.equal(state.keys.length, 2);
    assert.ok(state.keys.every((key) => key.ready === false && key.cooldownUntil > Date.now() - 50),
      "both keys are cooling right after being used");
  } finally { await stop(); }
});

test("one model: with every key cooling the request waits, then calls the key that became ready", async () => {
  const { router, groq, stop } = await start({ cooldownMs: 700 });
  try {
    assert.equal((await setOneModel(router, { enabled: true, provider: "groq", model: "m1" })).status, 200);
    assert.equal((await chat(router)).status, 200); // key 0
    assert.equal((await chat(router)).status, 200); // key 1
    const startedAt = Date.now();
    const res = await chat(router); // both cooling: waits for key 0
    assert.equal(res.status, 200);
    const waited = Date.now() - startedAt;
    assert.ok(waited >= 400, `it waited for a key to be ready (waited ${waited} ms)`);
    assert.equal(posts(groq).length, 3);
    assert.match(authOf(posts(groq)[2]), /g0/, "the first key to become ready served it");
  } finally { await stop(); }
});

test("one model: a wait longer than the bound ends in a 503 that says when a key is ready", async () => {
  const { router, groq, stop } = await start({ cooldownMs: 5000, maxWaitMs: 300 });
  try {
    assert.equal((await setOneModel(router, { enabled: true, provider: "groq", model: "m1" })).status, 200);
    assert.equal((await chat(router)).status, 200);
    assert.equal((await chat(router)).status, 200);
    const res = await chat(router);
    assert.equal(res.status, 503);
    const body = await res.json();
    assert.equal(body.error.type, "one_model_cooldown");
    assert.equal(posts(groq).length, 2, "no key was called while all were cooling");
  } finally { await stop(); }
});

test("one model: switching it off restores the normal fallback and leaves no cooldown behind", async () => {
  const { router, groq, mistral, stop } = await start({ groqScript: () => down, cooldownMs: 60000, maxWaitMs: 100 });
  try {
    assert.equal((await setOneModel(router, { enabled: true, provider: "groq", model: "m1" })).status, 200);
    assert.notEqual((await chat(router)).status, 200);
    assert.equal(posts(mistral).length, 0);

    assert.equal((await setOneModel(router, { enabled: false })).status, 200);
    const res = await chat(router);
    assert.equal(res.status, 200, "normal fallback reaches mistral again, with no cooldown stuck on groq's keys");
    assert.equal(posts(mistral).length, 1);
  } finally { await stop(); }
});

test("one model: the Model Switch still wins, and the request says why", async () => {
  const { router, groq, stop } = await start();
  try {
    assert.equal((await setOneModel(router, { enabled: true, provider: "groq", model: "m1" })).status, 200);
    assert.equal((await put(router, "/api/providers/switch", { provider: "groq", disabled: true })).status, 200);
    const res = await chat(router);
    assert.equal(res.status, 503);
    assert.equal(posts(groq).length, 0);
  } finally { await stop(); }
});

test("one model API: validates input, reports keys and persists", async () => {
  const { router, dir, stop } = await start();
  try {
    assert.equal((await setOneModel(router, { enabled: true })).status, 400, "nothing chosen yet");
    assert.equal((await setOneModel(router, { enabled: "yes" })).status, 400);
    assert.equal((await setOneModel(router, { provider: "groq" })).status, 400, "provider and model go together");
    assert.equal((await setOneModel(router, { enabled: true, provider: "groq", model: "nope" })).status, 404);

    const res = await setOneModel(router, { enabled: true, provider: "Groq", model: "m1" });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.changed, true);
    assert.equal(body.active, true);
    assert.equal(body.provider, "groq");
    assert.equal(body.keys.length, 2);
    assert.ok(body.candidates.some((candidate) => candidate.provider === "mistral" && candidate.selected === false));
    assert.equal((await (await setOneModel(router, { enabled: true })).json()).changed, false);

    const saved = JSON.parse(fs.readFileSync(path.join(dir, "one-model.json"), "utf8"));
    assert.deepEqual({ enabled: saved.enabled, provider: saved.provider, model: saved.model }, { enabled: true, provider: "groq", model: "m1" });

    const health = await (await router.request("/health")).json();
    assert.deepEqual(health.oneModel, { enabled: true, provider: "groq", model: "m1" });
  } finally { await stop(); }
});

test("OneModelStore persists, reloads and notifies", () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "one-model-store-")), "o.json");
  const events = [];
  const store = new OneModelStore({ file });
  store.onChange((event) => events.push(event));
  assert.equal(store.active(), null);
  assert.throws(() => store.set({ enabled: true }), /choose a provider/);

  assert.equal(store.set({ enabled: true, provider: "Groq", model: "m1" }), true);
  assert.deepEqual(store.active(), { provider: "groq", model: "m1" });
  assert.equal(store.set({ enabled: true, provider: "groq", model: "m1" }), false);
  assert.deepEqual(events, [{ enabled: true, provider: "groq", model: "m1" }]);

  const reloaded = new OneModelStore({ file });
  assert.deepEqual(reloaded.active(), { provider: "groq", model: "m1" });
  reloaded.set({ enabled: false });
  assert.equal(new OneModelStore({ file }).active(), null);
  assert.equal(new OneModelStore({ file }).get().model, "m1", "the choice is kept while the mode is off");
});

test("withOneModel: pacing is unconditional, failure is recorded without a health cooldown", async () => {
  const pacer = new KeyPacer({ cooldownMs: 10_000 });
  const health = new HealthRegistry();
  const targets = [0, 1].map((keyIndex) => ({ provider: "p", model: "m", keyIndex, pool: "text" }));
  const used = [];
  const invoke = async (target) => {
    used.push(target.keyIndex);
    if (target.keyIndex === 0) { const e = new Error("boom"); e.status = 500; throw e; }
    return "done";
  };
  assert.equal(await withOneModel(targets, invoke, { pacer, health }), "done");
  assert.deepEqual(used, [0, 1]);
  assert.equal(pacer.isReady(targets[0]), false);
  assert.equal(pacer.isReady(targets[1]), false, "the successful key cools too");
  assert.equal(health.isAvailable(targets[0]), true, "the health registry holds no cooldown for it");
  assert.equal(health.get(health.key(targets[0])).status, "failed");
});
