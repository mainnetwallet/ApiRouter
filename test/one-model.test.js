import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startMockUpstream } from "../test-helpers/mock-upstream.js";
import { startRouter, postJson } from "../test-helpers/router-harness.js";
import { OneModelStore, KeyPacer, withOneModel, normalizeKeyId } from "../src/one-model.js";
import { HealthRegistry } from "../src/health.js";

const ok = (model) => ({
  status: 200,
  body: { id: "x", object: "chat.completion", model, choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" }] }
});
const down = { status: 500, body: { error: "down" } };
const chat = (router) => router.request("/v1/chat/completions", postJson({ model: "anything", messages: [{ role: "user", content: "hello" }] }));
// A request that is left waiting (every key cooling) never ends by itself: the client gives up after `ms`.
const chatFor = async (router, ms) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await router.request("/v1/chat/completions", { ...postJson({ model: "anything", messages: [{ role: "user", content: "hello" }] }), signal: controller.signal });
  } catch (error) {
    if (error?.name === "AbortError") return { status: "waiting", aborted: true };
    throw error;
  } finally { clearTimeout(timer); }
};
const posts = (mock) => mock.requests.filter((record) => record.method === "POST");
const put = (router, route, body) => router.request(route, {
  method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body)
});
const setOneModel = (router, body) => put(router, "/api/one-model", body);
const authOf = (record) => String(record.headers?.authorization ?? "");

// groq has two keys (g0, g1); mistral has one. No key has a cooldown unless a test sets one.
async function start({ groqScript, mistralScript, groqModels = "m1" } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "one-model-"));
  const groq = await startMockUpstream(groqScript ?? (() => ok("m1")));
  const mistral = await startMockUpstream(mistralScript ?? (() => ok("m2")));
  const router = await startRouter({
    GROQ_API_KEYS: "g0,g1", GROQ_MODELS: groqModels, GROQ_BASE_URL: `${groq.baseUrl}/v1`,
    MISTRAL_API_KEYS: "s0", MISTRAL_MODELS: "m2", MISTRAL_BASE_URL: `${mistral.baseUrl}/v1`,
    FALLBACK_CHAIN_FILE: path.join(dir, "fallback-chain.json"),
    DISABLED_MODELS_FILE: path.join(dir, "disabled-models.json"),
    ONE_MODEL_FILE: path.join(dir, "one-model.json")
  });
  const stop = async () => { await router.close(); await groq.close(); await mistral.close(); };
  return { router, groq, mistral, dir, stop };
}

/** Turns the mode on for groq/m1, optionally giving each key its own cooldown (ms). */
const enableGroq = (router, { k0 = null, k1 = null } = {}) => setOneModel(router, {
  enabled: true, provider: "groq", model: "m1",
  ...(k0 || k1 ? { cooldowns: { ...(k0 ? { "text:0": k0 } : {}), ...(k1 ? { "text:1": k1 } : {}) } } : {})
});

test("one model: only the chosen model is ever called, even when it fails", async () => {
  const { router, groq, mistral, stop } = await start({ groqScript: () => down });
  try {
    assert.equal((await enableGroq(router)).status, 200);
    const res = await chatFor(router, 700);
    assert.equal(res.aborted, true, "every key failed and is cooling: the request keeps waiting, it is not failed");
    assert.equal(posts(mistral).length, 0, "no other provider is ever called");
    assert.equal(posts(groq).length, 2, "both keys of the chosen model were tried once and are not called while cooling");
  } finally { await stop(); }
});

test("one model: a failed key hands over to the next key, which answers", async () => {
  let calls = 0;
  const { router, groq, mistral, stop } = await start({
    groqScript: () => { calls += 1; return calls === 1 ? down : ok("m1"); }
  });
  try {
    assert.equal((await enableGroq(router)).status, 200);
    const res = await chat(router);
    assert.equal(res.status, 200);
    assert.equal(posts(groq).length, 2);
    assert.match(authOf(posts(groq)[0]), /g0/, "key 0 first");
    assert.match(authOf(posts(groq)[1]), /g1/, "then key 1");
    assert.equal(posts(mistral).length, 0);
  } finally { await stop(); }
});

