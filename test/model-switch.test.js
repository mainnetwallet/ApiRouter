import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startMockUpstream } from "../test-helpers/mock-upstream.js";
import { startRouter, postJson } from "../test-helpers/router-harness.js";
import { ModelSwitchStore } from "../src/model-switch.js";

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
const setSwitch = (router, provider, model, disabled) => put(router, "/api/models/switch", { provider, model, disabled });
const saveChain = (router, entries) => put(router, "/api/fallback", { entries });

async function start({ groqScript, mistralScript } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "model-switch-"));
  const groq = await startMockUpstream(groqScript ?? (() => ok("m1")));
  const mistral = await startMockUpstream(mistralScript ?? (() => ok("m2")));
  const router = await startRouter({
    GROQ_API_KEYS: "g0", GROQ_MODELS: "m1", GROQ_BASE_URL: `${groq.baseUrl}/v1`,
    MISTRAL_API_KEYS: "s0", MISTRAL_MODELS: "m2", MISTRAL_BASE_URL: `${mistral.baseUrl}/v1`,
    FALLBACK_CHAIN_FILE: path.join(dir, "fallback-chain.json"),
    DISABLED_MODELS_FILE: path.join(dir, "disabled-models.json")
  });
  const stop = async () => { await router.close(); await groq.close(); await mistral.close(); };
  return { router, groq, mistral, dir, stop };
}

test("automatic mode: a disabled model is never called, and enabling restores it", async () => {
  const { router, groq, mistral, stop } = await start({ groqScript: () => down });
  try {
    // groq is down, so mistral is the fallback. Switch mistral off: nothing is left.
    assert.equal((await setSwitch(router, "mistral", "m2", true)).status, 200);
    const blocked = await chat(router);
    assert.notEqual(blocked.status, 200);
    assert.equal(posts(mistral).length, 0, "a disabled model must not be called, even as the last resort");

    assert.equal((await setSwitch(router, "mistral", "m2", false)).status, 200);
    const restored = await chat(router);
    assert.equal(restored.status, 200);
    assert.equal(posts(mistral).length, 1);
  } finally { await stop(); }
});

test("manual selection: a disabled model leaves both the selected and the health batch", async () => {
  const { router, groq, mistral, stop } = await start({ groqScript: () => down });
  try {
    assert.equal((await saveChain(router, [{ provider: "groq", model: "m1" }])).status, 200);
    // mistral is NOT selected, so it is only reachable through the health batch.
    assert.equal((await chat(router)).status, 200, "unselected mistral is the health-batch fallback");
    const before = posts(mistral).length;
    assert.ok(before >= 1);

    assert.equal((await setSwitch(router, "mistral", "m2", true)).status, 200);
    const res = await chat(router);
    assert.notEqual(res.status, 200, "a disabled model must not come back through the health batch");
    assert.equal(posts(mistral).length, before);
  } finally { await stop(); }
});

test("a request waiting on a model that is switched off fails over to the next model at once", async () => {
  const { router, groq, mistral, stop } = await start({
    groqScript: () => ({ ...ok("m1"), afterMs: 3000 }),
    mistralScript: () => ok("m2")
  });
  try {
    assert.equal((await saveChain(router, [
      { provider: "groq", model: "m1" },
      { provider: "mistral", model: "m2" }
    ])).status, 200);

    const startedAt = Date.now();
    const pending = chat(router);
    // Let the request reach groq and start waiting, then switch groq off.
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.equal(posts(groq).length, 1, "the request is in flight on groq");
    assert.equal((await setSwitch(router, "groq", "m1", true)).status, 200);

    const res = await pending;
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.model, "m2", "the next model answered");
    assert.ok(Date.now() - startedAt < 2500, "it did not wait for the slow model");
    assert.equal(posts(mistral).length, 1);

    // Turning a model off is not a failure: no cooldown, so enabling restores it.
    const models = await (await router.request("/api/models")).json();
    const groqRow = models.models.find((row) => row.provider === "groq");
    assert.equal(groqRow.disabled, true);
    assert.ok(!groqRow.cooldownUntil, "the switched-off model was not put in cooldown");
    assert.notEqual(groqRow.status, "cooldown");

    assert.equal((await setSwitch(router, "groq", "m1", false)).status, 200);
    const again = await (await router.request("/api/models")).json();
    assert.equal(again.models.find((row) => row.provider === "groq").disabled, false);
  } finally { await stop(); }
});

