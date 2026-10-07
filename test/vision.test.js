import test from "node:test";
import assert from "node:assert/strict";
import { requestHasImage, selectPool } from "../src/vision.js";
import { loadConfig, buildTargets, isProviderConfigured, VISION_POOL } from "../src/config.js";

const IMAGE_BODY = { messages: [{ role: "user", content: [{ type: "image", source: {} }] }] };
const TEXT_BODY = { messages: [{ role: "user", content: "hi" }] };

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
  assert.equal(requestHasImage({ contents: [{ parts: [{ inlineData: { mimeType: "text/plain", data: "x" } }] }] }), false);
  assert.equal(requestHasImage(null), false);
});

test("vision pool has its own keys, base URL and models", () => {
  const cfg = loadConfig({
    GROQ_API_KEYS: "text-key", GROQ_BASE_URL: "https://text.example/v1", GROQ_MODELS: "text-model",
    GROQ_VISION_API_KEYS: "vk1,vk2", GROQ_VISION_BASE_URL: "https://vision.example/v1", GROQ_VISION_MODELS: "vision-model"
  });
  assert.deepEqual(cfg.providers.groq.apiKeys, ["text-key"]);
  assert.equal(cfg.providers.groq.baseUrl, "https://text.example/v1");
  assert.deepEqual(cfg.visionProviders.groq.apiKeys, ["vk1", "vk2"]);
  assert.equal(cfg.visionProviders.groq.baseUrl, "https://vision.example/v1");
  assert.deepEqual(cfg.visionProviders.groq.models, ["vision-model"]);

  const vision = buildTargets(cfg.visionProviders, VISION_POOL);
  assert.deepEqual(vision.map((x) => [x.model, x.apiKey, x.baseUrl, x.pool]),
    [["vision-model", "vk1", "https://vision.example/v1", "vision"], ["vision-model", "vk2", "https://vision.example/v1", "vision"]]);
  const text = buildTargets(cfg.providers);
  assert.equal(text.length, 1);
  assert.equal(text[0].pool, undefined);
});

test("a vision pool needs its own keys, models and base URL (nothing is inherited from the text pool)", () => {
  const cfg = loadConfig({ GROQ_API_KEYS: "k", GROQ_BASE_URL: "https://x/v1", GROQ_MODELS: "m", GROQ_VISION_MODELS: "v" });
  assert.equal(isProviderConfigured(cfg.providers.groq), true);
  assert.equal(isProviderConfigured(cfg.visionProviders.groq), false);
  assert.deepEqual(buildTargets(cfg.visionProviders, VISION_POOL), []);
});

test("vision targets never share an id (health state) with text targets of the same model", () => {
  const cfg = loadConfig({
    GROQ_API_KEYS: "k", GROQ_BASE_URL: "https://x/v1", GROQ_MODELS: "same",
    GROQ_VISION_API_KEYS: "v", GROQ_VISION_BASE_URL: "https://y/v1", GROQ_VISION_MODELS: "same"
  });
  const text = buildTargets(cfg.providers)[0];
  const vision = buildTargets(cfg.visionProviders, VISION_POOL)[0];
  assert.notEqual(text.id ?? `${text.provider}:${text.model}:key-${text.keyIndex}`, vision.id);
});

test("cloudflare vision pool uses CLOUDFLARE_VISION_ACCOUNT_IDS", () => {
  const cfg = loadConfig({
    CLOUDFLARE_API_KEYS: "t", CLOUDFLARE_ACCOUNT_IDS: "textacct", CLOUDFLARE_MODELS: "m",
    CLOUDFLARE_VISION_API_KEYS: "vt", CLOUDFLARE_VISION_ACCOUNT_IDS: "visionacct", CLOUDFLARE_VISION_MODELS: "vm"
  });
  const [v] = buildTargets(cfg.visionProviders, VISION_POOL);
  assert.match(v.baseUrl, /\/accounts\/visionacct\/ai\/v1$/);
  const [x] = buildTargets(cfg.providers);
  assert.match(x.baseUrl, /\/accounts\/textacct\/ai\/v1$/);
});

test("selectPool: images go only to the vision pool, text only to the text pool", () => {
  const textTargets = [{ provider: "groq", model: "t" }];
  const visionTargets = [{ provider: "gemini", model: "v", pool: "vision" }];
  assert.equal(selectPool(IMAGE_BODY, { textTargets, visionTargets }).pool, "vision");
  assert.deepEqual(selectPool(IMAGE_BODY, { textTargets, visionTargets }).targets, visionTargets);
  assert.equal(selectPool(TEXT_BODY, { textTargets, visionTargets }).pool, "text");
  assert.deepEqual(selectPool(TEXT_BODY, { textTargets, visionTargets }).targets, textTargets);
});

test("selectPool: an image request never receives a text target", () => {
  const textTargets = [{ provider: "groq", model: "t" }];
  const visionTargets = [{ provider: "gemini", model: "v", pool: "vision" }];
  for (const vt of [visionTargets, []]) {
    const out = selectPool(IMAGE_BODY, { textTargets, visionTargets: vt });
    assert.equal(out.targets.some((x) => textTargets.includes(x)), false);
  }
  assert.deepEqual(selectPool(TEXT_BODY, { textTargets, visionTargets: [] }).targets, textTargets);
});

test("selectPool: with no vision target configured, images get no targets (never the text pool)", () => {
  const textTargets = [{ provider: "groq", model: "t" }];
  const out = selectPool(IMAGE_BODY, { textTargets, visionTargets: [] });
  assert.equal(out.pool, "vision");
  assert.deepEqual(out.targets, []);
});