test("one model: with no cooldown set the key that works is called again and nothing waits", async () => {
  const { router, groq, stop } = await start();
  try {
    assert.equal((await enableGroq(router)).status, 200);
    const startedAt = Date.now();
    for (let i = 0; i < 4; i += 1) assert.equal((await chat(router)).status, 200);
    assert.ok(Date.now() - startedAt < 1500, "no waiting");
    const used = posts(groq).map((record) => authOf(record));
    assert.equal(used.length, 4);
    assert.ok(used.every((auth) => /g0/.test(auth)), "the successful key answered every request");
    const state = await (await router.request("/api/one-model")).json();
    assert.ok(state.keys.every((key) => key.ready && key.cooldownMs === 0), "no key is cooling");
  } finally { await stop(); }
});

test("one model: the key that answered last leads the next request, so a failed key is not retried first", async () => {
  let calls = 0;
  const { router, groq, stop } = await start({
    groqScript: () => { calls += 1; return calls === 1 ? down : ok("m1"); }
  });
  try {
    assert.equal((await enableGroq(router)).status, 200);
    assert.equal((await chat(router)).status, 200); // g0 fails, g1 answers
    assert.equal((await chat(router)).status, 200); // starts with g1
    const used = posts(groq).map((record) => authOf(record));
    assert.equal(used.length, 3);
    assert.match(used[0], /g0/);
    assert.match(used[1], /g1/);
    assert.match(used[2], /g1/, "key 1 answered last, so it is called first now");
  } finally { await stop(); }
});

test("one model: a key with a cooldown cools the moment it is called, so calls move to the next key", async () => {
  const { router, groq, stop } = await start();
  try {
    assert.equal((await enableGroq(router, { k0: 800, k1: 800 })).status, 200);
    assert.equal((await chat(router)).status, 200);
    assert.equal((await chat(router)).status, 200);
    const used = posts(groq).map((record) => authOf(record));
    assert.match(used[0], /g0/);
    assert.match(used[1], /g1/, "key 0 was cooling after its (successful) call, so key 1 served the second");

    const state = await (await router.request("/api/one-model")).json();
    assert.deepEqual(state.keys.map((key) => key.cooldownMs), [800, 800]);
    assert.ok(state.keys.every((key) => key.ready === false && key.cooldownUntil > Date.now() - 50),
      "both keys are cooling right after being used");
  } finally { await stop(); }
});

test("one model: only the keys given a cooldown are paced; the others keep being called", async () => {
  const { router, groq, stop } = await start();
  try {
    assert.equal((await enableGroq(router, { k0: 5000 })).status, 200); // key 1 has none
    const startedAt = Date.now();
    for (let i = 0; i < 4; i += 1) assert.equal((await chat(router)).status, 200);
    assert.ok(Date.now() - startedAt < 1500, "never waited: key 1 has no cooldown");
    const used = posts(groq).map((record) => authOf(record));
    assert.match(used[0], /g0/, "key 0 answered once, then cooled");
    assert.ok(used.slice(1).every((auth) => /g1/.test(auth)), "key 1 answered the rest, uncooled");
  } finally { await stop(); }
});

