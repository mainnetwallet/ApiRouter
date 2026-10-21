import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { CustomEndpointStore, CustomEndpointError, applyCustomEndpoints, isCustomProviderId } from "../src/custom-endpoints.js";
import { loadConfig, buildTargets } from "../src/config.js";
import { buildUpstreamRequest } from "../src/adapters.js";
import { healthProbePlan } from "../src/health-checks.js";
import { startMockUpstream } from "../test-helpers/mock-upstream.js";
import { startRouter, postJson } from "../test-helpers/router-harness.js";

const publicLookup = async () => [{ address: "93.184.216.34", family: 4 }];
const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "custom-endpoints-")), "custom-endpoints.json");
const sample = (over = {}) => ({
  name: "My Gateway",
  baseUrl: "https://gw.example.com/v1",
  protocol: "openai-chat",
  models: ["m-a", "m-b"],
  apiKeys: ["key-1", "key-2"],
  ...over
});

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

test("create persists the endpoint and never describes its keys", async () => {
  const file = tmpFile();
  const store = new CustomEndpointStore({ file, lookup: publicLookup });
  const created = await store.create(sample());

  assert.equal(created.id, "custom-my-gateway");
  assert.equal(created.keyCount, 2);
  assert.equal(JSON.stringify(created).includes("key-1"), false, "the public view must not carry key material");
  assert.equal(JSON.stringify(store.describeAll()).includes("key-2"), false);

  // A fresh store reads the same endpoint back from disk, keys included.
  const reloaded = new CustomEndpointStore({ file, lookup: publicLookup });
  assert.deepEqual(reloaded.list()[0].apiKeys, ["key-1", "key-2"]);
  assert.deepEqual(reloaded.list()[0].models, ["m-a", "m-b"]);
});

test("models and keys accept newline / comma separated text and are de-duplicated", async () => {
  const store = new CustomEndpointStore({ lookup: publicLookup });
  const created = await store.create(sample({ models: "a, b\nc\na", apiKeys: "k1\nk2,k1" }));
  assert.deepEqual(created.models, ["a", "b", "c"]);
  assert.equal(created.keyCount, 2);
});

test("keys and models also accept comma-joined text with or without spaces", async () => {
  const store = new CustomEndpointStore({ lookup: publicLookup });
  const created = await store.create(sample({ models: "m1,m2, m3;m4", apiKeys: "sk-key1,sk-key2, sk-key3 sk-key4" }));
  assert.deepEqual(created.models, ["m1", "m2", "m3", "m4"]);
  assert.equal(created.keyCount, 4);
  assert.deepEqual(store.get(created.id).apiKeys, ["sk-key1", "sk-key2", "sk-key3", "sk-key4"]);
});

test("two endpoints with the same name get distinct ids", async () => {
  const store = new CustomEndpointStore({ lookup: publicLookup });
  const first = await store.create(sample());
  const second = await store.create(sample());
  assert.notEqual(first.id, second.id);
  assert.ok(isCustomProviderId(second.id));
});

test("update keeps keys unless told otherwise; addApiKeys appends, apiKeys replaces", async () => {
  const store = new CustomEndpointStore({ lookup: publicLookup });
  const { id } = await store.create(sample());

  await store.update(id, { models: ["only-one"] });
  assert.deepEqual(store.get(id).apiKeys, ["key-1", "key-2"]);
  assert.deepEqual(store.get(id).models, ["only-one"]);

  await store.update(id, { addApiKeys: "key-3" });
  assert.deepEqual(store.get(id).apiKeys, ["key-1", "key-2", "key-3"]);

  await store.update(id, { apiKeys: ["fresh"] });
  assert.deepEqual(store.get(id).apiKeys, ["fresh"]);

  await assert.rejects(() => store.update(id, { apiKeys: [] }), /API key is required/);
});

test("remove deletes the endpoint and the file entry", async () => {
  const file = tmpFile();
  const store = new CustomEndpointStore({ file, lookup: publicLookup });
  const { id } = await store.create(sample());
  await store.remove(id);
  assert.equal(store.get(id), null);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")).endpoints, []);
  await assert.rejects(() => store.remove(id), (error) => error instanceof CustomEndpointError && error.status === 404);
});

