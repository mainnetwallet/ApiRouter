import test from "node:test";
import assert from "node:assert/strict";

import { healthProbePlan, probeTargetHealth, listedModelIds, modelInCatalogue } from "../src/health-checks.js";
import { HealthRegistry, HEALTH_STATES } from "../src/health.js";
import { PROVIDER_IDS } from "../src/config.js";
import { providerProtocols } from "../src/adapters.js";

/**
 * Issue E — the docs claimed every probe is quota-free, but Cohere's probe is a
 * generation request. The deviation is deliberate (Cohere's compatibility
 * surface has no dependable model-list probe); these tests pin it so it cannot
 * change silently, and so the documented cost stays true.
 *
 * Issue F — health described the KEY and the endpoint, never the model. A valid
 * key against a reachable /models endpoint reported `healthy` even when the
 * configured model did not exist. The probe now also reports `modelListed`,
 * which must never be conflated with `status`.
 */

// ------------------------------------------------------------ probe plans

const baseFor = (id) => (id === "cloudflare"
  ? "https://api.cloudflare.com/client/v4/accounts/acc/ai/v1"
  : id === "gemini" ? "https://generativelanguage.googleapis.com/v1beta" : "https://api.example.com/v1");

const targetFor = (id) => ({
  provider: id,
  model: "m",
  baseUrl: baseFor(id),
  apiKey: "k",
  protocols: providerProtocols(id),
  keyIndex: 0
});

test("no provider's probe sends a generation request, except the documented Cohere exception", () => {
  const generating = [];
  for (const id of PROVIDER_IDS) {
    const plan = healthProbePlan(targetFor(id));
    if (!plan) continue;
    if (plan.method === "POST" || plan.body) generating.push(id);
  }
  // Exactly one, and it is the one the README and Architecture.md call out.
  assert.deepEqual(generating, ["cohere"]);
});

test("the Cohere probe is pinned as a generation request, and says so in its name", () => {
  const plan = healthProbePlan(targetFor("cohere"));
  assert.equal(plan.method, "POST");
  assert.ok(plan.url.endsWith("/chat/completions"), plan.url);
  const body = JSON.parse(plan.body);
  assert.equal(body.model, "m");
  assert.equal(body.stream, false);
  assert.equal(body.max_tokens, 1, "the probe must stay the smallest useful generation request");
  assert.ok(Array.isArray(body.messages) && body.messages.length > 0, "the probe sends a prompt");
  assert.equal(plan.provider, "cohere-chat");
});

test("no probe URL carries a credential in the query string", () => {
  for (const id of PROVIDER_IDS) {
    const plan = healthProbePlan(targetFor(id));
    if (!plan) continue;
    assert.ok(!/[?&](key|api_key|token|access_token)=/i.test(plan.url), `${id}: ${plan.url}`);
  }
});

// ---------------------------------------------------- model-list reading

test("listedModelIds reads the OpenAI and Gemini catalogue shapes, and nothing else", () => {
  assert.deepEqual(listedModelIds({ data: [{ id: "a" }, { id: "b" }] }), ["a", "b"]);
  assert.deepEqual(listedModelIds({ models: [{ name: "models/a" }, { id: "b" }] }), ["models/a", "b"]);
  // Unrecognized shapes are "cannot tell", never an empty list.
  assert.equal(listedModelIds({ result: [{ name: "x" }] }), null);
  assert.equal(listedModelIds(null), null);
  assert.equal(listedModelIds("nope"), null);
});

test("modelInCatalogue accepts Gemini's models/<id> spelling and rejects a genuine miss", () => {
  assert.equal(modelInCatalogue(["models/gemini-3.8-flash"], "gemini-3.8-flash"), true);
  assert.equal(modelInCatalogue(["gemini-3.8-flash"], "gemini-3.8-flash"), true);
  assert.equal(modelInCatalogue(["other"], "gemini-3.8-flash"), false);
  assert.equal(modelInCatalogue(null, "m"), null);
  assert.equal(modelInCatalogue([], ""), null);
});

// ---------------------------------------------------- probe end to end

function jsonResponse(status, body) {
  return {
    status,
    headers: { get: () => null },
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
    body: { cancel: async () => {} }
  };
}

const groqTarget = (model = "m") => ({
  provider: "groq", model, baseUrl: "https://api.groq.com/openai/v1", apiKey: "k", protocols: ["openai-chat"], keyIndex: 0
});

test("probe reports modelListed: false when the catalogue is readable and does not name the model", async () => {
  const result = await probeTargetHealth(groqTarget("ghost-model"), {
    fetchImpl: async () => jsonResponse(200, { data: [{ id: "real-model" }] })
  });
  assert.equal(result.ok, true, "the key is valid, so the probe is healthy");
  assert.equal(result.status, 200);
  assert.equal(result.modelListed, false);
});