test("one model: with every key cooling the request waits, then calls the key that became ready", async () => {
  const { router, groq, stop } = await start();
  try {
    assert.equal((await enableGroq(router, { k0: 700, k1: 700 })).status, 200);
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

test("one model: a long wait has no bound: the request keeps waiting and calls nothing while every key cools", async () => {
  const { router, groq, stop } = await start();
  try {
    assert.equal((await enableGroq(router, { k0: 60000, k1: 60000 })).status, 200);
    assert.equal((await chat(router)).status, 200);
    assert.equal((await chat(router)).status, 200);
    const res = await chatFor(router, 1500);
    assert.equal(res.aborted, true, "still waiting, not a 503");
    assert.equal(posts(groq).length, 2, "no key was called while all were cooling");
  } finally { await stop(); }
});

test("one model: switching it off restores the normal fallback and leaves no pacing cooldown behind", async () => {
  let calls = 0;
  const { router, groq, mistral, stop } = await start({ groqScript: () => { calls += 1; return calls <= 2 ? ok("m1") : down; } });
  try {
    assert.equal((await enableGroq(router, { k0: 60000, k1: 60000 })).status, 200);
    assert.equal((await chat(router)).status, 200);
    assert.equal((await chat(router)).status, 200);
    assert.equal(posts(mistral).length, 0);

    assert.equal((await setOneModel(router, { enabled: false })).status, 200);
    const res = await chat(router);
    assert.equal(res.status, 200, "normal fallback reaches mistral again, with no pacing cooldown stuck on groq's keys");
    assert.equal(posts(mistral).length, 1);
    assert.equal(posts(groq).length >= 3, true, "the normal walk still called groq's keys first");
  } finally { await stop(); }
});

test("one model: the Model Switch still wins, and the request says why", async () => {
  const { router, groq, stop } = await start();
  try {
    assert.equal((await enableGroq(router)).status, 200);
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
    assert.equal((await setOneModel(router, { provider: "groq" })).status, 400, "provider and models go together");
    assert.equal((await setOneModel(router, { provider: "groq", models: "m1" })).status, 400, "models is a list");
    assert.equal((await setOneModel(router, { provider: "groq", models: ["m1"], model: "m1" })).status, 400, "models or model, not both");
    assert.equal((await setOneModel(router, { enabled: true, provider: "groq", model: "nope" })).status, 404);

    const res = await setOneModel(router, { enabled: true, provider: "Groq", model: "m1" });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.changed, true);
    assert.equal(body.active, true);
    assert.equal(body.provider, "groq");
    assert.equal(body.keys.length, 2);
    assert.deepEqual(body.keys.map((key) => key.cooldownMs), [0, 0], "no cooldown unless one is set");
    assert.ok(body.candidates.some((candidate) => candidate.provider === "mistral" && candidate.selected === false));
    assert.equal((await (await setOneModel(router, { enabled: true })).json()).changed, false);

    const saved = JSON.parse(fs.readFileSync(path.join(dir, "one-model.json"), "utf8"));
    assert.deepEqual({ enabled: saved.enabled, provider: saved.provider, models: saved.models }, { enabled: true, provider: "groq", models: ["m1"] });

    const health = await (await router.request("/health")).json();
    assert.deepEqual(health.oneModel, { enabled: true, provider: "groq", models: ["m1"] });
  } finally { await stop(); }
});

test("one model API: per-key cooldowns are validated, saved, removable and cleared with the model", async () => {
  const { router, dir, stop } = await start();
  try {
    assert.equal((await enableGroq(router)).status, 200);
    for (const bad of [
      { cooldowns: [] }, { cooldowns: "60" }, { cooldowns: null },
      { cooldowns: { "text:x": 1000 } }, { cooldowns: { "0": 1000 } },
      { cooldowns: { "text:0": -5 } }, { cooldowns: { "text:0": 1.5 } },
      { cooldowns: { "text:0": "60" } }, { cooldowns: { "text:0": 90_000_000 } }
    ]) {
      assert.equal((await setOneModel(router, bad)).status, 400, JSON.stringify(bad));
    }
    assert.equal((await setOneModel(router, { cooldowns: { "text:7": 60000 } })).status, 404, "the model has no key 7");

    const set = await (await setOneModel(router, { cooldowns: { "text:0": 60000 } })).json();
    assert.equal(set.changed, true);
    assert.deepEqual(set.keys.map((key) => key.cooldownMs), [60000, 0]);
    const saved = JSON.parse(fs.readFileSync(path.join(dir, "one-model.json"), "utf8"));
    assert.deepEqual(saved.cooldowns, { "m1::0": 60000 }, "stored against its model");

    // Removing it (null) and the key is unpaced again.
    const removed = await (await setOneModel(router, { cooldowns: { "text:0": null } })).json();
    assert.deepEqual(removed.keys.map((key) => key.cooldownMs), [0, 0]);

    // Choosing another model clears the cooldowns: they described other keys.
    await setOneModel(router, { cooldowns: { "text:1": 30000 } });
    const switched = await (await setOneModel(router, { provider: "mistral", models: ["m2"] })).json();
    assert.deepEqual(switched.keys.map((key) => key.cooldownMs), [0]);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, "one-model.json"), "utf8")).cooldowns, {});
  } finally { await stop(); }
});

test("one model: removing a key's cooldown makes it ready at once", async () => {
  const { router, stop } = await start();
  try {
    assert.equal((await enableGroq(router, { k0: 60000, k1: 60000 })).status, 200);
    assert.equal((await chat(router)).status, 200);
    let state = await (await router.request("/api/one-model")).json();
    assert.equal(state.keys[0].ready, false, "key 0 is cooling for a minute");

    state = await (await setOneModel(router, { cooldowns: { "text:0": null } })).json();
    assert.equal(state.keys[0].ready, true, "the edit releases it");
    assert.equal((await chat(router)).status, 200);
  } finally { await stop(); }
});

