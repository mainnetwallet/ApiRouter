import { describe, expect, it } from "vitest";

import {
  buildPinHeaders, buildRequestBody, endpointFor, extractDelta, extractStreamMeta, extractText,
  parseMaxTokens
} from "../playground.js";

/**
 * The playground must not invent a provider-specific request shape: it reuses
 * the same client protocols the gateway's public endpoints expect, and omits
 * `model` entirely for Auto Route so the backend widens the candidate set.
 */
describe("playground request building", () => {
  it("routes gemini through the model path rather than a JSON body field", () => {
    expect(endpointFor("gemini", "gemini-2.0-flash"))
      .toBe("/v1beta/models/gemini-2.0-flash:generateContent");
    expect(endpointFor("anthropic")).toBe("/v1/messages");
    expect(endpointFor("openai-responses")).toBe("/v1/responses");
    expect(endpointFor("openai-chat")).toBe("/v1/chat/completions");
    expect(endpointFor("unknown-protocol")).toBe("/v1/chat/completions");
  });

  it("omits the model entirely when Auto Route is on", () => {
    // This is what makes the gateway choose rather than pin a target.
    const body = buildRequestBody({
      protocol: "openai-chat",
      model: "some-model",
      autoRoute: true,
      prompt: "hi"
    });

    expect(body).not.toHaveProperty("model");
    expect(body.messages.at(-1)).toEqual({ role: "user", content: "hi" });
  });

  it("pins the model when Auto Route is off", () => {
    const body = buildRequestBody({
      protocol: "openai-chat",
      model: "pinned-model",
      autoRoute: false,
      prompt: "hi"
    });

    expect(body.model).toBe("pinned-model");
  });

  it("emits the native shape for each client protocol", () => {
    const anthropic = buildRequestBody({
      protocol: "anthropic", model: "m", autoRoute: false, prompt: "hi", system: "be terse", maxTokens: 256
    });
    expect(anthropic.system).toBe("be terse");
    expect(anthropic.max_tokens).toBe(256);

    const responses = buildRequestBody({
      protocol: "openai-responses", model: "m", autoRoute: false, prompt: "hi", system: "be terse"
    });
    expect(responses.input).toBe("hi");
    expect(responses.instructions).toBe("be terse");

    const gemini = buildRequestBody({
      protocol: "gemini", model: "m", autoRoute: false, prompt: "hi", system: "be terse", temperature: 0.4
    });
    expect(gemini.contents[0].parts[0].text).toBe("hi");
    expect(gemini.systemInstruction.parts[0].text).toBe("be terse");
    expect(gemini.generationConfig.temperature).toBe(0.4);
    // Gemini has no stream flag on generateContent in this shape.
    expect(gemini).not.toHaveProperty("stream");
  });

  it("carries the system prompt as a leading message for chat protocols", () => {
    const body = buildRequestBody({
      protocol: "openai-chat", model: "m", autoRoute: true, prompt: "hi", system: "be terse"
    });

    expect(body.messages[0]).toEqual({ role: "system", content: "be terse" });
  });
});

describe("playground stream parsing", () => {
  it("extracts openai-chat deltas and ignores the sentinel", () => {
    expect(extractDelta("openai-chat", { choices: [{ delta: { content: "Hel" } }] })).toBe("Hel");
    expect(extractDelta("openai-chat", { choices: [{ delta: {} }] })).toBe("");
    expect(extractDelta("openai-chat", null)).toBe("");
  });

  it("extracts anthropic content_block deltas", () => {
    expect(extractDelta("anthropic", { type: "content_block_delta", delta: { text: "Hi" } })).toBe("Hi");
    expect(extractDelta("anthropic", { type: "message_start" })).toBe("");
  });

  it("extracts openai-responses output text deltas", () => {
    expect(extractDelta("openai-responses", { type: "response.output_text.delta", delta: "Hi" })).toBe("Hi");
  });

  it("reads usage and finish reason from a final chunk", () => {
    expect(extractStreamMeta("openai-chat", { choices: [{ finish_reason: "stop" }], usage: { total_tokens: 42 } }))
      .toEqual({ tokens: 42, finishReason: "stop" });

    expect(extractStreamMeta("anthropic", { usage: { input_tokens: 10, output_tokens: 5 } }))
      .toEqual({ tokens: 15 });

    expect(extractStreamMeta("gemini", { usageMetadata: { totalTokens: 7 }, candidates: [{ finishReason: "STOP" }] }))
      .toEqual({ tokens: 7, finishReason: "STOP" });

    expect(extractStreamMeta("openai-chat", {})).toEqual({});
  });

  it("never reports a token count it was not given", () => {
    const meta = extractStreamMeta("openai-chat", { choices: [{ finish_reason: "stop" }] });
    expect(meta).not.toHaveProperty("tokens");
    expect(meta.finishReason).toBe("stop");
  });

  it("assembles non-streaming text for each protocol", () => {
    expect(extractText("anthropic", { content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] })).toBe("ab");
    expect(extractText("gemini", { candidates: [{ content: { parts: [{ text: "g" }] } }] })).toBe("g");
    expect(extractText("openai-responses", { output_text: "r" })).toBe("r");
    expect(extractText("openai-chat", { choices: [{ message: { content: "c" } }] })).toBe("c");
    expect(extractText("openai-chat", null)).toBe("");
  });
});

