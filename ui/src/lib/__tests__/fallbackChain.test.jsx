import { describe, expect, it } from "vitest";
import {
  addEntry, chainSummary, eligibleKeys, entryId, entryState, filterCatalogue, indexCatalogue,
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
    // `null` (unrestricted) and `[]` (a restriction that permits no key) are
    // NOT the same configuration: one routes to every key, the other to none.
    expect(sameChain([toEntry(a)], [{ provider: "a", model: "m1", keys: [], enabled: true }])).toBe(false);
    expect(sameChain([{ provider: "a", model: "m1", keys: [], enabled: true }],
      [{ provider: "a", model: "m1", keys: [], enabled: true }])).toBe(true);
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
    // An unreadable key restriction permits no key, so the entry is unusable
    // however healthy the provider is. "Active" here would promise a routing
    // the gateway will refuse.
    const unusable = entryState({ ...toEntry(a), keys: [] }, a);
    expect(unusable.key).toBe("unusable");
    expect(unusable.tone).toBe("danger");
  });

  it("reports a selected key the provider no longer has as unusable, not Active", () => {
    // The selection is non-empty, so a length check would call it a restriction
    // and report a healthy entry — but `a` has only keys 0 and 1, so key 5
    // matches nothing, the planner resolves the entry to zero targets, and the
    // pool fails closed. The panel must not promise that routing.
    const stale = { ...toEntry(a), keys: [5] };
    expect(eligibleKeys(stale, a)).toEqual([]);
    const state = entryState(stale, a);
    expect(state.key).toBe("unusable");
    expect(state.key).not.toBe("active");
    expect(state.label).toMatch(/none of the selected keys exist/);
    expect(keysLabel(stale, a)).toBe("no eligible key selected");

    // A partly stale selection keeps the keys that DO exist.
    expect(eligibleKeys({ ...toEntry(a), keys: [1, 5] }, a)).toEqual([1]);
    expect(entryState({ ...toEntry(a), keys: [1, 5] }, a).key).toBe("active");
  });

  it("resolves eligibility from the provider inventory, not from the selection alone", () => {
    // null is unrestricted: every key the provider has.
    expect(eligibleKeys(toEntry(a), a)).toEqual([0, 1]);
    expect(eligibleKeys({ ...toEntry(a), keys: null }, a)).toEqual([0, 1]);
    // An explicit selection is intersected with that inventory.
    expect(eligibleKeys({ ...toEntry(a), keys: [0] }, a)).toEqual([0]);
    // [] and a stale index both resolve to nothing.
    expect(eligibleKeys({ ...toEntry(a), keys: [] }, a)).toEqual([]);
    expect(eligibleKeys({ ...toEntry(a), keys: [5] }, a)).toEqual([]);
    // A model with no inventory can permit nothing, however the entry is written.
    expect(eligibleKeys(toEntry(a), { ...a, keyIndexes: [] })).toEqual([]);
  });

  it("describes the key selection in words, not just a count", () => {
    expect(keysLabel({ keys: null }, a)).toBe("all 2 keys");
    expect(keysLabel({ keys: [1] }, a)).toBe("keys 1");
    expect(keysLabel({ keys: [0, 1] }, a)).toBe("keys 0, 1");
    // A stale key index (the provider dropped that key) is not claimed as eligible.
    expect(keysLabel({ keys: [7] }, a)).toBe("no eligible key selected");
    expect(keysLabel({ keys: [] }, a)).toBe("no eligible key selected");
    expect(keysLabel({ keys: null }, { keyIndexes: [] })).toBe("no keys configured");
  });

  it("reports the ordering in force without inventing one", () => {
    expect(chainSummary([toEntry(a)], [a], "fixed").source).toBe("chain");
    expect(chainSummary([toEntry(a)], [a], "fixed").label).toBe("Configured order");
    expect(chainSummary([toEntry(a)], [a], "auto").source).toBe("auto");
    expect(chainSummary([], [a], "fixed").source).toBe("auto");
    expect(chainSummary([], [a], "fixed").failClosed).toBe(false);
  });

  it("distinguishes an unconfigured pool from a chain that cannot serve it", () => {
    // Entries that resolve to nothing usable are NOT the same as no chain:
    // the planner fails closed, and the panel must not claim automatic routing.
    const unusable = [
      chainSummary([toEntry(a)], [], "fixed"),
      chainSummary([{ ...toEntry(a), enabled: false }], [a], "fixed"),
      chainSummary([toEntry({ provider: "gone", model: "x" })], [a], "auto")
    ];
    for (const summary of unusable) {
      expect(summary.source).toBe("fail-closed");
      expect(summary.failClosed).toBe(true);
      expect(summary.count).toBe(0);
      expect(summary.label).toMatch(/no entry is usable/);
    }

    // A chain with at least one usable entry routes normally.
    const partly = chainSummary([toEntry(a), { ...toEntry(b), enabled: false }], [a, b], "fixed");
    expect(partly.failClosed).toBe(false);
    expect(partly.count).toBe(1);

    // An entry whose key restriction permits no key is unusable whatever the
    // catalogue says, so a chain made only of those is fail-closed too.
    const noKeys = chainSummary([{ ...toEntry(a), keys: [] }], [a], "fixed");
    expect(noKeys.failClosed).toBe(true);
    expect(noKeys.count).toBe(0);
    // ...but it counts as usable again as soon as one entry permits a key.
    const recovered = chainSummary([{ ...toEntry(a), keys: [] }, toEntry(a)], [a], "fixed");
    expect(recovered.failClosed).toBe(false);
    expect(recovered.count).toBe(1);

    // A non-empty selection naming only keys the provider no longer has is the
    // same situation: zero eligible keys, so the chain cannot serve.
    const stale = chainSummary([{ ...toEntry(a), keys: [5] }], [a], "fixed");
    expect(stale.failClosed).toBe(true);
    expect(stale.resolved ?? stale.count).toBe(0);
    expect(stale.source).toBe("fail-closed");

    // A mixed chain stays usable while ANY enabled entry has an eligible key.
    const mixed = chainSummary([{ ...toEntry(a), keys: [5] }, toEntry(b)], [a, b], "fixed");
    expect(mixed.failClosed).toBe(false);
    expect(mixed.count).toBe(1);
    expect(mixed.source).toBe("chain");

    // A valid restriction is eligible, and a disabled entry never counts.
    expect(chainSummary([{ ...toEntry(a), keys: [1] }], [a], "fixed").failClosed).toBe(false);
    expect(chainSummary([{ ...toEntry(a), keys: [1], enabled: false }], [a], "fixed").failClosed).toBe(true);
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

  it("labels every Manual Model Selection batch distinctly", () => {
    expect(phaseLabel("manual-selection")).toBe("Manual selection");
    expect(phaseLabel("health-fallback")).toBe("Health-based fallback");
    expect(phaseLabel("manual-retry")).toBe("Manual retry");
    expect(phaseLabel("health-retry")).toBe("Health retry");
    const labels = ["manual-selection", "health-fallback", "manual-retry", "health-retry"].map(phaseLabel);
    expect(new Set(labels).size).toBe(4);
    // The new vocabulary does not resurrect the retired "manual" phase id.
    expect(phaseLabel("manual")).toBeNull();
  });
});
