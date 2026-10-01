import test from "node:test";
import assert from "node:assert/strict";

import {
  sanitizeMessage,
  containsCredentialShapedText,
  REDACTION_PLACEHOLDER
} from "../src/observability/sanitize.js";
import { RequestLog } from "../src/observability/request-log.js";
import { selectRouteTargets, planFallbackOrder } from "../src/observability/route-select.js";
import { describeConfig, describeEnvironment } from "../src/observability/config-view.js";
import { describeRouting } from "../src/observability/router-preview.js";
import { HealthRegistry } from "../src/health.js";
import { loadConfig, buildTargets } from "../src/config.js";
import {
  breakdown,
  classifyFailure,
  modelCatalogue,
  percentile,
  providerRollup,
  resolveRange,
  series,
  summarizeHealth,
  summarizeRequests
} from "../src/observability/metrics.js";

const SECRET = "sk-super-secret-provider-key-1234567890";

// ---------------------------------------------------------------------------
// sanitize
// ---------------------------------------------------------------------------

test("sanitizeMessage removes credential-shaped text", () => {
  const cases = [
    `Upstream rejected Bearer ${SECRET}`,
    `failed with ${SECRET}`,
    "the authorization header was rejected",
    "x-goog-api-key is invalid",
    "Bearer abc.def.ghi"
  ];

  for (const input of cases) {
    const output = sanitizeMessage(input);
    assert.ok(!output.includes(SECRET), `key leaked from: ${input}`);
    assert.ok(!/bearer/i.test(output), `bearer leaked from: ${input}`);
    assert.ok(!/authorization/i.test(output), `authorization leaked from: ${input}`);
    assert.ok(!/x-goog-api-key/i.test(output), `goog header leaked from: ${input}`);
  }
});

test("sanitizeMessage keeps the useful part of a message", () => {
  const output = sanitizeMessage(`HTTP 429 rate limited for ${SECRET}`);
  assert.match(output, /429/);
  assert.match(output, /rate limited/);
  assert.ok(output.includes(REDACTION_PLACEHOLDER));
});

test("sanitizeMessage returns null for missing or empty input", () => {
  assert.equal(sanitizeMessage(null), null);
  assert.equal(sanitizeMessage(undefined), null);
  assert.equal(sanitizeMessage(""), null);
  assert.equal(sanitizeMessage("   "), null);
});

test("sanitizeMessage strips control characters and truncates", () => {
  const output = sanitizeMessage("bad\u0000value\u001b[31m" + "x".repeat(500));
  assert.ok(!output.includes("\u0000"));
  assert.ok(!output.includes("\u001b"));
  assert.ok(output.length <= 301);
});

test("containsCredentialShapedText detects what sanitizeMessage removes", () => {
  assert.equal(containsCredentialShapedText(`Bearer ${SECRET}`), true);
  assert.equal(containsCredentialShapedText("authorization"), true);
  assert.equal(containsCredentialShapedText("HTTP 503 provider unavailable"), false);
});

// ---------------------------------------------------------------------------
// request log
// ---------------------------------------------------------------------------

const entry = (overrides = {}) => ({
  id: overrides.id ?? "req-1",
  receivedAt: 1000,
  protocol: "openai-chat",
  finalProvider: "groq",
  finalModel: "m",
  httpStatus: 200,
  latencyMs: 120,
  outcome: "success",
  attempts: [],
  ...overrides
});

test("RequestLog evicts the oldest entries once bounded", () => {
  const log = new RequestLog({ maxEntries: 3 });

  for (let i = 1; i <= 5; i += 1) log.record(entry({ id: `req-${i}` }));

  assert.equal(log.size, 3);
  const ids = log.list().entries.map((row) => row.id);
  assert.deepEqual(ids, ["req-5", "req-4", "req-3"]);
  assert.equal(log.findById("req-1"), null);
});

test("RequestLog.list returns newest first and paginates by cursor", () => {
  const log = new RequestLog({ maxEntries: 10 });
  for (let i = 1; i <= 5; i += 1) log.record(entry({ id: `req-${i}` }));

  const first = log.list({ limit: 2 });
  assert.deepEqual(first.entries.map((row) => row.id), ["req-5", "req-4"]);
  assert.equal(first.matched, 5);
  assert.equal(first.total, 5);

  const second = log.list({ limit: 2, cursor: first.nextCursor });
  assert.deepEqual(second.entries.map((row) => row.id), ["req-3", "req-2"]);

  const third = log.list({ limit: 2, cursor: second.nextCursor });
  assert.deepEqual(third.entries.map((row) => row.id), ["req-1"]);
  assert.equal(third.nextCursor, null);
});