describe("max tokens", () => {
  it("treats a blank, zero or invalid field as no limit", () => {
    for (const value of ["", "   ", "0", "-5", "abc", null, undefined]) {
      expect(parseMaxTokens(value)).toBeNull();
    }
    expect(parseMaxTokens("2048")).toBe(2048);
    expect(parseMaxTokens(" 500000 ")).toBe(500000);
  });

  it("does not send a token cap when there is no limit", () => {
    const common = { model: "m", autoRoute: false, prompt: "hi", maxTokens: null };

    expect(buildRequestBody({ ...common, protocol: "openai-chat" })).not.toHaveProperty("max_tokens");
    expect(buildRequestBody({ ...common, protocol: "openai-responses" })).not.toHaveProperty("max_output_tokens");
    expect(buildRequestBody({ ...common, protocol: "gemini" })).not.toHaveProperty("generationConfig");
  });

  it("still sends an explicit limit, with no upper cap", () => {
    const body = buildRequestBody({ protocol: "openai-chat", model: "m", autoRoute: false, prompt: "hi", maxTokens: 500000 });
    expect(body.max_tokens).toBe(500000);
  });

  it("omits max_tokens for Anthropic when there is no limit, and sends an explicit one unchanged", () => {
    const none = buildRequestBody({ protocol: "anthropic", model: "m", autoRoute: false, prompt: "hi", maxTokens: null });
    expect(none).not.toHaveProperty("max_tokens");
    const set = buildRequestBody({ protocol: "anthropic", model: "m", autoRoute: false, prompt: "hi", maxTokens: 500000 });
    expect(set.max_tokens).toBe(500000);
  });
});

describe("playground pinning", () => {
  it("sends no pin headers under Auto Route or without a provider", () => {
    expect(buildPinHeaders({ autoRoute: true, provider: "groq", keyIndex: 1 })).toEqual({});
    expect(buildPinHeaders({ autoRoute: false, provider: "", keyIndex: 1 })).toEqual({});
    expect(buildPinHeaders()).toEqual({});
  });

  it("pins the provider, and the key only when one is chosen", () => {
    expect(buildPinHeaders({ autoRoute: false, provider: "groq", keyIndex: null }))
      .toEqual({ "x-multi-ai-pin-provider": "groq" });
    expect(buildPinHeaders({ autoRoute: false, provider: "groq", keyIndex: 0 }))
      .toEqual({ "x-multi-ai-pin-provider": "groq", "x-multi-ai-pin-key-index": "0" });
  });

  it("flags a custom model only when pinned to a provider", () => {
    expect(buildPinHeaders({ autoRoute: false, provider: "groq", keyIndex: null, customModel: true }))
      .toEqual({ "x-multi-ai-pin-provider": "groq", "x-multi-ai-pin-custom-model": "1" });
    expect(buildPinHeaders({ autoRoute: false, provider: "groq", customModel: false }))
      .toEqual({ "x-multi-ai-pin-provider": "groq" });
    expect(buildPinHeaders({ autoRoute: true, provider: "groq", customModel: true })).toEqual({});
    expect(buildPinHeaders({ autoRoute: false, provider: "", customModel: true })).toEqual({});
  });
});

describe("playground image attachments", () => {
  const png = { mimeType: "image/png", data: "AAAA" };

  it("keeps the plain-text shape when there are no images", () => {
    expect(buildRequestBody({ protocol: "openai-chat", autoRoute: true, prompt: "hi", images: [] }).messages.at(-1))
      .toEqual({ role: "user", content: "hi" });
    expect(buildRequestBody({ protocol: "anthropic", autoRoute: true, prompt: "hi" }).messages[0].content).toBe("hi");
  });

  it("sends images as image_url parts for openai-chat", () => {
    const body = buildRequestBody({ protocol: "openai-chat", autoRoute: true, prompt: "what is this?", images: [png] });
    expect(body.messages.at(-1).content).toEqual([
      { type: "text", text: "what is this?" },
      { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }
    ]);
  });

  it("sends images as base64 image blocks for anthropic", () => {
    const body = buildRequestBody({ protocol: "anthropic", autoRoute: true, prompt: "what is this?", images: [png] });
    expect(body.messages[0].content).toEqual([
      { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
      { type: "text", text: "what is this?" }
    ]);
  });

  it("sends images as input_image parts for openai-responses", () => {
    const body = buildRequestBody({ protocol: "openai-responses", autoRoute: true, prompt: "what is this?", images: [png] });
    expect(body.input).toEqual([{
      role: "user",
      content: [
        { type: "input_text", text: "what is this?" },
        { type: "input_image", image_url: "data:image/png;base64,AAAA" }
      ]
    }]);
  });

  it("sends images as inlineData parts for gemini", () => {
    const body = buildRequestBody({ protocol: "gemini", autoRoute: true, prompt: "what is this?", images: [png] });
    expect(body.contents[0].parts).toEqual([
      { text: "what is this?" },
      { inlineData: { mimeType: "image/png", data: "AAAA" } }
    ]);
  });

  it("allows an image with no text", () => {
    const body = buildRequestBody({ protocol: "openai-chat", autoRoute: true, prompt: "", images: [png] });
    expect(body.messages.at(-1).content).toEqual([
      { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }
    ]);
  });

  it("is detected as an image request by the gateway's own rules", async () => {
    const { requestHasImage } = await import("../../../../src/vision.js");
    for (const protocol of ["openai-chat", "anthropic", "openai-responses", "gemini"]) {
      const body = buildRequestBody({ protocol, autoRoute: true, prompt: "x", images: [png] });
      expect(requestHasImage(body), protocol).toBe(true);
      expect(requestHasImage(buildRequestBody({ protocol, autoRoute: true, prompt: "x" })), protocol).toBe(false);
    }
  });
});

describe("custom model reaches the gateway", () => {
  it("puts the chosen model in the gemini URL", () => {
    expect(endpointFor("gemini", "brand-new-model")).toBe("/v1beta/models/brand-new-model:generateContent");
  });
});
