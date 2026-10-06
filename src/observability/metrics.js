/**
 * Pure aggregation over health snapshots and request-log entries.
 *
 * No I/O and no clock reads: `now` is always passed in, so every function here
 * is deterministic and directly unit-testable.
 *
 * A metric with no underlying data returns `null` rather than `0`. The UI is
 * required to render "not available" for those, so that a quiet gateway is
 * never mistaken for a healthy one with zero traffic.
 */

const sum = (values) => values.reduce((total, value) => total + value, 0);

const average = (values) =>
  values.length === 0 ? null : Math.round(sum(values) / values.length);

const latenciesOf = (entries) =>
  entries.map((entry) => entry.latencyMs).filter((value) => Number.isFinite(value));

/** Nearest-rank percentile; `p` in [0,1]. */
export function percentile(values, p) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[index];
}

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

export function summarizeHealth(healthEntries = []) {
  const counts = { total: 0, healthy: 0, cooldown: 0, failed: 0, unknown: 0 };
  const latencies = [];

  for (const entry of healthEntries) {
    counts.total += 1;
    const status = entry?.status;
    if (status === "healthy") counts.healthy += 1;
    else if (status === "cooldown") counts.cooldown += 1;
    else if (status === "failed") counts.failed += 1;
    else counts.unknown += 1;

    if (Number.isFinite(entry?.latencyMs)) latencies.push(entry.latencyMs);
  }

  return {
    ...counts,
    // Targets the router can currently route to. `describe()` derives `cooldown`
    // from `cooldownUntil` at read time, so "not cooling down" is exactly the
    // predicate `isAvailable` uses — the two can never disagree.
    available: counts.total - counts.cooldown,
    // Averaged only over targets that actually reported a latency. Dividing by
    // `total` would let an unprobed target read as an instant one.
    averageLatencyMs: average(latencies)
  };
}

/**
 * Collapse per-target health into one row per provider, which is what the
 * Providers page and the dashboard's provider table both render.
 */
export function providerRollup(healthEntries = []) {
  const byProvider = new Map();

  for (const entry of healthEntries) {
    const id = entry?.provider ?? "unknown";
    if (!byProvider.has(id)) {
      byProvider.set(id, {
        provider: id,
        models: new Set(),
        protocols: new Set(),
        targets: 0,
        healthy: 0,
        cooldown: 0,
        failed: 0,
        unknown: 0,
        successes: 0,
        failures: 0,
        latencySamples: [],
        lastUpdatedAt: null
      });
    }

    const row = byProvider.get(id);
    row.targets += 1;
    if (entry.model) row.models.add(entry.model);
    for (const protocol of entry.protocols ?? []) row.protocols.add(protocol);

    if (entry.status === "healthy") row.healthy += 1;
    else if (entry.status === "cooldown") row.cooldown += 1;
    else if (entry.status === "failed") row.failed += 1;
    else row.unknown += 1;

    row.successes += Number(entry.successes) || 0;
    row.failures += Number(entry.failures) || 0;
    if (Number.isFinite(entry.latencyMs)) row.latencySamples.push(entry.latencyMs);

    if (entry.updatedAt && (!row.lastUpdatedAt || entry.updatedAt > row.lastUpdatedAt)) {
      row.lastUpdatedAt = entry.updatedAt;
    }
  }

  return [...byProvider.values()]
    .map((row) => ({
      provider: row.provider,
      models: [...row.models].sort(),
      modelCount: row.models.size,
      protocols: [...row.protocols].sort(),
      targets: row.targets,
      healthy: row.healthy,
      cooldown: row.cooldown,
      failed: row.failed,
      unknown: row.unknown,
      successes: row.successes,
      failures: row.failures,
      totalObservations: row.successes + row.failures,
      successRate:
        row.successes + row.failures === 0
          ? null
          : row.successes / (row.successes + row.failures),
      latencyMs: average(row.latencySamples),
      lastUpdatedAt: row.lastUpdatedAt,
      // Worst-first, matching how an operator scans a status table.
      status: row.failed > 0 ? "failed" : row.cooldown > 0 ? "cooldown" : row.healthy > 0 ? "healthy" : "unknown"
    }))
    .sort((a, b) => a.provider.localeCompare(b.provider));
}