test("RequestLog.list filters by outcome, provider, protocol and status", () => {
  const log = new RequestLog({ maxEntries: 10 });
  log.record(entry({ id: "a", finalProvider: "groq", protocol: "openai-chat", httpStatus: 200 }));
  log.record(entry({ id: "b", finalProvider: "gemini", protocol: "gemini", httpStatus: 502, outcome: "failed" }));
  log.record(entry({ id: "c", finalProvider: "groq", protocol: "anthropic", httpStatus: 200 }));

  assert.deepEqual(log.list({ outcome: "failed" }).entries.map((r) => r.id), ["b"]);
  assert.deepEqual(log.list({ provider: "groq" }).entries.map((r) => r.id), ["c", "a"]);
  assert.deepEqual(log.list({ protocol: "anthropic" }).entries.map((r) => r.id), ["c"]);
  assert.deepEqual(log.list({ status: "502" }).entries.map((r) => r.id), ["b"]);
});

test("RequestLog derives fallback counts and sanitizes stored messages", () => {
  const log = new RequestLog();
  const stored = log.record(entry({
    attempts: [
      { provider: "groq", model: "m", keyIndex: 0, ok: false, status: 429, errorMessage: `Bearer ${SECRET}` },
      { provider: "groq", model: "m", keyIndex: 1, ok: true, status: 200 }
    ],
    errorMessage: `all failed with ${SECRET}`
  }));

  assert.equal(stored.attemptCount, 2);
  assert.equal(stored.fallbackCount, 1);
  assert.deepEqual(stored.attempts.map((a) => a.index), [1, 2]);
  assert.equal(stored.attempts[0].ok, false);
  assert.equal(stored.attempts[1].ok, true);
  assert.ok(!JSON.stringify(stored).includes(SECRET), "request log stored a credential");
});

test("RequestLog keeps a numeric attempt startedAt and drops anything else", () => {
  const log = new RequestLog();
  const stored = log.record(entry({
    attempts: [
      { provider: "groq", model: "m", keyIndex: 0, ok: false, status: 429, startedAt: 1700000000000, apiKey: SECRET },
      { provider: "groq", model: "m", keyIndex: 1, ok: true, status: 200, startedAt: "not-a-number" }
    ]
  }));

  assert.equal(stored.attempts[0].startedAt, 1700000000000);
  assert.equal(stored.attempts[1].startedAt, null);
  assert.ok(!JSON.stringify(stored).includes(SECRET), "request log stored a credential");
});

test("RequestLog never stores request or response bodies", () => {
  const log = new RequestLog();
  const stored = log.record(entry({
    body: { messages: [{ role: "user", content: "prompt text" }] },
    rawBody: '{"messages":[]}',
    headers: { authorization: "Bearer x" },
    response: { secret: "upstream-body" }
  }));

  const serialized = JSON.stringify(stored);
  assert.ok(!serialized.includes("prompt text"));
  assert.ok(!serialized.includes("upstream-body"));
  // The allow-list means unknown fields are dropped outright.
  assert.equal(stored.body, undefined);
  assert.equal(stored.headers, undefined);
});

// ---------------------------------------------------------------------------
// route selection
// ---------------------------------------------------------------------------

const target = (provider, model, protocols, keyIndex = 0) => ({
  provider, model, protocols, keyIndex, baseUrl: "https://example.test", apiKey: "k"
});

test("selectRouteTargets excludes targets that lack the client protocol", () => {
  const targets = [
    target("agentrouter", "a", ["anthropic", "openai-chat"]),
    target("gemini", "g", ["gemini"]),
    target("groq", "q", ["openai-chat"])
  ];

  const result = selectRouteTargets(targets, "gemini", "");
  assert.equal(result.compatible.length, 1);
  assert.equal(result.compatible[0].provider, "gemini");
  assert.equal(result.selected.length, 1);
});

