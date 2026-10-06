import test from "node:test";
import assert from "node:assert/strict";
import { startMockUpstream } from "../test-helpers/mock-upstream.js";
import { startRouter, postJson } from "../test-helpers/router-harness.js";

const PROVIDER_KEY = "sk-super-secret-provider-key";
const ROUTER_KEY = "router-secret-token";

/** Patterns that must never appear in an admin response. */
const FORBIDDEN = [
  { pattern: PROVIDER_KEY, label: "provider API key" },
  { pattern: ROUTER_KEY, label: "router API key" },
  { pattern: "Bearer ", label: "bearer token" },
  { pattern: "authorization", label: "authorization header name" }
];

async function withRig(t, { script = () => ({ status: 200, body: { ok: true } }), env = {}, health } = {}) {
  const upstream = await startMockUpstream(script, health ? { health } : {});
  const router = await startRouter({
    GROQ_API_KEYS: `${PROVIDER_KEY},second-secret-key`,
    GROQ_MODELS: "model-a,model-b",
    GROQ_BASE_URL: upstream.baseUrl,
    ...env
  });
  t.after(async () => {
    await router.close();
    await upstream.close();
  });
  return { upstream, router };
}

async function getJson(router, path, headers = {}) {
  const res = await router.request(path, { headers });
  return { res, body: await res.json() };
}

const assertNoCredentialLeak = (res, body, label) => {
  const text = JSON.stringify(body) + [...res.headers.entries()].flat().join(" ");
  for (const { pattern, label: what } of FORBIDDEN) {
    assert.ok(!text.includes(pattern), `${what} leaked from ${label}`);
  }
};

// ---------------------------------------------------------------------------
// Endpoint availability and shape
// ---------------------------------------------------------------------------

const READ_ENDPOINTS = [
  "/api/health",
  "/api/providers",
  "/api/models",
  "/api/config",
  "/api/system",
  "/api/requests",
  "/api/analytics"
];

for (const path of READ_ENDPOINTS) {
  test(`GET ${path} returns 200 JSON and leaks no credentials`, async (t) => {
    const { router } = await withRig(t);

    const { res, body } = await getJson(router, path);

    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /application\/json/);
    assert.ok(body && typeof body === "object", `${path} did not return an object`);
    assertNoCredentialLeak(res, body, path);
  });
}

test("GET /api/health reports summary, targets, ranking and the monitor", async (t) => {
  const { router } = await withRig(t);

  const { body } = await getJson(router, "/api/health");

  assert.equal(body.ok, true);
  // 2 models x 2 keys
  assert.equal(body.summary.total, 4);
  assert.equal(body.targets.length, 4);
  assert.equal(body.ranked.length, 4);
  assert.deepEqual(body.retryableStatus, [401, 402, 403, 404, 408, 409, 425, 429, 500, 501, 502, 503, 504, 520, 521, 522, 523, 524, 529]);
  assert.deepEqual(body.states.sort(), ["cooldown", "failed", "healthy", "unknown"]);
  assert.ok(body.monitor === null || typeof body.monitor === "object");
  assert.equal(body.ranked[0].rank, 1);
  // "ranked" is the deterministic route order (key-major), with real fields.
  assert.deepEqual(
    body.ranked.map((r) => `${r.provider}/${r.model}/${r.keyIndex}`),
    ["groq/model-a/0", "groq/model-b/0", "groq/model-a/1", "groq/model-b/1"]
  );

  for (const key of ["provider", "model", "keyIndex", "status", "score", "latencyMs", "successes", "failures"]) {
    assert.ok(key in body.targets[0], `health target missing "${key}"`);
  }
});

test("GET /api/providers groups targets per provider and reports key counts", async (t) => {
  const { router } = await withRig(t);

  const { body } = await getJson(router, "/api/providers");
  const groq = body.providers.find((provider) => provider.id === "groq");

  assert.equal(groq.configured, true);
  assert.equal(groq.keyCount, 2);
  assert.equal(groq.modelCount, 2);
  assert.equal(groq.targetCount, 4);
  assert.equal(groq.targets.length, 4);
  assert.equal(groq.baseUrl, (await getJson(router, "/api/config")).body.providers.find((p) => p.id === "groq").baseUrl);
  assert.equal(body.summary.configuredTargets, 4);
});