test("the switch API validates input and the state is reported", async () => {
  const { router, dir, stop } = await start();
  try {
    assert.equal((await setSwitch(router, "groq", "no-such-model", true)).status, 404);
    assert.equal((await put(router, "/api/models/switch", { provider: "groq", model: "m1", disabled: "yes" })).status, 400);
    assert.equal((await put(router, "/api/models/switch", { provider: "groq" })).status, 400);

    const res = await setSwitch(router, "groq", "m1", true);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.changed, true);
    assert.deepEqual(body.disabledModels, [{ provider: "groq", model: "m1" }]);

    const fallback = await (await router.request("/api/fallback")).json();
    assert.equal(fallback.catalogue.find((group) => group.provider === "groq").disabled, true);

    const saved = JSON.parse(fs.readFileSync(path.join(dir, "disabled-models.json"), "utf8"));
    assert.deepEqual(saved.disabled, [{ provider: "groq", model: "m1" }]);

    const same = await (await setSwitch(router, "groq", "m1", true)).json();
    assert.equal(same.changed, false, "switching to the state it is already in changes nothing");
  } finally { await stop(); }
});

test("ModelSwitchStore persists, reloads and notifies", () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "model-switch-store-")), "d.json");
  const events = [];
  const store = new ModelSwitchStore({ file });
  store.onChange((event) => events.push(event));

  assert.equal(store.set("Groq", "m1", true), true);
  assert.equal(store.isDisabled("groq", "m1"), true, "provider ids are case-insensitive");
  assert.equal(store.set("groq", "m1", true), false);
  assert.deepEqual(events, [{ provider: "groq", model: "m1", disabled: true }]);

  const reloaded = new ModelSwitchStore({ file });
  assert.equal(reloaded.isDisabled("groq", "m1"), true);
  reloaded.set("groq", "m1", false);
  assert.equal(new ModelSwitchStore({ file }).isDisabled("groq", "m1"), false);
  assert.throws(() => store.set("", "m1", true));
});

const setProviderSwitch = (router, provider, disabled) => put(router, "/api/providers/switch", { provider, disabled });

test("provider switch: a disabled provider's models are out of fallback, and enabling restores them", async () => {
  const { router, groq, mistral, stop } = await start({ groqScript: () => down });
  try {
    // groq is down, so mistral is the fallback. Switch the whole mistral provider off.
    const off = await setProviderSwitch(router, "mistral", true);
    assert.equal(off.status, 200);
    const offBody = await off.json();
    assert.equal(offBody.changed, true);
    assert.deepEqual(offBody.disabledProviders, [{ provider: "mistral" }]);

    const blocked = await chat(router);
    assert.notEqual(blocked.status, 200);
    assert.equal(posts(mistral).length, 0, "a disabled provider must not be called, even as the last resort");

    const providers = await (await router.request("/api/providers")).json();
    assert.equal(providers.providers.find((row) => row.id === "mistral").disabled, true);
    assert.equal(providers.providers.find((row) => row.id === "groq").disabled, false);

    const models = await (await router.request("/api/models")).json();
    const row = models.models.find((model) => model.provider === "mistral");
    assert.equal(row.disabled, true);
    assert.equal(row.providerDisabled, true);

    // Enabling restores the earlier behaviour: nothing was cooled down.
    assert.equal((await setProviderSwitch(router, "mistral", false)).status, 200);
    const restored = await chat(router);
    assert.equal(restored.status, 200);
    assert.equal(posts(mistral).length, 1);
  } finally { await stop(); }
});

test("provider switch: manual selection and the health batch both drop the provider", async () => {
  const { router, mistral, stop } = await start({ groqScript: () => down });
  try {
    assert.equal((await saveChain(router, [{ provider: "groq", model: "m1" }])).status, 200);
    assert.equal((await setProviderSwitch(router, "mistral", true)).status, 200);
    const res = await chat(router);
    assert.notEqual(res.status, 200, "a disabled provider must not come back through the health batch");
    assert.equal(posts(mistral).length, 0);
  } finally { await stop(); }
});

