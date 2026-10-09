import { createHash } from "node:crypto";
import { describeHealth, HEALTH_STATES } from "./health.js";
import { resetAutomaticOrderCache, routeOrderByPool } from "./fallback-plan.js";
import {
  FALLBACK_MODE_INFO,
  FALLBACK_MODES,
  FALLBACK_POOLS,
  MAX_KEYS,
  normalizeEntries,
  normalizeMode,
  remembersSuccess
} from "./fallback-chain.js";
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

export function createApi({
  config,
  targets,
  health,
  requestLog,
  monitor,
  refreshHealth,
  fallbackChain = null,
  resetFallbackState = null,
  describeFallbackState = null
}) {
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

  // The chain store is the single source of truth for order and mode. These two
  // read it defensively so the API module stays usable when it is constructed
  // without one (a test harness, or a future embedder).
  const fallbackSnapshot = () => (fallbackChain ? { text: fallbackChain.get("text"), vision: fallbackChain.get("vision") } : {});
  const fallbackMode = () => fallbackChain?.mode ?? FALLBACK_MODES.FIXED;

  // --- /api/health -------------------------------------------------------
  function healthPayload(now = Date.now()) {
    const entries = describeAll(now);
    // The real route order per pool, exactly as the Fallback Chain produces it;
    // health only removes cooling targets. Not a health-score sort.
    const ranked = routeOrderByPool(targets, {
      chains: fallbackSnapshot(),
      mode: fallbackMode(),
      health,
      now,
      isEligible: (target) => health.isAvailable(target, now)
    });

    // Text and vision are reported separately as well as together. The combined
    // rollup answers "how is this provider doing overall"; the per-pool figures
    // are what routing actually depends on, since each pool has its own health.
    const textEntries = entries.filter((entry) => (entry.pool ?? "text") === "text");
    const visionEntries = entries.filter((entry) => entry.pool === "vision");

    return {
      ok: true,
      generatedAt: new Date(now).toISOString(),
      service: "apirouter",
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

  /**
   * Validates one entry's `keys` exactly as the operator sent it.
   *
   * `keys` is the one field where a lenient reading is dangerous. Anything not
   * understood here would be normalized to `null`, which means EVERY key, so a
   * typo — or a value that merely coerces to an index, like `true` or `"1"` —
   * would silently widen the restriction instead of failing.
   *
   * Absent and explicit `null` still mean every key: that is the documented way
   * to say it, and it is what the panel sends for an unrestricted model.
   * Everything else must be an array of real integers this provider has.
   *
   * Returns null when the restriction is valid, or a machine-readable reason.
   */
  function keyRestrictionProblem(keys, available) {
    if (keys === undefined || keys === null) return null;
    if (!Array.isArray(keys)) return { reason: "keys_not_an_array", keys };
    if (keys.length === 0) return { reason: "keys_empty", keys };
    const offending = [...new Set(keys.filter((value) => (
      typeof value !== "number"
      || !Number.isInteger(value)
      || value < 0
      || value >= MAX_KEYS
      || !available.has(value)
    )))];
    return offending.length > 0 ? { reason: "keys_not_configured", keys: offending } : null;
  }

  // --- /api/fallback -----------------------------------------------------
  /**
   * Everything the Fallback Configuration page needs, in one payload: the saved
   * chain per pool, the selected mode, and the catalogue of models that can be
   * added — each with its per-key health and its measured latency.
   *
   * Latency is reported WITH its source (`request` = a real generation, `probe`
   * = a health probe, `null` = never measured). The panel must be able to say
   * "not measured yet" rather than show a number the router does not have.
   */
  function fallbackPayload(now = Date.now()) {
    const health = describeAll(now);
    const byPool = { text: [], vision: [] };
    const index = new Map();

    for (const entry of health) {
      const pool = entry.pool ?? "text";
      if (!byPool[pool]) continue;
      const id = `${pool}/${entry.provider}/${entry.model}`;
      let group = index.get(id);
      if (!group) {
        group = { id, provider: entry.provider, model: entry.model, pool, keyStates: [], protocols: [] };
        index.set(id, group);
        byPool[pool].push(group);
      }
      // Every key of one model in one pool serves the same protocols; the union
      // is taken anyway so a partially configured provider cannot understate it.
      for (const protocol of entry.protocols ?? []) {
        if (!group.protocols.includes(protocol)) group.protocols.push(protocol);
      }
      const available = !(Number(entry.cooldownUntil) > now);
      group.keyStates.push({
        id: entry.id,
        keyIndex: entry.keyIndex,
        status: available ? entry.status : "cooldown",
        score: entry.score,
        available,
        cooldownUntil: entry.cooldownUntil,
        latencyMs: entry.latencyMs,
        requestLatencyMs: entry.requestLatencyMs ?? null,
        probeLatencyMs: entry.probeLatencyMs ?? null,
        lastStatus: entry.lastStatus,
        modelListed: entry.modelListedConfirmed ?? null
      });
      if (!group.protocols.includes) group.protocols = [...(entry.protocols ?? [])];
    }

    for (const pool of FALLBACK_POOLS) {
      for (const group of byPool[pool] ?? []) {
        group.keyStates.sort((a, b) => a.keyIndex - b.keyIndex);
        // The key indexes this model actually has, which is what an entry's own
        // `keys` narrows. Kept separate from `keyStates` so an entry's saved
        // subset can never be confused with the provider's key inventory.
        group.keyIndexes = group.keyStates.map((key) => key.keyIndex);
        const measured = group.keyStates.find((key) => Number.isFinite(key.requestLatencyMs));
        const probed = group.keyStates.find((key) => Number.isFinite(key.probeLatencyMs));
        group.measuredLatencyMs = measured?.requestLatencyMs ?? null;
        group.probeLatencyMs = probed?.probeLatencyMs ?? null;
        // The number routing actually orders by, and where it came from.
        group.latencyMs = group.measuredLatencyMs ?? group.probeLatencyMs;
        group.latencySource = group.measuredLatencyMs !== null ? "request" : group.probeLatencyMs !== null ? "probe" : null;
        group.available = group.keyStates.some((key) => key.available);
        group.status = rollupStatus(group.keyStates);
      }
    }

    return {
      mode: fallbackMode(),
      remembersSuccess: remembersSuccess(fallbackMode()),
      modes: FALLBACK_MODE_INFO,
      chain: { text: fallbackChain?.get?.("text") ?? [], vision: fallbackChain?.get?.("vision") ?? [] },
      catalogue: byPool,
      pools: FALLBACK_POOLS,
      poolsSeparate: true,
      // What the router is currently remembering, so the panel can show it and
      // Reset Fallback can be seen to have worked rather than merely claimed.
      remembered: typeof describeFallbackState === "function" ? describeFallbackState() : null
    };
  }

  /** One status for a model, from its keys. Cooling keys are never reported healthy. */
  function rollupStatus(keys) {
    if (keys.some((key) => key.available && key.status === "healthy")) return "healthy";
    if (keys.every((key) => !key.available)) return "cooldown";
    if (keys.some((key) => key.status === "failed")) return "failed";
    return "unknown";
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
        health,
        protocol,
        pool,
        chain: fallbackChain?.get?.(pool) ?? [],
        mode: fallbackMode(),
        retryableStatus: config.retryableStatus,
        model: (searchParams.get("model") || "").trim(),
        stickyTargetId: (searchParams.get("session") || "").trim() || null, // observability text only
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

    if (pathname === "/api/providers" && req.method === "GET") {
      return sendJson(req, res, 200, providersPayload(now));
    }

    if (pathname === "/api/models" && req.method === "GET") {
      return sendJson(req, res, 200, modelsPayload(now));
    }

    if (pathname === "/api/fallback" && fallbackChain) {
      if (req.method === "GET") return sendJson(req, res, 200, fallbackPayload(now));

      if (req.method === "PUT") {
        let body;
        try { body = await readJsonBody(req, config.maxBodyBytes); }
        catch (error) { return fail(req, res, error.status || 400, "Invalid JSON body", "invalid_request"); }

        /*
         * Everything is validated BEFORE anything is written. A rejected save
         * must leave the configuration exactly as it was — including the case
         * where one request carries both a mode and a pool and only the second
         * is invalid, which used to persist the mode on the way to the error.
         */
        const hasMode = body?.mode !== undefined;
        const hasPool = body?.pool !== undefined;
        if (!hasMode && !hasPool) return fail(req, res, 400, "a pool or a mode is required", "invalid_request");

        // The mode is its own setting and can be saved on its own, so the panel
        // does not have to post a whole chain just to flip a switch.
        let mode = null;
        if (hasMode) {
          mode = normalizeMode(body.mode);
          const requested = body.mode === null ? "" : String(body.mode).trim().toLowerCase();
          if (requested !== "" && mode !== requested) {
            return fail(req, res, 400, `unknown mode "${body.mode}"`, "invalid_request", { modes: FALLBACK_MODES });
          }
        }

        let pool = null;
        let entries = null;
        if (hasPool) {
          pool = String(body.pool ?? "").trim().toLowerCase();
          if (!FALLBACK_POOLS.includes(pool)) {
            return fail(req, res, 400, `unknown pool "${pool}"`, "invalid_request", { pools: FALLBACK_POOLS });
          }
          if (!Array.isArray(body?.entries)) return fail(req, res, 400, "entries must be an array", "invalid_request");

          // What this pool can actually be routed to: the models it serves, and
          // the key indexes each of those providers actually has configured.
          const keyIndexes = new Map();
          for (const target of targets) {
            if ((target.pool ?? "text") !== pool) continue;
            const id = `${target.provider}/${target.model}`;
            if (!keyIndexes.has(id)) keyIndexes.set(id, new Set());
            keyIndexes.get(id).add(target.keyIndex);
          }

          // Checked against what was SENT, not the normalized form: a key
          // restriction the store would quietly discard is read as "every key",
          // so anything malformed here must be refused rather than widened.
          const unknown = [];
          const badKeys = [];
          for (const raw of body.entries) {
            const provider = String(raw?.provider ?? "").trim().toLowerCase();
            const model = String(raw?.model ?? "").trim();
            // Malformed entries carry no routing intent; normalization drops them.
            if (!provider || !model) continue;
            const id = `${provider}/${model}`;
            const available = keyIndexes.get(id);
            if (!available) {
              unknown.push(id);
              continue;
            }
            const problem = keyRestrictionProblem(raw?.keys, available);
            if (problem) {
              badKeys.push({
                provider, model,
                ...problem,
                available: [...available].sort((a, b) => a - b)
              });
            }
          }

          if (unknown.length > 0) {
            return fail(
              req, res, 400,
              "entries contains models that are not configured for this pool",
              "invalid_request",
              { pool, unknown }
            );
          }
          if (badKeys.length > 0) {
            return fail(
              req, res, 400,
              "entries contains key restrictions that are not valid for this pool",
              "invalid_request",
              { pool, keys: badKeys }
            );
          }

          entries = normalizeEntries(body.entries);
        }

        // Nothing above failed, so this is the only place anything is written.
        // A mode and a chain arriving together go through ONE persisted update:
        // writing them separately could land the mode and then fail on the
        // chain, leaving a half-applied configuration behind.
        try {
          fallbackChain.update({
            ...(hasMode ? { mode } : {}),
            ...(hasPool ? { pool, entries } : {})
          });
        } catch {
          return fail(req, res, 500, "Could not save the fallback configuration", "server_error");
        }
        // The saved configuration is live from this moment. Invalidated only
        // after the writes succeeded, so a rejected save cannot disturb the
        // order already in force.
        resetAutomaticOrderCache();
        return sendJson(req, res, 200, fallbackPayload(now));
      }
    }

    if (pathname === "/api/fallback/reset" && req.method === "POST" && fallbackChain) {
      // Reset clears what the router REMEMBERS. It must not touch the saved
      // chain, the mode, the providers, the keys, the health measurements or a
      // genuine cooldown — those are all still true after the button is pressed.
      if (typeof resetFallbackState !== "function") {
        return fail(req, res, 503, "Reset is not available in this process", "unavailable");
      }
      let result;
      try { result = resetFallbackState(); }
      catch { return fail(req, res, 500, "Could not reset the fallback state", "server_error"); }
      return sendJson(req, res, 200, {
        ok: true,
        message: "Remembered targets cleared. The next request starts from the first target of the active chain.",
        reset: result,
        ...fallbackPayload(now)
      });
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
          outcome: searchParams.get("outcome")
        }),
        // Requests still running, so the Live Logs view can show them before
        // they finish. Never part of `entries`, so metrics are unaffected.
        pending: requestLog.pending(),
        attempts: requestLog.listAttempts({ limit: searchParams.get("attemptLimit") }).entries
      });
    }

    // Clear the request log (Live Logs "Clear"). Finished requests and attempts
    // are removed for good, so a page refresh cannot bring them back.
    if (pathname === "/api/requests" && req.method === "DELETE") {
      const cleared = requestLog.clearCompleted();
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
      // Accept either the client-visible request id or the internal sequence.
      const entry = requestLog.findById(id) ?? requestLog.get(id);
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