test("GET /api/models exposes a filterable catalogue", async (t) => {
  const { router } = await withRig(t);

  const { body } = await getJson(router, "/api/models");

  assert.equal(body.models.length, 4);
  assert.deepEqual(body.filters.providers, ["groq"]);
  assert.deepEqual(body.filters.protocols, ["openai-chat"]);
  assert.equal(body.models[0].provider, "groq");
  assert.ok("successRate" in body.models[0]);
});

test("GET /api/config reports safe values and never a secret", async (t) => {
  const { router } = await withRig(t, { env: { MULTIAI_ROUTER_API_KEYS: ROUTER_KEY } });

  const { res, body } = await getJson(router, "/api/config", { authorization: `Bearer ${ROUTER_KEY}` });

  assert.equal(body.server.clientAuthRequired, true);
  assert.equal(body.server.clientKeyCount, 1);
  assert.equal(body.routing.exactModelPreferred, true);
  assert.deepEqual(body.providers.find((p) => p.id === "groq").models, ["model-a", "model-b"]);
  assert.equal(body.providers.find((p) => p.id === "groq").keyCount, 2);
  assert.ok(Array.isArray(body.environment.providers));
  assertNoCredentialLeak(res, body, "/api/config");
});

test("GET /api/system reports runtime and monitor status", async (t) => {
  const { router } = await withRig(t);

  const { body } = await getJson(router, "/api/system");

  assert.equal(body.service, "multi-ai-router");
  assert.equal(body.status, "ok");
  assert.equal(body.runtime, "node");
  assert.equal(body.nodeVersion, process.version);
  assert.equal(body.configuredTargets, 4);
  assert.equal(
    body.pools.text.configuredTargets + body.pools.vision.configuredTargets,
    body.configuredTargets,
    "per-pool target counts should add up to the total"
  );
  assert.equal(body.pools.text.pool, "text");
  assert.equal(body.pools.vision.pool, "vision");
  assert.ok(Array.isArray(body.pools.vision.providers.loaded));
  assert.ok(body.uptimeMs >= 0);
  assert.ok(body.pid > 0);
  assert.equal(body.telemetry.persistence, "in-memory");
  assert.equal(body.healthMonitor.enabled, true);
  assert.equal(body.healthMonitor.intervalMs, 900000);
  assert.ok(body.healthMonitor.cycles >= 1, "the startup cycle should have been observed");
  assert.ok(body.healthMonitor.lastCycle.completedAt);
});

test("GET /api/analytics labels its source and never fabricates metrics", async (t) => {
  const { router } = await withRig(t);

  const empty = await getJson(router, "/api/analytics?range=1h");
  assert.equal(empty.body.sampleSize, 0);
  assert.equal(empty.body.summary.total, 0);
  assert.equal(empty.body.summary.avgLatencyMs, null);
  assert.ok(empty.body.unavailable.length > 0, "an empty range must be labelled unavailable");
  assert.equal(empty.body.range.label, "1h");
  assert.ok(empty.body.series.length > 1);

  await router.request("/v1/chat/completions", postJson({ model: "model-a", messages: [] }));

  const filled = await getJson(router, "/api/analytics?range=1h");
  assert.equal(filled.body.sampleSize, 1);
  assert.equal(filled.body.summary.total, 1);
  assert.equal(filled.body.summary.successful, 1);
  assert.equal(filled.body.unavailable.length, 0);
  assert.equal(filled.body.breakdowns.provider[0].key, "groq");
  assert.equal(filled.body.breakdowns.protocol[0].key, "openai-chat");
});

// ---------------------------------------------------------------------------
// Request log
// ---------------------------------------------------------------------------

test("a proxied request appears in /api/requests with its real target", async (t) => {
  const { upstream, router } = await withRig(t);

  const proxied = await router.request("/v1/chat/completions", postJson({ model: "model-a", messages: [] }));
  assert.equal(proxied.status, 200);

  const { body } = await getJson(router, "/api/requests");

  assert.equal(body.total, 1);
  assert.equal(body.entries.length, 1);

  const entry = body.entries[0];
  assert.equal(entry.protocol, "openai-chat");
  assert.equal(entry.finalProvider, "groq");
  assert.equal(entry.finalModel, "model-a");
  assert.equal(entry.httpStatus, 200);
  assert.equal(entry.outcome, "success");
  assert.equal(entry.attemptCount, 1);
  assert.equal(entry.fallbackCount, 0);
  assert.equal(entry.attempts[0].ok, true);
  assert.ok(Number.isFinite(entry.latencyMs));
  assert.ok(upstream.apiRequests.length === 1);
});