test("selectRouteTargets prefers an exact model match and widens otherwise", () => {
  const targets = [
    target("groq", "model-a", ["openai-chat"], 0),
    target("groq", "model-a", ["openai-chat"], 1),
    target("groq", "model-b", ["openai-chat"], 0)
  ];

  const exact = selectRouteTargets(targets, "openai-chat", "model-b");
  assert.equal(exact.modelMatched, true);
  assert.equal(exact.selected.length, 1);
  assert.equal(exact.selected[0].model, "model-b");

  const widened = selectRouteTargets(targets, "openai-chat", "does-not-exist");
  assert.equal(widened.modelMatched, false);
  assert.equal(widened.selected.length, 3);

  const none = selectRouteTargets(targets, "openai-chat", "");
  assert.equal(none.modelMatched, false);
  assert.equal(none.selected.length, 3);
});

test("planFallbackOrder moves the sticky target first only when it is available", () => {
  const health = new HealthRegistry();
  const a = target("groq", "a", ["openai-chat"]);
  const b = target("groq", "b", ["openai-chat"]);
  const ranked = [a, b];

  // Sticky target is already first: order is unchanged.
  assert.deepEqual(planFallbackOrder(ranked, health, health.key(a)), ranked);

  // Sticky target is second: it is promoted, the rest keep rank order.
  const promoted = planFallbackOrder(ranked, health, health.key(b));
  assert.equal(health.key(promoted[0]), health.key(b));
  assert.equal(health.key(promoted[1]), health.key(a));

  // No sticky target: plain ranking.
  assert.deepEqual(planFallbackOrder(ranked, health, null), ranked);

  // An unknown sticky id is ignored rather than producing an undefined slot.
  assert.deepEqual(planFallbackOrder(ranked, health, "ghost"), ranked);
});

// ---------------------------------------------------------------------------
// config view
// ---------------------------------------------------------------------------

const sampleConfig = () => loadConfig({
  GROQ_API_KEYS: `${SECRET},second-key-value`,
  GROQ_MODELS: "model-a,model-b",
  GROQ_BASE_URL: "https://api.groq.test/v1",
  GEMINI_API_KEYS: "gemini-key",
  GEMINI_MODELS: "gemini-x",
  GEMINI_BASE_URL: "https://gemini.test/",
  AGENTROUTER_ORIGINATOR: "codex_cli_rs",
  MULTIAI_ROUTER_API_KEYS: "router-token",
  REQUEST_TIMEOUT_MS: "9000",
  PORT: "9999",
  RETRY_STATUS_CODES: "429,503"
});

test("describeConfig never serializes a credential", () => {
  const config = sampleConfig();
  const view = describeConfig(config, buildTargets(config.providers));
  const serialized = JSON.stringify(view);

  assert.ok(!serialized.includes(SECRET), "provider key leaked from config view");
  assert.ok(!serialized.includes("router-token"), "router key leaked from config view");
  assert.ok(!serialized.includes("second-key-value"), "second key leaked from config view");
  assert.ok(!serialized.includes("gemini-key"), "gemini key leaked from config view");
  // The same substring rule the /health contract enforces.
  assert.ok(!/authorization/i.test(serialized));
  assert.ok(!/Bearer /.test(serialized));
});

test("describeConfig reports key counts and safe values", () => {
  const config = sampleConfig();
  const targets = buildTargets(config.providers);
  const view = describeConfig(config, targets);

  const groq = view.providers.find((p) => p.id === "groq");
  assert.equal(groq.configured, true);
  assert.equal(groq.keyCount, 2);
  assert.equal(groq.modelCount, 2);
  assert.deepEqual(groq.models, ["model-a", "model-b"]);
  assert.equal(groq.baseUrl, "https://api.groq.test/v1");
  assert.equal(groq.targetCount, 4); // 2 models x 2 keys
  assert.deepEqual(groq.protocols, ["openai-chat"]);

  assert.equal(view.server.port, 9999);
  assert.equal(view.server.requestTimeoutMs, 9000);
  assert.equal(view.server.clientAuthRequired, true);
  assert.equal(view.server.clientKeyCount, 1);
  assert.deepEqual(view.routing.retryableStatus, [429, 503]);

  // An unconfigured provider is reported as such, with a reason.
  const sambanova = view.providers.find((p) => p.id === "sambanova");
  assert.equal(sambanova.configured, false);
  assert.ok(sambanova.missing.length > 0);
});

test("describeConfig reports the agentrouter client header names but not values", () => {
  const config = sampleConfig();
  const view = describeConfig(config, buildTargets(config.providers));
  const agentrouter = view.providers.find((p) => p.id === "agentrouter");

  assert.deepEqual(agentrouter.clientHeaderNames, ["originator"]);
  assert.ok(!JSON.stringify(view).includes("codex_cli_rs"), "header value leaked");
});