test("validation: URL shape, protocol, models, keys", async () => {
  const store = new CustomEndpointStore({ lookup: publicLookup });
  await assert.rejects(() => store.create(sample({ baseUrl: "ftp://x.example.com" })), /http/);
  await assert.rejects(() => store.create(sample({ baseUrl: "https://x.example.com/v1?key=abc" })), /query/);
  await assert.rejects(() => store.create(sample({ baseUrl: "https://user:pw@x.example.com" })), /username/);
  await assert.rejects(() => store.create(sample({ protocol: "soap" })), /protocol/);
  await assert.rejects(() => store.create(sample({ models: [] })), /model/i);
  await assert.rejects(() => store.create(sample({ apiKeys: [] })), /API key/);
  await assert.rejects(() => store.create(sample({ name: "  " })), /Name/);
});

test("private and loopback hosts are refused unless the operator allowed them", async () => {
  const strict = new CustomEndpointStore({ lookup: publicLookup });
  await assert.rejects(() => strict.create(sample({ baseUrl: "http://127.0.0.1:11434/v1" })), /private or reserved/);
  await assert.rejects(() => strict.create(sample({ baseUrl: "http://169.254.169.254/latest" })), /private or reserved/);

  // A hostname that RESOLVES to a private address is refused too (checked at save time).
  const rebinding = new CustomEndpointStore({ lookup: async () => [{ address: "10.0.0.5", family: 4 }] });
  await assert.rejects(() => rebinding.create(sample({ baseUrl: "https://innocent.example.com/v1" })), /private or reserved/);

  const lan = new CustomEndpointStore({ allowPrivateHosts: true });
  const ok = await lan.create(sample({ baseUrl: "http://127.0.0.1:11434/v1" }));
  assert.equal(ok.baseUrl, "http://127.0.0.1:11434/v1");
});

test("an unreadable or hand-edited data file never stops startup", () => {
  const file = tmpFile();
  fs.writeFileSync(file, "{ not json");
  assert.deepEqual(new CustomEndpointStore({ file }).list(), []);

  fs.writeFileSync(file, JSON.stringify({ endpoints: [
    { id: "groq", name: "x", baseUrl: "https://a.example.com", protocol: "openai-chat", models: ["m"], apiKeys: ["k"] },
    { id: "custom-ok", name: "ok", baseUrl: "https://a.example.com/v1", protocol: "openai-chat", models: ["m"], apiKeys: ["k"] },
    { id: "custom-bad", name: "bad", baseUrl: "javascript:alert(1)", protocol: "openai-chat", models: ["m"], apiKeys: ["k"] }
  ] }));
  assert.deepEqual(new CustomEndpointStore({ file }).list().map((e) => e.id), ["custom-ok"]);
});

test("onChange fires after every create, update and remove", async () => {
  const store = new CustomEndpointStore({ lookup: publicLookup });
  let calls = 0;
  store.onChange(() => { calls += 1; });
  const { id } = await store.create(sample());
  await store.update(id, { name: "Renamed" });
  await store.remove(id);
  assert.equal(calls, 3);
});

// ---------------------------------------------------------------------------
// Routing integration (config -> targets -> upstream request -> probe)
// ---------------------------------------------------------------------------

test("a saved endpoint becomes one target per model and key, with its own protocol", async () => {
  const store = new CustomEndpointStore({ lookup: publicLookup });
  await store.create(sample());
  const config = loadConfig({ GROQ_API_KEYS: "g", GROQ_MODELS: "m", GROQ_BASE_URL: "https://api.groq.com/openai/v1" });
  applyCustomEndpoints(config, store.list());

  const targets = buildTargets(config.providers).filter((t) => t.provider === "custom-my-gateway");
  assert.equal(targets.length, 4, "2 models x 2 keys");
  assert.deepEqual([...new Set(targets.map((t) => t.model))], ["m-a", "m-b"]);
  assert.deepEqual(targets[0].protocols, ["openai-chat"]);

  // The env providers are untouched.
  assert.ok(buildTargets(config.providers).some((t) => t.provider === "groq"));

  const request = buildUpstreamRequest(targets[0], "openai-chat", { messages: [] });
  assert.equal(request.url, "https://gw.example.com/v1/chat/completions");
  assert.equal(healthProbePlan(targets[0]).url, "https://gw.example.com/v1/models");
});

