import test from "node:test";
import assert from "node:assert/strict";

import { buildUpstreamRequest } from "../src/adapters.js";
import { buildChatRequest } from "../src/chat-bridge.js";
import { buildCodexRequest } from "../src/codex-bridge.js";
import { buildBridgeRequest } from "../src/anthropic-bridge.js";
import { stripApiVersion } from "../src/url-utils.js";

/**
 * Regression: a configured base URL that already carries the API version
 * (`.../v1beta`, which `health-checks.js` accepts) must not have the version
 * appended a second time. Every Gemini URL used to be built by naively
 * appending `v1beta/models/...`, so a version-suffixed base produced
 * `/v1beta/v1beta/models/...` — a 404 from every provider so configured.
 */

const GEMINI_ROOT = "https://generativelanguage.googleapis.com";
const GEMINI_VERSIONED = GEMINI_ROOT + "/v1beta";

const geminiTarget = (baseUrl) => ({
  provider: "gemini",
  model: "gemini-3.8-flash",
  baseUrl,
  apiKey: "k",
  protocols: ["gemini"],
  keyIndex: 0
});

/** The four request builders that can address a Gemini provider. */
const builders = (target, baseUrl) => ({
  "adapters.buildUpstreamRequest": buildUpstreamRequest(target, "gemini", { contents: [] }, {}).url,
  "chat-bridge.buildChatRequest": buildChatRequest(target, "gemini", { messages: [] }, {}).url,
  "codex-bridge.buildCodexRequest": buildCodexRequest(target, "gemini", { input: [] }, {}).url,
  "anthropic-bridge.buildBridgeRequest": buildBridgeRequest(target, "gemini", { messages: [] }, {}).url
});

test("gemini URL: a base URL without a version gets /v1beta exactly once", () => {
  const target = geminiTarget(GEMINI_ROOT);
  for (const [name, url] of Object.entries(builders(target, GEMINI_ROOT))) {
    assert.equal(
      url,
      `${GEMINI_ROOT}/v1beta/models/gemini-3.8-flash:generateContent`,
      `${name} built ${url}`
    );
  }
});

test("gemini URL: a base URL that already carries /v1beta is not doubled", () => {
  const target = geminiTarget(GEMINI_VERSIONED);
  for (const [name, url] of Object.entries(builders(target, GEMINI_VERSIONED))) {
    assert.equal(
      url,
      `${GEMINI_ROOT}/v1beta/models/gemini-3.8-flash:generateContent`,
      `${name} built ${url}`
    );
    assert.ok(!url.includes("/v1beta/v1beta/"), `${name} duplicated the version: ${url}`);
  }
});

test("gemini URL: a trailing slash on the base URL does not create an empty segment", () => {
  for (const base of [GEMINI_ROOT + "/", GEMINI_VERSIONED + "/"]) {
    const target = geminiTarget(base);
    for (const [name, url] of Object.entries(builders(target, base))) {
      assert.equal(
        url,
        `${GEMINI_ROOT}/v1beta/models/gemini-3.8-flash:generateContent`,
        `${name} built ${url} for base ${base}`
      );
    }
  }
});

test("gemini URL: streaming keeps its ?alt=sse and still resolves the model once", () => {
  const target = geminiTarget(GEMINI_VERSIONED);
  const url = buildUpstreamRequest(target, "gemini", { contents: [] }, { accept: "text/event-stream" }, { stream: true }).url;
  assert.equal(url, `${GEMINI_ROOT}/v1beta/models/gemini-3.8-flash:streamGenerateContent?alt=sse`);
  assert.equal((url.match(/v1beta/g) || []).length, 1, url);
});

test("gemini URL: a custom non-Google base URL is preserved, only its version is normalized", () => {
  const target = geminiTarget("https://gemini-proxy.internal/api/v1beta");
  const url = buildUpstreamRequest(target, "gemini", { contents: [] }, {}).url;
  assert.equal(url, "https://gemini-proxy.internal/api/v1beta/models/gemini-3.8-flash:generateContent");
});

test("stripApiVersion: strips a trailing version, keeps a query string and custom paths", () => {
  assert.equal(stripApiVersion("https://x.dev"), "https://x.dev");
  assert.equal(stripApiVersion("https://x.dev/"), "https://x.dev");
  assert.equal(stripApiVersion("https://x.dev/v1beta"), "https://x.dev");
  assert.equal(stripApiVersion("https://x.dev/v1beta/"), "https://x.dev");
  assert.equal(stripApiVersion("https://x.dev/v2alpha1"), "https://x.dev");
  // A version-looking path segment that is NOT the last one is left alone.
  assert.equal(stripApiVersion("https://x.dev/v1beta/models"), "https://x.dev/v1beta/models");
  // Query strings survive.
  assert.equal(stripApiVersion("https://x.dev/v1beta?key=1"), "https://x.dev?key=1");
  assert.equal(stripApiVersion("https://x.dev/?key=1"), "https://x.dev?key=1");
  assert.equal(stripApiVersion(""), "");
});
