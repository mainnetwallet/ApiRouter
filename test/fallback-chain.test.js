import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  FALLBACK_MODES,
  FallbackChainStore,
  allowedKeyIndexes,
  entryId,
  hasLegacyConfig,
  normalizeEntries,
  normalizeEntry,
  normalizeMode,
  parseLegacyPriority,
  readLegacyConfig,
  remembersSuccess
} from "../src/fallback-chain.js";

const tmp = (prefix) => path.join(fs.mkdtempSync(path.join(os.tmpdir(), prefix)), "chain.json");

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

test("an entry keeps its provider and model, lowercasing only the provider", () => {
  assert.deepEqual(normalizeEntry({ provider: "  Gemini ", model: " Model-2 " }), {
    provider: "gemini", model: "Model-2", keys: null, enabled: true
  });
});

test("a malformed entry is dropped rather than guessed at", () => {
  for (const raw of [null, undefined, {}, "gemini/m2", { provider: "gemini" }, { model: "m2" }, { provider: "", model: "" }, 42]) {
    assert.equal(normalizeEntry(raw), null, `${JSON.stringify(raw)} should not normalize`);
  }
});

test("entries are unique by provider and model, in the order given", () => {
  const entries = normalizeEntries([
    { provider: "b", model: "B" },
    { provider: "a", model: "A" },
    { provider: "b", model: "B" },
    { provider: "c", model: "C" }
  ]);
  assert.deepEqual(entries.map(entryId), ["b/B", "a/A", "c/C"]);
});

test("a missing or malformed key list means every key, never a narrower set", () => {
  // Narrowing a model to a subset the operator never chose would silently drop
  // working credentials, so anything unusable is read as "all keys".
  assert.equal(normalizeEntry({ provider: "a", model: "A" }).keys, null);
  assert.equal(normalizeEntry({ provider: "a", model: "A", keys: null }).keys, null);
  assert.equal(normalizeEntry({ provider: "a", model: "A", keys: [] }).keys, null);
  assert.equal(normalizeEntry({ provider: "a", model: "A", keys: "1,2" }).keys, null);
  assert.deepEqual(normalizeEntry({ provider: "a", model: "A", keys: [0, "x", -1, 3.5] }).keys, [0]);
  assert.deepEqual(normalizeEntry({ provider: "a", model: "A", keys: [2, 0, 2] }).keys, [0, 2]);
});

test("enabled defaults to true and survives being switched off", () => {
  assert.equal(normalizeEntry({ provider: "a", model: "A" }).enabled, true);
  assert.equal(normalizeEntry({ provider: "a", model: "A", enabled: false }).enabled, false);
  // Only an explicit `false` disables: a missing flag must not silently park a model.
  assert.equal(normalizeEntry({ provider: "a", model: "A", enabled: 0 }).enabled, true);
});

test("allowedKeyIndexes narrows to the entry's keys, always in key order", () => {
  assert.deepEqual(allowedKeyIndexes({ keys: null }, [2, 0, 1]), [0, 1, 2]);
  assert.deepEqual(allowedKeyIndexes({ keys: [2] }, [2, 0, 1]), [2]);
  // A key the provider no longer has simply contributes nothing.
  assert.deepEqual(allowedKeyIndexes({ keys: [5] }, [0, 1]), []);
});

test("an unknown mode falls back to the default rather than inventing one", () => {
  assert.equal(normalizeMode("AUTO"), FALLBACK_MODES.AUTO);
  assert.equal(normalizeMode(" last-success "), FALLBACK_MODES.LAST_SUCCESS);
  for (const raw of ["nonsense", "", null, undefined, 7, {}]) {
    assert.equal(normalizeMode(raw), FALLBACK_MODES.FIXED);
  }
});

test("only the remembering modes remember a success", () => {
  assert.equal(remembersSuccess(FALLBACK_MODES.FIXED), false);
  assert.equal(remembersSuccess(FALLBACK_MODES.LAST_SUCCESS), true);
  assert.equal(remembersSuccess(FALLBACK_MODES.AUTO), true);
});

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

test("a saved chain and mode survive a restart, and no credential is written", () => {
  const file = tmp("chain-");
  const store = new FallbackChainStore({ file });
  store.set("text", [
    { provider: "gemini", model: "m2", apiKey: "SECRET-KEY" },
    { provider: "groq", model: "m3", keys: [1, 0], enabled: false }
  ]);
  store.set("vision", [{ provider: "gemini", model: "v2" }]);
  store.setMode(FALLBACK_MODES.LAST_SUCCESS);

  const reloaded = new FallbackChainStore({ file });
  assert.equal(reloaded.mode, FALLBACK_MODES.LAST_SUCCESS);
  assert.deepEqual(reloaded.get("text"), [
    { provider: "gemini", model: "m2", keys: null, enabled: true },
    { provider: "groq", model: "m3", keys: [0, 1], enabled: false }
  ]);
  assert.deepEqual(reloaded.get("vision"), [{ provider: "gemini", model: "v2", keys: null, enabled: true }]);
  assert.ok(!fs.readFileSync(file, "utf8").includes("SECRET-KEY"));
});