test("provider switch and model switch are independent", async () => {
  const { router, mistral, stop } = await start({ groqScript: () => down });
  try {
    assert.equal((await setSwitch(router, "mistral", "m2", true)).status, 200);
    assert.equal((await setProviderSwitch(router, "mistral", true)).status, 200);
    // Enabling the provider must not undo the model's own switch.
    assert.equal((await setProviderSwitch(router, "mistral", false)).status, 200);
    assert.notEqual((await chat(router)).status, 200);
    assert.equal(posts(mistral).length, 0, "the model's own switch is still off");
    const row = (await (await router.request("/api/models")).json()).models.find((model) => model.provider === "mistral");
    assert.equal(row.disabled, true);
    assert.equal(row.providerDisabled, false);

    assert.equal((await setSwitch(router, "mistral", "m2", false)).status, 200);
    assert.equal((await chat(router)).status, 200);
  } finally { await stop(); }
});

test("a request waiting on a provider that is switched off fails over to the next provider at once", async () => {
  const { router, groq, mistral, stop } = await start({
    groqScript: () => ({ ...ok("m1"), afterMs: 3000 }),
    mistralScript: () => ok("m2")
  });
  try {
    assert.equal((await saveChain(router, [
      { provider: "groq", model: "m1" },
      { provider: "mistral", model: "m2" }
    ])).status, 200);

    const startedAt = Date.now();
    const pending = chat(router);
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.equal(posts(groq).length, 1, "the request is in flight on groq");
    assert.equal((await setProviderSwitch(router, "groq", true)).status, 200);

    const res = await pending;
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.model, "m2");
    assert.ok(Date.now() - startedAt < 2500, "it did not wait for the slow provider");
  } finally { await stop(); }
});

test("the provider switch API validates input and persists", async () => {
  const { router, dir, stop } = await start();
  try {
    assert.equal((await setProviderSwitch(router, "no-such-provider", true)).status, 404);
    assert.equal((await put(router, "/api/providers/switch", { provider: "groq", disabled: "yes" })).status, 400);
    assert.equal((await put(router, "/api/providers/switch", { disabled: true })).status, 400);

    const res = await setProviderSwitch(router, "Groq", true);
    assert.equal(res.status, 200);
    assert.equal((await res.json()).changed, true);
    assert.equal((await (await setProviderSwitch(router, "groq", true)).json()).changed, false);

    const get = await (await router.request("/api/providers/switch")).json();
    assert.deepEqual(get.disabledProviders, [{ provider: "groq" }]);

    const fallback = await (await router.request("/api/fallback")).json();
    const group = fallback.catalogue.find((entry) => entry.provider === "groq");
    assert.equal(group.disabled, true);
    assert.equal(group.providerDisabled, true);

    const saved = JSON.parse(fs.readFileSync(path.join(dir, "disabled-models.json"), "utf8"));
    assert.deepEqual(saved.disabledProviders, ["groq"]);
  } finally { await stop(); }
});

test("ModelSwitchStore: provider switch persists, reloads and notifies", () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "provider-switch-store-")), "d.json");
  const events = [];
  const store = new ModelSwitchStore({ file });
  store.onChange((event) => events.push(event));

  assert.equal(store.setProvider("Groq", true), true);
  assert.equal(store.isProviderDisabled("groq"), true, "provider ids are case-insensitive");
  assert.equal(store.isDisabled("groq", "anything"), true, "every model of the provider is disabled");
  assert.equal(store.isModelDisabled("groq", "anything"), false, "the model's own switch is untouched");
  assert.equal(store.setProvider("groq", true), false);
  assert.deepEqual(events, [{ provider: "groq", model: null, disabled: true, scope: "provider" }]);

  const reloaded = new ModelSwitchStore({ file });
  assert.equal(reloaded.isProviderDisabled("groq"), true);
  reloaded.setProvider("groq", false);
  assert.equal(new ModelSwitchStore({ file }).isDisabled("groq", "anything"), false);
  assert.throws(() => store.setProvider("", true));
});
