import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startMockUpstream } from "../test-helpers/mock-upstream.js";
import { startMockGithub } from "../test-helpers/mock-github.js";
import { postJson, startRouter } from "../test-helpers/router-harness.js";

const ok = (model) => ({
  status: 200,
  body: {
    id: "x",
    object: "chat.completion",
    model,
    choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" }]
  }
});

const json = async (response) => {
  const text = await response.text();
  assert.ok(response.status >= 200 && response.status < 300, `expected 2xx, got ${response.status}: ${text}`);
  return JSON.parse(text);
};

const failure = async (response) => {
  const text = await response.text();
  assert.ok(response.status >= 400, `expected an error, got ${response.status}: ${text}`);
  return { status: response.status, body: JSON.parse(text) };
};

const chat = (router, body = {}) => router.request("/v1/chat/completions", postJson({
  model: "anything",
  messages: [{ role: "user", content: "hello" }],
  ...body
}));

const imageChat = (router, body = {}) => chat(router, {
  model: "anything",
  messages: [{
    role: "user",
    content: [
      { type: "text", text: "describe" },
      { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }
    ]
  }],
  ...body
});

const audioChat = (router, body = {}) => chat(router, {
  model: "anything",
  messages: [{
    role: "user",
    content: [{ type: "input_audio", input_audio: { format: "wav", data: "AAAA" } }]
  }],
  ...body
});

const saveConfig = (router, id, body) => router.request(
  id ? `/api/model-config/${encodeURIComponent(id)}` : "/api/model-config",
  { method: id ? "PUT" : "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }
);

const modelConfig = (router) => router.request("/api/model-config").then(json);
const putFallback = (router, body) => router.request("/api/fallback", {
  method: "PUT",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body)
});
const modelId = (payload, model) => payload.models.find((row) => row.model === model)?.configId
  ?? payload.models.find((row) => row.model === model)?.id;

const tmpDir = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `model-config-${name}-`));

/**
 * One provider: one base URL, one key list, one model list. There is no second
 * "vision" configuration to set up. Models differ only in what they DECLARE, so
 * a test that needs a second model lists it in GROQ_MODELS and declares (or
 * deliberately does not declare) its capabilities through the configurator.
 *
 * The single upstream answers with the model it was asked for, so a test can
 * tell which model a request was actually sent to.
 */
async function start({ dir, ...env } = {}) {
  const base = dir ?? tmpDir("routing");
  const upstream = await startMockUpstream((record) => ok(record.body?.model ?? "text-only"));
  const router = await startRouter({
    GROQ_API_KEYS: "g0",
    GROQ_MODELS: "text-only",
    GROQ_BASE_URL: `${upstream.baseUrl}/v1`,
    MODEL_CONFIG_FILE: path.join(base, "model-config.json"),
    ...env
  });
  return { router, upstream, base };
}

/** Requests that reached the upstream for one model (the model the router sent). */
const callsTo = (upstream, model) => upstream.apiRequests.filter((record) => record.body?.model === model).length;

test("the configurator lists every environment model with default capabilities and no pool", async () => {
  const { router, upstream } = await start({ GROQ_MODELS: "text-only,vision-model" });
  try {
    const payload = await modelConfig(router);
    assert.equal(payload.available, true);
    assert.equal(payload.summary.total, 2, "both models of the one provider are listed");
    assert.equal(payload.summary.configured, 0);
    assert.equal(payload.summary.environmentOnly, 2);
    assert.equal(payload.schema.version, 1);
    assert.ok(payload.schema.capabilities.some((entry) => entry.id === "image_input"));

    for (const model of ["text-only", "vision-model"]) {
      const row = payload.models.find((entry) => entry.model === model);
      assert.equal(row.source, "environment");
      assert.equal(row.capabilitiesSource, "inferred", "provisional until the operator declares it");
      // A model nobody has declared is text in, text out, streaming and nothing else. Its
      // NAME is never evidence: "vision-model" gets no image_input.
      assert.deepEqual([...row.capabilities].sort(), ["streaming", "text_input", "text_output"], `${model}: defaults only`);
      assert.ok(!("pools" in row), `${model}: a row carries no pool membership`);
    }
    // No credential of any kind may appear in the payload.
    assert.equal(JSON.stringify(payload).includes("g0"), false);
  } finally {
    await router.close(); await upstream.close();
  }
});

