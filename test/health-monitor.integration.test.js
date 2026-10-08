import test from "node:test";
import assert from "node:assert/strict";
import { startMockUpstream } from "../test-helpers/mock-upstream.js";
import { startRouter, postJson } from "../test-helpers/router-harness.js";

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function withRig(t, { script, health, env }) {
  const upstream = await startMockUpstream(script ?? (() => ({ status: 200, body: { ok: true } })), { health });
  const router = await startRouter(env(upstream));
  t.after(async () => {
    await router.close();
    await upstream.close();
  });
  return { upstream, router };
}

/** Poll GET /health until `predicate` holds, so tests never race the probe. */
async function waitForHealth(router, predicate, { timeoutMs = 5000, label = "health" } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = null;

  while (Date.now() < deadline) {
    last = await (await router.request("/health")).json();
    if (predicate(last)) return last;
    await delay(25);
  }

  throw new Error(`${label} condition not met within ${timeoutMs}ms; last=${JSON.stringify(last?.health)}`);
}

const groqEnv = (u) => ({
  GROQ_API_KEYS: "groq-key",
  GROQ_MODELS: "llama-x",
  GROQ_BASE_URL: u.baseUrl
});

const HEALTHY_BODY = { data: [{ id: "llama-x", object: "model" }] };

// ---------------------------------------------------------------------------
// Probe strategy selection
// ---------------------------------------------------------------------------

test("an OpenAI-compatible target is probed on its models endpoint with a bearer key", async (t) => {
  const { upstream, router } = await withRig(t, {
    health: { status: 200, body: HEALTHY_BODY },
    env: groqEnv
  });

  await waitForHealth(router, (h) => h.health[0]?.status === "healthy");

  const probe = upstream.requests.find((r) => r.method === "GET");
  assert.ok(probe, "no health probe was issued");
  assert.equal(probe.url, "/v1/models");
  assert.equal(probe.headers.authorization, "Bearer groq-key");
  assert.equal(probe.headers["x-goog-api-key"], undefined);

  // Routing must still reach the provider normally.
  const res = await router.request("/v1/chat/completions", postJson({ model: "llama-x", messages: [] }));
  assert.equal(res.status, 200);
});

test("a Gemini target is probed natively with x-goog-api-key and never a bearer token", async (t) => {
  const { upstream, router } = await withRig(t, {
    health: { status: 200, body: { models: [] } },
    env: (u) => ({
      GEMINI_API_KEYS: "gemini-key",
      GEMINI_MODELS: "gemini-2.0-flash",
      GEMINI_BASE_URL: u.baseUrl
    })
  });

  await waitForHealth(router, (h) => h.health[0]?.status === "healthy");

  const probe = upstream.requests.find((r) => r.method === "GET");
  assert.equal(probe.url, "/v1beta/models");
  assert.equal(probe.headers["x-goog-api-key"], "gemini-key");
  assert.equal(probe.headers.authorization, undefined);
});

// ---------------------------------------------------------------------------
// Probe outcomes
// ---------------------------------------------------------------------------

test("a healthy probe records the observed status, latency and success count", async (t) => {
  const { router } = await withRig(t, {
    health: { status: 200, body: HEALTHY_BODY },
    env: groqEnv
  });

  const health = await waitForHealth(router, (h) => h.health[0]?.status === "healthy");
  const entry = health.health[0];

  assert.equal(entry.provider, "groq");
  assert.equal(entry.lastStatus, 200);
  assert.equal(entry.failures, 0);
  assert.equal(entry.consecutiveFailures, 0);
  assert.ok(entry.successes >= 1);
  assert.ok(Number.isFinite(entry.latencyMs) && entry.latencyMs >= 0);
  assert.ok(entry.score > 50);
  assert.deepEqual(entry.protocols, ["openai-chat"]);
});