test("the fallback chain is recorded from real attempts", async (t) => {
  let n = 0;
  const { router } = await withRig(t, {
    script: () => (++n === 1 ? { status: 429, body: { error: { message: "slow down" } } } : { status: 200, body: { ok: true } })
  });

  const res = await router.request("/v1/chat/completions", postJson({ model: "model-a", messages: [] }));
  assert.equal(res.status, 200);

  const { body } = await getJson(router, "/api/requests");
  const entry = body.entries[0];

  assert.equal(entry.attemptCount, 2);
  assert.equal(entry.fallbackCount, 1);
  assert.equal(entry.attempts[0].ok, false);
  assert.equal(entry.attempts[0].status, 429);
  assert.equal(entry.attempts[1].ok, true);
  assert.equal(entry.outcome, "success");
});

test("each real attempt records its key index and a start time, never a key value", async (t) => {
  let n = 0;
  const { router } = await withRig(t, {
    script: () => (++n === 1 ? { status: 429, body: { error: { message: "slow down" } } } : { status: 200, body: { ok: true } })
  });

  const before = Date.now();
  const res = await router.request("/v1/chat/completions", postJson({ model: "model-a", messages: [] }));
  assert.equal(res.status, 200);

  const { res: logRes, body } = await getJson(router, "/api/requests");
  const [first, second] = body.entries[0].attempts;

  // Key-scoped fallback: key 0 runs its own model chain (model-a, then
  // model-b) before key 1 is touched. Two separate recorded attempts.
  assert.deepEqual([first.model, second.model], ["model-a", "model-b"]);
  assert.deepEqual([first.keyIndex, second.keyIndex], [0, 0]);
  assert.equal(first.status, 429);
  assert.equal(second.status, 200);

  for (const attempt of [first, second]) {
    assert.ok(Number.isFinite(attempt.startedAt));
    assert.ok(attempt.startedAt >= before);
  }
  assert.ok(second.startedAt >= first.startedAt);

  assertNoCredentialLeak(logRes, body, "/api/requests");
});

test("a fully failed request is logged with per-attempt detail", async (t) => {
  const { router } = await withRig(t, {
    script: () => ({ status: 503, body: { error: { message: "unavailable" } } })
  });

  const res = await router.request("/v1/chat/completions", postJson({ model: "model-a", messages: [] }));
  assert.equal(res.status, 502);

  const { body } = await getJson(router, "/api/requests");
  const entry = body.entries[0];

  assert.equal(entry.outcome, "failed");
  assert.equal(entry.httpStatus, 502);
  // The exact model match is tried first, then routing widens to the other
  // configured model — two keys each.
  assert.equal(entry.attempts.length, 4);
  assert.ok(entry.attempts.every((attempt) => attempt.ok === false));
  assert.equal(entry.attempts[0].errorMessage.includes(PROVIDER_KEY), false);
});

test("the request id resolves one request; a session id is looked up explicitly", async (t) => {
  const { router } = await withRig(t);

  const proxied = await router.request("/v1/chat/completions", postJson({ model: "model-a", messages: [] }));
  assert.equal(proxied.status, 200);
  const requestId = proxied.headers.get("x-multi-ai-request-id");
  const sessionId = proxied.headers.get("x-multi-ai-session-id");
  assert.ok(requestId, "every response names the request it answered");
  assert.ok(sessionId, "every response names the sticky session");
  assert.notEqual(requestId, sessionId);

  const { res, body } = await getJson(router, `/api/requests/${requestId}`);
  assert.equal(res.status, 200);
  assert.equal(body.request.requestId, requestId);
  assert.equal(body.request.id, sessionId);

  // A session id names many requests, so the single-request endpoint must not
  // resolve it — that was the ambiguity this contract removes.
  const bySession = await getJson(router, `/api/requests/${sessionId}`);
  assert.equal(bySession.res.status, 404, "a session id must not be ambiguous with a request id");

  // It is looked up through the explicit session filter instead.
  const listed = await getJson(router, `/api/requests?session=${encodeURIComponent(sessionId)}`);
  assert.equal(listed.res.status, 200);
  assert.ok(listed.body.entries.length >= 1);
  assert.ok(listed.body.entries.every((row) => row.id === sessionId));
  assert.ok(listed.body.entries.every((row) => row.requestId !== sessionId));
  assert.ok(listed.body.entries.some((row) => row.requestId === requestId));

  const missing = await getJson(router, "/api/requests/does-not-exist");
  assert.equal(missing.res.status, 404);
  assert.equal(missing.body.error.type, "not_found");
});

