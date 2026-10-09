import { describe, expect, it } from "vitest";
import { addEntry, filterAvailable, moveEntry, removeEntry, sameOrder } from "../manualSelection.js";

const a = { provider: "a", model: "m1" };
const b = { provider: "b", model: "m2" };
const c = { provider: "c", model: "m3" };

describe("manual selection helpers", () => {
  it("adds without duplicates, reorders and removes", () => {
    expect(addEntry(addEntry([], a), a)).toEqual([a]);
    expect(moveEntry([a, b, c], 2, 0)).toEqual([c, a, b]);
    expect(moveEntry([a, b], 0, 9)).toEqual([b, a]);
    expect(removeEntry([a, b, c], 1)).toEqual([a, c]);
    expect(sameOrder([a, b], [b, a])).toBe(false);
  });
  it("searches provider and model", () => {
    expect(filterAvailable([a, b, c], "B/M2")).toEqual([b]);
    expect(filterAvailable([a, b], "")).toEqual([a, b]);
  });
});