test("OneModelStore persists, reloads and notifies", () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "one-model-store-")), "o.json");
  const events = [];
  const store = new OneModelStore({ file });
  store.onChange((event) => events.push(event));
  assert.equal(store.active(), null);
  assert.throws(() => store.set({ enabled: true }), /choose a provider/);

  assert.equal(store.set({ enabled: true, provider: "Groq", models: ["m1", "m3", "m1", " "] }), true, "duplicates and blanks are dropped");
  assert.deepEqual(store.active(), { provider: "groq", models: ["m1", "m3"] });
  assert.equal(store.set({ enabled: true, provider: "groq", models: ["m1", "m3"] }), false);
  assert.deepEqual(events, [{ enabled: true, provider: "groq", models: ["m1", "m3"], scope: "selection", reset: true, changedKeys: [] }]);

  assert.equal(store.set({ models: ["m3", "m1"] }), true, "the order is part of the selection");
  assert.deepEqual(store.get().models, ["m3", "m1"]);
  assert.equal(events.at(-1).reset, false, "reordering is not a reset");
  assert.equal(store.modelRank({ provider: "groq", model: "m1" }), 1);
  assert.equal(store.matches({ provider: "groq", model: "m3" }), true);
  assert.equal(store.matches({ provider: "groq", model: "other" }), false);
  assert.throws(() => store.set({ models: "m1" }), /list/);

  const reloaded = new OneModelStore({ file });
  assert.deepEqual(reloaded.active(), { provider: "groq", models: ["m3", "m1"] });
  reloaded.set({ enabled: false });
  assert.equal(new OneModelStore({ file }).active(), null);
  assert.deepEqual(new OneModelStore({ file }).get().models, ["m3", "m1"], "the choice is kept while the mode is off");
});

test("OneModelStore: key cooldowns persist, edit by scope and reset with the model", () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "one-model-cd-")), "o.json");
  const events = [];
  const store = new OneModelStore({ file });
  store.set({ enabled: true, provider: "groq", models: ["m1"] });
  store.onChange((event) => events.push(event));
  const key = (keyIndex, model = "m1") => ({ model, pool: "text", keyIndex });

  assert.equal(store.cooldownFor(key(0)), 0, "none by default");
  assert.equal(store.set({ cooldowns: { "text:0": 60000 } }), true);
  assert.equal(store.cooldownFor(key(0)), 60000);
  assert.equal(store.cooldownFor(key(1)), 0);
  assert.deepEqual(events.at(-1), { enabled: true, provider: "groq", models: ["m1"], scope: "cooldowns", reset: false, changedKeys: ["m1::0"] });
  assert.equal(store.set({ cooldowns: { "text:0": 60000 } }), false, "same value changes nothing");

  assert.equal(new OneModelStore({ file }).cooldownFor(key(0)), 60000, "reloaded");
  assert.throws(() => store.set({ cooldowns: { "text:0": 0.5 } }));
  assert.throws(() => store.set({ cooldowns: { bad: 1000 } }));

  store.set({ cooldowns: { "text:0": null } });
  assert.equal(store.cooldownFor(key(0)), 0);

  store.set({ cooldowns: { "text:1": 1000 } });
  store.set({ provider: "mistral", models: ["m2"] });
  assert.deepEqual(store.getCooldowns(), {}, "a different provider starts with no cooldowns");
  assert.equal(events.at(-1).scope, "selection");
  assert.equal(events.at(-1).reset, true);
});

test("withOneModel: only a key with a cooldown is paced, a failure cools the key in health, the last good key leads", async () => {
  const pacer = new KeyPacer();
  const health = new HealthRegistry();
  const targets = [0, 1].map((keyIndex) => ({ provider: "p", model: "m", keyIndex }));
  const used = [];
  const invoke = async (target) => {
    used.push(target.keyIndex);
    if (target.keyIndex === 0) { const e = new Error("boom"); e.status = 500; throw e; }
    return "done";
  };
  const cooldownFor = (target) => (target.keyIndex === 1 ? 10_000 : 0);

  assert.equal(await withOneModel(targets, invoke, { pacer, health, cooldownFor }), "done");
  assert.deepEqual(used, [0, 1]);
  assert.equal(pacer.isReady(targets[0]), true, "key 0 has no pacing cooldown, even after failing");
  assert.equal(pacer.isReady(targets[1]), false, "key 1 has one, so it cools after its (successful) call");
  assert.equal(health.isAvailable(targets[0]), false, "the failed key is cooling in the health registry");
  assert.equal(health.get(health.key(targets[0])).status, "failed");
  assert.equal(pacer.preferredKeyIndex("m"), 1, "the key that answered leads next time");
});

