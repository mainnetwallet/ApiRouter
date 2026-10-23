import { describe, expect, it } from "vitest";
import {
  EMPTY_FORM, formFromEndpoint, formProblem, createBody, updateBody
} from "../customEndpointForm.js";

const filled = (over = {}) => ({
  ...EMPTY_FORM, name: "Gw", baseUrl: "https://gw.example.com/v1", models: "m-a, m-b", keys: "k1\nk2", ...over
});

describe("Custom endpoint form", () => {
  it("a valid form sends a clean body", () => {
    expect(formProblem(filled(), true)).toBeNull();
    expect(createBody(filled())).toMatchObject({
      models: ["m-a", "m-b"], apiKeys: ["k1", "k2"]
    });
  });

  it("requires a name", () => {
    expect(formProblem(filled({ name: "" }), true)).toBe("Enter a name.");
  });

  it("requires a base URL", () => {
    expect(formProblem(filled({ baseUrl: "" }), true)).toBe("Enter a base URL.");
  });

  it("requires at least one model", () => {
    expect(formProblem(filled({ models: "" }), true)).toMatch(/at least one model/i);
  });

  it("requires at least one key for a new endpoint", () => {
    expect(formProblem(filled({ keys: "" }), true)).toMatch(/API key/);
  });

  it("editing keeps saved keys unless new ones are typed", () => {
    const edit = filled({ keys: "" });
    expect(formProblem(edit, false)).toBeNull();
    expect(updateBody(edit)).not.toHaveProperty("addApiKeys");
  });

  it("sends new keys when typed, and Replace swaps them", () => {
    expect(updateBody(filled({ keys: "new" }))).toMatchObject({ addApiKeys: ["new"] });
    expect(updateBody(filled({ keys: "new", replaceKeys: true })))
      .toMatchObject({ apiKeys: ["new"] });
  });

  it("formFromEndpoint fills models and leaves keys empty", () => {
    const form = formFromEndpoint({
      name: "Gw", baseUrl: "https://gw.example.com/v1", protocol: "anthropic", models: ["m"], keyCount: 2
    });
    expect(form).toMatchObject({ models: "m", keys: "" });
    expect(formFromEndpoint({ name: "Old", baseUrl: "https://a.example.com", protocol: "openai-chat", models: ["m"], keyCount: 1 }))
      .toMatchObject({ models: "m", keys: "" });
  });
});
