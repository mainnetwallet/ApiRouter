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
  isKnownMode,
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

test("omitted keys mean every key; a key list that cannot be read means none", () => {
  // The two are deliberately different states, and the difference is what stops
  // a malformed key restriction from silently widening to every key.
  assert.equal(normalizeEntry({ provider: "a", model: "A" }).keys, null, "omitted means unrestricted");
  assert.equal(normalizeEntry({ provider: "a", model: "A", keys: null }).keys, null, "null means unrestricted");

  // Everything else was MEANT as a restriction, so one that cannot be read
  // permits nothing rather than everything.
  const unreadable = [[], "1,2", {}, 1, true, [true], ["1"], [1.5], [null], [""], [-1], [64]];
  for (const keys of unreadable) {
    assert.deepEqual(
      normalizeEntry({ provider: "a", model: "A", keys }).keys,
      [],
      `keys ${JSON.stringify(keys)} must be an unusable restriction, never a free pass`
    );
  }

  // A partly readable list keeps exactly what it could read.
  assert.deepEqual(normalizeEntry({ provider: "a", model: "A", keys: [0, "x", -1, 3.5] }).keys, [0]);
  assert.deepEqual(normalizeEntry({ provider: "a", model: "A", keys: [2, 0, 2] }).keys, [0, 2]);
});

test("an unreadable key restriction permits no key, while the unrestricted form permits every one", () => {
  for (const keys of [[true], ["1"], [], "1"]) {
    const entry = normalizeEntry({ provider: "a", model: "A", keys });
    assert.deepEqual(allowedKeyIndexes(entry, [0, 1, 2]), [], `keys ${JSON.stringify(keys)} must permit nothing`);
  }
  assert.deepEqual(allowedKeyIndexes(normalizeEntry({ provider: "a", model: "A" }), [0, 1, 2]), [0, 1, 2]);
  assert.deepEqual(allowedKeyIndexes(normalizeEntry({ provider: "a", model: "A", keys: [1] }), [0, 1, 2]), [1]);
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
  assert.equal(normalizeMode("MANUAL"), FALLBACK_MODES.MANUAL);
  // The retired ids still resolve, to the mode that replaced them.
  assert.equal(normalizeMode(" last-success "), FALLBACK_MODES.AUTO);
  assert.equal(normalizeMode("fixed"), FALLBACK_MODES.AUTO);
  for (const raw of ["nonsense", "", null, undefined, 7, {}]) {
    assert.equal(normalizeMode(raw), FALLBACK_MODES.AUTO);
  }
});

test("only modes the API knows are accepted, retired ids included", () => {
  for (const raw of ["auto", "AUTO", " manual ", "fixed", "last-success"]) {
    assert.equal(isKnownMode(raw), true, `${JSON.stringify(raw)} must be accepted`);
  }
  for (const raw of ["nonsense", "", null, undefined, 7, {}]) {
    assert.equal(isKnownMode(raw), false, `${JSON.stringify(raw)} must be refused`);
  }
});

test("every mode remembers a success now", () => {
  // Fixed Order and Remember Last Successful were removed as separate modes:
  // whether a selection is saved or not, the last success leads the next request.
  assert.equal(remembersSuccess(FALLBACK_MODES.AUTO), true);
  assert.equal(remembersSuccess(FALLBACK_MODES.MANUAL), true);
  assert.equal(remembersSuccess("fixed"), true);
  assert.equal(remembersSuccess("last-success"), true);
  assert.equal(remembersSuccess(undefined), true);
});

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

test("a saved selection survives a restart, and no credential is written", () => {
  const file = tmp("chain-");
  const store = new FallbackChainStore({ file });
  store.set("text", [
    { provider: "gemini", model: "m2", apiKey: "SECRET-KEY" },
    { provider: "groq", model: "m3", keys: [1, 0], enabled: false }
  ]);
  store.set("vision", [{ provider: "gemini", model: "v2" }]);

  const reloaded = new FallbackChainStore({ file });
  // A saved selection means the pool is walked manually; the mode is derived
  // from the entries, never stored separately.
  assert.equal(reloaded.mode, FALLBACK_MODES.MANUAL);
  assert.deepEqual(reloaded.get("text"), [
    { provider: "gemini", model: "m2", keys: null, enabled: true },
    { provider: "groq", model: "m3", keys: [0, 1], enabled: false }
  ]);
  assert.deepEqual(reloaded.get("vision"), [{ provider: "gemini", model: "v2", keys: null, enabled: true }]);
  assert.ok(!fs.readFileSync(file, "utf8").includes("SECRET-KEY"));
});