/** Per-target rows joined with the request log, used by the Models catalogue. */
export function modelCatalogue(healthEntries = [], logEntries = []) {
  const byProviderModel = new Map();

  for (const entry of logEntries) {
    if (!entry.finalProvider || !entry.finalModel) continue;
    // Pool is part of the key: the same provider + model can sit in both the
    // text and vision pools, and their request counts must not be merged.
    const key = `${entry.pool ?? "text"}\u0000${entry.finalProvider}\u0000${entry.finalModel}`;
    if (!byProviderModel.has(key)) byProviderModel.set(key, { requests: 0, failures: 0 });
    const row = byProviderModel.get(key);
    row.requests += 1;
    if (entry.outcome === "failed") row.failures += 1;
  }

  return healthEntries.map((entry) => {
    const usage = byProviderModel.get(`${entry.pool ?? "text"}\u0000${entry.provider}\u0000${entry.model}`) ?? {
      requests: 0,
      failures: 0
    };

    return {
      id: entry.id,
      provider: entry.provider,
      model: entry.model,
      keyIndex: entry.keyIndex,
      // Which pool serves this row. A model configured for both pools appears
      // once per pool, and the UI must be able to say which is which.
      pool: entry.pool ?? "text",
      protocols: [...(entry.protocols ?? [])],
      status: entry.status,
      score: entry.score,
      latencyMs: entry.latencyMs,
      successes: entry.successes,
      failures: entry.failures,
      consecutiveFailures: entry.consecutiveFailures,
      lastStatus: entry.lastStatus,
      lastReason: entry.lastReason,
      cooldownUntil: entry.cooldownUntil,
      updatedAt: entry.updatedAt,
      // Lifetime health-check success rate for this target.
      successRate:
        entry.successes + entry.failures === 0
          ? null
          : entry.successes / (entry.successes + entry.failures),
      requests: usage.requests,
      requestFailures: usage.failures
    };
  });
}

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

export function summarizeRequests(logEntries = []) {
  const latencies = latenciesOf(logEntries);
  const successful = logEntries.filter((entry) => entry.outcome === "success").length;
  const failed = logEntries.length - successful;
  const withFallback = logEntries.filter((entry) => (entry.fallbackCount ?? 0) > 0);

  return {
    total: logEntries.length,
    successful,
    failed,
    successRate: logEntries.length === 0 ? null : successful / logEntries.length,
    failureRate: logEntries.length === 0 ? null : failed / logEntries.length,
    avgLatencyMs: average(latencies),
    p50LatencyMs: percentile(latencies, 0.5),
    p95LatencyMs: percentile(latencies, 0.95),
    maxLatencyMs: latencies.length === 0 ? null : Math.max(...latencies),
    requestsWithFallback: withFallback.length,
    totalFallbacks: sum(logEntries.map((entry) => entry.fallbackCount ?? 0)),
    tokens: sum(logEntries.map((entry) => (Number.isFinite(entry.tokens) ? entry.tokens : 0))),
    tokenReportingRequests: logEntries.filter((entry) => Number.isFinite(entry.tokens)).length
  };
}

// ---------------------------------------------------------------------------
// Time series / breakdowns
// ---------------------------------------------------------------------------

export const RANGE_PRESETS = Object.freeze({
  "5m": 5 * 60 * 1000,
  "15m": 15 * 60 * 1000,
  "1h": 60 * 60 * 1000,
  "6h": 6 * 60 * 60 * 1000,
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000
});

export function resolveRange(range, now = Date.now()) {
  if (typeof range === "string" && range in RANGE_PRESETS) {
    return { label: range, rangeMs: RANGE_PRESETS[range], now };
  }
  const parsed = Number(range);
  if (Number.isFinite(parsed) && parsed > 0) {
    return { label: `${parsed}ms`, rangeMs: parsed, now };
  }
  return { label: "1h", rangeMs: RANGE_PRESETS["1h"], now };
}

