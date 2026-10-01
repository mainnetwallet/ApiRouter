import "dotenv/config";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { loadConfig, buildTargets } from "./config.js";
import {
  describeHealth,
  rankTargets,
  healthRegistry,
  startHealthMonitor,
  refreshAllHealth
} from "./health.js";
import { probeTargetHealth, PROBE_TIMEOUT_MS } from "./health-checks.js";
import { RouteSession, SessionStore, withFallback } from "./router.js";
import { clientProtocol, buildUpstreamRequest, readJsonBody, createSessionId } from "./adapters.js";
import { PROVIDERS } from "./providers/catalog.js";
import { createApi } from "./api.js";
import { createStaticHandler } from "./static-files.js";
import { selectRouteTargets } from "./observability/route-select.js";
import { requestLog } from "./observability/request-log.js";
import { HealthMonitorState } from "./observability/monitor-state.js";
import { sanitizeMessage } from "./observability/sanitize.js";

const config = loadConfig();
const targets = buildTargets(config.providers);
const sessions = new SessionStore();

/**
 * Mirrors the default in `src/health.js`. Passed explicitly so the value the
 * system page reports is the value the monitor is actually running on.
 */
const HEALTH_CHECK_INTERVAL_MS = 15 * 60 * 1000;

/** Built control panel. Absent until `npm run ui:build` has run. */
const staticFiles = createStaticHandler({
  root: fileURLToPath(new URL("../ui/dist/", import.meta.url))
});

/**
 * Largest JSON response that will be buffered to read token usage. Anything
 * larger (or unlabelled) keeps streaming, because buffering an unbounded body
 * is a memory risk the observability feature does not justify.
 */
const MAX_INSPECT_BYTES = 1024 * 1024;

function isAbortError(error) {
  return error?.name === "AbortError" || error?.name === "TimeoutError";
}

/**
 * `fetch` rejects with a DOMException whose `message`/`name` are getter-only,
 * so an aborted request must be converted into a fresh Error. Assigning to
 * `error.message` directly throws a TypeError and destroys the 408 status,
 * which silently disables retry/fallback for timed-out upstreams.
 */
function toTimeoutError(message) {
  const error = new Error(message);
  error.name = "TimeoutError";
  error.status = 408;
  return error;
}

/**
 * Health probes are provider-aware (see src/health-checks.js) and capped well
 * below the request timeout so a single slow provider cannot stall a cycle.
 */
const checkTargetHealth = (target) =>
  probeTargetHealth(target, {
    timeoutMs: Math.min(config.timeoutMs, PROBE_TIMEOUT_MS)
  });

/**
 * The monitor reports cycle timing without `src/health.js` changing: the
 * tracker observes the probe function the monitor is handed.
 */
const monitor = new HealthMonitorState({
  intervalMs: HEALTH_CHECK_INTERVAL_MS,
  targetCount: targets.length
});
const trackedCheckTargetHealth = monitor.wrapCheck(checkTargetHealth);

function json(res, status, body, extraHeaders = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(payload), ...extraHeaders });
  res.end(payload);
}

function authorized(req) {
  if (config.routerApiKeys.length === 0) return true;
  const value = String(req.headers.authorization || "");
  const token = value.startsWith("Bearer ") ? value.slice(7).trim() : "";
  return Boolean(token && config.routerApiKeys.includes(token));
}

function getSession(req, protocol) {
  const requested = String(req.headers["x-multi-ai-session-id"] || "").trim();
  const id = requested || createSessionId();
  const key = protocol + ":" + id;

  let state = sessions.get(key);
  if (!state) {
    state = sessions.set(key, { id, protocol, session: new RouteSession() });
  }

  return { id, state };
}

function publicFailure(error) {
  return (error?.failures || []).map((item) => ({
    provider: item.target?.provider,
    model: item.target?.model,
    keyIndex: item.target?.keyIndex,
    status: item.status,
    message: item.message
  }));
}

/**
 * Pull usage/finish-reason out of an OpenAI-, Anthropic- or Gemini-shaped body.
 * These are read opportunistically: a shape we do not recognise yields nulls,
 * and the UI reports "not reported" rather than guessing.
 */
function extractUsage(parsed) {
  if (!parsed || typeof parsed !== "object") return { tokens: null, finishReason: null };

  const usage = parsed.usage ?? parsed.usageMetadata ?? null;
  const tokens = Number.isFinite(usage?.total_tokens)
    ? usage.total_tokens
    : Number.isFinite(usage?.totalTokens)
      ? usage.totalTokens
      : Number.isFinite(usage?.input_tokens) || Number.isFinite(usage?.output_tokens)
        ? (Number(usage.input_tokens) || 0) + (Number(usage.output_tokens) || 0)
        : null;

  const candidate =
    parsed.choices?.[0]?.finish_reason ??
    parsed.stop_reason ??
    parsed.candidates?.[0]?.finishReason ??
    null;

  return {
    tokens,
    finishReason: typeof candidate === "string" ? candidate : null
  };
}

/** Records a routed request. Never allowed to break the request it describes. */
function recordRequest(fields) {
  try {
    return requestLog.record(fields);
  } catch {
    return null;
  }
}

