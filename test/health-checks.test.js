import test from "node:test";
import assert from "node:assert/strict";
import {
  PROBE_TIMEOUT_MS,
  classifyProbeStatus,
  healthProbePlan,
  probeTargetHealth
} from "../src/health-checks.js";

const geminiTarget = (overrides = {}) => ({
  provider: "gemini",
  model: "gemini-2.0-flash",
  baseUrl: "https://generativelanguage.googleapis.com/",
  apiKey: "gemini-secret-key",
  protocols: ["gemini"],
  keyIndex: 0,
  ...overrides
});

const chatTarget = (overrides = {}) => ({
  provider: "groq",
  model: "llama-x",
  baseUrl: "https://api.groq.com/openai/v1",
  apiKey: "groq-secret-key",
  protocols: ["openai-chat"],
  keyIndex: 0,
  ...overrides
});

/** Minimal fetch stub that records the call and returns a scripted response. */
function stubFetch(response) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    if (typeof response === "function") return response(url, init);
    return {
      status: response.status,
      body: { cancel: async () => {} }
    };
  };
  impl.calls = calls;
  return impl;
}

// ---------------------------------------------------------------------------
// Probe plans
// ---------------------------------------------------------------------------

test("gemini targets probe the native models endpoint with x-goog-api-key", () => {
  const plan = healthProbePlan(geminiTarget());

  assert.equal(plan.url, "https://generativelanguage.googleapis.com/v1beta/models");
  assert.equal(plan.headers["x-goog-api-key"], "gemini-secret-key");
  assert.equal(plan.headers.authorization, undefined);
});

test("gemini base URLs already carrying a version are not double-versioned", () => {
  const plan = healthProbePlan(geminiTarget({ baseUrl: "https://example.test/v1beta" }));
  assert.equal(plan.url, "https://example.test/v1beta/models");
});

test("openai-compatible targets probe the models endpoint on their configured base", () => {
  const versioned = healthProbePlan(chatTarget());
  assert.equal(versioned.url, "https://api.groq.com/openai/v1/models");
  assert.equal(versioned.headers.authorization, "Bearer groq-secret-key");
  assert.equal(versioned.headers["x-goog-api-key"], undefined);

  const bare = healthProbePlan(chatTarget({ baseUrl: "https://agentrouter.org/" }));
  assert.equal(bare.url, "https://agentrouter.org/v1/models");
});

test("openai-responses-only targets are probed through the same family", () => {
  const plan = healthProbePlan(chatTarget({ protocols: ["openai-responses"] }));
  assert.equal(plan.url, "https://api.groq.com/openai/v1/models");
});

test("probe URLs never carry the API key", () => {
  for (const target of [geminiTarget(), chatTarget(), chatTarget({ baseUrl: "https://x.test" })]) {
    const plan = healthProbePlan(target);
    assert.ok(!plan.url.includes(target.apiKey), "key leaked into probe URL");
  }
});

test("no safe probe exists for anthropic-only targets", () => {
  assert.equal(healthProbePlan(chatTarget({ protocols: ["anthropic"] })), null);
});

test("targets without a base URL or key have no probe", () => {
  assert.equal(healthProbePlan(chatTarget({ baseUrl: "" })), null);
  assert.equal(healthProbePlan(chatTarget({ apiKey: "" })), null);
  assert.equal(healthProbePlan(undefined), null);
});

// ---------------------------------------------------------------------------
// Status classification
// ---------------------------------------------------------------------------

test("2xx probe responses are healthy", () => {
  assert.equal(classifyProbeStatus(200).ok, true);
  assert.equal(classifyProbeStatus(204).ok, true);
});

test("authentication failures are never classified as healthy", () => {
  for (const status of [401, 403]) {
    const verdict = classifyProbeStatus(status);
    assert.equal(verdict.ok, false, `HTTP ${status} must not be healthy`);
    assert.match(verdict.reason, /authentication/);
  }
});

test("provider failures are classified as unhealthy", () => {
  for (const status of [402, 408, 429, 500, 502, 503, 504]) {
    assert.equal(classifyProbeStatus(status).ok, false, `HTTP ${status} should be a failure`);
  }
});

test("missing or unimplemented probe endpoints stay passive", () => {
  for (const status of [400, 404, 405, 406, 410, 422, 501]) {
    assert.equal(classifyProbeStatus(status).ok, null, `HTTP ${status} should stay passive`);
  }
});

