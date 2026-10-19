import { describe, expect, it, vi } from "vitest";

vi.mock("../client.js", () => ({ apiRequest: vi.fn() }));
import { splitList } from "../customEndpoints.js";

describe("splitList", () => {
  it("splits on newlines and commas, trims and de-duplicates", () => {
    expect(splitList(" a, b\nc\n a ,, ")).toEqual(["a", "b", "c"]);
    expect(splitList("")).toEqual([]);
    expect(splitList("sk-key1,sk-key2")).toEqual(["sk-key1", "sk-key2"]);
    expect(splitList("sk-key1, sk-key2; sk-key3 sk-key4\nsk-key5")).toEqual(["sk-key1", "sk-key2", "sk-key3", "sk-key4", "sk-key5"]);
  });
});