test("OneModelStore: a saved single-model file and an old \"text:0\" cooldown still load", () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "one-model-legacy-")), "o.json");
  fs.writeFileSync(file, JSON.stringify({ version: 1, enabled: true, provider: "groq", model: "m1", cooldowns: { "text:0": 5000 } }));
  const store = new OneModelStore({ file });
  assert.deepEqual(store.active(), { provider: "groq", models: ["m1"] });
  assert.equal(store.cooldownFor({ model: "m1", keyIndex: 0 }), 5000);
});

test("normalizeKeyId: the canonical \"model::N\" id is kept and every legacy spelling migrates to it", () => {
  const models = ["m1", "m2"];
  assert.equal(normalizeKeyId("m1::0", models), "m1::0");
  assert.equal(normalizeKeyId("m2::12", models), "m2::12");
  assert.equal(normalizeKeyId("m1::text:0", models), "m1::0", "two-pool text id");
  assert.equal(normalizeKeyId("m1::vision:3", models), "m1::3", "two-pool vision id");
  assert.equal(normalizeKeyId("text:1", models), "m1::1", "oldest bare id names the first model");
  assert.equal(normalizeKeyId("text:1", []), null, "a bare id needs a model to belong to");
  for (const bad of ["", "0", "m1::", "m1::x", "text:x", null, undefined]) {
    assert.equal(normalizeKeyId(bad, models), null, `${String(bad)} is not a key id`);
  }
});

test("OneModelStore: a version 2 pooled cooldown file migrates to model::N ids, keeping the longer pause, and is rewritten as version 3", () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "one-model-v2-")), "o.json");
  fs.writeFileSync(file, JSON.stringify({
    version: 2, enabled: true, provider: "groq", models: ["m1", "m2"],
    cooldowns: { "m1::text:0": 600, "m1::vision:0": 900, "m2::text:1": 100, "gone::text:0": 500 }
  }));
  const store = new OneModelStore({ file });
  // text:0 and vision:0 now name the same key; a model that is no longer listed is dropped.
  assert.deepEqual(store.getCooldowns(), { "m1::0": 900, "m2::1": 100 });

  assert.equal(store.set({ cooldowns: { "m2::0": 50 } }), true);
  const saved = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(saved.version, 3);
  assert.deepEqual(saved.cooldowns, { "m1::0": 900, "m2::1": 100, "m2::0": 50 });
});

test("withOneModel: model 1 leads, the next model is used when its keys fail or cool, and it is back on model 1 afterwards", async () => {
  const pacer = new KeyPacer();
  const targets = ["m1", "m2", "m3"].flatMap((model) => [0, 1].map((keyIndex) => ({ provider: "p", model, keyIndex })));
  const used = [];
  let m1Up = false;
  const invoke = async (target) => {
    used.push(`${target.model}:${target.keyIndex}`);
    if (target.model === "m1" && !m1Up) { const e = new Error("boom"); e.status = 500; throw e; }
    if (target.model === "m2") { const e = new Error("boom"); e.status = 500; throw e; }
    return target.model;
  };
  const run = () => withOneModel(targets, invoke, { pacer, models: ["m1", "m2", "m3"] });

  assert.equal(await run(), "m3");
  assert.deepEqual(used, ["m1:0", "m1:1", "m2:0", "m2:1", "m3:0"], "model by model, key by key, in order");
  used.length = 0;
  m1Up = true;
  assert.equal(await run(), "m1", "every request starts from model 1 again");
  assert.deepEqual(used, ["m1:0"]);
});

