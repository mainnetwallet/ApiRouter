import test from "node:test";
import assert from "node:assert/strict";

import { geminiRoot, geminiModelUrl, geminiModelsUrl } from "../src/gemini-url.js";
import { buildUpstreamRequest } from "../src/adapters.js";
import { buildBridgeRequest } from "../src/anthropic-bridge.js";
import { buildChatRequest } from "../src/chat-bridge.js";
import { buildCodexRequest } from "../src/codex-bridge.js";
import { healthProbePlan } from "../src/health-checks.js";

const BASES = [
  "https://example.com",
  "https://example.com/",
  "https://example.com/v1",
  "https://example.com/v1/",
  "https://example.com/v1beta",
  "https://example.com/v1beta/",
  "https://example.com/v1alpha",
  "https://example.com/v1alpha/"
];

const target = (baseUrl) => ({ provider: "gemini", model: "gem-1", baseUrl, apiKey: "K", protocols: ["gemini"] });

test("every Gemini URL builder yields exactly one /v1beta, for every base URL form", () => {
  for (const base of BASES) {
    const t = target(base);
    const generate = "https://example.com/v1beta/models/gem-1:generateContent";
    const stream = "https://example.com/v1beta/models/gem-1:streamGenerateContent?alt=sse";
    assert.equal(buildUpstreamRequest(t, "gemini", { contents: [] }, {}, { stream: false }).url, generate, `native ${base}`);
    assert.equal(buildUpstreamRequest(t, "gemini", { contents: [] }, {}, { stream: true }).url, stream, `native stream ${base}`);
    assert.equal(buildBridgeRequest(t, "gemini", { messages: [] }, {}).url, generate, `anthropic bridge ${base}`);
    assert.equal(buildChatRequest(t, "gemini", { messages: [] }, {}).url, generate, `chat bridge ${base}`);
    assert.equal(buildCodexRequest(t, "gemini", { input: "x" }, {}).url, generate, `responses bridge ${base}`);
    assert.equal(healthProbePlan(t).url, "https://example.com/v1beta/models", `health probe ${base}`);
  }
});

test("streaming translated requests also get one version and the SSE flag", () => {
  for (const base of BASES) {
    const t = target(base);
    const expected = "https://example.com/v1beta/models/gem-1:streamGenerateContent?alt=sse";
    assert.equal(buildBridgeRequest(t, "gemini", { messages: [], stream: true }, {}).url, expected);
    assert.equal(buildChatRequest(t, "gemini", { messages: [], stream: true }, {}).url, expected);
    assert.equal(buildCodexRequest(t, "gemini", { input: "x", stream: true }, {}).url, expected);
  }
});

test("a base path that is not a version is kept, and only a trailing version is replaced", () => {
  assert.equal(geminiRoot("https://proxy.example.com/gemini/v1beta/"), "https://proxy.example.com/gemini");
  assert.equal(geminiModelsUrl("https://proxy.example.com/gemini"), "https://proxy.example.com/gemini/v1beta/models");
  assert.equal(geminiRoot("https://example.com/v1beta/v1beta"), "https://example.com/v1beta", "only one suffix is removed");
});

test("the model id is URL-encoded in the path", () => {
  assert.equal(geminiModelUrl("https://example.com", "tuned/model:x", { stream: false }),
    "https://example.com/v1beta/models/tuned%2Fmodel%3Ax:generateContent");
});