test("probe reports modelListed: true when the catalogue names the model", async () => {
  const result = await probeTargetHealth(groqTarget("real-model"), {
    fetchImpl: async () => jsonResponse(200, { data: [{ id: "real-model" }] })
  });
  assert.equal(result.modelListed, true);
});

test("probe reports modelListed: null when it cannot tell", async () => {
  const cases = [
    ["a non-200 status", jsonResponse(404, { error: "nope" })],
    ["an unrecognized shape", jsonResponse(200, { result: [] })],
    ["a non-JSON body", jsonResponse(200, "<html>not json</html>")]
  ];
  for (const [label, response] of cases) {
    const result = await probeTargetHealth(groqTarget(), { fetchImpl: async () => response });
    assert.equal(result.modelListed, null, `${label} must not be read as "missing"`);
  }
});

test("probe survives a response object with no readable body at all", async () => {
  const result = await probeTargetHealth(groqTarget(), { fetchImpl: async () => ({ status: 200 }) });
  assert.equal(result.ok, true);
  assert.equal(result.modelListed, null);
});

// ---------------------------------------------------- registry separation

test("modelListed is recorded without ever changing status, score or cooldown", () => {
  const registry = new HealthRegistry();
  const target = groqTarget("ghost-model");

  registry.recordHealthCheck(target, { ok: true, status: 200, modelListed: false }, 1000);
  const state = registry.ensureTarget(target);
  assert.equal(state.status, HEALTH_STATES.HEALTHY, "a valid key is still healthy");
  assert.equal(state.modelListed, false, "but the model is reported as absent");
  assert.equal(state.cooldownUntil, 0, "and nothing was cooled down");

  const described = registry.describe([target], 1000)[0];
  assert.equal(described.status, "healthy");
  assert.equal(described.modelListed, false);
});

test("an unreadable catalogue replaces the reported value but keeps the last confirmed one", () => {
  const registry = new HealthRegistry();
  const target = groqTarget("ghost-model");

  registry.recordHealthCheck(target, { ok: true, status: 200, modelListed: false }, 1000);
  registry.recordHealthCheck(target, { ok: true, status: 200, modelListed: null }, 2000);

  const state = registry.ensureTarget(target);
  // This test used to assert the OPPOSITE — that `false` was retained and
  // reported. That was the bug: the documented contract says `modelListed` is
  // what the catalogue said on the LAST probe, and it kept saying `false` after
  // a probe that could not read the catalogue at all, so the panel presented a
  // stale absence as a fresh confirmation.
  assert.equal(state.modelListed, null, "the latest observation is 'could not tell'");
  assert.equal(state.modelListedAt, new Date(2000).toISOString());
  // Nothing is lost: the last definite result is retained separately, dated.
  assert.equal(state.modelListedConfirmed, false);
  assert.equal(state.modelListedConfirmedAt, new Date(1000).toISOString());

  // A caller that reports no catalogue observation at all is not an observation,
  // so it leaves the signal untouched rather than clearing it.
  registry.recordHealthCheck(target, { ok: true, status: 200 }, 3000);
  assert.equal(registry.ensureTarget(target).modelListed, null);
  assert.equal(registry.ensureTarget(target).modelListedAt, new Date(2000).toISOString());
});

test("modelListed is kept while a target is cooling down, because it describes the catalogue and not the health", () => {
  const registry = new HealthRegistry();
  const target = groqTarget("ghost-model");

  registry.markFailure(target, 500, {}, 1000);
  assert.ok(registry.ensureTarget(target).cooldownUntil > 1000);

  registry.recordHealthCheck(target, { ok: true, status: 200, modelListed: true }, 1100);
  const state = registry.ensureTarget(target);
  assert.equal(state.status, HEALTH_STATES.FAILED, "the cooldown guard still freezes health");
  assert.equal(state.modelListed, true, "but the catalogue fact is still recorded");
});

test("a target is never reported as a confirmed usable model just because its key works", () => {
  const registry = new HealthRegistry();
  const target = groqTarget("ghost-model");
  registry.recordHealthCheck(target, { ok: true, status: 200, modelListed: false }, 1000);

  const [row] = registry.describe([target], 1000);
  // Both facts are present and distinct: the operator can see that the key is
  // fine while the model is not offered.
  assert.equal(row.status, "healthy");
  assert.equal(row.modelListed, false);
  assert.notEqual(row.status, "unknown");
});

test("a target that was never probed reports modelListed as null, not false", () => {
  const registry = new HealthRegistry();
  const [row] = registry.describe([groqTarget()], 1000);
  assert.equal(row.modelListed, null);
});
