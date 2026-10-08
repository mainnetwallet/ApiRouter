import { createHash } from "node:crypto";
import { describeHealth, HEALTH_STATES } from "./health.js";
import { routeOrderByPool } from "./routing-plan.js";
import { readJsonBody } from "./adapters.js";
import { describeConfig, describeEnvironment } from "./observability/config-view.js";
import { describeRouting } from "./observability/router-preview.js";
import { servableProtocols } from "./observability/route-select.js";
import { describeSystem } from "./observability/system-info.js";
import {
  breakdown,
  classifyFailure,
  errorDistribution,
  modelCatalogue,
  providerRollup,
  resolveRange,
  series,
  summarizeHealth,
  summarizeRequests
} from "./observability/metrics.js";

/**
 * Read-only JSON API backing the control panel.
 *
 * Kept in its own module so `src/server.js` gains one mount point rather than
 * a second routing table. Every handler is a pure read over state that already
 * exists (`health.js`, `config.js`, the request log) — nothing here can change
 * routing, health or provider behaviour.
 *
 * Auth mirrors the proxy path exactly: the same `authorized(req)` predicate, so
 * enabling client auth protects the admin surface too.
 */

const JSON_TYPE = "application/json; charset=utf-8";

/**
 * Stable weak ETag so polling clients can use `If-None-Match`.
 *
 * `generatedAt` is excluded from the hash: it changes on every request, so
 * including it would make every conditional poll a miss and defeat the point.
 * Everything that actually describes gateway state stays in the hash.
 */
function stableKey(body) {
  if (body && typeof body === "object" && !Array.isArray(body) && "generatedAt" in body) {
    const { generatedAt, ...rest } = body;
    return JSON.stringify(rest);
  }
  return JSON.stringify(body);
}

function etagOf(body) {
  return `W/"${createHash("sha1").update(stableKey(body)).digest("hex").slice(0, 20)}"`;
}

function sendJson(req, res, status, body, extraHeaders = {}) {
  const payload = JSON.stringify(body);

  const headers = {
    "content-type": JSON_TYPE,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    ...extraHeaders
  };

  // Only 200s are cacheable; an error must never be pinned by an ETag.
  if (status === 200) {
    const etag = etagOf(body);
    headers.etag = etag;
    if (req.headers["if-none-match"] === etag) {
      return sendJsonRaw(res, 304, headers, "");
    }
  }

  return sendJsonRaw(res, status, headers, payload);
}

function sendJsonRaw(res, status, headers, payload) {
  res.writeHead(status, { ...headers, "content-length": Buffer.byteLength(payload) });
  res.end(payload);
}

function fail(req, res, status, message, type, details = null) {
  const error = { message, type };
  // Optional machine-readable context, so the UI can offer the valid values
  // rather than only reporting that something was wrong.
  if (details) error.details = details;
  return sendJson(req, res, status, { error });
}

// ---------------------------------------------------------------------------

/** Live-stream clients allowed at once; each one is an open socket. */
const MAX_LIVE_STREAMS = 50;
const STREAM_HEARTBEAT_MS = 15_000;