test("switching a model off in the configurator takes effect immediately and is mirrored by the switch", async () => {
  const { router, upstream } = await start();
  try {
    const created = await json(await saveConfig(router, null, {
      provider: "groq",
      model: "text-only",
      enabled: false
    }));
    assert.equal(created.entry.enabled, false);
    assert.ok(!("pools" in created.models.find((row) => row.model === "text-only")), "a row carries no pool");

    const refused = await failure(await chat(router));
    assert.equal(refused.status, 503);
    assert.equal(refused.body.error.type, "models_disabled");
    assert.equal(upstream.apiRequests.length, 0, "a switched-off model is never called");

    // The Models page and the configurator agree: the same model is off there too.
    const models = await json(await router.request("/api/models"));
    assert.equal(models.models.find((row) => row.model === "text-only").disabled, true);

    const id = modelId(created, "text-only");
    await json(await saveConfig(router, id, { enabled: true }));
    assert.equal((await chat(router)).status, 200);
    assert.equal(upstream.apiRequests.length, 1);
  } finally {
    await router.close(); await upstream.close();
  }
});

test("the Models page switch updates a declaration, so the two surfaces cannot disagree", async () => {
  const { router, upstream } = await start();
  try {
    await json(await saveConfig(router, null, { provider: "groq", model: "text-only" }));

    const off = await json(await router.request("/api/models/switch", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: "groq", model: "text-only", disabled: true })
    }));
    assert.equal(off.disabled, true);
    let row = (await modelConfig(router)).models.find((model) => model.model === "text-only");
    assert.equal(row.enabledByConfig, false, "the durable declaration is off");
    assert.equal(row.disabledBySwitch, true, "the runtime switch mirrors it");
    assert.equal((await failure(await chat(router))).body.error.type, "models_disabled");
    assert.equal(upstream.apiRequests.length, 0);

    const on = await json(await router.request("/api/models/switch", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: "groq", model: "text-only", disabled: false })
    }));
    assert.equal(on.disabled, false);
    row = (await modelConfig(router)).models.find((model) => model.model === "text-only");
    assert.equal(row.enabledByConfig, true);
    assert.equal(row.disabledBySwitch, false);
    assert.equal((await chat(router)).status, 200);
  } finally {
    await router.close(); await upstream.close();
  }
});

test("a pinned request remains an explicit one-off when the configurator switched the model off", async () => {
  const { router, upstream } = await start();
  try {
    await json(await saveConfig(router, null, {
      provider: "groq",
      model: "text-only",
      enabled: false
    }));

    // Ordinary traffic obeys the switch...
    assert.equal((await failure(await chat(router))).body.error.type, "models_disabled");
    assert.equal(upstream.apiRequests.length, 0);

    // ...while a pin is the documented one-off override, exactly as it is for
    // the Models page switch (both surfaces now own the same flag).
    const pinned = await router.request("/v1/chat/completions", postJson(
      { model: "text-only", messages: [{ role: "user", content: "hello" }] },
      { "x-multi-ai-pin-provider": "groq", "x-multi-ai-pin-key-index": "0" }
    ));
    assert.equal(pinned.status, 200);
    assert.equal(upstream.apiRequests.length, 1, "the pinned target is reached");
  } finally {
    await router.close(); await upstream.close();
  }
});

test("an image request is never sent to an undeclared model, whatever the model is called", async () => {
  const { router, upstream } = await start({ GROQ_MODELS: "text-only,vision-model" });
  try {
    // Nothing declares image_input. "vision-model" is only a name: it earns no
    // capability from it, so the request fails locally and nothing is called.
    const refused = await failure(await imageChat(router));
    assert.equal(refused.status, 503);
    assert.equal(refused.body.error.type, "no_capable_route");
    assert.ok(refused.body.error.required_capabilities.includes("image_input"));
    assert.equal(upstream.apiRequests.length, 0, "no model is called when none can carry the image");
  } finally {
    await router.close(); await upstream.close();
  }
});

test("declaring image_input routes images to that model only, while text may use any model", async () => {
  const { router, upstream } = await start({ GROQ_MODELS: "text-only,vision-model" });
  try {
    await json(await saveConfig(router, null, {
      provider: "groq",
      model: "vision-model",
      capabilities: ["text_input", "text_output", "image_input"]
    }));

    assert.equal((await imageChat(router)).status, 200);
    assert.equal(callsTo(upstream, "vision-model"), 1, "the image went to the declared model");
    assert.equal(callsTo(upstream, "text-only"), 0, "and never to the model that did not declare it");

    // Declaring an extra capability does not take the model out of ordinary
    // text routing: there is one list, so both models are text candidates.
    const before = upstream.apiRequests.length;
    assert.equal((await chat(router)).status, 200);
    assert.equal(upstream.apiRequests.length, before + 1);
  } finally {
    await router.close(); await upstream.close();
  }
});