test("withOneModel: a model with every key cooling is passed over, and the request waits only when all models are cooling", async () => {
  const pacer = new KeyPacer();
  const targets = ["m1", "m2"].flatMap((model) => [0, 1].map((keyIndex) => ({ provider: "p", model, keyIndex })));
  const used = [];
  const invoke = async (target) => { used.push(`${target.model}:${target.keyIndex}`); return "ok"; };
  const options = { pacer, models: ["m1", "m2"], cooldownFor: () => 400 };

  for (let i = 0; i < 4; i += 1) await withOneModel(targets, invoke, options);
  assert.deepEqual(used, ["m1:0", "m1:1", "m2:0", "m2:1"], "m1's keys cooled, so the third and fourth went to m2");
  used.length = 0;
  const startedAt = Date.now();
  await withOneModel(targets, invoke, options);
  assert.ok(Date.now() - startedAt >= 200, "everything was cooling, so it waited");
  assert.equal(used.length, 1);
  assert.match(used[0], /^m1:/, "and the first cooldown to end was one of model 1's keys, not model 2's");
});

test("withOneModel: keys that failed and have a cooldown are tried again once it is over; keys without one are not", async () => {
  const targets = [0, 1].map((keyIndex) => ({ provider: "p", model: "m1", keyIndex }));
  let calls = 0;
  const invoke = async () => { calls += 1; if (calls <= 2) { const e = new Error("boom"); e.status = 500; throw e; } return "ok"; };
  const withCooldown = await withOneModel(targets, invoke, { pacer: new KeyPacer(), models: ["m1"], cooldownFor: () => 150 });
  assert.equal(withCooldown, "ok", "after both keys failed it waited for the first cooldown and retried");
  assert.equal(calls, 3);

  calls = 0;
  await assert.rejects(
    withOneModel(targets, invoke, { pacer: new KeyPacer(), models: ["m1"] }),
    (error) => error.status === 502 && error.errorType === "one_model_failed",
    "no cooldown: each key once, then the request fails at once"
  );
  assert.equal(calls, 2);
});

test("one provider: model 1 fails, model 2 answers; the next request starts from model 1 again", async () => {
  const { router, groq, mistral, stop } = await start({
    groqModels: "m1,m3",
    groqScript: (record) => (record.body?.model === "m1" ? down : ok("m3"))
  });
  try {
    assert.equal((await setOneModel(router, { enabled: true, provider: "groq", models: ["m1", "m3"] })).status, 200);
    assert.equal((await chat(router)).status, 200);
    assert.equal((await chat(router)).status, 200);
    const seen = posts(groq).map((record) => `${record.body.model}:${/g0/.test(authOf(record)) ? 0 : 1}`);
    assert.deepEqual(seen, ["m1:0", "m1:1", "m3:0", "m3:0"], "m1's keys failed, so they are cooling and the second request goes straight to m3");
    assert.equal(posts(mistral).length, 0, "no other provider is ever used");
  } finally { await stop(); }
});

test("one provider: a model whose keys are all cooling is skipped without waiting, then used again once they are ready", async () => {
  const { router, groq, stop } = await start({ groqModels: "m1,m3", groqScript: (record) => ok(record.body?.model) });
  try {
    const cooldowns = { "m1::0": 600, "m1::1": 600 };
    assert.equal((await setOneModel(router, { enabled: true, provider: "groq", models: ["m1", "m3"], cooldowns })).status, 200);
    const startedAt = Date.now();
    for (let i = 0; i < 3; i += 1) assert.equal((await chat(router)).status, 200);
    assert.ok(Date.now() - startedAt < 400, "nobody waited: model 3 took over");
    assert.deepEqual(posts(groq).map((record) => record.body.model), ["m1", "m1", "m3"]);

    await new Promise((resolve) => setTimeout(resolve, 700));
    assert.equal((await chat(router)).status, 200);
    assert.equal(posts(groq).at(-1).body.model, "m1", "model 1's cooldown is over, so it leads again");
  } finally { await stop(); }
});

test("one provider: when every key of every model fails, the request keeps waiting and calls nothing while they cool", async () => {
  const { router, groq, stop } = await start({ groqModels: "m1,m3", groqScript: () => down });
  try {
    assert.equal((await setOneModel(router, { enabled: true, provider: "groq", models: ["m1", "m3"] })).status, 200);
    const res = await chatFor(router, 1500);
    assert.equal(res.aborted, true, "the request is still waiting, not failed");
    assert.equal(posts(groq).length, 4, "each key was tried once and none was called again while cooling");
  } finally { await stop(); }
});

