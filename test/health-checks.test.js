import test from "node:test";
import assert from "node:assert/strict";

import { healthProbePlan, probeTargetHealth, listedModelIds, modelInCatalogue } from "../src/health-checks.js";
import { HealthRegistry, HEALTH_STATES } from "../src/health.js";
import { PROVIDER_IDS } from "../src/config.js";
import { providerProtocols } from "../src/adapters.js";
import { startMockUpstream } from "../test-helpers/mock-upstream.js";
import { startRouter } from "../test-helpers/router-harness.js";

/**
 * Issue E — the docs claimed every probe is quota-free, but Cohere's probe was a
 * generation request, which spent the key's chat quota every cycle and answered
 * 429 once it was gone. Cohere is now probed with its own "Get a Model" call
 * (GET /v1/models/{model}); these tests pin that no probe generates anything.
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

test("no provider's probe sends a generation request", () => {
  const generating = [];
  for (const id of PROVIDER_IDS) {
    for (const baseUrl of [baseFor(id), "https://api.cohere.com/compatibility/v1"]) {
      const plan = healthProbePlan({ ...targetFor(id), baseUrl });
      if (!plan) continue;
      if ((plan.method && plan.method !== "GET") || plan.body) generating.push(`${id} ${baseUrl}`);
    }
  }
  assert.deepEqual(generating, []);
});

const COHERE = { provider: "cohere", model: "command-a-plus-05-2026", apiKey: "k", protocols: ["openai-chat"], keyIndex: 0 };

test("Cohere is probed with its own Get-a-Model call, on the native root of the compatibility base", () => {
  const cases = [
    ["https://api.cohere.com/compatibility/v1", "https://api.cohere.com/v1/models/command-a-plus-05-2026"],
    ["https://api.cohere.ai/compatibility/v1/", "https://api.cohere.ai/v1/models/command-a-plus-05-2026"],
    ["https://api.cohere.com/compatibility", "https://api.cohere.com/v1/models/command-a-plus-05-2026"],
    ["https://vault.example.com/compatibility/v1", "https://vault.example.com/v1/models/command-a-plus-05-2026"]
  ];
  for (const [baseUrl, expected] of cases) {
    const plan = healthProbePlan({ ...COHERE, baseUrl });
    assert.equal(plan.provider, "cohere-model", baseUrl);
    assert.equal(plan.method, "GET");
    assert.equal(plan.url, expected, baseUrl);
    assert.equal(plan.body, undefined, "nothing is generated");
    assert.equal(plan.headers.authorization, "Bearer k");
  }
});

test("the Cohere model id is path-encoded, so it can never alter the probed route", () => {
  const plan = healthProbePlan({ ...COHERE, model: "a/b?c#d", baseUrl: "https://api.cohere.com/compatibility/v1" });
  assert.equal(plan.url, "https://api.cohere.com/v1/models/a%2Fb%3Fc%23d");
});

test("a Cohere base that is not a compatibility base falls back to the generic models probe", () => {
  const plan = healthProbePlan({ ...COHERE, baseUrl: "https://gw.example.com/v1" });
  assert.equal(plan.provider, "openai-compatible");
  assert.equal(plan.url, "https://gw.example.com/v1/models");
});

const answer = (status, body) => async () => new Response(JSON.stringify(body ?? {}), { status, headers: { "content-type": "application/json" } });
const cohereProbe = (fetchImpl) => probeTargetHealth({ ...COHERE, baseUrl: "https://api.cohere.com/compatibility/v1" }, { fetchImpl });

test("a Cohere 200 for the model is healthy and confirms the model; it never touches the chat endpoint", async () => {
  const seen = [];
  const result = await cohereProbe(async (url, init) => {
    seen.push([init.method, url]);
    return new Response(JSON.stringify({ name: "command-a-plus-05-2026", endpoints: ["chat"], is_deprecated: false }), { status: 200 });
  });
  assert.deepEqual(seen, [["GET", "https://api.cohere.com/v1/models/command-a-plus-05-2026"]]);
  assert.equal(result.ok, true);
  assert.equal(result.status, 200);
  assert.equal(result.modelListed, true);

  const registry = new HealthRegistry();
  registry.recordHealthCheck({ ...COHERE }, result);
  assert.equal(registry.get(registry.key(COHERE)).status, HEALTH_STATES.HEALTHY, "the target leaves unknown");
});

test("a Cohere 200 for a different model name is healthy but does not confirm this model", async () => {
  const result = await cohereProbe(answer(200, { name: "something-else" }));
  assert.equal(result.ok, true);
  assert.equal(result.modelListed, null);
});

test("Cohere answers are classified as every other provider's are", async () => {
  assert.equal((await cohereProbe(answer(401))).ok, false, "a rejected key is never healthy");
  assert.equal((await cohereProbe(answer(403))).ok, false);
  assert.equal((await cohereProbe(answer(429))).ok, false, "a genuine rate limit still counts");
  assert.equal((await cohereProbe(answer(503))).ok, false);
  const missing = await cohereProbe(answer(404));
  assert.equal(missing.ok, null, "a 404 may be a wrong route as well as a missing model: unknown, not failed");
  assert.equal(missing.modelListed, null, "and never claims the model is absent");
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

test("a started server marks Cohere targets healthy from Get-a-Model alone, and sends no chat request", async () => {
  const seen = [];
  const cohere = await startMockUpstream(() => ({ status: 500, body: {} }), {
    health: (record) => {
      seen.push(`${record.method} ${record.url}`);
      const match = /^\/v1\/models\/([^/?]+)$/.exec(record.url);
      if (!match || record.headers.authorization !== "Bearer COHERE-SECRET") return { status: 404, body: {} };
      return { status: 200, body: { name: decodeURIComponent(match[1]), endpoints: ["chat"] } };
    }
  });
  const router = await startRouter({
    COHERE_API_KEYS: "COHERE-SECRET",
    COHERE_MODELS: "command-a-plus-05-2026,north-mini-code-1-0",
    COHERE_BASE_URL: `${cohere.baseUrl}/compatibility/v1`
  });
  try {
    const health = await router.request("/api/health").then((response) => response.json());
    const targets = health.targets.filter((target) => target.provider === "cohere");
    assert.equal(targets.length, 2);
    for (const target of targets) {
      assert.equal(target.status, "healthy", `${target.model}: ${target.lastReason}`);
      assert.equal(target.modelListed, true, `${target.model} is confirmed by the lookup`);
      assert.equal(target.cooldownUntil, 0);
    }
    assert.deepEqual(new Set(seen), new Set([
      "GET /v1/models/command-a-plus-05-2026",
      "GET /v1/models/north-mini-code-1-0"
    ]), "one lookup per model, nothing else");
    assert.equal(cohere.requests.some((record) => record.method === "POST"), false, "no generation request was sent");
  } finally {
    await router.close();
    await cohere.close();
  }
});