test("applyCustomEndpoints replaces earlier custom providers instead of piling them up", async () => {
  const store = new CustomEndpointStore({ lookup: publicLookup });
  const { id } = await store.create(sample());
  const config = loadConfig({});
  applyCustomEndpoints(config, store.list());
  await store.remove(id);
  applyCustomEndpoints(config, store.list());
  assert.equal(Object.keys(config.providers).some(isCustomProviderId), false);
});

test("a custom anthropic endpoint sends both x-api-key and Bearer", async () => {
  const store = new CustomEndpointStore({ lookup: publicLookup });
  await store.create(sample({ protocol: "anthropic", baseUrl: "https://api.anthropic.example.com" }));
  const config = loadConfig({});
  applyCustomEndpoints(config, store.list());
  const target = buildTargets(config.providers).find((t) => t.provider === "custom-my-gateway");
  const { url, options } = buildUpstreamRequest(target, "anthropic", { messages: [] });
  assert.equal(url, "https://api.anthropic.example.com/v1/messages");
  assert.equal(options.headers["x-api-key"], "key-1");
  assert.equal(options.headers.authorization, "Bearer key-1");
});

// ---------------------------------------------------------------------------
// End to end: add through the API, route, fall back, survive a restart, remove
// ---------------------------------------------------------------------------

const okBody = (model) => ({ id: "x", object: "chat.completion", model, choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" }] });
const bearer = (record) => String(record.headers.authorization || "").replace(/^Bearer /, "");
const put = (router, url, body, method = "POST") => router.request(url, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const chat = (router) => router.request("/v1/chat/completions", postJson({ model: "anything", messages: [{ role: "user", content: "hello" }] }));

test("e2e: a saved custom endpoint joins the fallback chain with no restart, uses every key, and can be removed", async () => {
  const groq = await startMockUpstream(() => ({ status: 500, body: { error: "down" } }));
  const custom = await startMockUpstream((record) => (bearer(record) === "c0" ? { status: 500, body: { error: "down" } } : { status: 200, body: okBody("cm1") }));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "custom-e2e-"));
  const env = {
    GROQ_API_KEYS: "g0", GROQ_MODELS: "m1", GROQ_BASE_URL: `${groq.baseUrl}/v1`,
    PLAYGROUND_ALLOW_PRIVATE_HOSTS: "1",
    CUSTOM_ENDPOINTS_FILE: path.join(dir, "custom-endpoints.json")
  };
  let router = await startRouter(env);
  try {
    const created = await put(router, "/api/custom-endpoints", {
      name: "Mine", baseUrl: `${custom.baseUrl}/v1`, protocol: "openai-chat", models: ["cm1", "cm2"], apiKeys: ["c0", "c1"]
    });
    assert.equal(created.status, 201);
    const createdBody = await created.json();
    assert.equal(createdBody.endpoint.id, "custom-mine");
    assert.equal(JSON.stringify(createdBody).includes("c0"), false, "keys are never echoed");

    // Visible to the panel as a provider, no restart needed.
    const providers = await (await router.request("/api/providers")).json();
    const row = providers.providers.find((p) => p.id === "custom-mine");
    assert.ok(row, "the custom endpoint is listed as a provider");
    assert.equal(row.custom, true);
    assert.equal(row.targetCount, 4);

    // Put it behind groq in the chain: groq fails, then custom key c0 fails, then c1 answers.
    const saved = await put(router, "/api/fallback", { pool: "text", entries: [
      { provider: "groq", model: "m1" }, { provider: "custom-mine", model: "cm1" }
    ] }, "PUT");
    assert.equal(saved.status, 200, await saved.clone().text());

    const response = await chat(router);
    assert.equal(response.status, 200, await response.clone().text());
    const posts = custom.requests.filter((r) => r.method === "POST").map(bearer);
    assert.deepEqual(posts, ["c0", "c1"], "every key of the custom endpoint is tried, like any provider");

    // The list over the API never carries keys.
    const listed = await (await router.request("/api/custom-endpoints")).text();
    assert.equal(listed.includes("c1"), false);

    // Removal takes effect at once.
    const removed = await router.request("/api/custom-endpoints/custom-mine", { method: "DELETE" });
    assert.equal(removed.status, 200);
    const after = await (await router.request("/api/providers")).json();
    assert.equal(after.providers.some((p) => p.id === "custom-mine"), false);
  } finally {
    await router.close();
  }

  // Permanent: a new process reads the saved endpoint from disk.
  router = await startRouter(env);
  try {
    assert.equal((await put(router, "/api/custom-endpoints", {
      name: "Again", baseUrl: `${custom.baseUrl}/v1`, models: "x", apiKeys: "k"
    })).status, 201);
  } finally {
    await router.close();
  }
  router = await startRouter(env);
  try {
    const listed = await (await router.request("/api/custom-endpoints")).json();
    assert.deepEqual(listed.endpoints.map((e) => e.id), ["custom-again"]);
    const providers = await (await router.request("/api/providers")).json();
    assert.ok(providers.providers.some((p) => p.id === "custom-again"), "restored on startup");
  } finally {
    await router.close(); await groq.close(); await custom.close();
  }
});

test("e2e: API rejects bad input with a clear 400 and an unknown id with 404", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "custom-e2e-"));
  const router = await startRouter({ CUSTOM_ENDPOINTS_FILE: path.join(dir, "ce.json") });
  try {
    const bad = await put(router, "/api/custom-endpoints", { name: "x", baseUrl: "http://127.0.0.1:1/v1", models: "m", apiKeys: "k" });
    assert.equal(bad.status, 400, "loopback is refused without PLAYGROUND_ALLOW_PRIVATE_HOSTS");
    assert.equal((await put(router, "/api/custom-endpoints/custom-nope", { name: "y" }, "PUT")).status, 404);
    assert.equal((await router.request("/api/custom-endpoints/custom-nope", { method: "DELETE" })).status, 404);
  } finally {
    await router.close();
  }
});

