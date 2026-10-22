import test from "node:test";
import assert from "node:assert/strict";
import {
  ADAPTER_CAPABILITIES,
  CAPABILITY_IDS,
  adapterCapabilities,
  evaluateCandidate,
  filterTargetsByRequirements,
  inferCapabilities,
  noCapableRouteMessage,
  normalizeCapabilities,
  normalizeRequirements,
  requestedModelCapabilityMessage,
  unsupportedCapabilities,
  validateRequestedModel
} from "../src/model-capabilities.js";

const target = (provider, model, protocols = ["openai-chat"], pool = "text") => ({ provider, model, protocols, pool });

test("the capability schema is stable and ordered", () => {
  assert.equal(CAPABILITY_IDS.length, 16);
  assert.equal(new Set(CAPABILITY_IDS).size, 16);
  assert.deepEqual(normalizeCapabilities(["streaming", "unknown-thing", "text_input", "text_input"]).capabilities, [
    "text_input", "streaming"
  ]);
  assert.deepEqual(normalizeCapabilities(["streaming", "future_capability"]).unknown, ["future_capability"]);
});

test("reasoning can never be a hard requirement", () => {
  assert.deepEqual(normalizeRequirements(["reasoning", "text_input", "reasoning"]), ["text_input"]);
});

test("inference is pool- and adapter-aware, and never invents generated media", () => {
  const text = inferCapabilities({ pool: "text", protocols: ["openai-chat"] });
  assert.ok(text.includes("text_input"));
  assert.ok(text.includes("tool_calling"));
  assert.ok(!text.includes("image_input"));

  const vision = inferCapabilities({ pool: "vision", protocols: ["openai-chat"] });
  assert.ok(vision.includes("image_input"));

  // The anthropic adapter has no structured-output wire form today.
  assert.ok(!inferCapabilities({ pool: "text", protocols: ["anthropic"] }).includes("structured_output"));

  for (const protocol of Object.keys(ADAPTER_CAPABILITIES)) {
    for (const generated of ["image_output", "audio_output", "video_output", "embeddings"]) {
      assert.ok(!ADAPTER_CAPABILITIES[protocol].includes(generated), `${protocol} must not claim ${generated}`);
    }
  }
});

test("an unknown protocol executes nothing rather than assuming OpenAI", () => {
  assert.equal(adapterCapabilities(["mystery-wire"]).size, 0);
  assert.deepEqual(unsupportedCapabilities(["text_input"], ["mystery-wire"]), ["text_input"]);
});

test("eligibility requires enabled, declared and executable", () => {
  assert.deepEqual(
    evaluateCandidate({ required: ["text_input"], declared: ["text_input"], protocols: ["openai-chat"] }),
    { eligible: true, reason: null, missing: [] }
  );

  assert.equal(evaluateCandidate({
    required: ["text_input"], declared: ["text_input"], protocols: ["openai-chat"], enabled: false
  }).reason, "model_config_disabled");

  assert.equal(evaluateCandidate({
    required: ["image_input"], declared: ["text_input"], protocols: ["openai-chat"]
  }).reason, "capability_not_configured");

  // Declared, but no adapter can carry it: skipped instead of sent upstream.
  assert.deepEqual(evaluateCandidate({
    required: ["image_output"], declared: ["image_output"], protocols: ["openai-chat"]
  }), { eligible: false, reason: "adapter_unsupported", missing: ["image_output"] });
});

test("a request with no requirements leaves every candidate eligible", () => {
  assert.equal(evaluateCandidate({ required: [], declared: [], protocols: [] }).eligible, true);
});

test("filtering keeps eligible targets and de-duplicates exclusions per model", () => {
  const targets = [
    target("groq", "text", ["openai-chat"]),
    { ...target("groq", "text", ["openai-chat"]), keyIndex: 1 },
    target("gemini", "flash", ["gemini"]),
    target("anthropic", "claude", ["anthropic"])
  ];
  const index = new Map([
    ["groq/text", { enabled: true, capabilities: ["text_input", "text_output"] }],
    ["gemini/flash", { enabled: true, capabilities: ["text_input", "text_output", "audio_input"] }],
    ["anthropic/claude", { enabled: true, capabilities: ["text_input", "text_output"] }]
  ]);

  const result = filterTargetsByRequirements(targets, ["audio_input"], (item) => index.get(`${item.provider}/${item.model}`));
  assert.deepEqual(result.eligible.map((item) => item.provider), ["gemini"]);
  // groq appears twice in the target list (two keys) but is excluded once.
  assert.equal(result.exclusions.length, 2);
  const groq = result.exclusions.find((item) => item.provider === "groq");
  assert.equal(groq.reason, "capability_not_configured");
  assert.deepEqual(groq.missing, ["audio_input"]);
});

test("a saved model never mutates the target list", () => {
  const targets = [target("groq", "text")];
  const before = JSON.stringify(targets);
  filterTargetsByRequirements(targets, [], () => ({ enabled: false, capabilities: [] }));
  assert.equal(JSON.stringify(targets), before);
});

test("an explicitly requested known model is rejected only when none of its providers can serve", () => {
  const index = new Map([
    ["groq/text", {
      provider: "groq", model: "text", capabilities: ["text_input", "text_output"],
      protocols: ["openai-chat"], pools: ["text"], enabled: true, configuredInEnvironment: true
    }],
    ["groq/audio", {
      provider: "groq", model: "audio", capabilities: ["text_input", "text_output", "audio_input"],
      protocols: ["openai-chat"], pools: ["text"], enabled: true, configuredInEnvironment: true
    }],
    // Switched off, but capable: that is a routing decision, not a mismatch.
    ["groq/off", {
      provider: "groq", model: "off", capabilities: ["text_input", "text_output"],
      protocols: ["openai-chat"], pools: ["text"], enabled: false, configuredInEnvironment: true
    }]
  ]);

  assert.equal(validateRequestedModel(index, "text", ["audio_input"])?.model, "text");
  assert.equal(validateRequestedModel(index, "audio", ["audio_input"]), null);
  assert.equal(validateRequestedModel(index, "off", ["text_input"]), null, "disabled is reported as models_disabled, not a capability mismatch");
  assert.equal(validateRequestedModel(index, "never-heard-of", ["audio_input"]), null, "unknown ids keep working");
  assert.equal(validateRequestedModel(index, "text", []), null);

  const rejection = validateRequestedModel(index, "text", ["audio_input"]);
  assert.match(requestedModelCapabilityMessage(rejection), /Audio input/);
});

test("the no-route message names the capabilities, in the operator's vocabulary", () => {
  assert.match(noCapableRouteMessage(["image_input", "text_input"], "vision"), /Text input, Image input/);
  assert.match(noCapableRouteMessage(["image_input"], "vision"), /Model Configurator/);
});