test("describeEnvironment reports env var names and configured state only", () => {
  const config = sampleConfig();
  const env = describeEnvironment(config);
  const serialized = JSON.stringify(env);

  assert.ok(env.providers.some((p) => p.vars.some((v) => v.name === "GROQ_API_KEYS" && v.configured)));
  assert.ok(serialized.includes("GROQ_MODELS"));
  assert.ok(!serialized.includes(SECRET));
  assert.ok(/secret/.test(serialized)); // the *kind* is disclosed, not the value
});

// ---------------------------------------------------------------------------
// metrics
// ---------------------------------------------------------------------------

test("summarizeHealth counts every state including unknown", () => {
  const summary = summarizeHealth([
    { status: "healthy" }, { status: "healthy" }, { status: "cooldown" },
    { status: "failed" }, { status: "unknown" }, {}
  ]);

  assert.deepEqual(summary, {
    total: 6, healthy: 2, cooldown: 1, failed: 1, unknown: 2,
    // 6 minus the single cooling-down target.
    available: 5,
    // No entry carried a latency, so this is unavailable rather than 0 ms.
    averageLatencyMs: null
  });
});

test("summarizeHealth averages latency over reporting targets only", () => {
  const summary = summarizeHealth([
    { status: "healthy", latencyMs: 100 },
    { status: "healthy", latencyMs: 300 },
    // An unprobed target must not count as an instant one.
    { status: "unknown", latencyMs: null },
    { status: "cooldown", latencyMs: 200 }
  ]);

  assert.equal(summary.averageLatencyMs, 200);
  assert.equal(summary.available, 3);
});

test("summarizeRequests returns null rates when there is no traffic", () => {
  const summary = summarizeRequests([]);
  assert.equal(summary.total, 0);
  assert.equal(summary.avgLatencyMs, null);
  assert.equal(summary.successRate, null);
  assert.equal(summary.p95LatencyMs, null);
});

test("summarizeRequests computes rates, latency and fallback totals", () => {
  const summary = summarizeRequests([
    { outcome: "success", latencyMs: 100, fallbackCount: 0, tokens: 10 },
    { outcome: "success", latencyMs: 200, fallbackCount: 1, tokens: 20 },
    { outcome: "failed", latencyMs: 300, fallbackCount: 2 }
  ]);

  assert.equal(summary.total, 3);
  assert.equal(summary.successful, 2);
  assert.equal(summary.failed, 1);
  assert.equal(summary.avgLatencyMs, 200);
  assert.equal(summary.maxLatencyMs, 300);
  assert.equal(summary.requestsWithFallback, 2);
  assert.equal(summary.totalFallbacks, 3);
  assert.equal(summary.tokens, 30);
  assert.equal(summary.tokenReportingRequests, 2);
});

test("providerRollup aggregates targets per provider", () => {
  const rollup = providerRollup([
    { provider: "groq", model: "a", protocols: ["openai-chat"], status: "healthy", successes: 3, failures: 0, latencyMs: 100, updatedAt: "2026-01-01T00:00:00.000Z" },
    { provider: "groq", model: "b", protocols: ["openai-chat"], status: "failed", successes: 1, failures: 2, latencyMs: 300, updatedAt: "2026-01-02T00:00:00.000Z" },
    { provider: "gemini", model: "g", protocols: ["gemini"], status: "unknown", successes: 0, failures: 0, latencyMs: null, updatedAt: "2026-01-01T00:00:00.000Z" }
  ]);

  const groq = rollup.find((row) => row.provider === "groq");
  assert.equal(groq.targets, 2);
  assert.deepEqual(groq.models, ["a", "b"]);
  assert.equal(groq.healthy, 1);
  assert.equal(groq.failed, 1);
  assert.equal(groq.successes, 4);
  assert.equal(groq.failures, 2);
  assert.equal(groq.latencyMs, 200);
  assert.equal(groq.status, "failed"); // worst-first
  assert.equal(groq.lastUpdatedAt, "2026-01-02T00:00:00.000Z");
});