async function proxy(req, res, protocol, pathname) {
  const receivedAt = Date.now();
  const attempts = [];

  if (!authorized(req)) {
    recordRequest({
      receivedAt,
      protocol,
      httpStatus: 401,
      outcome: "failed",
      errorType: "authentication_error",
      errorMessage: "client authentication failed",
      attempts
    });
    return json(res, 401, { error: { message: "Unauthorized", type: "authentication_error" } });
  }

  let body;
  try { body = await readJsonBody(req); }
  catch (error) {
    recordRequest({
      receivedAt,
      protocol,
      httpStatus: error.status || 400,
      outcome: "failed",
      errorType: "invalid_request_error",
      errorMessage: sanitizeMessage(error.message),
      attempts
    });
    return json(res, error.status || 400, { error: { message: error.message, type: "invalid_request_error" } });
  }

  const sessionInfo = getSession(req, protocol);

  const geminiPathModel = protocol === "gemini"
    ? pathname.match(/^\/v1beta\/models\/([^:]+):generateContent$/)?.[1] || ""
    : "";
  const requestedModel = typeof body.model === "string" ? body.model : geminiPathModel;

  // Target selection is shared with the routing preview, so what the Router
  // page shows is the decision this function actually makes.
  const selection = selectRouteTargets(targets, protocol, requestedModel);
  const routeTargets = selection.selected;

  if (selection.compatible.length === 0) {
    recordRequest({
      id: sessionInfo.id,
      receivedAt,
      protocol,
      requestedModel,
      httpStatus: 503,
      outcome: "failed",
      errorType: "no_route",
      errorMessage: "No configured provider targets support this client protocol",
      attempts
    });
    return json(res, 503, { error: { message: "No configured provider targets support this client protocol", type: "no_route" } });
  }

  try {
    const result = await withFallback(
      routeTargets,
      async (target) => {
        const request = buildUpstreamRequest(target, protocol, body, req.headers);
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), config.timeoutMs);
        const attemptStartedAt = Date.now();

        // Records one real upstream attempt, in the order `withFallback` makes
        // them. This is the true fallback chain, observed rather than
        // reconstructed from the final error.
        let recorded = false;
        const attempt = (ok, status, errorMessage) => {
          recorded = true;
          attempts.push({
            provider: target.provider,
            model: target.model,
            keyIndex: target.keyIndex,
            protocol,
            ok,
            status: Number.isInteger(status) ? status : null,
            // Wall-clock start, so the Live Logs view can place each real
            // attempt on a timeline instead of guessing from request totals.
            startedAt: attemptStartedAt,
            latencyMs: Date.now() - attemptStartedAt,
            errorMessage: sanitizeMessage(errorMessage)
          });
        };

        try {
          const upstream = await fetch(request.url, { ...request.options, signal: controller.signal });
          if (!upstream.ok) {
            const text = await upstream.text();
            const error = new Error(text.slice(0, 2000) || ("Upstream HTTP " + upstream.status));
            error.status = upstream.status;
            attempt(false, upstream.status, error.message);
            throw error;
          }
          // The successful attempt is recorded too — otherwise the log would
          // show a chain of failures with no terminal success.
          attempt(true, upstream.status, null);
          return { upstream, target };
        } catch (error) {
          if (isAbortError(error)) {
            const timeout = toTimeoutError("Upstream request timed out");
            attempt(false, timeout.status, timeout.message);
            throw timeout;
          }
          // A transport-level rejection (DNS, TLS, socket) records here; an
          // HTTP error status was already recorded above.
          if (!recorded) attempt(false, Number(error?.status) || null, error?.message);
          throw error;
        } finally { clearTimeout(timer); }
      },
      config.retryableStatus,
      sessionInfo.state.session,
      healthRegistry
    );

    const sessionId = sessionInfo.id;
    const contentType = result.upstream.headers.get("content-type") || "application/json";
    const declaredLength = Number(result.upstream.headers.get("content-length"));
    let usage = { tokens: null, finishReason: null };
    let buffered = null;

    // Only small, explicitly-sized JSON bodies are inspected for usage. The
    // bytes forwarded to the client are unchanged either way.
    if (
      result.upstream.body &&
      contentType.includes("application/json") &&
      Number.isFinite(declaredLength) &&
      declaredLength <= MAX_INSPECT_BYTES
    ) {
      try {
        const raw = Buffer.from(await result.upstream.arrayBuffer());
        buffered = raw;
        usage = extractUsage(JSON.parse(raw.toString("utf8")));
      } catch {
        buffered = null;
      }
    }

    const latencyMs = Date.now() - receivedAt;

    // Recorded before the body is written: a client that reads the request log
    // immediately after this call would otherwise race the write and see a
    // stale list. `latencyMs` is time-to-upstream-response, which is the
    // figure an operator acts on; stream duration is not included.
    recordRequest({
      id: sessionId,
      receivedAt,
      protocol,
      requestedModel,
      autoRouted: !selection.modelMatched,
      streamed: !buffered && Boolean(result.upstream.body),
      attempts,
      finalProvider: result.target.provider,
      finalModel: result.target.model,
      finalKeyIndex: result.target.keyIndex,
      httpStatus: result.upstream.status,
      latencyMs,
      totalMs: Date.now() - receivedAt,
      tokens: usage.tokens,
      finishReason: usage.finishReason,
      outcome: "success"
    });

    res.writeHead(result.upstream.status, {
      "content-type": contentType,
      "cache-control": "no-cache",
      "x-multi-ai-provider": result.target.provider,
      "x-multi-ai-model": result.target.model,
      "x-multi-ai-key-index": String(result.target.keyIndex),
      "x-multi-ai-session-id": sessionId
    });

    if (buffered) {
      res.end(buffered);
    } else if (result.upstream.body) {
      try {
        // pipeline() applies backpressure and tears down the upstream reader
        // when the client disconnects.
        await pipeline(Readable.fromWeb(result.upstream.body), res);
      } catch {
        // Headers are already on the wire, so the failure cannot be reported
        // as a JSON error response. Drop the connection instead.
        res.destroy();
      }
    } else {
      res.end();
    }
  } catch (error) {
    recordRequest({
      id: sessionInfo.id,
      receivedAt,
      protocol,
      requestedModel,
      autoRouted: !selection.modelMatched,
      attempts,
      finalProvider: attempts.at(-1)?.provider ?? null,
      finalModel: attempts.at(-1)?.model ?? null,
      finalKeyIndex: attempts.at(-1)?.keyIndex ?? null,
      httpStatus: error.status || 502,
      latencyMs: Date.now() - receivedAt,
      totalMs: Date.now() - receivedAt,
      errorType: error?.errorType ?? "upstream_error",
      errorMessage: sanitizeMessage(error?.message || "All routing targets failed"),
      outcome: "failed"
    });
    return json(res, error.status || 502, { error: { message: error.message || "All routing targets failed", type: "upstream_error", failures: publicFailure(error) }, }, { "x-multi-ai-session-id": sessionInfo.id });
  }
}

