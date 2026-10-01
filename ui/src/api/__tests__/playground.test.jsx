import { describe, expect, it } from "vitest";

import {
  buildRequestBody, endpointFor, extractDelta, extractStreamMeta, extractText
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