for (const status of [401, 403]) {
  test(`an HTTP ${status} probe cools the target down and is never reported healthy`, async (t) => {
    const { router } = await withRig(t, {
      health: { status, body: { error: "denied" } },
      env: groqEnv
    });

    const health = await waitForHealth(router, (h) => h.health[0]?.status === "cooldown");
    const entry = health.health[0];

    assert.equal(entry.lastStatus, status);
    assert.equal(entry.consecutiveFailures, 1);
    assert.equal(entry.successes, 0);
    assert.match(entry.lastReason, /authentication/);
    assert.ok(entry.cooldownUntil > Date.now() - 1);

    // A cooled-down target is not routable.
    assert.equal(health.rankedTargets.length, 0);
    const res = await router.request("/v1/chat/completions", postJson({ model: "llama-x", messages: [] }));
    assert.equal(res.status, 503);
  });
}

for (const status of [429, 500, 503]) {
  test(`an HTTP ${status} probe cools the target down`, async (t) => {
    const { router } = await withRig(t, {
      health: { status, body: { error: "nope" } },
      env: groqEnv
    });

    const health = await waitForHealth(router, (h) => h.health[0]?.status === "cooldown");
    assert.equal(health.health[0].lastStatus, status);
    assert.equal(health.health[0].failures, 1);
  });
}

test("a missing models endpoint yields passive unknown health, not a false claim", async (t) => {
  const { upstream, router } = await withRig(t, {
    health: { status: 404, body: {} },
    env: groqEnv
  });

  // Give the probe time to land, then confirm nothing was claimed.
  await delay(400);
  const health = await (await router.request("/health")).json();
  const entry = health.health[0];

  assert.equal(upstream.requests.some((r) => r.method === "GET"), true, "probe never ran");
  assert.equal(entry.status, "unknown");
  assert.equal(entry.successes, 0);
  assert.equal(entry.failures, 0);
  assert.equal(entry.lastStatus, null);
  assert.equal(entry.cooldownUntil, 0);
  assert.match(entry.lastReason, /not supported/);

  // A passive target stays routable.
  assert.equal(health.rankedTargets.length, 1);
  const res = await router.request("/v1/chat/completions", postJson({ model: "llama-x", messages: [] }));
  assert.equal(res.status, 200);
});

test("a probe that times out is recorded as a failure", async (t) => {
  const { router } = await withRig(t, {
    health: { hang: true },
    env: (u) => ({ ...groqEnv(u), REQUEST_TIMEOUT_MS: "300" })
  });

  const health = await waitForHealth(router, (h) => h.health[0]?.status === "cooldown");
  const entry = health.health[0];

  assert.equal(entry.lastStatus, 408);
  assert.equal(entry.lastReason, "probe timed out");
});

test("a slow but successful probe records its real latency", async (t) => {
  const { router } = await withRig(t, {
    health: { status: 200, body: HEALTHY_BODY, delayMs: 120 },
    env: groqEnv
  });

  const health = await waitForHealth(router, (h) => h.health[0]?.status === "healthy");
  assert.ok(
    health.health[0].latencyMs >= 100,
    `expected a latency reflecting the delay, got ${health.health[0].latencyMs}`
  );
});

// ---------------------------------------------------------------------------
// Per-target isolation
// ---------------------------------------------------------------------------

test("a key rejected by the health probe does not disable its sibling key", async (t) => {
  const { upstream, router } = await withRig(t, {
    health: (record) => (record.headers.authorization === "Bearer bad-key"
      ? { status: 401, body: { error: "invalid key" } }
      : { status: 200, body: HEALTHY_BODY }),
    env: (u) => ({
      GROQ_API_KEYS: "bad-key,good-key",
      GROQ_MODELS: "llama-x",
      GROQ_BASE_URL: u.baseUrl
    })
  });

  const health = await waitForHealth(router, (h) =>
    h.health[0]?.status === "cooldown" && h.health[1]?.status === "healthy");

  assert.equal(health.health[0].keyIndex, 0);
  assert.equal(health.health[0].lastStatus, 401);
  assert.equal(health.health[1].keyIndex, 1);
  assert.equal(health.health[1].lastStatus, 200);

  // Only the healthy sibling remains routable, and it is the one used.
  assert.deepEqual(health.rankedTargets.map((r) => r.keyIndex), [1]);

  const res = await router.request("/v1/chat/completions", postJson({ model: "llama-x", messages: [] }));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("x-multi-ai-key-index"), "1");
  assert.equal(upstream.apiRequests.length, 1);
  assert.equal(upstream.apiRequests[0].headers.authorization, "Bearer good-key");
});

