import test from "node:test";
import assert from "node:assert/strict";
import { buildUpstreamRequest } from "../src/adapters.js";
import { buildChatRequest } from "../src/chat-bridge.js";
import { buildBridgeRequest } from "../src/anthropic-bridge.js";
import { buildCodexRequest } from "../src/codex-bridge.js";
import { healthProbePlan } from "../src/health-checks.js";
import { geminiModelsUrl, geminiModelsProbeUrl } from "../src/upstream-url.js";

/**
 * One canonical Gemini URL, whatever shape the operator configured.
 *
 * Before the shared builder the same `joinUrl` lived in four files and only
 * some of them stripped a version segment already present on the base URL, so a
 * base of `.../v1beta` produced `/v1beta/v1beta/models/...` from the bridges
 * while the native adapter and the health probe used the correct path. Every
 * builder is now checked against the same matrix.
 */

const MODEL = "gemini-2.5-flash";
const BASES = [
  "https://h",
  "https://h/",
  "https://h/v1beta",
  "https://h/v1beta/",
  "https://h/v1",
  "https://h/v1/",
  "https://h/api/v1beta",
  "https://h/api/"
];

const target = (baseUrl) => ({ provider: "gemini", model: MODEL, baseUrl, apiKey: "GK", keyIndex: 0, protocols: ["gemini"], clientHeaders: {} });
const chat = (stream) => ({ messages: [{ role: "user", content: "hi" }], stream });
const anthropic = (stream) => ({ max_tokens: 8, messages: [{ role: "user", content: "hi" }], stream });
const responses = (stream) => ({ model: "ignored", input: "hi", stream });

const urlsFor = (base, stream) => {
  const t = target(base);
  return {
    // The native adapter takes `stream` as an option (the client's method name
    // decides it), the three bridges read `body.stream`.
    adapter: buildUpstreamRequest(t, "gemini", chat(stream), {}, { stream }).url,
    chat: buildChatRequest(t, "gemini", chat(stream), {}).url,
    anthropic: buildBridgeRequest(t, "gemini", anthropic(stream), {}).url,
    codex: buildCodexRequest(t, "gemini", responses(stream), {}).url
  };
};

for (const base of BASES) {
  test(`${base}: every Gemini builder agrees, with no duplicated version segment`, () => {
    for (const stream of [false, true]) {
      const expected = geminiModelsUrl(base, MODEL, { stream });
      const urls = urlsFor(base, stream);
      assert.deepEqual(new Set(Object.values(urls)).size, 1, `builders disagree: ${JSON.stringify(urls)}`);
      assert.equal(urls.adapter, expected, "the shared builder is the contract");
      for (const url of Object.values(urls)) {
        assert.ok(!/v\d+(?:alpha|beta)?\d*\/v\d+(?:alpha|beta)?\d*/i.test(url), `duplicated version segment: ${url}`);
      }
      assert.equal((urls.adapter.match(/\/v1beta\//g) || []).length, 1, `exactly one /v1beta/: ${urls.adapter}`);
      if (stream) assert.match(urls.adapter, /:streamGenerateContent\?alt=sse$/);
      else assert.match(urls.adapter, /:generateContent$/);
    }
  });
}

test("the Gemini health probe uses the same base resolution and never duplicates a version", () => {
  for (const base of BASES) {
    const plan = healthProbePlan(target(base));
    assert.equal(plan.url, geminiModelsProbeUrl(base));
    assert.ok(!/v\d+(?:alpha|beta)?\d*\/v\d+(?:alpha|beta)?\d*/i.test(plan.url), `duplicated version segment: ${plan.url}`);
    assert.match(plan.url, /\/models$/);
    assert.equal(plan.headers["x-goog-api-key"], "GK");
  }
});

test("a model name with a slash or a space is percent-encoded exactly once", () => {
  const url = geminiModelsUrl("https://h/v1beta", "google/gemini flash", {});
  assert.equal(url, "https://h/v1beta/models/google%2Fgemini%20flash:generateContent");
});
