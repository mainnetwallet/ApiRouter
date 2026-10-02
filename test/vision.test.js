import test from "node:test";
import assert from "node:assert/strict";
import { requestHasImage, filterTargetsForImages, isVisionTarget, parseVisionModels } from "../src/vision.js";

const t = (provider, model) => ({ provider, model, keyIndex: 0 });
const targets = [t("groq", "openai/gpt-oss-120b"), t("gemini", "gemini-3.7-flash"), t("cloudflare", "@cf/qwen/qwen3.8-27b"), t("groq", "qwen3.8-27b")];

test("detects images in every client protocol", () => {
  assert.equal(requestHasImage({ messages: [{ role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "x" } }] }] }), true);
  assert.equal(requestHasImage({ messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "data:image/png;base64,x" } }] }] }), true);
  assert.equal(requestHasImage({ input: [{ role: "user", content: [{ type: "input_image", image_url: "data:image/png;base64,x" }] }] }), true);
  assert.equal(requestHasImage({ contents: [{ parts: [{ inlineData: { mimeType: "image/jpeg", data: "x" } }] }] }), true);
  // image nested in an Anthropic tool_result
  assert.equal(requestHasImage({ messages: [{ role: "user", content: [{ type: "tool_result", content: [{ type: "image", source: {} }] }] }] }), true);
});

test("text-only requests and tool schemas are not images", () => {
  assert.equal(requestHasImage({ messages: [{ role: "user", content: "hello image_url" }] }), false);
  assert.equal(requestHasImage({ messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }], tools: [{ input_schema: { properties: { image: { type: "string" } } } }] }), false);
  assert.equal(requestHasImage({ contents: [{ parts: [{ inlineData: { mimeType: "audio/wav", data: "x" } }] }] }), false);
  assert.equal(requestHasImage(null), false);
});

test("filter keeps only vision targets when a request has an image", () => {
  const body = { messages: [{ role: "user", content: [{ type: "image", source: {} }] }] };
  const out = filterTargetsForImages(targets, body, ["gemini-3.7-flash", "cloudflare:@cf/qwen/qwen3.8-27b"]);
  assert.equal(out.filtered, true);
  assert.deepEqual(out.targets.map((x) => `${x.provider}:${x.model}`), ["gemini:gemini-3.7-flash", "cloudflare:@cf/qwen/qwen3.8-27b"]);
});

test("no filtering without VISION_MODELS or without an image", () => {
  const body = { messages: [{ role: "user", content: [{ type: "image", source: {} }] }] };
  assert.equal(filterTargetsForImages(targets, body, []).filtered, false);
  assert.equal(filterTargetsForImages(targets, { messages: [{ role: "user", content: "hi" }] }, ["gemini-3.7-flash"]).filtered, false);
});

test("provider:model entries are scoped to that provider and ids are case-insensitive", () => {
  assert.equal(isVisionTarget(t("groq", "qwen3.8-27b"), ["cloudflare:qwen3.8-27b"]), false);
  assert.equal(isVisionTarget(t("groq", "Qwen3.8-27B"), ["qwen3.8-27b"]), true);
  assert.deepEqual(parseVisionModels(" a , b ,,"), ["a", "b"]);
});

import { readVisionModels, loadConfig } from "../src/config.js";

test("per-provider *_VISION_MODELS become provider-scoped entries", () => {
  const env = {
    GEMINI_VISION_MODELS: "gemini-3.7-flash, gemini-3.6-flash",
    GROQ_VISION_MODELS: "qwen/qwen3.8-27b",
    CLOUDFLARE_VISION_MODELS: "@cf/qwen/qwen3.8-27b"
  };
  assert.deepEqual(readVisionModels(env), [
    "gemini:gemini-3.7-flash", "gemini:gemini-3.6-flash",
    "groq:qwen/qwen3.8-27b", "cloudflare:@cf/qwen/qwen3.8-27b"
  ]);
  assert.deepEqual(loadConfig(env).visionModels, readVisionModels(env));
});

test("a provider's vision list does not leak onto the same model id elsewhere", () => {
  const visionModels = readVisionModels({ GROQ_VISION_MODELS: "shared-model" });
  assert.equal(isVisionTarget({ provider: "groq", model: "shared-model" }, visionModels), true);
  assert.equal(isVisionTarget({ provider: "openrouter", model: "shared-model" }, visionModels), false);
});

test("no vision variables means no filtering; legacy VISION_MODELS still works", () => {
  assert.deepEqual(readVisionModels({}), []);
  assert.deepEqual(readVisionModels({ VISION_MODELS: "a,b" }), ["a", "b"]);
});
