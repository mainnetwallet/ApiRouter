import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../client.js", () => ({ apiRequest: vi.fn() }));
import { apiRequest } from "../client.js";
import { saveCustomEndpoint, splitList } from "../customEndpoints.js";

describe("splitList", () => {
  it("splits on newlines and commas, trims and de-duplicates", () => {
    expect(splitList(" a, b\nc\n a ,, ")).toEqual(["a", "b", "c"]);
    expect(splitList("")).toEqual([]);
  });
});

describe("saveCustomEndpoint", () => {
  beforeEach(() => apiRequest.mockReset());

  it("creates a new endpoint the first time", async () => {
    apiRequest.mockResolvedValueOnce({ endpoints: [] }).mockResolvedValueOnce({ ok: true });
    const result = await saveCustomEndpoint({ name: "gw.example.com", baseUrl: "https://gw.example.com/v1", protocol: "openai-chat", model: "m1", apiKey: "k1" });
    expect(result.created).toBe(true);
    expect(apiRequest).toHaveBeenLastCalledWith("/api/custom-endpoints", {
      method: "POST",
      body: { name: "gw.example.com", baseUrl: "https://gw.example.com/v1", protocol: "openai-chat", models: ["m1"], apiKeys: ["k1"] }
    });
  });

  it("saving the same base URL again adds the model and key instead of duplicating", async () => {
    apiRequest
      .mockResolvedValueOnce({ endpoints: [{ id: "custom-gw", baseUrl: "https://gw.example.com/v1/", protocol: "openai-chat", models: ["m1"], keyCount: 1 }] })
      .mockResolvedValueOnce({ ok: true });
    const result = await saveCustomEndpoint({ name: "gw", baseUrl: "https://GW.example.com/v1", protocol: "openai-chat", model: "m2", apiKey: "k2" });
    expect(result.created).toBe(false);
    expect(apiRequest).toHaveBeenLastCalledWith("/api/custom-endpoints/custom-gw", {
      method: "PUT",
      body: { models: ["m1", "m2"], addApiKeys: ["k2"] }
    });
  });

  it("a different API style on the same URL is a separate endpoint", async () => {
    apiRequest
      .mockResolvedValueOnce({ endpoints: [{ id: "custom-gw", baseUrl: "https://gw.example.com/v1", protocol: "openai-chat", models: ["m1"], keyCount: 1 }] })
      .mockResolvedValueOnce({ ok: true });
    const result = await saveCustomEndpoint({ name: "gw", baseUrl: "https://gw.example.com/v1", protocol: "anthropic", model: "m1", apiKey: "k" });
    expect(result.created).toBe(true);
  });

  it("a blank key (local model) is saved as the placeholder \"none\"", async () => {
    apiRequest.mockResolvedValueOnce({ endpoints: [] }).mockResolvedValueOnce({ ok: true });
    await saveCustomEndpoint({ name: "local", baseUrl: "http://localhost:11434/v1", protocol: "openai-chat", model: "llama3", apiKey: "  " });
    expect(apiRequest.mock.calls[1][1].body.apiKeys).toEqual(["none"]);
  });
});
