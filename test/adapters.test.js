import test from "node:test";
import assert from "node:assert/strict";
import {
  buildUpstreamRequest,
  clientProtocol,
  providerProtocols
} from "../src/adapters.js";

test("client protocols are explicit", () => {
  assert.equal(clientProtocol("/v1/messages"), "anthropic");
  assert.equal(clientProtocol("/v1/responses"), "openai-responses");
  assert.equal(clientProtocol("/v1/chat/completions"), "openai-chat");
  assert.equal(clientProtocol("/v1beta/models:generateContent"), "gemini");
});

test("provider capabilities distinguish chat and responses", () => {
  assert.deepEqual(providerProtocols("agentrouter"), [
    "anthropic",
    "openai-chat",
    "openai-responses"
  ]);
  assert.deepEqual(providerProtocols("gemini"), ["gemini"]);
  assert.deepEqual(providerProtocols("groq"), ["openai-chat"]);
});

test("OpenAI chat request uses chat completions", () => {
  const request = buildUpstreamRequest(
    {
      provider: "groq",
      model: "model-a",
      baseUrl: "https://example.test/v1",
      apiKey: "secret"
    },
    "openai-chat",
    { messages: [{ role: "user", content: "hi" }] }
  );

  assert.equal(request.url, "https://example.test/v1/chat/completions");
  assert.equal(JSON.parse(request.options.body).model, "model-a");
});

test("OpenAI Responses request uses responses endpoint", () => {
  const request = buildUpstreamRequest(
    {
      provider: "agentrouter",
      model: "model-a",
      baseUrl: "https://example.test/",
      apiKey: "secret"
    },
    "openai-responses",
    { input: "hi" }
  );

  assert.equal(request.url, "https://example.test/v1/responses");
  assert.equal(JSON.parse(request.options.body).model, "model-a");
});

test("Gemini request uses native generateContent endpoint", () => {
  const request = buildUpstreamRequest(
    {
      provider: "gemini",
      model: "gemini-model",
      baseUrl: "https://generativelanguage.googleapis.com",
      apiKey: "secret"
    },
    "gemini",
    { contents: [{ parts: [{ text: "hi" }] }] }
  );

  assert.equal(
    request.url,
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-model:generateContent"
  );
  assert.equal(request.options.headers["x-goog-api-key"], "secret");
  assert.equal(JSON.parse(request.options.body).model, undefined);
});