// ---------------------------------------------------------------------------
// Vision pool (image requests)
// ---------------------------------------------------------------------------

test("an endpoint without vision models stays text only, as before", async () => {
  const store = new CustomEndpointStore({ lookup: publicLookup });
  const created = await store.create(sample());
  assert.deepEqual(created.visionModels, []);
  assert.equal(created.visionBaseUrl, "");
  assert.equal(created.visionKeyCount, 0);

  const config = loadConfig({});
  applyCustomEndpoints(config, store.list());
  assert.equal(config.visionProviders[created.id], undefined, "no vision entry without vision models");
  assert.equal(buildTargets(config.visionProviders, "vision").some((t) => t.provider === created.id), false);
});

test("vision models share the text base URL and keys unless the endpoint sets its own", async () => {
  const store = new CustomEndpointStore({ lookup: publicLookup });
  const created = await store.create(sample({ visionModels: "v-a\nv-b" }));
  assert.deepEqual(created.visionModels, ["v-a", "v-b"]);
  assert.equal(created.visionKeyCount, 0, "no keys of their own: the text keys are shared");

  const config = loadConfig({});
  applyCustomEndpoints(config, store.list());
  const vision = buildTargets(config.visionProviders, "vision").filter((t) => t.provider === created.id);
  assert.equal(vision.length, 4, "2 vision models x the 2 shared keys");
  assert.ok(vision.every((t) => t.pool === "vision" && t.baseUrl === "https://gw.example.com/v1" && t.id.startsWith("vision:")));
  assert.deepEqual([...new Set(vision.map((t) => t.model))], ["v-a", "v-b"]);
  assert.deepEqual([...new Set(vision.map((t) => t.apiKey))], ["key-1", "key-2"]);

  // The text pool is unchanged: only the text models, none of the vision ones.
  const text = buildTargets(config.providers).filter((t) => t.provider === created.id);
  assert.deepEqual([...new Set(text.map((t) => t.model))], ["m-a", "m-b"]);
});

test("vision models can use their own base URL and keys", async () => {
  const store = new CustomEndpointStore({ lookup: publicLookup });
  const created = await store.create(sample({
    visionModels: ["v-a"], visionBaseUrl: "https://vision.example.com/v1", visionApiKeys: "vk-1, vk-2, vk-3"
  }));
  assert.equal(created.visionBaseUrl, "https://vision.example.com/v1");
  assert.equal(created.visionKeyCount, 3);
  assert.equal(JSON.stringify(created).includes("vk-1"), false, "vision keys are never described");

  const config = loadConfig({});
  applyCustomEndpoints(config, store.list());
  const vision = buildTargets(config.visionProviders, "vision").filter((t) => t.provider === created.id);
  assert.equal(vision.length, 3);
  assert.ok(vision.every((t) => t.baseUrl === "https://vision.example.com/v1"));
  assert.deepEqual(vision.map((t) => t.apiKey), ["vk-1", "vk-2", "vk-3"]);
  // The text pool keeps the text URL and keys.
  const text = buildTargets(config.providers).filter((t) => t.provider === created.id);
  assert.ok(text.every((t) => t.baseUrl === "https://gw.example.com/v1" && t.apiKey.startsWith("key-")));
});

