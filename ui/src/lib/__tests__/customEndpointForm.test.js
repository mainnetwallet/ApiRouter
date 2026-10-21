import { describe, expect, it } from "vitest";
import {
  EMPTY_FORM, formFromEndpoint, formProblem, createBody, updateBody, visionSummary
} from "../customEndpointForm.js";

const filled = (over = {}) => ({
  ...EMPTY_FORM, name: "Gw", baseUrl: "https://gw.example.com/v1", models: "m-a, m-b", keys: "k1\nk2", ...over
});

describe("Custom endpoint form: text and vision", () => {
  it("a text-only form is still valid and sends an empty vision part", () => {
    expect(formProblem(filled(), true)).toBeNull();
    expect(createBody(filled())).toMatchObject({
      models: ["m-a", "m-b"], apiKeys: ["k1", "k2"], visionModels: [], visionBaseUrl: "", visionApiKeys: []
    });
  });

  it("vision models are split like text models and use the text keys by default", () => {
    const form = filled({ visionModels: "v-a\nv-b, v-a" });
    expect(formProblem(form, true)).toBeNull();
    expect(createBody(form).visionModels).toEqual(["v-a", "v-b"]);
    expect(createBody(form).visionApiKeys).toEqual([]);
  });

  it("vision models can bring their own base URL and keys", () => {
    const body = createBody(filled({ visionModels: "v", visionBaseUrl: " https://v.example.com/v1 ", visionKeys: "vk1, vk2" }));
    expect(body.visionBaseUrl).toBe("https://v.example.com/v1");
    expect(body.visionApiKeys).toEqual(["vk1", "vk2"]);
  });

  it("needs some model, and a key for every pool it serves", () => {
    expect(formProblem(filled({ models: "", visionModels: "" }), true)).toMatch(/at least one model/i);
    expect(formProblem(filled({ keys: "" }), true)).toMatch(/API key/);
    // Vision only, with no keys at all.
    expect(formProblem(filled({ models: "", visionModels: "v", keys: "" }), true)).toMatch(/vision API keys/i);
    // Vision only, with vision keys of its own.
    expect(formProblem(filled({ models: "", visionModels: "v", keys: "", visionKeys: "vk" }), true)).toBeNull();
  });

  it("editing keeps saved keys unless new ones are typed, and Replace needs new keys", () => {
    const edit = filled({ keys: "", visionModels: "v" });
    expect(formProblem(edit, false)).toBeNull();
    expect(updateBody(edit)).not.toHaveProperty("addApiKeys");
    expect(updateBody(edit)).not.toHaveProperty("addVisionApiKeys");

    expect(updateBody(filled({ keys: "new", visionKeys: "vnew" }))).toMatchObject({ addApiKeys: ["new"], addVisionApiKeys: ["vnew"] });
    expect(updateBody(filled({ keys: "new", replaceKeys: true, visionKeys: "vnew", replaceVisionKeys: true })))
      .toMatchObject({ apiKeys: ["new"], visionApiKeys: ["vnew"] });
    expect(formProblem(filled({ replaceVisionKeys: true }), false)).toMatch(/new vision keys/i);
  });

  it("clearing the vision base URL is sent as an empty string so the server resets it", () => {
    expect(updateBody(filled({ visionModels: "v", visionBaseUrl: "" }))).toHaveProperty("visionBaseUrl", "");
  });

  it("opening an endpoint fills the vision fields and never any keys", () => {
    const form = formFromEndpoint({
      name: "Gw", baseUrl: "https://gw.example.com/v1", protocol: "anthropic", models: ["m"], keyCount: 2,
      visionModels: ["v1", "v2"], visionBaseUrl: "https://v.example.com/v1", visionKeyCount: 1
    });
    expect(form).toMatchObject({ models: "m", visionModels: "v1\nv2", visionBaseUrl: "https://v.example.com/v1", keys: "", visionKeys: "" });
    // An endpoint saved before vision existed has no vision fields at all.
    expect(formFromEndpoint({ name: "Old", baseUrl: "https://a.example.com", protocol: "openai-chat", models: ["m"], keyCount: 1 }))
      .toMatchObject({ visionModels: "", visionBaseUrl: "" });
  });

  it("summarises the vision part for the list", () => {
    expect(visionSummary({ models: ["m"], visionModels: [] })).toBeNull();
    expect(visionSummary({ visionModels: ["v"], visionKeyCount: 0, visionBaseUrl: "" })).toBe("1 vision model · shares the text keys · text base URL");
    expect(visionSummary({ visionModels: ["a", "b"], visionKeyCount: 2, visionBaseUrl: "https://v" })).toBe("2 vision models · 2 own keys · own base URL");
  });
});
