import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ModelConfigError, ModelConfigStore, modelConfigId } from "../src/model-config.js";
import { createModelConfigStorage } from "../src/remote-storage.js";
import { startMockGithub } from "../test-helpers/mock-github.js";

const tmpFile = (name = "model-config.json") => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "model-config-")), name);

const target = (provider, model, extra = {}) => ({
  provider, model, protocols: ["openai-chat"], pool: "text", keyIndex: 0, ...extra
});

const quiet = { warn() {}, error() {} };

test("a declaration is persisted to plain JSON and restored", async () => {
  const file = tmpFile();
  const store = new ModelConfigStore({ file, logger: quiet });

  const created = await store.create({
    provider: "Groq",
    model: "llama-3.3-70b",
    capabilities: ["text_input", "text_output", "tool_calling"],
    metadata: { notes: "primary" }
  }, { knownModels: new Set(["groq/llama-3.3-70b"]) });

  assert.equal(created.entry.provider, "groq", "provider ids are normalized");
  assert.equal(created.entry.id, modelConfigId("groq", "llama-3.3-70b"));

  const document = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(document.version, 1);
  assert.equal(document.models.length, 1);
  assert.equal(document.models[0].model, "llama-3.3-70b");
  assert.equal(JSON.stringify(document).includes("apiKey"), false);

  const reopened = new ModelConfigStore({ file, logger: quiet });
  assert.equal(reopened.list().length, 1);
  assert.deepEqual(reopened.list()[0].capabilities, ["text_input", "text_output", "tool_calling"]);
});

test("writing is atomic and a corrupt local file is ignored, not fatal", async () => {
  const file = tmpFile();
  fs.writeFileSync(file, "{ not json");
  const store = new ModelConfigStore({ file, logger: quiet });
  assert.equal(store.list().length, 0);
  assert.match(store.warnings[0], /Ignored/);

  await store.create({ provider: "groq", model: "m", capabilities: ["text_input"] }, { knownModels: new Set(["groq/m"]) });
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).models.length, 1);
  assert.equal(fs.readdirSync(path.dirname(file)).some((name) => name.endsWith(".tmp")), false);
});

test("capability declarations are normalized and unknown ids are warned about", async () => {
  const store = new ModelConfigStore({ logger: quiet });
  const { entry, warnings } = await store.create({
    provider: "groq",
    model: "m",
    capabilities: ["streaming", "text_input", "made_up", "streaming"]
  }, { knownModels: new Set(["groq/m"]) });

  assert.deepEqual(entry.capabilities, ["text_input", "streaming"]);
  assert.match(warnings[0], /made_up/);
});

test("identity is immutable and a duplicate model is refused", async () => {
  const store = new ModelConfigStore({ logger: quiet });
  const knownModels = new Set(["groq/m", "groq/other"]);
  const { entry } = await store.create({ provider: "groq", model: "m", capabilities: ["text_input"] }, { knownModels });

  await assert.rejects(
    () => store.update(entry.id, { provider: "groq", model: "other" }),
    (error) => error instanceof ModelConfigError && error.type === "identity_immutable"
  );
  await assert.rejects(
    () => store.create({ provider: "groq", model: "m" }, { knownModels }),
    (error) => error.status === 409 && error.type === "conflict"
  );
});

test("credentials are refused, including token-shaped metadata", async () => {
  const store = new ModelConfigStore({ logger: quiet });
  const knownModels = new Set(["groq/m"]);

  for (const input of [
    { provider: "groq", model: "m", apiKey: "sk-live-abcdef123456" },
    { provider: "groq", model: "m", metadata: { apiKey: "secret" } },
    { provider: "groq", model: "m", metadata: { note: "sk-live-abcdef123456" } },
    { provider: "groq", model: "m", metadata: { note: "Bearer abcdef123456" } }
  ]) {
    await assert.rejects(
      () => store.create(input, { knownModels }),
      (error) => error instanceof ModelConfigError && error.type === "secret_rejected",
      JSON.stringify(input)
    );
  }
  assert.equal(store.list().length, 0);
});

test("an unknown model cannot be declared, so a typo never becomes an invisible entry", async () => {
  const store = new ModelConfigStore({ logger: quiet });
  await assert.rejects(
    () => store.create({ provider: "groq", model: "nope" }, { knownModels: new Set(["groq/m"]) }),
    (error) => error.status === 400 && error.type === "unknown_model"
  );
});