test("a vision-only endpoint is allowed, and routes nothing in the text pool", async () => {
  const store = new CustomEndpointStore({ lookup: publicLookup });
  const created = await store.create(sample({ models: [], visionModels: ["v-only"] }));
  const config = loadConfig({});
  applyCustomEndpoints(config, store.list());
  assert.equal(buildTargets(config.providers).some((t) => t.provider === created.id), false);
  assert.equal(buildTargets(config.visionProviders, "vision").filter((t) => t.provider === created.id).length, 2);
});

test("vision validation: some model is required, and every pool needs a key", async () => {
  const store = new CustomEndpointStore({ lookup: publicLookup });
  await assert.rejects(() => store.create(sample({ models: [], visionModels: [] })), /model/i);
  await assert.rejects(() => store.create(sample({ visionBaseUrl: "javascript:alert(1)", visionModels: ["v"] })), (e) => e.status === 400);
  // Vision-only, no keys of any kind.
  await assert.rejects(() => store.create(sample({ models: [], apiKeys: [], visionModels: ["v"] })), /API key.*vision/i);
  // Vision-only, but with keys of its own: fine.
  const ok = await store.create(sample({ name: "Own keys", models: [], apiKeys: [], visionModels: ["v"], visionApiKeys: ["vk"] }));
  assert.equal(ok.visionKeyCount, 1);
});

test("update adds, changes and removes the vision part; omitted fields are kept", async () => {
  const store = new CustomEndpointStore({ lookup: publicLookup });
  const { id } = await store.create(sample());

  await store.update(id, { visionModels: ["v1"] });
  assert.deepEqual(store.get(id).visionModels, ["v1"]);
  assert.deepEqual(store.get(id).models, ["m-a", "m-b"], "text models untouched");

  await store.update(id, { visionApiKeys: ["vk-1"] });
  await store.update(id, { addVisionApiKeys: ["vk-2", "vk-1"] });
  assert.deepEqual(store.get(id).visionApiKeys, ["vk-1", "vk-2"]);

  await store.update(id, { visionBaseUrl: "https://vision.example.com/v1" });
  assert.equal(store.get(id).visionBaseUrl, "https://vision.example.com/v1");
  await store.update(id, { visionBaseUrl: "" });
  assert.equal(store.get(id).visionBaseUrl, "", "an empty value goes back to the text base URL");

  await store.update(id, { name: "Renamed" });
  assert.deepEqual(store.get(id).visionModels, ["v1"], "an unrelated update keeps the vision part");

  await store.update(id, { visionModels: [] });
  assert.deepEqual(store.get(id).visionModels, []);

  // Dropping the text models of a text-only endpoint would leave nothing to serve.
  await assert.rejects(() => store.update(id, { models: [] }), /model/i);
});

test("the vision part survives a restart, and a pre-vision saved file still loads", async () => {
  const file = tmpFile();
  const store = new CustomEndpointStore({ file, lookup: publicLookup });
  const { id } = await store.create(sample({ visionModels: ["v1"], visionBaseUrl: "https://vision.example.com/v1", visionApiKeys: ["vk"] }));

  const reloaded = new CustomEndpointStore({ file, lookup: publicLookup });
  assert.deepEqual(reloaded.get(id).visionModels, ["v1"]);
  assert.equal(reloaded.get(id).visionBaseUrl, "https://vision.example.com/v1");
  assert.deepEqual(reloaded.get(id).visionApiKeys, ["vk"]);

  const legacy = tmpFile();
  fs.writeFileSync(legacy, JSON.stringify({
    version: 1,
    endpoints: [{ id: "custom-old", name: "Old", baseUrl: "https://a.example.com/v1", protocol: "openai-chat", models: ["m"], apiKeys: ["k"] }]
  }));
  const old = new CustomEndpointStore({ file: legacy, lookup: publicLookup });
  assert.equal(old.list().length, 1);
  assert.deepEqual(old.get("custom-old").visionModels, []);
  assert.equal(old.get("custom-old").visionBaseUrl, "");
});