test("one provider API: models are ordered, ranked, validated, and dropping a model drops its cooldowns", async () => {
  const { router, dir, stop } = await start({ groqModels: "m1,m3,m4" });
  try {
    assert.equal((await setOneModel(router, { enabled: true, provider: "groq", models: ["m1", "nope"] })).status, 404);
    assert.equal((await setOneModel(router, { enabled: true, provider: "groq", models: [] })).status, 400);
    assert.equal((await setOneModel(router, { enabled: true, provider: "groq", models: [1] })).status, 400);

    const body = await (await setOneModel(router, {
      enabled: true, provider: "groq", models: ["m4", "m1", "m4"],
      cooldowns: { "m4::0": 1000, "m1::1": 2000 }
    })).json();
    assert.deepEqual(body.models, ["m4", "m1"], "duplicates collapse, order kept");
    assert.deepEqual(body.keys.map((key) => [key.model, key.rank, key.keyIndex, key.cooldownMs]),
      [["m4", 1, 0, 1000], ["m4", 1, 1, 0], ["m1", 2, 0, 0], ["m1", 2, 1, 2000]]);
    assert.deepEqual(body.candidates.filter((c) => c.provider === "groq").map((c) => [c.model, c.rank]),
      [["m1", 2], ["m3", null], ["m4", 1]]);
    assert.equal((await setOneModel(router, { cooldowns: { "m3::0": 1000 } })).status, 404, "m3 is not in the list");
    assert.equal((await setOneModel(router, { cooldowns: { "text:0": 3000 } })).status, 200, "an old-style id means the first model");

    const dropped = await (await setOneModel(router, { provider: "groq", models: ["m1"] })).json();
    assert.deepEqual(dropped.keys.map((key) => key.cooldownMs), [0, 2000], "m4's cooldowns went with it");
    const saved = JSON.parse(fs.readFileSync(path.join(dir, "one-model.json"), "utf8"));
    assert.deepEqual(saved.models, ["m1"]);
    assert.deepEqual(saved.cooldowns, { "m1::1": 2000 });
  } finally { await stop(); }
});

test("withOneModel: a key or model cooling in the health registry is never called", async () => {
  const pacer = new KeyPacer();
  const health = new HealthRegistry();
  const targets = [
    { provider: "p", model: "m1", keyIndex: 0, pool: "text" },
    { provider: "p", model: "m1", keyIndex: 1, pool: "text" },
    { provider: "p", model: "m2", keyIndex: 0, pool: "text" }
  ];
  health.markFailure(targets[0], 429, { cooldownMs: 60_000 });
  health.markFailure(targets[1], 429, { cooldownMs: 60_000 });
  const used = [];
  const invoke = async (target) => { used.push(`${target.model}:${target.keyIndex}`); return "done"; };

  assert.equal(await withOneModel(targets, invoke, { pacer, health, models: ["m1", "m2"] }), "done");
  assert.deepEqual(used, ["m2:0"], "both keys of m1 are cooling, so only m2 is called");

  health.markFailure(targets[2], 429, { cooldownMs: 60_000 });
  used.length = 0;
  const gone = () => { const e = new Error("Client disconnected"); e.status = 499; e.retryable = false; return e; };
  const until = Date.now() + 300;
  await assert.rejects(
    withOneModel(targets, invoke, { pacer, health, models: ["m1", "m2"], checkpoint: () => { if (Date.now() > until) throw gone(); } }),
    (error) => error.status === 499
  );
  assert.deepEqual(used, [], "nothing is called while everything is cooling, and it kept waiting until the client left");

});

test("withOneModel: a 503 puts the key in cooldown, so the next request does not call it", async () => {
  const pacer = new KeyPacer();
  const health = new HealthRegistry();
  const targets = [
    { provider: "p", model: "m1", keyIndex: 0, pool: "text" },
    { provider: "p", model: "m2", keyIndex: 0, pool: "text" }
  ];
  const used = [];
  const invoke = async (target) => {
    used.push(target.model);
    if (target.model === "m1") { const e = new Error("unavailable"); e.status = 503; throw e; }
    return "done";
  };
  const run = () => withOneModel(targets, invoke, { pacer, health, models: ["m1", "m2"] });

  assert.equal(await run(), "done");
  assert.deepEqual(used, ["m1", "m2"], "m1 fails with 503, m2 answers");
  assert.equal(health.isAvailable(targets[0]), false, "m1's key is now cooling");

  used.length = 0;
  assert.equal(await run(), "done");
  assert.deepEqual(used, ["m2"], "m1 is cooling, so it is not called");
});