test("the effective index overlays declarations on the environment", () => {
  const store = new ModelConfigStore({ logger: quiet });
  const targets = [
    target("groq", "text-model"),
    target("groq", "text-model", { keyIndex: 1 }),
    target("groq", "vision-model", { pool: "vision" }),
    target("gemini", "flash", { protocols: ["gemini"] })
  ];

  // Before any save: inferred, and a vision-pool model accepts images.
  let index = store.index(targets);
  assert.equal(index.get("groq/text-model").capabilitiesSource, "inferred");
  assert.equal(index.get("groq/text-model").keyCount, 2);
  assert.ok(index.get("groq/vision-model").capabilities.includes("image_input"));
  assert.ok(index.get("gemini/flash").capabilities.includes("image_input") === false);

  // After a save the declaration replaces the inference for that pair only.
  store.entries = [{
    id: modelConfigId("groq", "text-model"),
    provider: "groq",
    model: "text-model",
    displayName: "Text model",
    enabled: false,
    capabilities: ["text_input"],
    protocol: null,
    metadata: {},
    version: 1,
    createdAt: 1,
    updatedAt: 1
  }];
  index = store.index(targets);
  assert.equal(index.get("groq/text-model").capabilitiesSource, "configured");
  assert.deepEqual(index.get("groq/text-model").capabilities, ["text_input"]);
  assert.equal(index.get("groq/text-model").enabled, false);
  assert.equal(store.explicitlyDisabled("groq", "text-model"), true);

  // The other models keep the environment behaviour exactly.
  assert.equal(index.get("groq/vision-model").capabilitiesSource, "inferred");
  assert.equal(index.get("groq/vision-model").enabled, true);
});

test("a declaration whose model is no longer configured stays visible and warns", () => {
  const store = new ModelConfigStore({ logger: quiet });
  store.entries = [{
    id: modelConfigId("groq", "gone"),
    provider: "groq",
    model: "gone",
    displayName: "gone",
    enabled: true,
    capabilities: ["text_input"],
    protocol: null,
    metadata: {},
    version: 1,
    createdAt: 1,
    updatedAt: 1
  }];

  const rows = store.listEffective([]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].configuredInEnvironment, false);
  assert.match(rows[0].warnings.join(" "), /No provider currently configures this model/);
});

test("image input on a text-only model is reported as a routing dead end", () => {
  const store = new ModelConfigStore({ logger: quiet });
  store.entries = [{
    id: modelConfigId("groq", "text-model"),
    provider: "groq",
    model: "text-model",
    displayName: "text-model",
    enabled: true,
    capabilities: ["text_input", "text_output", "image_input"],
    protocol: null,
    metadata: {},
    version: 1,
    createdAt: 1,
    updatedAt: 1
  }];

  const row = store.index([target("groq", "text-model")]).get("groq/text-model");
  assert.match(row.warnings.join(" "), /only in the text pool/);
});

test("declared capabilities no adapter can execute are reported, not silently trusted", () => {
  const store = new ModelConfigStore({ logger: quiet });
  store.entries = [{
    id: modelConfigId("groq", "image-maker"),
    provider: "groq",
    model: "image-maker",
    displayName: "image-maker",
    enabled: true,
    capabilities: ["text_input", "image_output"],
    protocol: null,
    metadata: {},
    version: 1,
    createdAt: 1,
    updatedAt: 1
  }];

  const row = store.index([target("groq", "image-maker")]).get("groq/image-maker");
  assert.deepEqual(row.unsupportedCapabilities, ["image_output"]);
  assert.deepEqual(row.executableCapabilities, ["text_input"]);
  assert.match(row.warnings.join(" "), /No adapter can execute: image_output/);
});

test("a document from a newer schema is refused and never rewritten", () => {
  const store = new ModelConfigStore({ logger: quiet });
  assert.throws(
    () => store.applyDocument({ version: 99, models: [] }),
    (error) => error.status === 409 && error.type === "schema_too_new"
  );
  assert.equal(store.list().length, 0);
});

test("malformed entries are skipped with a warning, the rest of the document is kept", () => {
  const store = new ModelConfigStore({ logger: quiet });
  store.applyDocument({
    version: 1,
    models: [
      { provider: "groq", model: "good", capabilities: ["text_input"] },
      { provider: "", model: "bad" },
      { provider: "groq", model: "good", capabilities: ["text_output"] },
      "not an object"
    ]
  });
  assert.equal(store.list().length, 1);
  assert.equal(store.skipped.length, 3);
});

// ---------------------------------------------------------------------------
// GitHub persistence
// ---------------------------------------------------------------------------

