import test from "node:test";
import assert from "node:assert/strict";

import { loadConfig } from "../src/config.js";

/**
 * Base URLs must be plain API roots.
 *
 * Every request builder appends its endpoint path to the base URL as a plain
 * string, so a base carrying a query string produces
 * `https://gw.example.com/v1?key=abc/v1/chat/completions` — the path lands
 * inside the query value. That cannot be made to work by the router, so it is
 * refused at startup instead of failing every request later.
 */

const provider = (baseUrl) => ({ GROQ_API_KEYS: "k", GROQ_MODELS: "m", GROQ_BASE_URL: baseUrl });
const visionProvider = (baseUrl) => ({ GROQ_VISION_API_KEYS: "k", GROQ_VISION_MODELS: "m", GROQ_VISION_BASE_URL: baseUrl });

test("a base URL with a query string is refused", () => {
  assert.throws(() => loadConfig(provider("https://gw.example.com/v1?key=abc")), /GROQ_BASE_URL/);
});

test("a base URL with a fragment is refused", () => {
  assert.throws(() => loadConfig(provider("https://gw.example.com/v1#frag")), /GROQ_BASE_URL/);
});

test("a vision base URL is refused the same way, under its own variable name", () => {
  assert.throws(() => loadConfig(visionProvider("https://gw.example.com/v1?k=1")), /GROQ_VISION_BASE_URL/);
});

test("the refusal never echoes the URL, which is where a pasted credential would live", () => {
  const secret = "sk-live-do-not-log-me";
  try {
    loadConfig(provider(`https://gw.example.com/v1?key=${secret}`));
    assert.fail("loadConfig should have thrown");
  } catch (error) {
    assert.match(error.message, /GROQ_BASE_URL/);
    assert.ok(!error.message.includes(secret), `the startup error leaked a credential: ${error.message}`);
    assert.ok(!error.message.includes("gw.example.com"), "the startup error echoed the URL");
  }
});

test("plain base URLs are accepted, in every supported form", () => {
  const config = loadConfig({
    GROQ_API_KEYS: "k1",
    GROQ_MODELS: "m",
    GROQ_BASE_URL: "https://api.groq.com/openai/v1",
    GEMINI_VISION_API_KEYS: "k2",
    GEMINI_VISION_MODELS: "m",
    // A version suffix, and no trailing slash.
    GEMINI_VISION_BASE_URL: "https://generativelanguage.googleapis.com/v1beta",
    MISTRAL_API_KEYS: "k3",
    MISTRAL_MODELS: "m",
    // A custom proxy path.
    MISTRAL_BASE_URL: "https://proxy.internal/openai/mistral"
  });
  assert.equal(config.providers.groq.baseUrl, "https://api.groq.com/openai/v1");
  assert.equal(config.visionProviders.gemini.baseUrl, "https://generativelanguage.googleapis.com/v1beta");
  assert.equal(config.providers.mistral.baseUrl, "https://proxy.internal/openai/mistral");
});

test("an empty or absent base URL is not an error — the provider is simply not configured", () => {
  assert.doesNotThrow(() => loadConfig(provider("")));
  assert.doesNotThrow(() => loadConfig({ GROQ_API_KEYS: "k", GROQ_MODELS: "m" }));
  // A key/model pair with no base URL never becomes a target.
  const config = loadConfig(provider(""));
  assert.equal(config.providers.groq.baseUrl, "");
});

test("a Cloudflare account-scoped base URL is still accepted", () => {
  assert.doesNotThrow(() => loadConfig({
    CLOUDFLARE_API_KEYS: "k",
    CLOUDFLARE_MODELS: "m",
    CLOUDFLARE_ACCOUNT_ID: "acct-123"
  }));
});