test("series buckets requests and includes empty buckets as zero", () => {
  const now = 1_000_000;
  const rows = series(
    [
      { receivedAt: now - 500, outcome: "success", latencyMs: 10, fallbackCount: 0 },
      { receivedAt: now - 1500, outcome: "failed", latencyMs: 20, fallbackCount: 1 }
    ],
    { rangeMs: 2000, buckets: 2, now }
  );

  assert.equal(rows.length, 2);
  assert.equal(rows[0].total, 1);
  assert.equal(rows[0].failed, 1);
  assert.equal(rows[1].total, 1);
  assert.equal(rows[1].successful, 1);
  assert.equal(rows[1].avgLatencyMs, 10);
});

test("series excludes entries outside the range", () => {
  const now = 1_000_000;
  const rows = series([{ receivedAt: now - 999_999, outcome: "success" }], { rangeMs: 1000, buckets: 2, now });
  assert.equal(rows.reduce((total, row) => total + row.total, 0), 0);
});

test("breakdown counts, shares and sorts", () => {
  const rows = breakdown(
    [{ finalProvider: "groq" }, { finalProvider: "groq" }, { finalProvider: "gemini" }],
    (row) => row.finalProvider
  );

  assert.deepEqual(rows[0], { key: "groq", count: 2, share: 2 / 3 });
  assert.equal(rows[1].key, "gemini");
  assert.equal(rows[1].share, 1 / 3);
});

test("classifyFailure distinguishes the actionable failure classes", () => {
  assert.equal(classifyFailure({ httpStatus: 401 }), "authentication");
  assert.equal(classifyFailure({ httpStatus: 403 }), "authentication");
  assert.equal(classifyFailure({ httpStatus: 402 }), "quota exhausted");
  assert.equal(classifyFailure({ httpStatus: 408 }), "timeout");
  assert.equal(classifyFailure({ httpStatus: 429 }), "rate limited");
  assert.equal(classifyFailure({ httpStatus: 500 }), "provider error");
  assert.equal(classifyFailure({ httpStatus: 502 }), "provider error");
  assert.equal(classifyFailure({ httpStatus: 503 }), "unavailable");
  assert.equal(classifyFailure({ httpStatus: 504 }), "timeout");
  assert.equal(classifyFailure({ errorType: "no_route", httpStatus: 503 }), "no route");
  assert.equal(classifyFailure({ attempts: [{ errorMessage: "probe unreachable" }] }), "network failure");
});

test("percentile uses nearest-rank and handles empty input", () => {
  assert.equal(percentile([], 0.5), null);
  assert.equal(percentile([10, 20, 30, 40], 0.5), 20);
  assert.equal(percentile([10, 20, 30, 40], 0.95), 40);
});

test("modelCatalogue joins health targets with request usage", () => {
  const catalogue = modelCatalogue(
    [{ id: "groq:m:key-0", provider: "groq", model: "m", keyIndex: 0, protocols: ["openai-chat"], status: "healthy", score: 80, successes: 2, failures: 1, latencyMs: 50, consecutiveFailures: 0, lastStatus: 200, lastReason: "ok", cooldownUntil: 0, updatedAt: "2026-01-01T00:00:00.000Z" }],
    [
      { finalProvider: "groq", finalModel: "m", outcome: "success" },
      { finalProvider: "groq", finalModel: "m", outcome: "failed" }
    ]
  );

  assert.equal(catalogue.length, 1);
  assert.equal(catalogue[0].requests, 2);
  assert.equal(catalogue[0].requestFailures, 1);
  assert.equal(catalogue[0].successRate, 2 / 3);
});

test("resolveRange maps presets and falls back to one hour", () => {
  assert.equal(resolveRange("5m").rangeMs, 5 * 60 * 1000);
  assert.equal(resolveRange("7d").rangeMs, 7 * 24 * 60 * 60 * 1000);
  assert.equal(resolveRange("nonsense").label, "1h");
  assert.equal(resolveRange("60000").rangeMs, 60000);
});

// ---------------------------------------------------------------------------
// routing preview
// ---------------------------------------------------------------------------