export function createApi({ config, targets, health, requestLog, monitor, refreshHealth, manualSelection = null }) {
  const liveStreams = new Set();

  /**
   * Server-sent events for Live Logs: the current state first (`snapshot`, the
   * same payload as `GET /api/requests`), then one event per change, written in
   * the same tick the request log changes, so a box appears with no polling
   * delay. Same auth as every other /api route (the caller has already passed it).
   */
  function openRequestStream(req, res, searchParams) {
    if (liveStreams.size >= MAX_LIVE_STREAMS) {
      return fail(req, res, 503, "Too many live streams", "unavailable");
    }

    res.socket?.setNoDelay?.(true);
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store, no-transform",
      "x-accel-buffering": "no",
      "x-content-type-options": "nosniff"
    });

    const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

    let closed = false;
    let unsubscribe = () => {};
    let heartbeat = null;
    const handle = { close };
    function close() {
      if (closed) return;
      closed = true;
      unsubscribe();
      clearInterval(heartbeat);
      liveStreams.delete(handle);
      if (!res.writableEnded) res.end();
    }
    liveStreams.add(handle);
    req.on("close", close);
    res.on("close", close);
    res.on("error", close);

    // Subscribe before reading the snapshot, in the same tick, so no change can
    // fall between the two.
    unsubscribe = requestLog.subscribe(({ type, entry }) => send(type, entry));
    send("snapshot", {
      generatedAt: new Date().toISOString(),
      ...requestLog.list({ limit: searchParams.get("limit") }),
      pending: requestLog.pending(),
      // Every real upstream attempt as its own event, oldest first: the same
      // events the stream then pushes one by one as `attempt`.
      attempts: requestLog.listAttempts({ limit: searchParams.get("attemptLimit") }).entries
    });
    heartbeat = setInterval(() => res.write(": ping\n\n"), STREAM_HEARTBEAT_MS);
    heartbeat.unref?.();
    return undefined;
  }

  const describeAll = (now = Date.now()) => health.describe(targets, now);

  // --- /api/health -------------------------------------------------------
  function healthPayload(now = Date.now()) {
    const entries = describeAll(now);
    // The real route order per pool (priority first, then Provider -> Key ->
    // Models); health only removes cooling targets. Not a health-score sort.
    const ranked = routeOrderByPool(targets, config.priority, (target) => health.isAvailable(target, now), manualSelection?.all() ?? {});

    // Text and vision are reported separately as well as together. The combined
    // rollup answers "how is this provider doing overall"; the per-pool figures
    // are what routing actually depends on, since each pool has its own health.
    const textEntries = entries.filter((entry) => (entry.pool ?? "text") === "text");
    const visionEntries = entries.filter((entry) => entry.pool === "vision");

    return {
      ok: true,
      generatedAt: new Date(now).toISOString(),
      service: "multi-ai-router",
      summary: summarizeHealth(entries),
      poolSummary: {
        text: summarizeHealth(textEntries),
        vision: summarizeHealth(visionEntries)
      },
      providers: providerRollup(entries),
      visionProviders: providerRollup(visionEntries),
      targets: entries,
      ranked: ranked.map((target, index) => ({
        rank: index + 1,
        id: health.key(target),
        provider: target.provider,
        model: target.model,
        keyIndex: target.keyIndex,
        pool: target.pool ?? "text",
        protocols: [...(target.protocols ?? [])]
      })),
      monitor: monitor ? monitor.snapshot(now) : null,
      retryableStatus: [...config.retryableStatus].sort((a, b) => a - b),
      states: Object.values(HEALTH_STATES)
    };
  }

  // --- /api/providers ----------------------------------------------------
  /**
   * The rollup a provider gets when it has no targets in a pool. Same shape as
   * `providerRollup`, so the UI renders one table for both.
   */
  const emptyRollup = (provider) => ({
    targets: 0,
    healthy: 0,
    cooldown: 0,
    failed: 0,
    unknown: 0,
    successes: 0,
    failures: 0,
    successRate: null,
    latencyMs: null,
    lastUpdatedAt: null,
    status: "unknown",
    models: provider.models,
    modelCount: provider.modelCount,
    protocols: provider.protocols,
    totalObservations: 0
  });

  function providersPayload(now = Date.now()) {
    const allEntries = describeAll(now);
    // Text providers and the separate vision pool are reported apart. Both the
    // health rollup and the target list are computed per pool, so a vision
    // failure can never be counted against a provider's text health (or the
    // other way round).
    const entries = allEntries.filter((entry) => (entry.pool ?? "text") === "text");
    const visionEntries = allEntries.filter((entry) => entry.pool === "vision");
    const rollup = providerRollup(entries);
    const visionRollup = providerRollup(visionEntries);
    const configView = describeConfig(config, targets);
    const byId = new Map(configView.providers.map((provider) => [provider.id, provider]));

    const providers = configView.providers.map((provider) => {
      const healthRow = rollup.find((row) => row.provider === provider.id);
      return {
        ...provider,
        health: healthRow ?? emptyRollup(provider),
        // Per-target detail is what the provider drawer renders.
        targets: entries.filter((entry) => entry.provider === provider.id)
      };
    });

    // A provider can appear in health without appearing in config only if the
    // catalog and config disagree; surface that rather than silently dropping it.
    const orphans = rollup.filter((row) => !byId.has(row.provider));

    return {
      generatedAt: new Date(now).toISOString(),
      summary: {
        ...configView.summary,
        health: summarizeHealth(entries),
        visionHealth: summarizeHealth(visionEntries)
      },
      providers,
      // The separate vision pool (image requests only), per target, with its
      // own independent health rollup.
      visionProviders: configView.visionProviders.map((provider) => {
        const healthRow = visionRollup.find((row) => row.provider === provider.id);
        return {
          ...provider,
          health: healthRow ?? emptyRollup(provider),
          targets: visionEntries.filter((entry) => entry.provider === provider.id)
        };
      }),
      unconfiguredHealth: orphans
    };
  }

  // --- /api/models -------------------------------------------------------
  function modelsPayload(now = Date.now()) {
    const entries = describeAll(now);
    const catalogue = modelCatalogue(entries, [...requestLog.entries.values()]);

    return {
      generatedAt: new Date(now).toISOString(),
      models: catalogue,
      filters: {
        providers: [...new Set(catalogue.map((model) => model.provider))].sort(),
        protocols: [...new Set(catalogue.flatMap((model) => model.protocols))].sort(),
        pools: [...new Set(catalogue.map((model) => model.pool))].sort(),
        statuses: Object.values(HEALTH_STATES)
      },
      summary: summarizeHealth(entries)
    };
  }

  // --- /api/router/preview -----------------------------------------------
  const POOLS = ["text", "vision"];

  /**
   * `pool` selects which routing pool to preview. Text is the default so every
   * existing caller keeps working; `vision` previews the image-request pool,
   * which has its own targets, its own health and its own fallback chain.
   */
  function routerPreviewPayload(searchParams, now = Date.now()) {
    const protocol = (searchParams.get("protocol") || "").trim();
    if (!protocol) {
      return { error: "a protocol query parameter is required" };
    }

    const requestedPool = (searchParams.get("pool") || "").trim().toLowerCase();
    const pool = requestedPool || "text";
    if (!POOLS.includes(pool)) {
      return {
        error: `unknown pool "${requestedPool}"`,
        details: { pools: POOLS }
      };
    }

    // The preview must run against the same target set the proxy would use for
    // this pool — never the combined list, which could show a route the router
    // would refuse to take.
    const poolTargets = targets.filter((target) => (target.pool ?? "text") === pool);

    if (poolTargets.length === 0) {
      return {
        status: 503,
        type: pool === "vision" ? "no_vision_route" : "no_route",
        error: pool === "vision"
          ? "No vision provider is configured"
          : "No provider is configured"
      };
    }

    // A client protocol is servable if any target can be reached for it —
    // natively, or through a bridge (so a chat client is servable by a
    // Gemini-only configuration).
    const supported = servableProtocols(poolTargets);
    if (!supported.has(protocol)) {
      return {
        error: `protocol "${protocol}" is not served by any configured target in the ${pool} pool`,
        details: { supported: [...supported].sort(), pool }
      };
    }

    return {
      generatedAt: new Date(now).toISOString(),
      pools: POOLS,
      protocols: [...supported].sort(),
      ...describeRouting({
        targets: poolTargets,
        config,
        health,
        protocol,
        pool,
        model: (searchParams.get("model") || "").trim(),
        stickyTargetId: (searchParams.get("session") || "").trim() || null, // observability text only
        manual: manualSelection?.get(pool) ?? [],
        now
      })
    };
  }

  // --- /api/analytics ----------------------------------------------------
  function analyticsPayload(searchParams, now = Date.now()) {
    const { label, rangeMs } = resolveRange(searchParams.get("range") || "1h", now);
    const buckets = Math.max(2, Math.min(Number(searchParams.get("buckets")) || 30, 120));

    // Optional pool scope. Only "text" / "vision" narrow the figures; any other
    // value is ignored (all traffic) so a typo cannot silently empty the page.
    const requestedPool = (searchParams.get("pool") || "").trim().toLowerCase();
    const pool = requestedPool === "text" || requestedPool === "vision" ? requestedPool : null;

    const start = now - rangeMs;
    const entries = [...requestLog.entries.values()].filter((entry) =>
      entry.receivedAt >= start && (pool === null || (entry.pool ?? "text") === pool));

    return {
      generatedAt: new Date(now).toISOString(),
      pool,
      range: { label, rangeMs, from: new Date(start).toISOString(), to: new Date(now).toISOString() },
      bucketMs: Math.floor(rangeMs / buckets),
      availableRanges: ["5m", "15m", "1h", "6h", "24h", "7d"],

      // Explicit: these figures come from live in-memory traffic only.
      source: "in-memory request log",
      sampleSize: entries.length,
      // Metrics that need a data source the gateway does not have yet are
      // reported as unavailable rather than as zero.
      unavailable: entries.length === 0 ? ["all metrics (no requests recorded in this range)"] : [],

      summary: summarizeRequests(entries),
      series: series(entries, { rangeMs, buckets, now }),
      breakdowns: {
        provider: breakdown(entries, (entry) => entry.finalProvider),
        model: breakdown(entries, (entry) => entry.finalModel),
        protocol: breakdown(entries, (entry) => entry.protocol),
        // Text and vision traffic are broken out so an image-routing problem is
        // never averaged away by the (usually much larger) text volume.
        pool: breakdown(entries, (entry) => entry.pool),
        outcome: breakdown(entries, (entry) => entry.outcome),
        errors: errorDistribution(entries),
        fallback: breakdown(
          entries.filter((entry) => (entry.fallbackCount ?? 0) > 0),
          (entry) => `${entry.finalProvider ?? "unknown"} / ${entry.finalModel ?? "unknown"}`
        )
      },
      recentFailures: entries
        .filter((entry) => entry.outcome === "failed")
        .slice(-10)
        .reverse()
        .map((entry) => ({
          id: entry.id,
          seq: entry.seq,
          receivedAt: entry.receivedAt,
          provider: entry.finalProvider,
          model: entry.finalModel,
          protocol: entry.protocol,
          httpStatus: entry.httpStatus,
          category: classifyFailure(entry),
          message: entry.errorMessage
        })),
      recentFallbacks: entries
        .filter((entry) => (entry.fallbackCount ?? 0) > 0)
        .slice(-10)
        .reverse()
        .map((entry) => ({
          id: entry.id,
          seq: entry.seq,
          receivedAt: entry.receivedAt,
          fallbackCount: entry.fallbackCount,
          outcome: entry.outcome,
          finalProvider: entry.finalProvider,
          finalModel: entry.finalModel,
          attempts: entry.attempts
        }))
    };
  }

  // --- /api/manual-selection ---------------------------------------------
  /**
   * The operator's manual order plus everything they can pick from. `available`
   * lists each provider/model once per pool (keys are counted, not listed: a
   * manual entry always covers every key of that provider/model, in key order),
   * in the router's own deterministic order so the picker matches real routing.
   */
  function manualSelectionPayload() {
    const snapshot = manualSelection?.snapshot() ?? { text: [], vision: [], updatedAt: null, persisted: true };
    const available = { text: [], vision: [] };
    for (const pool of ["text", "vision"]) {
      const byId = new Map();
      const inPool = targets.filter((target) => (target.pool ?? "text") === pool);
      for (const target of routeOrderByPool(inPool, config.priority, () => true)) {
        const id = `${target.provider}/${target.model}`;
        const row = byId.get(id) ?? { id, provider: target.provider, model: target.model, keys: 0, available: 0 };
        row.keys += 1;
        if (health.isAvailable(target)) row.available += 1;
        byId.set(id, row);
      }
      available[pool] = [...byId.values()];
    }
    const known = {
      text: new Set(available.text.map((row) => row.id)),
      vision: new Set(available.vision.map((row) => row.id))
    };
    return {
      ...snapshot,
      // Saved entries that no longer match a configured target (a removed key or
      // model). They are kept, so a temporarily missing key does not erase the order.
      unmatched: {
        text: snapshot.text.filter((id) => !known.text.has(id)),
        vision: snapshot.vision.filter((id) => !known.vision.has(id))
      },
      available
    };
  }

  // --- dispatcher --------------------------------------------------------
  async function handleApi(req, res, pathname, searchParams) {
    const now = Date.now();

    if (pathname === "/api/health" && req.method === "GET") {
      return sendJson(req, res, 200, healthPayload(now));
    }

    if (pathname === "/api/health/refresh" && req.method === "POST") {
      if (!monitor || typeof refreshHealth !== "function") {
        return fail(req, res, 503, "Health refresh is not available", "unavailable");
      }
      const result = await monitor.runManualCycle(refreshHealth);
      if (!result.started) {
        return sendJson(req, res, 409, { error: { message: result.reason, type: "conflict" }, ...result });
      }
      return sendJson(req, res, 200, { ok: true, cycle: result, health: healthPayload(Date.now()) });
    }

    if (pathname === "/api/manual-selection" && req.method === "GET") {
      return sendJson(req, res, 200, manualSelectionPayload());
    }

    if (pathname === "/api/manual-selection" && req.method === "PUT") {
      if (!manualSelection) return fail(req, res, 503, "Manual selection is not available", "unavailable");
      let body;
      try { body = await readJsonBody(req, { maxBytes: 64 * 1024 }); }
      catch (error) { return fail(req, res, error.status || 400, error.message, "invalid_request"); }
      try { manualSelection.set(body); }
      catch (error) { return fail(req, res, error.status || 400, error.message, "invalid_request"); }
      return sendJson(req, res, 200, manualSelectionPayload());
    }

    if (pathname === "/api/providers" && req.method === "GET") {
      return sendJson(req, res, 200, providersPayload(now));
    }

    if (pathname === "/api/models" && req.method === "GET") {
      return sendJson(req, res, 200, modelsPayload(now));
    }

    if (pathname === "/api/router/preview" && req.method === "GET") {
      const payload = routerPreviewPayload(searchParams, now);
      if (payload.error) {
        return fail(req, res, payload.status || 400, payload.error, payload.type || "invalid_request",
          payload.details || null);
      }
      return sendJson(req, res, 200, payload);
    }

    if (pathname === "/api/analytics" && req.method === "GET") {
      return sendJson(req, res, 200, analyticsPayload(searchParams, now));
    }

    if (pathname === "/api/config" && req.method === "GET") {
      return sendJson(req, res, 200, {
        generatedAt: new Date(now).toISOString(),
        ...describeConfig(config, targets),
        environment: describeEnvironment(config)
      });
    }

    if (pathname === "/api/system" && req.method === "GET") {
      return sendJson(req, res, 200, describeSystem({
        config,
        targets,
        monitor: monitor ? monitor.snapshot(now) : null,
        now
      }));
    }

    if (pathname === "/api/requests" && req.method === "GET") {
      return sendJson(req, res, 200, {
        generatedAt: new Date(now).toISOString(),
        ...requestLog.list({
          limit: searchParams.get("limit"),
          cursor: searchParams.get("cursor"),
          status: searchParams.get("status"),
          provider: searchParams.get("provider"),
          protocol: searchParams.get("protocol"),
          pool: searchParams.get("pool"),
          outcome: searchParams.get("outcome"),
          // Explicit sticky-session lookup. The single-request endpoint below
          // resolves request ids only, so the two identifiers never mix.
          session: searchParams.get("session")
        }),
        // Requests still running, so the Live Logs view can show them before
        // they finish. Never part of `entries`, so metrics are unaffected.
        pending: requestLog.pending(),
        attempts: requestLog.listAttempts({ limit: searchParams.get("attemptLimit") }).entries
      });
    }

    // Clear the request/attempt log (Live Logs "Clear"). Running requests stay.
    if (pathname === "/api/requests" && req.method === "DELETE") {
      const cleared = requestLog.clearFinished();
      return sendJson(req, res, 200, { ok: true, cleared });
    }

    // One event per real upstream attempt, oldest first. A request's attempts
    // share its `requestId`; no two attempts ever share an `attemptId`.
    if (pathname === "/api/attempts" && req.method === "GET") {
      return sendJson(req, res, 200, {
        generatedAt: new Date(now).toISOString(),
        ...requestLog.listAttempts({
          limit: searchParams.get("limit") ?? undefined,
          afterSeq: searchParams.get("afterSeq") ?? 0,
          requestId: searchParams.get("requestId"),
          pool: searchParams.get("pool"),
          state: searchParams.get("state"),
          provider: searchParams.get("provider")
        })
      });
    }

    // Before the `/api/requests/<id>` lookup below, which would take it for an id.
    if (pathname === "/api/requests/stream" && req.method === "GET") {
      return openRequestStream(req, res, searchParams);
    }

    if (pathname.startsWith("/api/requests/") && req.method === "GET") {
      let id;
      try { id = decodeURIComponent(pathname.slice("/api/requests/".length)); }
      catch { return fail(req, res, 400, "Malformed percent-encoding in request path", "invalid_request"); }
      // Accept the log-minted request id (echoed as `x-multi-ai-request-id`) or
      // the internal sequence number. A sticky session id is deliberately not
      // accepted here: it names many requests, so it is looked up through
      // `GET /api/requests?session=<id>` instead.
      const entry = requestLog.findByRequestId(id) ?? requestLog.get(id);
      if (!entry) return fail(req, res, 404, "Request not found", "not_found");
      return sendJson(req, res, 200, { request: entry });
    }

    if (pathname.startsWith("/api/")) {
      // An unknown admin path is a JSON 404 — never the SPA shell, so a typo
      // in a fetch call surfaces as an error instead of HTML.
      return fail(req, res, 404, "Not found", "not_found");
    }

    return false;
  }

  // Open live streams never end on their own, so shutdown has to close them or
  // `server.close()` would wait on them forever.
  handleApi.closeStreams = () => { for (const stream of [...liveStreams]) stream.close(); };
  return handleApi;
}
