import { describe, expect, it } from "vitest";
import {
  addEntry, chainSummary, entryId, entryState, filterCatalogue, indexCatalogue,
  keysLabel, latencyOf, moveEntry, phaseLabel, removeEntry, sameChain, setKeys, toEntry, toggleEnabled
} from "../fallbackChain.js";

const group = (provider, model, extra = {}) => ({
  id: `${provider}/${model}`,
  provider,
  model,
  pool: "text",
  // The provider's key inventory, and each key's state — NOT an entry's subset.
  keyIndexes: [0, 1],
  keyStates: [
    { keyIndex: 0, status: "healthy", available: true },
    { keyIndex: 1, status: "cooldown", available: false }
  ],
  available: true,
  status: "healthy",
  ...extra
});

const a = group("a", "m1");
const b = group("b", "m2");
const c = group("c", "m3");

describe("fallback chain editing helpers", () => {
  it("adds without duplicates, reorders and removes", () => {
    const once = addEntry(addEntry([], a), a);
    expect(once).toHaveLength(1);
    expect(entryId(once[0])).toBe("a/m1");
    expect(moveEntry([a, b, c].map(toEntry), 2, 0).map(entryId)).toEqual(["c/m3", "a/m1", "b/m2"]);
    expect(moveEntry([a, b].map(toEntry), 0, 9).map(entryId)).toEqual(["b/m2", "a/m1"]);
    expect(moveEntry([a, b].map(toEntry), 5, 0)).toHaveLength(2);
    expect(removeEntry([a, b, c].map(toEntry), 1).map(entryId)).toEqual(["a/m1", "c/m3"]);
  });

  it("an entry is added enabled, with every key", () => {
    expect(toEntry(a)).toEqual({ provider: "a", model: "m1", keys: null, enabled: true });
  });

  it("disabling keeps the entry, and its position", () => {
    const list = [a, b, c].map(toEntry);
    const off = toggleEnabled(list, 1);
    expect(off).toHaveLength(3);
    expect(off[1]).toMatchObject({ provider: "b", model: "m2", enabled: false });
    expect(off.map(entryId)).toEqual(list.map(entryId), "the saved order is not touched");
    expect(toggleEnabled(off, 1)[1].enabled).toBe(true);
  });

  it("a key selection is sorted and deduplicated, and an empty one means every key", () => {
    const list = [toEntry(a)];
    expect(setKeys(list, 0, [2, 0, 2])[0].keys).toEqual([0, 2]);
    expect(setKeys(list, 0, [])[0].keys).toBeNull();
    // A model narrowed to no keys at all could never be called, so an empty
    // selection must mean "all", never "none".
    expect(setKeys(list, 0, [-1, 1.5, "x"])[0].keys).toBeNull();
  });

  it("sameChain sees order, enablement and key changes, and ignores a re-created list", () => {
    const list = [a, b].map(toEntry);
    expect(sameChain(list, [a, b].map(toEntry))).toBe(true);
    expect(sameChain(list, [b, a].map(toEntry))).toBe(false);
    expect(sameChain(list, [toEntry(a), { ...toEntry(b), enabled: false }])).toBe(false);
    expect(sameChain(list, [toEntry(a), { ...toEntry(b), keys: [0] }])).toBe(false);
    expect(sameChain(list, list.slice(0, 1))).toBe(false);
    expect(sameChain(null, list)).toBe(false);
    // null and [] both mean "every key", so they are the same configuration.
    expect(sameChain([toEntry(a)], [{ provider: "a", model: "m1", keys: [], enabled: true }])).toBe(true);
  });

  it("searches provider and model", () => {
    expect(filterCatalogue([a, b, c], "B/M2")).toEqual([b]);
    expect(filterCatalogue([a, b], "")).toEqual([a, b]);
    expect(filterCatalogue([a, b], "nothing")).toEqual([]);
  });

  it("indexes the catalogue by provider and model", () => {
    const index = indexCatalogue([a, b, null].filter(Boolean));
    expect(index.get("b/m2")).toBe(b);
    expect(index.get("missing")).toBeUndefined();
  });
});

describe("fallback chain presentation", () => {
  it("never shows a latency the router does not have", () => {
    expect(latencyOf(group("a", "m1", { measuredLatencyMs: 120, probeLatencyMs: 900 })))
      .toEqual({ ms: 120, source: "request", label: "measured from requests" });
    expect(latencyOf(group("a", "m1", { measuredLatencyMs: null, probeLatencyMs: 900 })))
      .toEqual({ ms: 900, source: "probe", label: "from the health probe" });
    expect(latencyOf(group("a", "m1", { measuredLatencyMs: null, probeLatencyMs: null })))
      .toEqual({ ms: null, source: null, label: "not measured" });
    expect(latencyOf(undefined)).toEqual({ ms: null, source: null, label: "not measured" });
  });

  it("explains what an entry will actually do", () => {
    expect(entryState(toEntry(a), a).key).toBe("active");
    expect(entryState({ ...toEntry(a), enabled: false }, a).key).toBe("disabled");
    expect(entryState(toEntry(a), undefined).key).toBe("missing");
    // Cooling down wins over "active": the model is configured but not usable.
    expect(entryState(toEntry(a), { ...a, available: false }).key).toBe("cooldown");
  });

  it("describes the key selection in words, not just a count", () => {
    expect(keysLabel({ keys: null }, a)).toBe("all 2 keys");
    expect(keysLabel({ keys: [1] }, a)).toBe("keys 1");
    expect(keysLabel({ keys: [0, 1] }, a)).toBe("keys 0, 1");
    // A stale key index (the provider dropped that key) is not claimed as eligible.
    expect(keysLabel({ keys: [7] }, a)).toBe("no eligible key selected");
    expect(keysLabel({ keys: null }, { keyIndexes: [] })).toBe("no keys configured");
  });

  it("reports the ordering in force without inventing one", () => {
    expect(chainSummary([toEntry(a)], [a], "fixed").source).toBe("chain");
    expect(chainSummary([toEntry(a)], [a], "fixed").label).toBe("Configured order");
    expect(chainSummary([toEntry(a)], [a], "auto").source).toBe("auto");
    // A chain that names nothing this pool serves is not a usable order.
    expect(chainSummary([toEntry(a)], [], "fixed").source).toBe("auto");
    expect(chainSummary([{ ...toEntry(a), enabled: false }], [a], "fixed").source).toBe("auto");
    expect(chainSummary([], [a], "fixed").source).toBe("auto");
  });

  it("uses one vocabulary for the routing phases", () => {
    expect(phaseLabel("sticky")).toBe("Remembered");
    expect(phaseLabel("chain")).toBe("Fallback chain");
    expect(phaseLabel("auto")).toBe("Automatic (health + latency)");
    // The removed systems leave no label behind.
    expect(phaseLabel("priority")).toBeNull();
    expect(phaseLabel("manual")).toBeNull();
    expect(phaseLabel(null)).toBeNull();
  });
});