test("clearing the last pool returns the router to the automatic order", () => {
  const file = tmp("chain-clear-");
  const store = new FallbackChainStore({ file });
  store.set("text", [{ provider: "a", model: "A" }]);
  store.set("vision", [{ provider: "b", model: "B" }]);
  assert.equal(store.mode, FALLBACK_MODES.MANUAL);

  store.clear("text");
  // One pool still has a selection, so the router is not fully automatic...
  assert.equal(store.mode, FALLBACK_MODES.MANUAL);

  // ...until the last one is cleared, which is what "Automatic" means now.
  store.clear("vision");
  assert.equal(store.mode, FALLBACK_MODES.AUTO);

  const reloaded = new FallbackChainStore({ file });
  assert.deepEqual(reloaded.get("text"), []);
  assert.deepEqual(reloaded.get("vision"), []);
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
  assert.deepEqual(store.snapshot(), { mode: FALLBACK_MODES.AUTO, text: [], vision: [] });
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
  assert.equal(first.mode, FALLBACK_MODES.MANUAL);

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
  assert.deepEqual(store.snapshot(), { mode: FALLBACK_MODES.AUTO, text: [], vision: [] });
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

// ---------------------------------------------------------------------------
// Atomic combined updates
// ---------------------------------------------------------------------------

/** A store whose persistence always fails: its parent path is a regular file. */
function unwritableStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chain-blocked-"));
  const blocker = path.join(dir, "blocker");
  fs.writeFileSync(blocker, "not a directory");
  return new FallbackChainStore({ file: path.join(blocker, "chain.json") });
}

test("a pool update is persisted in a single write, and the mode follows it", () => {
  const file = tmp("chain-atomic-");
  const store = new FallbackChainStore({ file });
  const writes = [];
  const persist = store.persist.bind(store);
  store.persist = (data) => { writes.push(data); return persist(data); };

  store.update({ pool: "text", entries: [{ provider: "a", model: "A" }] });

  // One write. The mode is derived from the entries, so it cannot land on disk
  // separately from the selection it describes.
  assert.equal(writes.length, 1, "an update must persist exactly once");
  assert.deepEqual(writes[0].text.map(entryId), ["a/A"]);

  // And the file agrees with memory: a saved selection reads back as manual.
  const reloaded = new FallbackChainStore({ file });
  assert.equal(reloaded.mode, FALLBACK_MODES.MANUAL);
  assert.deepEqual(reloaded.get("text").map(entryId), ["a/A"]);

  // Clearing the pool writes once more and derives the automatic mode.
  store.update({ pool: "text", entries: [] });
  assert.equal(store.mode, FALLBACK_MODES.AUTO);
  assert.equal(new FallbackChainStore({ file }).mode, FALLBACK_MODES.AUTO);
});

/** The `mode` field as it was actually written, without a store re-deriving it. */
const modeOnDisk = (file) => JSON.parse(fs.readFileSync(file, "utf8")).mode;
const selectionOnDisk = (file, pool) => JSON.parse(fs.readFileSync(file, "utf8"))[pool];

// The mode must be derived from the entries in the SAME write. Deriving it from
// the store's own state instead is not observable through a reload — `apply()`
// re-derives the mode from the entries and ignores the field — so these read the
// file directly. A file whose `mode` contradicts its own selection misleads any
// reader that trusts the field, an older build included.

test("adding the first model writes `manual` to the file, in that same write", () => {
  const file = tmp("chain-mode-on-");
  const store = new FallbackChainStore({ file });
  // Establish the file with nothing selected, so there is a previous mode to
  // get stuck on: without this the first write has no stale value to carry.
  store.update({ pool: "text", entries: [] });
  assert.equal(modeOnDisk(file), FALLBACK_MODES.AUTO, "an empty selection is automatic");

  store.update({ pool: "text", entries: [{ provider: "gemini", model: "model-a" }] });

  assert.equal(modeOnDisk(file), FALLBACK_MODES.MANUAL, "the file must not keep the previous mode");
  assert.deepEqual(selectionOnDisk(file, "text").map(entryId), ["gemini/model-a"]);
  assert.equal(store.mode, FALLBACK_MODES.MANUAL, "and memory agrees with it");
});

test("removing the last model writes `auto` back, in that same write", () => {
  const file = tmp("chain-mode-off-");
  const store = new FallbackChainStore({ file });
  store.update({ pool: "text", entries: [{ provider: "gemini", model: "model-a" }] });
  assert.equal(modeOnDisk(file), FALLBACK_MODES.MANUAL);

  store.update({ pool: "text", entries: [] });

  assert.equal(modeOnDisk(file), FALLBACK_MODES.AUTO, "the file must not keep the previous mode");
  assert.deepEqual(selectionOnDisk(file, "text"), []);
});

test("either pool's selection keeps the file on `manual` until both are empty", () => {
  const file = tmp("chain-mode-pools-");
  const store = new FallbackChainStore({ file });

  // A vision-only selection is still a selection.
  store.update({ pool: "vision", entries: [{ provider: "a", model: "V" }] });
  assert.equal(modeOnDisk(file), FALLBACK_MODES.MANUAL);

  // Clearing vision leaves text selected, so the file stays manual.
  store.update({ pool: "text", entries: [{ provider: "a", model: "T" }] });
  store.update({ pool: "vision", entries: [] });
  assert.equal(modeOnDisk(file), FALLBACK_MODES.MANUAL, "text is still selected");
  assert.deepEqual(selectionOnDisk(file, "vision"), []);

  // Only when both are empty does the file say automatic.
  store.update({ pool: "text", entries: [] });
  assert.equal(modeOnDisk(file), FALLBACK_MODES.AUTO);
});

test("a posted mode is accepted and ignored, so either pool can be left alone", () => {
  const store = new FallbackChainStore({ file: tmp("chain-halves-") });
  store.update({ pool: "text", entries: [{ provider: "a", model: "A" }] });

  // A mode-only update changes nothing: an empty selection is already automatic.
  store.update({ mode: FALLBACK_MODES.AUTO });
  assert.equal(store.mode, FALLBACK_MODES.MANUAL, "the saved pool keeps the router manual");
  assert.deepEqual(store.get("text").map(entryId), ["a/A"]);

  // A pool-only update leaves the other pool's selection untouched.
  store.update({ pool: "vision", entries: [{ provider: "b", model: "B" }] });
  assert.equal(store.mode, FALLBACK_MODES.MANUAL);
  assert.deepEqual(store.get("vision").map(entryId), ["b/B"]);
  assert.deepEqual(store.get("text").map(entryId), ["a/A"]);

  // A retired mode id is accepted too, and equally ignored.
  store.update({ mode: "last-success" });
  assert.deepEqual(store.get("text").map(entryId), ["a/A"]);
});

test("a failed persistence changes neither memory nor the file", () => {
  const store = unwritableStore();
  const before = store.snapshot();
  assert.deepEqual(before, { mode: FALLBACK_MODES.AUTO, text: [], vision: [] });

  // Asserts a FILESYSTEM failure, not merely "something threw": a missing or
  // broken update method would also throw, and would look like a pass.
  let thrown = null;
  try {
    store.update({ pool: "text", entries: [{ provider: "a", model: "A" }] });
  } catch (error) {
    thrown = error;
  }
  assert.ok(thrown, "the write failure must surface");
  assert.equal(typeof thrown.code, "string", `expected a filesystem error, got ${thrown.name}: ${thrown.message}`);

  // Nothing may be applied: not the selection, and so not the derived mode.
  assert.deepEqual(store.snapshot(), before, "memory must be exactly as it was");
  assert.equal(store.mode, FALLBACK_MODES.AUTO);
  assert.deepEqual(store.get("text"), []);
});

test("a failed persistence leaves a previously saved file untouched", () => {
  const file = tmp("chain-keep-");
  const store = new FallbackChainStore({ file });
  store.update({ pool: "text", entries: [{ provider: "a", model: "A" }] });
  const onDisk = fs.readFileSync(file, "utf8");

  // Break persistence, then attempt another update.
  store.file = path.join(path.dirname(file), "blocker", "chain.json");
  fs.writeFileSync(path.join(path.dirname(file), "blocker"), "not a directory");
  assert.throws(() => store.update({ pool: "text", entries: [{ provider: "c", model: "C" }] }));

  assert.equal(store.mode, FALLBACK_MODES.MANUAL, "in-memory mode unchanged");
  assert.deepEqual(store.get("text").map(entryId), ["a/A"], "in-memory selection unchanged");
  assert.equal(fs.readFileSync(file, "utf8"), onDisk, "the saved file is byte-for-byte unchanged");
});

test("set, clear and the legacy setMode all go through the same single write", () => {
  const file = tmp("chain-single-");
  const store = new FallbackChainStore({ file });
  const writes = [];
  const persist = store.persist.bind(store);
  store.persist = (data) => { writes.push(data); return persist(data); };

  store.set("text", [{ provider: "a", model: "A" }]);
  // The retired switch is a no-op that reports the derived mode; it must not
  // write, because there is no separate mode left to persist.
  assert.equal(store.setMode(FALLBACK_MODES.AUTO), FALLBACK_MODES.MANUAL);
  store.clear("text");

  assert.equal(writes.length, 2, "one write per real change");
  assert.deepEqual(store.get("text"), []);
  assert.equal(store.mode, FALLBACK_MODES.AUTO);
  assert.deepEqual(new FallbackChainStore({ file }).snapshot(), { mode: FALLBACK_MODES.AUTO, text: [], vision: [] });
});

test("a key list never invents an index from a value that is not one", () => {
  // `Number(true)` is 1 and `Number("1")` is 1; reading either as "key 1" would
  // be a restriction nobody wrote. The reader refuses to coerce.
  assert.deepEqual(normalizeEntry({ provider: "a", model: "A", keys: [true, "1", 0] }).keys, [0]);
  assert.deepEqual(normalizeEntry({ provider: "a", model: "A", keys: [1, false, "0"] }).keys, [1]);
  // And when coercion was the only thing that could have produced an index,
  // there is no restriction left to honour — which permits nothing, not everything.
  assert.deepEqual(normalizeEntry({ provider: "a", model: "A", keys: [true, "1"] }).keys, []);
});