test("a failing model cools only its own targets", async (t) => {
  const { router } = await withRig(t, {
    // Passive probes so this test isolates routing-driven health only.
    health: { status: 404, body: {} },
    script: (record) => (record.body?.model === "model-a"
      ? { status: 503, body: { error: { message: "down" } } }
      : { status: 200, body: { ok: true } }),
    env: (u) => ({
      GROQ_API_KEYS: "k0,k1",
      GROQ_MODELS: "model-a,model-b",
      GROQ_BASE_URL: u.baseUrl
    })
  });

  // Key-scoped fallback: key k0 tries model-a first and it fails; k0 then
  // continues to model-b on the same key, which serves the request. Key k1 is
  // never reached, so its model-a target is untouched.
  const fellBack = await router.request(
    "/v1/chat/completions",
    postJson({ model: "model-a", messages: [] })
  );
  assert.equal(fellBack.status, 200);

  const health = await (await router.request("/health")).json();
  const modelA = health.health.filter((e) => e.model === "model-a");
  const modelB = health.health.filter((e) => e.model === "model-b");

  // Only the target that actually failed (model-a on k0) is cooled down.
  assert.equal(modelA.length, 2);
  assert.equal(modelA.filter((e) => e.status === "cooldown").length, 1, "only the failing model-a target should be cooled");
  assert.equal(modelA.find((e) => e.keyIndex === 0).status, "cooldown");
  assert.equal(modelA.reduce((n, e) => n + e.failures, 0), 1);

  // The failure never marks model-b, which only served the fallback.
  assert.equal(modelB.length, 2);
  assert.equal(modelB.reduce((n, e) => n + e.failures, 0), 0, "model-b must record no failures");
  assert.ok(modelB.every((e) => e.status !== "cooldown"), "model-b must not be cooled");

  // model-b's targets never failed and still serve traffic.
  const served = await router.request(
    "/v1/chat/completions",
    postJson({ model: "model-b", messages: [] })
  );
  assert.equal(served.status, 200);
});

// ---------------------------------------------------------------------------
// Security
// ---------------------------------------------------------------------------

test("GET /health never exposes provider credentials", async (t) => {
  const secret = "sk-super-secret-provider-key";
  const { router } = await withRig(t, {
    health: { status: 200, body: HEALTHY_BODY },
    env: (u) => ({
      GROQ_API_KEYS: secret,
      GROQ_MODELS: "llama-x",
      GROQ_BASE_URL: u.baseUrl
    })
  });

  await waitForHealth(router, (h) => h.health[0]?.status === "healthy");

  const res = await router.request("/health");
  const text = await res.text();

  assert.ok(!text.includes(secret), "provider key leaked through /health");
  assert.ok(!text.includes("authorization"), "/health exposed an authorization header");
  assert.ok(!text.includes("Bearer "), "/health exposed a bearer token");
});

test("the health report surfaces target detail useful for operations", async (t) => {
  const { router } = await withRig(t, {
    health: { status: 200, body: HEALTHY_BODY },
    env: groqEnv
  });

  const health = await waitForHealth(router, (h) => h.health[0]?.status === "healthy");
  const entry = health.health[0];

  for (const key of [
    "provider", "model", "keyIndex", "protocols", "status", "score",
    "latencyMs", "successes", "failures", "consecutiveFailures",
    "lastStatus", "cooldownUntil", "updatedAt"
  ]) {
    assert.ok(key in entry, `/health health entry is missing "${key}"`);
  }
});