// ---------------------------------------------------------------------------
// probeTargetHealth
// ---------------------------------------------------------------------------

test("a healthy provider reports ok with the observed status and latency", async () => {
  const fetchImpl = stubFetch({ status: 200 });
  const result = await probeTargetHealth(chatTarget(), { fetchImpl });

  assert.equal(result.ok, true);
  assert.equal(result.status, 200);
  assert.ok(Number.isFinite(result.latencyMs) && result.latencyMs >= 0);
  assert.equal(fetchImpl.calls.length, 1);
  assert.equal(fetchImpl.calls[0].url, "https://api.groq.com/openai/v1/models");
  assert.equal(fetchImpl.calls[0].init.method, "GET");
});

test("a rejected key reports unhealthy and keeps the key out of the reason", async () => {
  const target = chatTarget();
  const result = await probeTargetHealth(target, { fetchImpl: stubFetch({ status: 401 }) });

  assert.equal(result.ok, false);
  assert.equal(result.status, 401);
  assert.match(result.reason, /authentication/);
  assert.ok(!result.reason.includes(target.apiKey));
});

test("a probe against a missing endpoint is passive, not healthy or failed", async () => {
  const result = await probeTargetHealth(chatTarget(), { fetchImpl: stubFetch({ status: 404 }) });

  assert.equal(result.ok, null);
  assert.equal(result.status, 404);
});

test("an unreachable provider reports unhealthy without leaking error text", async () => {
  const target = chatTarget();
  const fetchImpl = async () => {
    throw new Error(`connect ECONNREFUSED while sending ${target.apiKey}`);
  };

  const result = await probeTargetHealth(target, { fetchImpl });

  assert.equal(result.ok, false);
  assert.equal(result.status, 408);
  assert.equal(result.reason, "probe unreachable");
  assert.ok(!result.reason.includes(target.apiKey));
});

test("a slow provider times out and is reported as such", async () => {
  const fetchImpl = (url, init) => new Promise((_, reject) => {
    init.signal.addEventListener("abort", () => {
      const error = new Error("aborted");
      error.name = "AbortError";
      reject(error);
    });
  });

  const result = await probeTargetHealth(chatTarget(), { fetchImpl, timeoutMs: 20 });

  assert.equal(result.ok, false);
  assert.equal(result.status, 408);
  assert.equal(result.reason, "probe timed out");
});

test("probeTargetHealth never rejects", async () => {
  const boom = async () => { throw new TypeError("fetch exploded"); };
  const result = await probeTargetHealth(chatTarget(), { fetchImpl: boom });

  assert.equal(result.ok, false);
  assert.equal(typeof result.reason, "string");
});

test("targets without a probe plan are reported passive without any request", async () => {
  const fetchImpl = stubFetch({ status: 200 });
  const result = await probeTargetHealth(
    chatTarget({ protocols: ["anthropic"] }),
    { fetchImpl }
  );

  assert.equal(result.ok, null);
  assert.match(result.reason, /no safe health probe/);
  assert.equal(fetchImpl.calls.length, 0);
});

test("the probe releases the upstream response body", async () => {
  let cancelled = false;
  const fetchImpl = async () => ({
    status: 200,
    body: { cancel: async () => { cancelled = true; } }
  });

  await probeTargetHealth(chatTarget(), { fetchImpl });

  assert.equal(cancelled, true);
});

test("the default probe timeout is defined and bounded", () => {
  assert.ok(Number.isFinite(PROBE_TIMEOUT_MS));
  assert.ok(PROBE_TIMEOUT_MS <= 10000);
});


test("AgentRouter health probe forwards explicitly configured client headers", () => {
  const plan = healthProbePlan({
    provider: "agentrouter",
    model: "model-a",
    baseUrl: "https://agentrouter.org",
    apiKey: "secret",
    protocols: ["openai-chat"],
    clientHeaders: {
      originator: "approved-client",
      version: "1.2.3",
      "user-agent": "ApprovedClient/1.2.3"
    }
  });

  assert.equal(plan.url, "https://agentrouter.org/v1/models");
  assert.equal(plan.headers.authorization, "Bearer secret");
  assert.equal(plan.headers.originator, "approved-client");
  assert.equal(plan.headers.version, "1.2.3");
  assert.equal(plan.headers["user-agent"], "ApprovedClient/1.2.3");
});