test("applyCustomEndpoints drops stale custom vision providers too", async () => {
  const store = new CustomEndpointStore({ lookup: publicLookup });
  const { id } = await store.create(sample({ visionModels: ["v1"] }));
  const config = loadConfig({});
  applyCustomEndpoints(config, store.list());
  assert.ok(config.visionProviders[id]);
  await store.update(id, { visionModels: [] });
  applyCustomEndpoints(config, store.list());
  assert.equal(config.visionProviders[id], undefined);
  await store.remove(id);
  applyCustomEndpoints(config, store.list());
  assert.equal(Object.keys(config.visionProviders).some(isCustomProviderId), false);
});

test("e2e: a saved endpoint's vision models serve image requests, text models serve text, with no restart", async () => {
  const groq = await startMockUpstream(() => ({ status: 500, body: { error: "down" } }));
  const textGw = await startMockUpstream(() => ({ status: 200, body: okBody("tm") }));
  const visionGw = await startMockUpstream(() => ({ status: 200, body: okBody("vm") }));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "custom-e2e-vision-"));
  const env = {
    GROQ_API_KEYS: "g0", GROQ_MODELS: "m1", GROQ_BASE_URL: `${groq.baseUrl}/v1`,
    PLAYGROUND_ALLOW_PRIVATE_HOSTS: "1",
    CUSTOM_ENDPOINTS_FILE: path.join(dir, "custom-endpoints.json")
  };
  const image = () => ({
    model: "anything",
    messages: [{ role: "user", content: [{ type: "text", text: "what is this?" }, { type: "image_url", image_url: { url: "data:image/png;base64,iVBORw0KGgo=" } }] }]
  });
  const router = await startRouter(env);
  try {
    // Before the endpoint exists there is no vision route at all.
    const before = await router.request("/v1/chat/completions", postJson(image()));
    assert.equal(before.status, 503);

    const created = await put(router, "/api/custom-endpoints", {
      name: "Both", baseUrl: `${textGw.baseUrl}/v1`, models: ["tm"], apiKeys: ["t0"],
      visionModels: ["vm"], visionBaseUrl: `${visionGw.baseUrl}/v1`, visionApiKeys: ["v0"]
    });
    assert.equal(created.status, 201, await created.clone().text());
    const body = await created.json();
    assert.deepEqual(body.endpoint.visionModels, ["vm"]);
    assert.equal(body.endpoint.visionKeyCount, 1);
    assert.equal(JSON.stringify(body).includes("v0\""), false, "vision keys are never echoed");

    // The panel sees the provider in both pools.
    const providers = await (await router.request("/api/providers")).json();
    const row = providers.providers.find((p) => p.id === "custom-both");
    assert.equal(row.targetCount, 1, "one text target");
    assert.ok(providers.visionProviders.some((p) => p.id === "custom-both" && p.targetCount === 1), "one vision target");

    // Text goes to the text gateway, with the text key.
    const text = await chat(router);
    assert.equal(text.status, 200, await text.clone().text());
    assert.deepEqual(textGw.requests.filter((r) => r.method === "POST").map(bearer), ["t0"]);
    assert.equal(visionGw.requests.filter((r) => r.method === "POST").length, 0, "text never reaches the vision gateway");

    // An image goes to the vision gateway, with the vision key.
    const seen = await router.request("/v1/chat/completions", postJson(image()));
    assert.equal(seen.status, 200, await seen.clone().text());
    assert.deepEqual(visionGw.requests.filter((r) => r.method === "POST").map(bearer), ["v0"]);
    assert.equal(textGw.requests.filter((r) => r.method === "POST").length, 1, "the image never reaches the text gateway");

    // Dropping the vision part takes effect at once.
    const updated = await put(router, "/api/custom-endpoints/custom-both", { visionModels: [] }, "PUT");
    assert.equal(updated.status, 200, await updated.clone().text());
    const gone = await router.request("/v1/chat/completions", postJson(image()));
    assert.equal(gone.status, 503);
    const after = await (await router.request("/api/providers")).json();
    assert.equal(after.visionProviders.some((p) => p.id === "custom-both"), false);
  } finally {
    await router.close(); await groq.close(); await textGw.close(); await visionGw.close();
  }
});
