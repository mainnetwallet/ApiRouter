import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadConfig, buildTargets, VISION_POOL } from "../src/config.js";
import { PROVIDERS } from "../src/providers/catalog.js";
import { providerProtocols, buildUpstreamRequest } from "../src/adapters.js";
import { healthProbePlan } from "../src/health-checks.js";
import { selectPool } from "../src/vision.js";

const BASE = "https://inference-api.nousresearch.com/v1";
const TEXT = [
  "poolside/laguna-s-2.1:free",
  "stepfun/step-3.7-flash:free",
  "meituan/longcat-2.5-preview:free",
  "inclusionai/ling-3.0-flash-fin:free",
  "meituan/longcat-2.0:free",
  "poolside/laguna-xs-2.1:free",
  "inclusionai/ling-3.0-flash-sante:free",
  "upstage/solar-pro4:free"
];
const VISION = ["stepfun/step-3.7-flash:free"];

test("Nous Portal free model pools are documented and ordered", () => {
  const example = readFileSync(new URL("../.env.example", import.meta.url), "utf8");
  assert.match(example, new RegExp("^NOUS_MODELS=" + TEXT.join(",").replace(/\./g, "\\\.") + "$", "m"));
  assert.match(example, /^NOUS_VISION_MODELS=stepfun\/step-3\.7-flash:free$/m);
  assert.match(example, /^NOUS_BASE_URL=https:\/\/inference-api\.nousresearch\.com\/v1$/m);
  assert.match(example, /^NOUS_VISION_BASE_URL=https:\/\/inference-api\.nousresearch\.com\/v1$/m);
});

test("Nous is a first-class OpenAI-compatible provider with separate vision config", () => {
  assert.ok(PROVIDERS.includes("nous"));
  const c = loadConfig({
    NOUS_API_KEYS: "n1,n2",
    NOUS_BASE_URL: BASE,
    NOUS_MODELS: TEXT.join(","),
    NOUS_VISION_API_KEYS: "nv1",
    NOUS_VISION_BASE_URL: BASE,
    NOUS_VISION_MODELS: VISION.join(",")
  });
  assert.deepEqual(c.providers.nous.models, TEXT);
  assert.deepEqual(c.providers.nous.apiKeys, ["n1", "n2"]);
  assert.equal(c.providers.nous.baseUrl, BASE);
  assert.deepEqual(c.visionProviders.nous.models, VISION);
  assert.deepEqual(providerProtocols("nous"), ["openai-chat"]);
});

test("Nous targets preserve model order and keep vision isolated", () => {
  const c = loadConfig({
    NOUS_API_KEYS: "n1,n2",
    NOUS_BASE_URL: BASE,
    NOUS_MODELS: TEXT.join(","),
    NOUS_VISION_API_KEYS: "nv1",
    NOUS_VISION_BASE_URL: BASE,
    NOUS_VISION_MODELS: VISION.join(",")
  });
  const text = buildTargets(c.providers);
  const vision = buildTargets(c.visionProviders, VISION_POOL);
  assert.equal(text.length, TEXT.length * 2);
  assert.equal(vision.length, 1);
  assert.deepEqual([...new Set(text.map((x) => x.model))], TEXT);
  assert.deepEqual([...new Set(vision.map((x) => x.model))], VISION);
  assert.ok(vision.every((x) => x.pool === "vision"));
});

test("Nous base URL does not duplicate /v1 and health probes use the same endpoint", () => {
  const c = loadConfig({
    NOUS_API_KEYS: "n1",
    NOUS_BASE_URL: BASE,
    NOUS_MODELS: TEXT.join(",")
  });
  const target = buildTargets(c.providers).find((x) => x.model === TEXT[0]);
  const req = buildUpstreamRequest(target, "openai-chat", { messages: [] });
  assert.equal(req.url, BASE + "/chat/completions");
  assert.equal(JSON.parse(req.options.body).model, TEXT[0]);
  const probe = healthProbePlan(target);
  assert.equal(probe.url, BASE + "/models");
  assert.equal(probe.headers.authorization, "Bearer n1");
});

test("Step 3.7 Flash is the only configured Nous free vision model", () => {
  const c = loadConfig({
    NOUS_API_KEYS: "n1",
    NOUS_BASE_URL: BASE,
    NOUS_MODELS: TEXT.join(","),
    NOUS_VISION_API_KEYS: "nv1",
    NOUS_VISION_BASE_URL: BASE,
    NOUS_VISION_MODELS: VISION.join(",")
  });
  const image = { messages: [{ role: "user", content: [
    { type: "text", text: "describe this" },
    { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }
  ] }] };
  const picked = selectPool(image, {
    textTargets: buildTargets(c.providers),
    visionTargets: buildTargets(c.visionProviders, VISION_POOL)
  });
  assert.equal(picked.targets.length, 1);
  assert.equal(picked.targets[0].model, "stepfun/step-3.7-flash:free");
  assert.equal(picked.targets[0].pool, VISION_POOL);
});