test("a declared model without image_input is refused instead of being sent the image", async () => {
  const { router, upstream } = await start({ GROQ_MODELS: "text-only,vision-model" });
  try {
    await json(await saveConfig(router, null, {
      provider: "groq",
      model: "vision-model",
      capabilities: ["text_input", "text_output", "streaming"]
    }));

    const refused = await failure(await imageChat(router));
    assert.equal(refused.status, 503);
    assert.equal(refused.body.error.type, "no_capable_route");
    assert.ok(refused.body.error.required_capabilities.includes("image_input"));
    const excluded = refused.body.error.excluded_candidates.find((entry) => entry.model === "vision-model");
    assert.equal(excluded?.reason, "capability_not_configured");
    assert.equal(upstream.apiRequests.length, 0, "the payload is never sent to a model that cannot carry it");
  } finally {
    await router.close(); await upstream.close();
  }
});

const lookupTool = { type: "function", function: { name: "lookup", parameters: { type: "object", properties: {} } } };

async function startSelectionRouter(name) {
  const selected = await startMockUpstream(() => ok("selected"));
  const automatic = await startMockUpstream(() => ok("automatic"));
  const base = tmpDir(name);
  const router = await startRouter({
    GROQ_API_KEYS: "g0",
    GROQ_MODELS: "selected",
    GROQ_BASE_URL: `${selected.baseUrl}/v1`,
    MISTRAL_API_KEYS: "m0",
    MISTRAL_MODELS: "automatic",
    MISTRAL_BASE_URL: `${automatic.baseUrl}/v1`,
    MODEL_CONFIG_FILE: path.join(base, "model-config.json")
  });
  await json(await saveConfig(router, null, {
    provider: "groq",
    model: "selected",
    capabilities: ["text_input", "text_output", "streaming", "structured_output"]
  }));
  await json(await putFallback(router, { entries: [{ provider: "groq", model: "selected" }] }));
  return { router, selected, automatic };
}

test("a capability-incompatible manual selection falls through to eligible unselected models", async () => {
  const { router, selected, automatic } = await startSelectionRouter("capability-fallback");
  try {
    // The unselected model is eligible because it DECLARES tool_calling, not
    // because of anything it is called or which provider it belongs to.
    await json(await saveConfig(router, null, {
      provider: "mistral",
      model: "automatic",
      capabilities: ["text_input", "text_output", "tool_calling"]
    }));

    const response = await chat(router, { tools: [lookupTool] });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-multi-ai-provider"), "mistral");
    assert.equal(selected.apiRequests.length, 0, "the incompatible selected model is never sent the tool call");
    assert.equal(automatic.apiRequests.length, 1, "an eligible unselected model serves the request");
  } finally {
    await router.close(); await selected.close(); await automatic.close();
  }
});

test("an unselected model that has not declared the capability is not a fallback for it", async () => {
  const { router, selected, automatic } = await startSelectionRouter("capability-undeclared");
  try {
    // Neither model declares tool_calling (the second has only the defaults), so
    // nothing is guessed: the request fails locally and no upstream is called.
    const refused = await failure(await chat(router, { tools: [lookupTool] }));
    assert.equal(refused.status, 503);
    assert.equal(refused.body.error.type, "no_capable_route");
    assert.ok(refused.body.error.required_capabilities.includes("tool_calling"));
    assert.equal(selected.apiRequests.length + automatic.apiRequests.length, 0);

    // Plain text is unaffected: the selection still serves it first.
    const plain = await chat(router);
    assert.equal(plain.status, 200);
    assert.equal(plain.headers.get("x-multi-ai-provider"), "groq");
  } finally {
    await router.close(); await selected.close(); await automatic.close();
  }
});

test("an audio request with no capable model fails locally, and an explicit model is rejected as a mismatch", async () => {
  const { router, upstream } = await start();
  try {
    const noRoute = await failure(await audioChat(router));
    assert.equal(noRoute.status, 503);
    assert.equal(noRoute.body.error.type, "no_capable_route");
    assert.ok(noRoute.body.error.required_capabilities.includes("audio_input"));

    const named = await failure(await chat(router, {
      model: "text-only",
      messages: [{ role: "user", content: [{ type: "input_audio", input_audio: { format: "wav", data: "AAAA" } }] }]
    }));
    assert.equal(named.status, 400);
    assert.equal(named.body.error.type, "model_capability_mismatch");
    assert.ok(named.body.error.required_capabilities.includes("audio_input"));
    assert.equal(upstream.apiRequests.length, 0);
  } finally {
    await router.close(); await upstream.close();
  }
});