test("/api/requests paginates without repeating or skipping entries", async (t) => {
  const { router } = await withRig(t);

  for (let i = 0; i < 5; i += 1) {
    await router.request("/v1/chat/completions", postJson({ model: "model-a", messages: [] }));
  }

  const first = await getJson(router, "/api/requests?limit=2");
  assert.equal(first.body.entries.length, 2);
  assert.equal(first.body.total, 5);

  const second = await getJson(router, `/api/requests?limit=2&cursor=${first.body.nextCursor}`);
  assert.equal(second.body.entries.length, 2);

  const ids = [...first.body.entries, ...second.body.entries].map((entry) => entry.seq);
  assert.equal(new Set(ids).size, 4, "pagination repeated an entry");
});

test("/api/requests filters by outcome and provider", async (t) => {
  // A non-retryable status fails the request without cooling the target down,
  // so both requests stay independently attributable to their provider. A
  // retryable failure would exhaust every target on the first request — the
  // exact model match first, then the widened fallbacks — and leave the second
  // with no live target and therefore no provider to record.
  const { router } = await withRig(t, {
    script: () => ({ status: 400, body: { error: { message: "boom" } } })
  });

  await router.request("/v1/chat/completions", postJson({ model: "model-a", messages: [] }));
  await router.request("/v1/chat/completions", postJson({ model: "model-b", messages: [] }));

  const failed = await getJson(router, "/api/requests?outcome=failed");
  assert.equal(failed.body.entries.length, 2);
  assert.ok(failed.body.entries.every((entry) => entry.outcome === "failed"));

  const succeeded = await getJson(router, "/api/requests?outcome=success");
  assert.equal(succeeded.body.entries.length, 0);

  const groq = await getJson(router, "/api/requests?provider=groq");
  assert.equal(groq.body.entries.length, 2);

  const gemini = await getJson(router, "/api/requests?provider=gemini");
  assert.equal(gemini.body.entries.length, 0);

  const byModel = await getJson(router, "/api/requests?limit=10");
  assert.equal(byModel.body.entries.length, 2);
  // Each request records the model the client asked for.
  assert.deepEqual(
    byModel.body.entries.map((entry) => entry.requestedModel).sort(),
    ["model-a", "model-b"]
  );
});

// ---------------------------------------------------------------------------
// Routing preview
// ---------------------------------------------------------------------------

test("GET /api/router/preview matches the target the router actually selects", async (t) => {
  const { router } = await withRig(t);

  const { res, body } = await getJson(router, "/api/router/preview?protocol=openai-chat&model=model-a");

  assert.equal(res.status, 200);
  assert.equal(body.protocol, "openai-chat");
  assert.equal(body.modelMatched, true);
  assert.equal(body.selected.model, "model-a");
  assert.equal(body.counts.compatible, 4);
  assert.deepEqual(body.stages.map((stage) => stage.key), [
    "received", "protocol", "compatible", "model", "health", "ranking", "sticky", "selected", "fallback"
  ]);

  // The prediction must hold: request that model and see where it lands.
  const proxied = await router.request("/v1/chat/completions", postJson({ model: "model-a", messages: [] }));
  assert.equal(proxied.headers.get("x-multi-ai-model"), body.selected.model);
});

test("GET /api/router/preview widens when the model is not configured", async (t) => {
  const { router } = await withRig(t);

  const { body } = await getJson(router, "/api/router/preview?protocol=openai-chat&model=ghost-model");

  assert.equal(body.modelMatched, false);
  assert.equal(body.counts.exactMatch, 0);
  assert.equal(body.counts.compatible, 4);
  assert.ok(body.selected, "routing must widen rather than fail");
});