/**
 * Bucketed request counts for the analytics charts. Empty buckets are included
 * (as zeros) so a gap in traffic reads as a gap rather than a straight line.
 */
export function series(logEntries = [], { rangeMs, buckets = 24, now = Date.now() } = {}) {
  const bucketMs = Math.max(1, Math.floor(rangeMs / buckets));
  const start = now - rangeMs;

  const rows = Array.from({ length: buckets }, (_, index) => ({
    bucketStart: start + index * bucketMs,
    bucketEnd: start + (index + 1) * bucketMs,
    total: 0,
    successful: 0,
    failed: 0,
    fallbacks: 0,
    latencySamples: []
  }));

  for (const entry of logEntries) {
    const at = Number(entry.receivedAt);
    if (!Number.isFinite(at) || at < start || at > now) continue;

    const index = Math.min(buckets - 1, Math.floor((at - start) / bucketMs));
    const row = rows[index];
    if (!row) continue;

    row.total += 1;
    if (entry.outcome === "success") row.successful += 1;
    else row.failed += 1;
    row.fallbacks += entry.fallbackCount ?? 0;
    if (Number.isFinite(entry.latencyMs)) row.latencySamples.push(entry.latencyMs);
  }

  return rows.map(({ latencySamples, ...row }) => ({
    ...row,
    avgLatencyMs: average(latencySamples),
    successRate: row.total === 0 ? null : row.successful / row.total
  }));
}

export function breakdown(logEntries = [], selector, { limit = 10 } = {}) {
  if (typeof selector !== "function") return [];

  const counts = new Map();
  for (const entry of logEntries) {
    const key = selector(entry);
    if (key === null || key === undefined || key === "") continue;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  const total = sum([...counts.values()]);
  return [...counts.entries()]
    .map(([key, count]) => ({ key, count, share: total === 0 ? 0 : count / total }))
    .sort((a, b) => b.count - a.count || String(a.key).localeCompare(String(b.key)))
    .slice(0, limit);
}

/**
 * Classify failures by the reason an operator can act on, rather than by raw
 * status code. A 429 and a 402 are both "the provider refused", but only one
 * of them is fixed by waiting.
 */
export function classifyFailure(entry) {
  const status = entry?.httpStatus;
  const message = String(entry?.errorMessage ?? "").toLowerCase();
  const errorType = String(entry?.errorType ?? "").toLowerCase();

  if (errorType === "no_route") return "no route";
  if (status === 401 || status === 403) return "authentication";
  if (status === 402) return "quota exhausted";
  if (status === 408 || status === 504) return "timeout";
  if (status === 429) return "rate limited";
  if (status === 503) return "unavailable";
  if (status === 502 || status === 500) return "provider error";

  const lastAttemptError = [...(entry?.attempts ?? [])].reverse().find((a) => !a.skipped)?.errorMessage;
  const attemptMessage = String(lastAttemptError ?? "").toLowerCase();
  const haystack = message || attemptMessage;
  if (haystack.includes("timed out")) return "timeout";
  if (haystack.includes("unreachable")) return "network failure";
  if (haystack.includes("model")) return "model unavailable";

  return status ? `http ${status}` : "unknown";
}

export function errorDistribution(logEntries = []) {
  const failed = logEntries.filter((entry) => entry.outcome === "failed");
  return breakdown(failed, (entry) => classifyFailure(entry));
}

/** The dashboard's headline card set. */
export function dashboardCards({ healthEntries = [], logEntries = [], providerCounts = {} } = {}) {
  const health = summarizeHealth(healthEntries);
  const requests = summarizeRequests(logEntries);

  return {
    providers: {
      configured: providerCounts.configured ?? 0,
      known: providerCounts.known ?? 0
    },
    targets: health,
    requests
  };
}