test("clearing one pool leaves the other pool and the mode alone", () => {
  const file = tmp("chain-clear-");
  const store = new FallbackChainStore({ file });
  store.set("text", [{ provider: "a", model: "A" }]);
  store.set("vision", [{ provider: "b", model: "B" }]);
  store.setMode(FALLBACK_MODES.AUTO);

  store.clear("text");

  const reloaded = new FallbackChainStore({ file });
  assert.deepEqual(reloaded.get("text"), []);
  assert.deepEqual(reloaded.get("vision"), [{ provider: "b", model: "B", keys: null, enabled: true }]);
  assert.equal(reloaded.mode, FALLBACK_MODES.AUTO);
});

test("an unknown pool is refused instead of being created", () => {
  const store = new FallbackChainStore({ file: tmp("chain-pool-") });
  assert.throws(() => store.set("video", []), /unknown pool/);
});

test("a corrupt file is ignored, not fatal, and is left on disk for the operator", () => {
  const file = tmp("chain-corrupt-");
  fs.writeFileSync(file, "{not json");
  const store = new FallbackChainStore({ file });
  assert.deepEqual(store.snapshot(), { mode: FALLBACK_MODES.FIXED, text: [], vision: [] });
  assert.equal(fs.readFileSync(file, "utf8"), "{not json");
});

test("a store with no file still behaves, for tests and embedders", () => {
  const store = new FallbackChainStore({ file: null });
  store.set("text", [{ provider: "a", model: "A" }]);
  assert.equal(store.get("text").length, 1);
  assert.equal(store.persist(), undefined);
});

// ---------------------------------------------------------------------------
// Legacy migration
// ---------------------------------------------------------------------------

test("legacy priority parsing keeps everything after the first slash", () => {
  // Model ids legitimately contain slashes; only the provider is split off.
  assert.deepEqual(parseLegacyPriority("meta/G1, groq/GR2"), [
    { provider: "meta", model: "G1", keys: null, enabled: true },
    { provider: "groq", model: "GR2", keys: null, enabled: true }
  ]);
  assert.deepEqual(parseLegacyPriority("meta/llama/3-70b"), [
    { provider: "meta", model: "llama/3-70b", keys: null, enabled: true }
  ]);
  // Malformed entries are dropped, never guessed at.
  assert.deepEqual(parseLegacyPriority("nope,groq/,/x,,"), []);
});

test("the legacy configuration seeds a chain exactly once, never over a saved one", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chain-migrate-"));
  const file = path.join(dir, "chain.json");
  const manualFile = path.join(dir, "manual.json");
  fs.writeFileSync(manualFile, JSON.stringify({ text: [{ provider: "gemini", model: "m2" }], vision: [] }));

  const migrate = () => readLegacyConfig({
    manualFile,
    env: { TEXT_PRIORITY_MODELS: "groq/m9" }
  });

  const first = new FallbackChainStore({ file, migrate });
  assert.equal(first.migrated, true);
  // Manual entries lead, priority entries not already present follow.
  assert.deepEqual(first.get("text").map(entryId), ["gemini/m2", "groq/m9"]);
  // The seeded mode is what the legacy manual selection actually did.
  assert.equal(first.mode, FALLBACK_MODES.LAST_SUCCESS);

  // The operator then edits the chain. A later start must NOT re-import.
  first.set("text", [{ provider: "groq", model: "only" }]);
  const second = new FallbackChainStore({ file, migrate });
  assert.equal(second.migrated, false);
  assert.deepEqual(second.get("text").map(entryId), ["groq/only"]);
});

test("nothing is seeded when there is no legacy configuration to read", () => {
  const file = tmp("chain-nomigrate-");
  const store = new FallbackChainStore({ file, migrate: () => readLegacyConfig({ manualFile: null, env: {} }) });
  assert.equal(store.migrated, false);
  assert.deepEqual(store.snapshot(), { mode: FALLBACK_MODES.FIXED, text: [], vision: [] });
  assert.equal(fs.existsSync(file), false, "an empty migration must not write a file");
});

test("a legacy read that throws does not stop the gateway from starting", () => {
  const file = tmp("chain-throw-");
  const store = new FallbackChainStore({ file, migrate: () => { throw new Error("boom"); } });
  assert.equal(store.migrated, false);
  assert.deepEqual(store.get("text"), []);
});

test("hasLegacyConfig sees both legacy sources", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chain-legacy-"));
  assert.equal(hasLegacyConfig({ manualFile: null, env: {} }), false);
  assert.equal(hasLegacyConfig({ manualFile: null, env: { TEXT_PRIORITY_MODELS: "a/A" } }), true);
  assert.equal(hasLegacyConfig({ manualFile: null, env: { VISION_PRIORITY_MODELS: "a/A" } }), true);

  const manualFile = path.join(dir, "manual.json");
  fs.writeFileSync(manualFile, JSON.stringify({ text: [{ provider: "a", model: "A" }] }));
  assert.equal(hasLegacyConfig({ manualFile, env: {} }), true);

  fs.writeFileSync(manualFile, JSON.stringify({ text: [] }));
  assert.equal(hasLegacyConfig({ manualFile, env: {} }), false);
});