test("a declaration survives a restart, including its disabled flag", async () => {
  const { router, upstream, base } = await start();
  await json(await saveConfig(router, null, { provider: "groq", model: "text-only", enabled: false }));
  await router.close();

  const restarted = await startRouter({
    GROQ_API_KEYS: "g0",
    GROQ_MODELS: "text-only",
    GROQ_BASE_URL: `${upstream.baseUrl}/v1`,
    MODEL_CONFIG_FILE: path.join(base, "model-config.json")
  });
  try {
    const payload = await modelConfig(restarted);
    const row = payload.models.find((model) => model.model === "text-only");
    assert.equal(row.source, "configured");
    assert.equal(row.enabled, false);
    assert.equal(row.capabilitiesSource, "configured");
    assert.equal((await failure(await chat(restarted))).body.error.type, "models_disabled");
  } finally {
    await restarted.close(); await upstream.close();
  }
});

test("the document is persisted to GitHub, contains no credentials, and is restored by a new container", async () => {
  const github = await startMockGithub();
  const first = await start({
    dir: tmpDir("github-a"),
    MODEL_CONFIG_GITHUB_REPO: github.repo,
    MODEL_CONFIG_GITHUB_TOKEN: github.token,
    MODEL_CONFIG_GITHUB_API: github.apiBase
  });
  try {
    const created = await json(await saveConfig(first.router, null, {
      provider: "groq",
      model: "text-only",
      enabled: false,
      capabilities: ["text_input", "text_output"]
    }));
    assert.equal(created.storage.mode, "github");
    assert.equal(created.storage.ready, true);

    const document = JSON.parse(github.stored("main", "model-config.json"));
    assert.equal(document.models.length, 1);
    assert.deepEqual(document.models[0].capabilities, ["text_input", "text_output"]);
    assert.equal(JSON.stringify(document).includes("g0"), false);
    assert.equal(JSON.stringify(document).includes(github.token), false);
  } finally {
    await first.router.close(); await first.upstream.close();
  }

  // A fresh container: empty local mirror, same repository.
  const second = await start({
    dir: tmpDir("github-b"),
    MODEL_CONFIG_GITHUB_REPO: github.repo,
    MODEL_CONFIG_GITHUB_TOKEN: github.token,
    MODEL_CONFIG_GITHUB_API: github.apiBase
  });
  try {
    const payload = await modelConfig(second.router);
    const row = payload.models.find((model) => model.model === "text-only");
    assert.equal(row.source, "configured");
    assert.equal(row.enabled, false);
    assert.equal((await failure(await chat(second.router))).body.error.type, "models_disabled");
  } finally {
    await second.router.close(); await second.upstream.close();
    await github.close();
  }
});

test("a newer document saved on GitHub is never overwritten with a stale revision", async () => {
  const github = await startMockGithub();
  const running = await start({
    MODEL_CONFIG_GITHUB_REPO: github.repo,
    MODEL_CONFIG_GITHUB_TOKEN: github.token,
    MODEL_CONFIG_GITHUB_API: github.apiBase
  });
  try {
    const created = await json(await saveConfig(running.router, null, { provider: "groq", model: "text-only" }));
    const id = modelId(created, "text-only");

    // Another device commits a newer document behind this instance's back.
    const newer = JSON.stringify({
      version: 1,
      revision: "another-device",
      updatedAt: new Date().toISOString(),
      models: [{
        id: `mc_${"a".repeat(16)}`,
        provider: "groq",
        model: "vision-model",
        displayName: "newer",
        enabled: true,
        capabilities: ["text_input", "text_output", "image_input"]
      }]
    });
    github.files.set("main:model-config.json", {
      content: Buffer.from(newer, "utf8").toString("base64"),
      sha: "external-sha"
    });

    const refused = await failure(await saveConfig(running.router, id, { enabled: false }));
    assert.equal(refused.status, 409);
    assert.equal(refused.body.error.type, "conflict");
    assert.equal(github.stored("main", "model-config.json"), newer, "the newer document is untouched");
  } finally {
    await running.router.close(); await running.upstream.close();
    await github.close();
  }
});