test("GET /api/router/preview rejects a missing protocol", async (t) => {
  const { router } = await withRig(t);

  const missing = await getJson(router, "/api/router/preview");
  assert.equal(missing.res.status, 400);

  // A chat-only provider can serve all three bridged client protocols — the
  // Gemini client protocol included, since `src/gemini-bridge.js` translates it.
  const supported = await getJson(router, "/api/router/preview?protocol=gemini");
  assert.equal(supported.res.status, 200);
  assert.deepEqual(
    supported.body.protocols,
    ["anthropic", "gemini", "openai-chat", "openai-responses"]
  );
});

// ---------------------------------------------------------------------------
// Health refresh, auth, 404 and caching
// ---------------------------------------------------------------------------

test("POST /api/health/refresh runs a cycle and returns fresh health", async (t) => {
  const { upstream, router } = await withRig(t, { health: { status: 200, body: { data: [] } } });

  const before = upstream.requests.filter((r) => r.method === "GET").length;
  const { res, body } = await getJson(router, "/api/health/refresh", {});
  // getJson only reads; issue the POST explicitly.
  assert.equal(res.status, 404); // GET on a POST-only route must not match
  assert.equal(body.error.type, "not_found");

  const refreshed = await router.request("/api/health/refresh", { method: "POST" });
  assert.equal(refreshed.status, 200);
  const payload = await refreshed.json();

  assert.equal(payload.ok, true);
  assert.equal(payload.cycle.started, true);
  assert.ok(payload.cycle.durationMs >= 0);
  assert.equal(payload.health.summary.total, 4);
  assert.ok(upstream.requests.filter((r) => r.method === "GET").length > before, "refresh should probe providers");
});

test("the admin API requires the router key when one is configured", async (t) => {
  const { router } = await withRig(t, { env: { MULTIAI_ROUTER_API_KEYS: ROUTER_KEY } });

  for (const path of READ_ENDPOINTS) {
    const unauthenticated = await router.request(path);
    assert.equal(unauthenticated.status, 401, `${path} should require auth`);

    const wrong = await router.request(path, { headers: { authorization: "Bearer nope" } });
    assert.equal(wrong.status, 401, `${path} should reject a wrong key`);

    const right = await router.request(path, { headers: { authorization: `Bearer ${ROUTER_KEY}` } });
    assert.equal(right.status, 200, `${path} should accept the configured key`);
  }
});

test("an unknown /api path returns a JSON 404 rather than the SPA shell", async (t) => {
  const { router } = await withRig(t);

  const res = await router.request("/api/nope");
  assert.equal(res.status, 404);
  assert.match(res.headers.get("content-type"), /application\/json/);

  const body = await res.json();
  assert.equal(body.error.type, "not_found");
});

test("the existing gateway contract is unchanged by the admin API", async (t) => {
  const { router } = await withRig(t);

  const health = await (await router.request("/health")).json();
  assert.equal(health.ok, true);
  assert.equal(health.configuredTargets, 4);
  assert.deepEqual(health.retryableStatus, [401, 402, 403, 404, 408, 409, 425, 429, 500, 501, 502, 503, 504, 520, 521, 522, 523, 524, 529]);
  assert.ok(!("summary" in health), "/health must keep its original shape");

  const models = await (await router.request("/v1/models")).json();
  assert.equal(models.object, "list");
  assert.equal(models.data.length, 2, "unique model ids (model-a, model-b), not one per key");

  // The pre-existing 404 contract for unknown POST routes still holds.
  const nope = await router.request("/nope", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}"
  });
  assert.equal(nope.status, 404);
});

test("/api/health supports conditional requests so polling is cheap", async (t) => {
  const { router } = await withRig(t);

  const first = await router.request("/api/health");
  assert.equal(first.status, 200);
  const etag = first.headers.get("etag");
  assert.ok(etag, "a pollable endpoint should send an ETag");
  await first.json();

  const cached = await router.request("/api/health", { headers: { "if-none-match": etag } });
  assert.equal(cached.status, 304);
});

test("errors from the admin API are not cached", async (t) => {
  const { router } = await withRig(t);

  const res = await router.request("/api/nope");
  assert.equal(res.headers.get("cache-control"), "no-store");
  assert.equal(res.headers.get("etag"), null);
});
