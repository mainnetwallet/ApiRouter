import test from "node:test";
import assert from "node:assert/strict";
import {
  buildUpstreamRequest,
  clientProtocol,
  isGeminiStream,
  parseGeminiPath,
  providerProtocols
} from "../src/adapters.js";

test("client protocols are explicit", () => {
  assert.equal(clientProtocol("/v1/messages"), "anthropic");
  assert.equal(clientProtocol("/v1/responses"), "openai-responses");
  assert.equal(clientProtocol("/v1/chat/completions"), "openai-chat");
  assert.equal(clientProtocol("/v1beta/models/gemini-model:generateContent"), "gemini");
});

// One parser decides detection, streaming and the model name, so the three can
// never disagree. The previous regex only accepted `[^/]+:` and a bare method
// name, so a nested model id, a percent-escape or `GenerateContent` was not
// recognised at all.
test("the Gemini endpoint parser accepts every real spelling and rejects the rest", () => {
  assert.deepEqual(parseGeminiPath("/v1beta/models/gemini-2.5-flash:generateContent"), {
    model: "gemini-2.5-flash", method: "generateContent", stream: false
  });
  assert.deepEqual(parseGeminiPath("/v1beta/models/gemini-2.5-flash:streamGenerateContent"), {
    model: "gemini-2.5-flash", method: "streamGenerateContent", stream: true
  });
  // Google's own clients use both spellings; the method is case-insensitive.
  assert.equal(parseGeminiPath("/v1beta/models/m:GenerateContent").method, "generateContent");
  assert.equal(parseGeminiPath("/v1beta/models/m:STREAMGENERATECONTENT").stream, true);
  // A model id may contain slashes and percent-escapes.
  assert.equal(parseGeminiPath("/v1beta/models/google/gemini-2.5-flash:generateContent").model, "google/gemini-2.5-flash");
  assert.equal(parseGeminiPath("/v1beta/models/google%2Fgemini:generateContent").model, "google/gemini");
  // Anything else is not a Gemini generate/stream endpoint.
  assert.equal(parseGeminiPath("/v1beta/models/m:countTokens"), null);
  assert.equal(parseGeminiPath("/v1beta/models/m"), null);
  assert.equal(parseGeminiPath("/v1beta/models/:generateContent"), null);
  assert.equal(parseGeminiPath("/v1/messages"), null);
  assert.equal(parseGeminiPath(""), null);
  assert.equal(parseGeminiPath(undefined), null);

  for (const path of ["/v1beta/models/m:generateContent", "/v1beta/models/m:streamGenerateContent"]) {
    assert.equal(clientProtocol(path), "gemini");
  }
  assert.equal(isGeminiStream("/v1beta/models/m:streamGenerateContent"), true);
  assert.equal(isGeminiStream("/v1beta/models/m:generateContent"), false);
  assert.equal(isGeminiStream("/v1beta/models/m:countTokens"), false);
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


test("AgentRouter applies only explicitly configured client headers", () => {
  const request = buildUpstreamRequest(
    {
      provider: "agentrouter",
      model: "model-a",
      baseUrl: "https://agentrouter.org",
      apiKey: "secret",
      clientHeaders: {
        originator: "approved-client",
        version: "1.2.3",
        "user-agent": "ApprovedClient/1.2.3"
      }
    },
    "openai-chat",
    { messages: [{ role: "user", content: "hi" }] }
  );

  assert.equal(request.options.headers.authorization, "Bearer secret");
  assert.equal(request.options.headers.originator, "approved-client");
  assert.equal(request.options.headers.version, "1.2.3");
  assert.equal(request.options.headers["user-agent"], "ApprovedClient/1.2.3");
});

test("other providers do not receive AgentRouter client headers", () => {
  const request = buildUpstreamRequest(
    {
      provider: "groq",
      model: "model-a",
      baseUrl: "https://example.test/v1",
      apiKey: "secret",
      clientHeaders: {
        originator: "should-not-forward",
        version: "1.2.3",
        "user-agent": "should-not-forward"
      }
    },
    "openai-chat",
    { messages: [] }
  );

  assert.equal(request.options.headers.originator, undefined);
  assert.equal(request.options.headers.version, undefined);
});