test("describeRouting reports the same primary target the router ranks first", () => {
  const health = new HealthRegistry();
  const targets = [
    target("groq", "a", ["openai-chat"], 0),
    target("groq", "b", ["openai-chat"], 0),
    target("gemini", "g", ["gemini"], 0)
  ];

  // Make model-b strictly better so ranking is unambiguous.
  health.markFailure(targets[1], 500);

  const preview = describeRouting({
    targets, health, protocol: "openai-chat", model: "", now: Date.now()
  });

  // The router ranks only protocol-compatible targets, so the comparison must
  // use the same subset — otherwise gemini (score 50, sorts first by name)
  // would appear to be the router's choice.
  const compatible = selectRouteTargets(targets, "openai-chat", "").selected;
  const ranked = health.rank(compatible);
  assert.equal(preview.selected.id, health.key(ranked[0]));
  assert.equal(preview.selected.provider, ranked[0].provider);
  assert.equal(preview.counts.totalTargets, 3);
  assert.equal(preview.counts.compatible, 2);
  assert.equal(preview.counts.excluded, 1);
  assert.equal(preview.excluded[0].provider, "gemini");
});

test("describeRouting exposes the decision as ordered stages", () => {
  const health = new HealthRegistry();
  const targets = [target("groq", "m", ["openai-chat"], 0)];

  const preview = describeRouting({ targets, health, protocol: "openai-chat", model: "m" });

  const keys = preview.stages.map((stage) => stage.key);
  assert.deepEqual(keys, ["received", "protocol", "compatible", "model", "health", "ranking", "sticky", "selected", "fallback"]);
  assert.equal(preview.modelMatched, true);
  assert.equal(preview.selected.model, "m");
  assert.equal(preview.fallbackOrder.length, 1);
});

test("describeRouting reports an unavailable target as cooldown and picks another", () => {
  const health = new HealthRegistry();
  const bad = target("groq", "bad", ["openai-chat"], 0);
  const good = target("groq", "good", ["openai-chat"], 0);
  const targets = [bad, good];

  health.markFailure(bad, 503);
  health.markSuccess(good, { latencyMs: 12 });

  const preview = describeRouting({ targets, health, protocol: "openai-chat", model: "" });

  assert.equal(preview.counts.available, 1);
  assert.equal(preview.counts.unavailable, 1);
  assert.equal(preview.selected.model, "good");

  // Regression: the selected target's status must describe *that* target.
  // Deriving it from the first candidate reported "cooldown" for a healthy
  // selection whenever a lower-ranked target happened to sort first.
  assert.equal(preview.selected.status, "healthy");
  assert.equal(preview.selected.available, true);

  // The fallback chain reports each entry's own status, not a placeholder.
  // Only eligible targets appear, so the cooling one is absent by design.
  assert.equal(preview.fallbackOrder.length, 1);
  assert.equal(preview.fallbackOrder[0].model, "good");
  assert.equal(preview.fallbackOrder[0].status, "healthy");
  assert.notEqual(preview.fallbackOrder[0].status, "available");

  const cooling = preview.unavailable[0];
  assert.equal(cooling.model, "bad");
  assert.equal(cooling.status, "cooldown");
  assert.equal(cooling.available, false);
});

test("describeRouting reports a cooling target's status accurately in every list", () => {
  const health = new HealthRegistry();
  const a = target("groq", "a", ["openai-chat"], 0);
  const b = target("groq", "b", ["openai-chat"], 0);

  // `b` is observed healthy; `a` then fails, so only `b` remains eligible and
  // every list on the page must agree about both of them.
  health.markSuccess(b, { latencyMs: 20 });
  health.markFailure(a, 429);

  const preview = describeRouting({ targets: [a, b], health, protocol: "openai-chat", model: "" });

  assert.equal(preview.selected.model, "b");
  assert.equal(preview.selected.status, "healthy");

  const candidateA = preview.candidates.find((row) => row.model === "a");
  assert.equal(candidateA.status, "cooldown");
  assert.equal(candidateA.available, false);
  assert.equal(candidateA.rank, null, "a cooldown target must not be given a fallback rank");

  // A never-probed target is reported as unknown, never as healthy.
  const untouched = target("groq", "c", ["openai-chat"], 0);
  const withUntouched = describeRouting({
    targets: [untouched], health, protocol: "openai-chat", model: ""
  });
  assert.equal(withUntouched.selected.status, "unknown");
});

test("describeRouting reports no selection when every target is in cooldown", () => {
  const health = new HealthRegistry();
  const only = target("groq", "m", ["openai-chat"], 0);
  health.markFailure(only, 429);

  const preview = describeRouting({ targets: [only], health, protocol: "openai-chat" });

  assert.equal(preview.selected, null);
  assert.equal(preview.counts.available, 0);
  assert.equal(preview.stages.find((s) => s.key === "selected").state, "error");
});
