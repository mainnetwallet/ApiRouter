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
const modelId = (payload, model) => payload.models.find((row) => row.model === model)?.configId
  ?? payload.models.find((row) => row.model === model)?.id;

const tmpDir = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `model-config-${name}-`));

async function start({ dir, ...env } = {}) {
  const base = dir ?? tmpDir("routing");
  const text = await startMockUpstream(() => ok("text-only"));
  const vision = await startMockUpstream(() => ok("vision-model"));
  const router = await startRouter({
    GROQ_API_KEYS: "g0",
    GROQ_MODELS: "text-only",
    GROQ_BASE_URL: `${text.baseUrl}/v1`,
    GROQ_VISION_API_KEYS: "v0",
    GROQ_VISION_MODELS: "vision-model",
    GROQ_VISION_BASE_URL: `${vision.baseUrl}/v1`,
    MODEL_CONFIG_FILE: path.join(base, "model-config.json"),
    ...env
  });
  return { router, text, vision, base };
}

test("the configurator lists every environment model with provisional capabilities", async () => {
  const { router, text, vision } = await start();
  try {
    const payload = await modelConfig(router);
    assert.equal(payload.available, true);
    assert.equal(payload.summary.total, 2);
    assert.equal(payload.summary.configured, 0);
    assert.equal(payload.summary.environmentOnly, 2);
    assert.equal(payload.schema.version, 1);
    assert.ok(payload.schema.capabilities.some((entry) => entry.id === "image_input"));

    const textModel = payload.models.find((row) => row.model === "text-only");
    const visionModel = payload.models.find((row) => row.model === "vision-model");
    assert.equal(textModel.source, "environment");
    assert.equal(textModel.capabilitiesSource, "inferred");
    assert.ok(textModel.capabilities.includes("text_input"));
    assert.ok(!textModel.capabilities.includes("image_input"));
    assert.deepEqual(textModel.pools, ["text"]);
    assert.ok(visionModel.capabilities.includes("image_input"));
    assert.deepEqual(visionModel.pools, ["vision"]);
    // No credential of any kind may appear in the payload.
    assert.equal(JSON.stringify(payload).includes("g0"), false);
    assert.equal(JSON.stringify(payload).includes("v0"), false);
  } finally {
    await router.close(); await text.close(); await vision.close();
  }
});

test("switching a model off in the configurator takes effect immediately and is mirrored by the switch", async () => {
  const { router, text, vision } = await start();
  try {
    const created = await json(await saveConfig(router, null, {
      provider: "groq",
      model: "text-only",
      enabled: false
    }));
    assert.equal(created.entry.enabled, false);
    assert.deepEqual(created.models.find((row) => row.model === "text-only").pools, ["text"]);

    const refused = await failure(await chat(router));
    assert.equal(refused.status, 503);
    assert.equal(refused.body.error.type, "models_disabled");
    assert.equal(text.apiRequests.length, 0, "a switched-off model is never called");

    // The Models page and the configurator agree: the same model is off there too.
    const models = await json(await router.request("/api/models"));
    assert.equal(models.models.find((row) => row.model === "text-only").disabled, true);

    const id = modelId(created, "text-only");
    await json(await saveConfig(router, id, { enabled: true }));
    assert.equal((await chat(router)).status, 200);
    assert.equal(text.apiRequests.length, 1);
  } finally {
    await router.close(); await text.close(); await vision.close();
  }
});

test("a pinned request remains an explicit one-off when the configurator switched the model off", async () => {
  const { router, text, vision } = await start();
  try {
    await json(await saveConfig(router, null, {
      provider: "groq",
      model: "text-only",
      enabled: false
    }));

    // Ordinary traffic obeys the switch...
    assert.equal((await failure(await chat(router))).body.error.type, "models_disabled");
    assert.equal(text.apiRequests.length, 0);

    // ...while a pin is the documented one-off override, exactly as it is for
    // the Models page switch (both surfaces now own the same flag).
    const pinned = await router.request("/v1/chat/completions", postJson(
      { model: "text-only", messages: [{ role: "user", content: "hello" }] },
      { "x-multi-ai-pin-provider": "groq", "x-multi-ai-pin-key-index": "0" }
    ));
    assert.equal(pinned.status, 200);
    assert.equal(text.apiRequests.length, 1, "the pinned target is reached");
  } finally {
    await router.close(); await text.close(); await vision.close();
  }
});

test("image requests still reach an inferred vision model with no configuration at all", async () => {
  const { router, vision, text } = await start();
  try {
    assert.equal((await imageChat(router)).status, 200);
    assert.equal(vision.apiRequests.length, 1);
  } finally {
    await router.close(); await text.close(); await vision.close();
  }
});

test("a declared vision model without image_input is refused instead of being sent the image", async () => {
  const { router, vision, text } = await start();
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
    assert.equal(refused.body.error.excluded_candidates[0].reason, "capability_not_configured");
    assert.equal(vision.apiRequests.length, 0, "the payload is never sent to a model that cannot carry it");
  } finally {
    await router.close(); await text.close(); await vision.close();
  }
});

test("an audio request with no capable model fails locally, and an explicit model is rejected as a mismatch", async () => {
  const { router, text, vision } = await start();
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
    assert.equal(text.apiRequests.length, 0);
  } finally {
    await router.close(); await text.close(); await vision.close();
  }
});

test("a declaration survives a restart, including its disabled flag", async () => {
  const { router, text, vision, base } = await start();
  await json(await saveConfig(router, null, { provider: "groq", model: "text-only", enabled: false }));
  await router.close();

  const restarted = await startRouter({
    GROQ_API_KEYS: "g0",
    GROQ_MODELS: "text-only",
    GROQ_BASE_URL: `${text.baseUrl}/v1`,
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
    await restarted.close(); await text.close(); await vision.close();
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
    await first.router.close(); await first.text.close(); await first.vision.close();
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
    await second.router.close(); await second.text.close(); await second.vision.close();
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
    await running.router.close(); await running.text.close(); await running.vision.close();
    await github.close();
  }
});