const handleApi = createApi({
  config,
  targets,
  health: healthRegistry,
  requestLog,
  monitor,
  refreshHealth: () => refreshAllHealth(targets, trackedCheckTargetHealth)
});

/** Paths the SPA must never shadow; they belong to the gateway itself. */
const RESERVED_PREFIXES = ["/api", "/v1", "/v1beta", "/health"];

function isReserved(pathname) {
  return RESERVED_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(prefix + "/")
  );
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  const pathname = url.pathname;

  if (req.method === "GET" && pathname === "/health") {
    const ranked = rankTargets(targets).map((target, index) => ({ rank: index + 1, provider: target.provider, model: target.model, keyIndex: target.keyIndex, protocols: target.protocols }));
    return json(res, 200, { ok: true, service: "multi-ai-router", providers: PROVIDERS, configuredTargets: targets.length, health: describeHealth(targets), rankedTargets: ranked, retryableStatus: [...config.retryableStatus] });
  }

  if (req.method === "GET" && pathname === "/v1/models") {
    const data = rankTargets(targets).map((target) => ({ id: target.model, object: "model", provider: target.provider, keyIndex: target.keyIndex }));
    return json(res, 200, { object: "list", data });
  }

  // Admin surface. Same auth rule as the proxy path.
  if (pathname.startsWith("/api/") || pathname === "/api") {
    if (!authorized(req)) {
      return json(res, 401, { error: { message: "Unauthorized", type: "authentication_error" } });
    }
    const handled = await handleApi(req, res, pathname, url.searchParams);
    if (handled !== false) return undefined;
    return json(res, 404, { error: { message: "Not found", type: "not_found" } });
  }

  const protocol = req.method === "POST" ? clientProtocol(pathname) : null;
  if (protocol) return proxy(req, res, protocol, pathname);

  // Static panel assets, then the SPA shell for client-side routes.
  if (req.method === "GET" || req.method === "HEAD") {
    if (!isReserved(pathname)) {
      if (await staticFiles.serve(req, res, pathname)) return undefined;

      // Extensionless paths are client-side routes, so they get the shell.
      // Anything that looks like a missing file still 404s, which keeps a
      // typo'd asset URL diagnosable.
      const looksLikeRoute = !/\.[a-z0-9]+$/i.test(pathname);
      if (looksLikeRoute) return staticFiles.serveIndex(req, res);
    }
    return json(res, 404, { error: { message: "Not found", type: "not_found" } });
  }

  return json(res, 404, { error: { message: "Not found", type: "not_found" } });
});

const stopHealthMonitor = startHealthMonitor(targets, trackedCheckTargetHealth, HEALTH_CHECK_INTERVAL_MS);
process.once("SIGINT", () => {
  monitor.stop();
  stopHealthMonitor();
  server.close(() => process.exit(0));
});
process.once("SIGTERM", () => {
  monitor.stop();
  stopHealthMonitor();
  server.close(() => process.exit(0));
});

server.listen(config.port, () => {
  console.log("MultiAI Router listening on http://localhost:" + config.port);
  console.log("Control Panel UI: http://localhost:" + config.port + "/");
});