test("the model document is stored as plain JSON in GitHub and survives a fresh container", async () => {
  const github = await startMockGithub();
  const storage = { repo: github.repo, token: github.token, apiBase: github.apiBase, branch: "main", path: "model-config.json" };
  const remote = createModelConfigStorage(storage);
  const firstFile = tmpFile();

  const first = new ModelConfigStore({ file: firstFile, remote, logger: quiet });
  await first.init();
  await first.create({ provider: "groq", model: "m", capabilities: ["text_input", "text_output"] }, {
    knownModels: new Set(["groq/m"])
  });
  assert.deepEqual(first.storageInfo().ready, true);

  const stored = JSON.parse(github.stored("main", "model-config.json"));
  assert.equal(stored.models.length, 1);
  assert.equal(JSON.stringify(stored).includes(github.token), false);
  assert.equal(JSON.stringify(stored).includes("apiKey"), false);

  // A new process with an EMPTY local mirror must adopt the remote document.
  const second = new ModelConfigStore({ file: tmpFile(), remote: createModelConfigStorage(storage), logger: quiet });
  assert.equal(await second.init(), true);
  assert.equal(second.list().length, 1);
  assert.equal(second.list()[0].model, "m");
  await github.close();
});

test("a stale write is refused with 409 instead of overwriting a newer document", async () => {
  const github = await startMockGithub();
  const options = { repo: github.repo, token: github.token, apiBase: github.apiBase, branch: "main", path: "model-config.json" };
  const knownModels = new Set(["groq/a", "groq/b"]);

  const one = new ModelConfigStore({ remote: createModelConfigStorage(options), logger: quiet });
  await one.init();
  await one.create({ provider: "groq", model: "a" }, { knownModels });

  const two = new ModelConfigStore({ remote: createModelConfigStorage(options), logger: quiet });
  await two.init();

  // `one` saves first, moving the document on.
  await one.create({ provider: "groq", model: "b" }, { knownModels });

  // `two` still holds the old revision. Its save MUST fail, not win.
  await assert.rejects(
    () => two.update(two.list()[0].id, { displayName: "stale" }),
    (error) => error.status === 409 && error.type === "conflict"
  );

  const stored = JSON.parse(github.stored("main", "model-config.json"));
  assert.equal(stored.models.length, 2);
  assert.equal(stored.models.find((entry) => entry.model === "a").displayName, "a");
  await github.close();
});

test("an unreachable remote is reported, and a save is refused rather than losing newer data", async () => {
  const github = await startMockGithub();
  const options = { repo: github.repo, token: github.token, apiBase: github.apiBase, branch: "main", path: "model-config.json" };
  const store = new ModelConfigStore({ remote: createModelConfigStorage(options), logger: quiet });

  github.setFailing(true);
  assert.equal(await store.init(), false);
  assert.equal(store.storageInfo().ready, false);
  assert.match(store.storageInfo().error, /HTTP 503|unavailable/);

  await assert.rejects(
    () => store.create({ provider: "groq", model: "m" }, { knownModels: new Set(["groq/m"]) }),
    (error) => error.status === 503 && error.type === "unavailable"
  );
  assert.equal(github.stored("main", "model-config.json"), null);

  github.setFailing(false);
  const created = await store.create({ provider: "groq", model: "m" }, { knownModels: new Set(["groq/m"]) });
  assert.equal(created.entry.model, "m");
  assert.equal(store.storageInfo().ready, true);
  await github.close();
});

test("removing the last declaration restores the environment default", async () => {
  const store = new ModelConfigStore({ logger: quiet });
  const { entry } = await store.create({ provider: "groq", model: "m", enabled: false }, {
    knownModels: new Set(["groq/m"])
  });
  assert.equal(store.explicitlyDisabled("groq", "m"), true);

  await store.remove(entry.id);
  assert.equal(store.list().length, 0);
  assert.equal(store.explicitlyDisabled("groq", "m"), false);
});

test("concurrent saves are serialized, so neither can persist a stale list", async () => {
  const store = new ModelConfigStore({ logger: quiet });
  const knownModels = new Set(["groq/a", "groq/b", "groq/c"]);
  await Promise.all([
    store.create({ provider: "groq", model: "a" }, { knownModels }),
    store.create({ provider: "groq", model: "b" }, { knownModels }),
    store.create({ provider: "groq", model: "c" }, { knownModels })
  ]);
  assert.deepEqual(store.list().map((entry) => entry.model).sort(), ["a", "b", "c"]);
});