test("withOneModel: every failing status cools the key, so the next request does not call it", async () => {
  for (const status of [429, 500, 502, 504, 408, 401, 0]) {
    const pacer = new KeyPacer();
    const health = new HealthRegistry();
    const targets = ["m1", "m2"].map((model) => ({ provider: "p", model, keyIndex: 0, pool: "text" }));
    const used = [];
    const invoke = async (target) => {
      used.push(target.model);
      if (target.model === "m1") { const e = new Error("fail"); e.status = status; throw e; }
      return "done";
    };
    const options = { pacer, health, models: ["m1", "m2"] };
    await withOneModel(targets, invoke, options);
    used.length = 0;
    await withOneModel(targets, invoke, options);
    assert.deepEqual(used, ["m2"], `status ${status}: m1 is cooling and is not called`);
  }
});

test("withOneModel: every key cooling means waiting for the first cooldown and trying again, round after round", async () => {
  const pacer = new KeyPacer();
  const health = new HealthRegistry();
  const targets = [0, 1].map((keyIndex) => ({ provider: "p", model: "m1", keyIndex, pool: "text" }));
  let calls = 0;
  const invoke = async () => { calls += 1; if (calls <= 4) { const e = new Error("down"); e.status = 503; throw e; } return "ok"; };
  // a short pacing cooldown, so several rounds fit in the test
  const cooldownFor = () => 100;
  const startedAt = Date.now();
  assert.equal(await withOneModel(targets, invoke, { pacer, health, models: ["m1"], cooldownFor }), "ok");
  assert.equal(calls, 5, "two keys, two rounds of failures, then an answer: it never gave up");
  assert.ok(Date.now() - startedAt >= 200, "it waited for the cooldowns");
});

test("withOneModel: a cooldown is the operator's time plus 1%, after a success and after a failure alike", async () => {
  const pacer = new KeyPacer();
  const health = new HealthRegistry();
  const ok1 = { provider: "p", model: "m1", keyIndex: 0, pool: "text" };
  const bad = { provider: "p", model: "m2", keyIndex: 0, pool: "text" };
  const invoke = async (target) => { if (target === bad) { const e = new Error("x"); e.status = 500; throw e; } return "ok"; };
  const before = Date.now();
  await withOneModel([ok1], invoke, { pacer, health, cooldownFor: () => 60_000 });
  const okLeft = pacer.readyAt(ok1) - before;
  assert.ok(okLeft >= 60_600 && okLeft < 60_700, `success: 1 minute set cools 1.01 minutes (${okLeft} ms)`);
  assert.equal(health.isAvailable(ok1), true, "a success adds no health cooldown");

  const before2 = Date.now();
  const blocked = withOneModel([bad], invoke, { pacer, health, cooldownFor: () => 60_000, checkpoint: () => { if (Date.now() - before2 > 150) { const e = new Error("gone"); e.retryable = false; throw e; } } });
  await assert.rejects(blocked, /gone/);
  const badLeft = pacer.readyAt(bad) - before2;
  assert.ok(badLeft >= 60_600 && badLeft < 60_700, `failure: the same 1.01 minutes (${badLeft} ms)`);
  assert.equal(health.isAvailable(bad), true, "with a cooldown set the failure adds no second one");
});

test("withOneModel: with no cooldown set a success is not paced and a failure cools the key for 5 minutes", async () => {
  const pacer = new KeyPacer();
  const health = new HealthRegistry();
  const bad = { provider: "p", model: "m1", keyIndex: 0, pool: "text" };
  const good = { provider: "p", model: "m1", keyIndex: 1, pool: "text" };
  let failBad = true;
  const invoke = async (target) => { if (target === bad && failBad) { const e = new Error("x"); e.status = 429; throw e; } return `k${target.keyIndex}`; };
  const run = () => withOneModel([bad, good], invoke, { pacer, health, models: ["m1"] });

  assert.equal(await run(), "k1", "key 0 fails, key 1 answers");
  const left = health.get(health.key(bad)).cooldownUntil - Date.now();
  assert.ok(left > 299_000 && left <= 300_000, `the failed key cools 5 minutes (${left} ms)`);
  assert.equal(pacer.isReady(good), true, "the key that answered is not paced");
  assert.equal(await run(), "k1", "the key that answered leads the next request");
  failBad = false;
  assert.equal(await run(), "k1", "the cooling key is not called even though it would work now");
});
