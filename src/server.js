import "dotenv/config";
import { startKeepAlive } from "./keepalive.js";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { loadConfig, buildTargets, VISION_POOL } from "./config.js";
import {
  TEXT_POOL,
  capabilityErrorMessage,
  modelPoolIndex,
  validateModelForPool
} from "./capabilities.js";
import {
  describeHealth,
  rankTargets,
  healthRegistry,
  startHealthMonitor,
  refreshAllHealth
} from "./health.js";
import { probeTargetHealth, PROBE_TIMEOUT_MS } from "./health-checks.js";
import { RouteSession, SessionStore, parseRetryAfterMs, withFallback } from "./router.js";
import { clientProtocol, buildUpstreamRequest, readJsonBody, isGeminiStream } from "./adapters.js";
import { PROVIDERS } from "./providers/catalog.js";
import { createApi } from "./api.js";
import { createSseUsageTap, createJsonUsageTap, tapBytes, tapEvents, usageFrom } from "./usage.js";
import { createStaticHandler } from "./static-files.js";
import { selectTargetsForProtocol, pinTargets } from "./observability/route-select.js";
import { buildRoutePlan, chainStatusByPool, routeOrderByPool, resetAutomaticOrderCache } from "./fallback-plan.js";
import {
  FallbackChainStore,
  hasLegacyConfig,
  readLegacyConfig,
  remembersSuccess
} from "./fallback-chain.js";
import { selectPool } from "./vision.js";
import {
  bridgeProtocol,
  buildBridgeRequest,
  convertJsonResponse,
  streamToAnthropic,
  sseData,
  estimateInputTokens
} from "./anthropic-bridge.js";
import {
  codexProtocol,
  buildCodexRequest,
  convertCodexJson,
  streamToResponses,
  customToolNames,
  estimateResponsesInputTokens
} from "./codex-bridge.js";
import {
  chatProtocol,
  buildChatRequest,
  convertChatJson,
  streamToChat,
  estimateChatInputTokens
} from "./chat-bridge.js";
import {
  geminiProtocol,
  buildGeminiBridgeRequest,
  chatJsonToGemini,
  streamToGemini
} from "./gemini-bridge.js";
import { isSignatureRejection } from "./gemini-signature.js";
import { requestLog } from "./observability/request-log.js";
import { HealthMonitorState } from "./observability/monitor-state.js";
import { sanitizeMessage, registerConfiguredSecrets } from "./observability/sanitize.js";
import { validateRequestShape } from "./request-validation.js";

let config;
try { config = loadConfig(); }
catch (error) {
  console.error(`Configuration error: ${error.message}`);
  process.exit(1);
}

// Everything the router holds that must never be echoed back: provider keys
// (both pools), Cloudflare account ids (they sit in the upstream URL path) and
// the router's own client keys. Registered once, before any request is served.
registerConfiguredSecrets([
  ...(config.routerApiKeys || []),
  ...[config.providers, config.visionProviders].flatMap((group) => Object.values(group || {}).flatMap((p) => p?.apiKeys || [])),
  ...[config.providers, config.visionProviders].flatMap((group) => group?.cloudflare?.accountIds || [])
]);
// The Fallback Chain: the single source of truth for routing order, per pool.
// On first run it is seeded from the legacy manual-selection file and priority
// env vars, so an upgrade keeps the operator's routing; after that the legacy
// sources are never read again and cannot override what is configured here.
const fallbackChain = new FallbackChainStore({
  file: config.fallbackChainFile,
  migrate: () => readLegacyConfig({ manualFile: config.legacyManualSelectionFile, env: process.env })
});
if (fallbackChain.migrated) {
  console.log("fallback chain: migrated the legacy manual selection / priority configuration");
}
if (hasLegacyConfig({ manualFile: config.legacyManualSelectionFile, env: process.env })) {
  console.warn(
    "fallback chain: MANUAL_SELECTION_FILE / TEXT_PRIORITY_MODELS / VISION_PRIORITY_MODELS are legacy and are now ignored. "
    + "Configure the fallback chain in the control panel instead."
  );
}
const textTargets = buildTargets(config.providers);
const visionTargets = buildTargets(config.visionProviders, VISION_POOL);
// Everything the router can reach: health checks, the dashboard and the metrics cover both pools.
const targets = [...textTargets, ...visionTargets];
// Which pools each configured model id belongs to. Static for the process
// lifetime (it comes from the environment), so it is built once.
const modelCapabilities = modelPoolIndex(config);
const sessions = new SessionStore();

/**
 * Mirrors the default in `src/health.js`. Passed explicitly so the value the
 * system page reports is the value the monitor is actually running on.
 */
const HEALTH_CHECK_INTERVAL_MS = 12 * 60 * 1000;

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
/** True when an upstream 400 body says the model id itself was rejected. */
export function isModelRejection(message) {
  const text = String(message || "");
  return /model/i.test(text)
    && /(not (a )?valid|invalid|not found|does not exist|doesn't exist|unknown|unsupported|not supported|no such|unavailable)/i.test(text);
}

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

// Clients such as Claude Code, Codex and the OpenAI SDKs never send
// x-multi-ai-session-id. A random id per request meant every such request
// started a brand-new session, so the last successful model + key was never
// found again. Requests without the header now share one stable session per
// protocol + pool; an explicit header still selects its own isolated session.
const DEFAULT_SESSION_ID = "default";

function getSession(req, protocol, pool = TEXT_POOL) {
  const requested = String(req.headers["x-multi-ai-session-id"] || "").trim();
  const id = requested || DEFAULT_SESSION_ID;
  // Text and vision keep independent sticky targets. Sharing one entry would
  // let a vision target's id sit in a text session (and vice versa), which is
  // harmless today only because the id would not be found in the other pool's
  // group — an accident, not a design. The pools get their own state.
  const key = protocol + ":" + pool + ":" + id;

  let state = sessions.get(key);
  if (!state) {
    state = sessions.set(key, { id, protocol, pool, session: new RouteSession({ ttlMs: config.stickyTtlMs }) });
  }

  return { id, state };
}

// Upstream error bodies are allowed up to 2000 characters; a client-facing
// message keeps that room so the diagnostic survives, minus any credential.
const CLIENT_MESSAGE_MAX = 2000;
const clientMessage = (value) => sanitizeMessage(value, { maxLength: CLIENT_MESSAGE_MAX });

function publicFailure(error) {
  return (error?.failures || []).map((item) => ({
    provider: item.target?.provider,
    model: item.target?.model,
    keyIndex: item.target?.keyIndex,
    status: item.status,
    message: sanitizeMessage(item.message)
  }));
}

/**
 * Pull usage/finish-reason out of an OpenAI-, Anthropic- or Gemini-shaped body.
 * These are read opportunistically: a shape we do not recognise yields nulls,
 * and the UI reports "not reported" rather than guessing.
 */
function extractUsage(parsed) {
  if (!parsed || typeof parsed !== "object") return { tokens: null, finishReason: null, reported: null };

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
    finishReason: typeof candidate === "string" ? candidate : null,
    // Input / output / total exactly as the provider reported them (null when it did not).
    reported: usageFrom(parsed)
  };
}

/** Total tokens of a converted response, across all three client shapes. */
function convertedTokens(converted) {
  const usage = converted?.usage;
  if (!usage) return null;
  if (Number.isFinite(usage.total_tokens)) return usage.total_tokens;
  const input = Number(usage.input_tokens ?? usage.prompt_tokens) || 0;
  const output = Number(usage.output_tokens ?? usage.completion_tokens) || 0;
  return input + output || null;
}

/** Records a routed request. Never allowed to break the request it describes. */
function recordRequest(fields) {
  try {
    return requestLog.record(fields);
  } catch {
    return null;
  }
}

/** Live-view bookkeeping has the same rule: it must never break a request. */
function beginRequest(fields) {
  try { return requestLog.begin(fields); } catch { return null; }
}

/**
 * One real upstream call is going on the wire: open its own attempt event.
 * Returns the new attempt's id (or null when the live view is unavailable).
 */
function startAttemptEvent(startSeq, target) {
  if (startSeq === null || startSeq === undefined) return null;
  try { return requestLog.startAttempt(startSeq, target); } catch { return null; }
}

/** That call answered: settle ITS event, and only its. */
function finishAttemptEvent(attemptId, result) {
  if (!attemptId) return;
  try { requestLog.finishAttempt(attemptId, result); } catch { /* observability only */ }
}

/**
 * Attach what the provider reported to the ONE attempt that answered. Usage is
 * keyed by that attempt's id, so a fallback attempt can never receive (or lose)
 * another attempt's figures.
 */
function reportAttemptUsage(attemptId, usage) {
  if (!attemptId || !usage) return;
  try { requestLog.recordAttemptUsage(attemptId, usage); } catch { /* observability only */ }
}

function progressRequest(startSeq, update) {
  if (startSeq === null || startSeq === undefined) return;
  try { requestLog.progress(startSeq, update); } catch { /* observability only */ }
}

/**
 * Optional pin headers. Returns `{ provider, keyIndex }`, or `{ error }` for a
 * malformed key index so a typo is reported rather than ignored.
 */
function readPin(req) {
  const provider = String(req.headers["x-multi-ai-pin-provider"] || "").trim();
  const rawKey = String(req.headers["x-multi-ai-pin-key-index"] ?? "").trim();
  const customModel = ["1", "true"].includes(String(req.headers["x-multi-ai-pin-custom-model"] ?? "").trim().toLowerCase());
  if (!provider) return { provider: "", keyIndex: null };
  if (rawKey === "") return { provider, keyIndex: null, customModel };
  const keyIndex = Number(rawKey);
  if (!Number.isInteger(keyIndex) || keyIndex < 0) {
    return { error: "x-multi-ai-pin-key-index must be a non-negative integer" };
  }
  return { provider, keyIndex, customModel };
}

/**
 * Health view for pinned requests. A pinned request names one specific target
 * on purpose (the Playground testing a key), so a cooldown must not make it
 * unreachable. Outcomes are still recorded in the shared registry, so a pinned
 * failure still cools the target for ordinary traffic.
 */
const pinnedHealth = Object.create(healthRegistry);
pinnedHealth.rank = (group) => [...group];
pinnedHealth.isAvailable = () => true;

const lastRealAttempt = (list) => [...list].reverse().find((item) => !item.skipped);

async function proxy(req, res, protocol, pathname) {
  const receivedAt = Date.now();
  const attempts = [];
  let liveSeq = null;

  if (!authorized(req)) {
    recordRequest({
      pendingSeq: liveSeq,
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
  try { body = await readJsonBody(req, config.maxBodyBytes); }
  catch (error) {
    recordRequest({
      pendingSeq: liveSeq,
      receivedAt,
      protocol,
      httpStatus: error.status || 400,
      outcome: "failed",
      errorType: "invalid_request_error",
      errorMessage: sanitizeMessage(error.message),
      attempts
    });
    return json(res, error.status || 400, { error: { message: clientMessage(error.message), type: "invalid_request_error" } });
  }

  // Basic request-shape check, before the pool, session or any target is
  // chosen: a request no adapter can read must fail here, locally, as a 400 and
  // never reach routing, an upstream or the fallback walk.
  const shapeError = validateRequestShape(protocol, body);
  if (shapeError) {
    recordRequest({
      pendingSeq: liveSeq,
      receivedAt,
      protocol,
      httpStatus: 400,
      outcome: "failed",
      errorType: "invalid_request_error",
      errorMessage: shapeError,
      attempts
    });
    return json(res, 400, { error: { message: shapeError, type: "invalid_request_error" } });
  }

  // The model id is one path segment, so a client may percent-encode the "/" in
  // ids such as "vendor/model" as %2F. Decode it, or it never matches a target.
  const geminiPathModelRaw = protocol === "gemini"
    ? pathname.match(/^\/v1beta\/models\/([^:]+):(?:stream)?[Gg]enerateContent$/)?.[1] || ""
    : "";
  let geminiPathModel = geminiPathModelRaw;
  try { geminiPathModel = decodeURIComponent(geminiPathModelRaw); } catch { /* malformed escape: keep raw */ }
  const requestedModel = typeof body.model === "string" ? body.model : geminiPathModel;

  // A Gemini client selects streaming with the method name rather than a body
  // field, so both spellings have to be considered here.
  const wantsStream = body.stream === true || (protocol === "gemini" && isGeminiStream(pathname));

  // The pool is decided from the request body before anything else, because it
  // governs the session, the candidate targets and the capability rules for the
  // whole request. An image request is served only by the vision pool (own
  // keys / base URLs / models); every other request only by the text pool.
  const { pool, targets: poolTargets } = selectPool(body, { textTargets, visionTargets });

  const sessionInfo = getSession(req, protocol, pool);

  // Target selection is shared with the routing preview, so what the Router
  // page shows is the decision this function actually makes.
  // Claude Code (Anthropic protocol), Codex (Responses protocol) and OpenAI
  // chat clients may fall back to ANY reachable provider: targets that do not
  // speak the client's protocol are reached through a translation bridge.
  const bridgeKind =
    protocol === "anthropic" ? "anthropic"
    : protocol === "openai-responses" ? "codex"
    : protocol === "openai-chat" ? "chat"
    : protocol === "gemini" ? "gemini"
    : null;
  const bridged = bridgeKind !== null;
  const nativeProtocol =
    bridgeKind === "codex" ? "openai-responses"
    : bridgeKind === "chat" ? "openai-chat"
    : bridgeKind === "gemini" ? "gemini"
    : "anthropic";
  const upstreamProtocolFor = (target) =>
    bridgeKind === "codex" ? codexProtocol(target)
    : bridgeKind === "chat" ? chatProtocol(target)
    : bridgeKind === "gemini" ? geminiProtocol(target)
    : bridgeProtocol(target);

  liveSeq = beginRequest({ id: sessionInfo.id, receivedAt, protocol, pool, requestedModel });

  const pin = readPin(req);
  if (pin.error) {
    recordRequest({
      pendingSeq: liveSeq,
      id: sessionInfo.id, receivedAt, protocol, pool, requestedModel, httpStatus: 400,
      outcome: "failed", errorType: "invalid_request_error", errorMessage: pin.error, attempts
    });
    return json(res, 400, { error: { message: clientMessage(pin.error), type: "invalid_request_error" } }, { "x-multi-ai-session-id": sessionInfo.id });
  }

  // Nothing in this pool at all. Reported before capability validation, because
  // "no vision provider is configured" is the more useful answer than "that
  // model is not a vision model" when both are true.
  if (pool === VISION_POOL && poolTargets.length === 0) {
    const message = "No vision provider is configured";
    recordRequest({
      pendingSeq: liveSeq,
      id: sessionInfo.id, receivedAt, protocol, pool, requestedModel, httpStatus: 503,
      outcome: "failed", errorType: "no_vision_route", errorMessage: message, attempts
    });
    return json(res, 503, { error: { message, type: "no_vision_route" } }, { "x-multi-ai-session-id": sessionInfo.id });
  }

  // A model the router only knows as configured for the *other* pool is a
  // capability mismatch: reject it clearly instead of silently routing the
  // request to a different model than the client asked for. A model the router
  // has never heard of is not a mismatch and keeps the existing
  // widen-to-all-compatible-targets behaviour.
  const capability = validateModelForPool(modelCapabilities, requestedModel, pool);
  if (capability) {
    const message = capabilityErrorMessage(capability);
    recordRequest({
      pendingSeq: liveSeq,
      id: sessionInfo.id, receivedAt, protocol, pool, requestedModel, httpStatus: 400,
      outcome: "failed", errorType: capability.type, errorMessage: message, attempts
    });
    return json(res, 400, {
      error: {
        message,
        type: capability.type,
        model: capability.model,
        required_capability: capability.required_capability
      }
    }, { "x-multi-ai-session-id": sessionInfo.id });
  }

  const pinned = pinTargets(poolTargets, pin, requestedModel);
  if (pinned.pinned && pinned.targets.length === 0) {
    const where = `${pinned.provider}${pinned.keyIndex !== null ? ` key ${pinned.keyIndex}` : ""}${pinned.model ? ` / ${pinned.model}` : ""}`;
    const message = `No configured target matches the pinned selection (${sanitizeMessage(where)})`;
    recordRequest({
      pendingSeq: liveSeq,
      id: sessionInfo.id, receivedAt, protocol, pool, requestedModel, httpStatus: 404,
      outcome: "failed", errorType: "no_route", errorMessage: message, attempts
    });
    return json(res, 404, { error: { message, type: "no_route" } }, { "x-multi-ai-session-id": sessionInfo.id });
  }

  const selection = selectTargetsForProtocol(pinned.targets, protocol, requestedModel);
  const bridgeCtx = bridgeKind === "codex"
    ? { customTools: customToolNames(body), inputTokens: estimateResponsesInputTokens(body) }
    : bridgeKind === "chat"
      ? { inputTokens: estimateChatInputTokens(body), includeUsage: body.stream_options?.include_usage === true }
      : null;
  // The saved Manual Model Selection for this request's own pool: those models
  // in their saved order (the remembered target leading when it is one of them),
  // then every model not selected, by health — or the automatic health-based
  // order when nothing is selected. Either way the remembered target
  // target is tried first. A pinned request is strict and walks its targets in
  // key order with no selection, no automatic order and no memory.
  const routePlan = buildRoutePlan({
    targets: selection.selected,
    chain: fallbackChain.get(pool),
    pinned: pinned.pinned,
    health: pinned.pinned ? null : healthRegistry,
    cacheKey: `pool:${pool}`,
    stickyTargetId: pinned.pinned ? null : sessionInfo.state.session.validTargetId()
  });

  if (selection.compatible.length === 0) {
    const noRouteMessage = pool === VISION_POOL
      ? "No configured vision target supports this client protocol"
      : "No configured provider targets support this client protocol";
    recordRequest({
      pendingSeq: liveSeq,
      id: sessionInfo.id,
      receivedAt,
      protocol,
      pool,
      requestedModel,
      httpStatus: 503,
      outcome: "failed",
      errorType: "no_route",
      errorMessage: noRouteMessage,
      attempts
    });
    return json(res, 503, { error: { message: noRouteMessage, type: "no_route" } });
  }

  // A Manual Model Selection is saved for this pool but nothing in it can serve
  // this request. The plan is deliberately empty: reaching for a model the
  // selection does not name, or a key an entry excludes, would be the silent
  // fallback the selection exists to prevent. Say so plainly instead of
  // reporting a generic outage.
  if (routePlan.failClosed) {
    const chainMessage = `The saved ${pool} Manual Model Selection has no usable target for this request `
      + `(${routePlan.entries} entr${routePlan.entries === 1 ? "y" : "ies"} saved, none reachable for this protocol). `
      + "Clear the selection to use the automatic order instead.";
    recordRequest({
      pendingSeq: liveSeq,
      id: sessionInfo.id,
      receivedAt,
      protocol,
      pool,
      requestedModel,
      httpStatus: 503,
      outcome: "failed",
      errorType: "fallback_chain_unusable",
      errorMessage: chainMessage,
      attempts
    });
    return json(res, 503, { error: { message: chainMessage, type: "fallback_chain_unusable" } });
  }

  try {
    const result = await withFallback(
      selection.selected,
      async (target, { phase } = {}) => {
        const upstreamProtocol = bridged
          ? upstreamProtocolFor(target)
          : protocol;
        const translated = bridged && upstreamProtocol !== nativeProtocol;
        const controller = new AbortController();
        // If the client goes away while an upstream attempt is pending, abort
        // that attempt immediately. Do not turn a client cancellation into a
        // provider failure and start spending credentials on fallback targets.
        let clientDisconnected = false;
        const abortForClient = () => {
          clientDisconnected = true;
          controller.abort();
        };
        const onResponseClose = () => {
          if (!res.writableEnded) abortForClient();
        };
        req.once("aborted", abortForClient);
        res.once("close", onResponseClose);
        // fetch() resolves once response headers arrive, so for streaming
        // requests this is a time-to-first-response limit: a hung provider
        // fails over after connectTimeoutMs rather than the full request timeout.
        const attemptTimeoutMs = wantsStream && config.connectTimeoutMs > 0
          ? Math.min(config.timeoutMs, config.connectTimeoutMs)
          : config.timeoutMs;
        const timer = setTimeout(() => controller.abort(), attemptTimeoutMs);
        const attemptStartedAt = Date.now();
        // Every invoke is a new attempt with its own id, even when the very same
        // provider/model/key was called a moment ago (or by an earlier request).
        const attemptId = startAttemptEvent(liveSeq, {
          phase: phase ?? null,
          provider: target.provider,
          model: target.model,
          keyIndex: target.keyIndex,
          protocol: upstreamProtocol,
          startedAt: attemptStartedAt
        });

        // Records one real upstream attempt, in the order `withFallback` makes
        // them. This is the true fallback chain, observed rather than
        // reconstructed from the final error.
        let recorded = false;
        const attempt = (ok, status, errorMessage) => {
          recorded = true;
          const completedAt = Date.now();
          attempts.push({
            attemptId,
            phase: phase ?? null,
            provider: target.provider,
            model: target.model,
            keyIndex: target.keyIndex,
            protocol: upstreamProtocol,
            ok,
            status: Number.isInteger(status) ? status : null,
            // Wall-clock start, so the Live Logs view can place each real
            // attempt on a timeline instead of guessing from request totals.
            startedAt: attemptStartedAt,
            completedAt,
            latencyMs: completedAt - attemptStartedAt,
            errorMessage: sanitizeMessage(errorMessage)
          });
          finishAttemptEvent(attemptId, {
            ok,
            status,
            completedAt,
            latencyMs: completedAt - attemptStartedAt,
            errorMessage
          });
          progressRequest(liveSeq, { attempts, inflight: null });
        };

        try {
          // Building the request lives inside the try so a target that cannot
          // represent the request at all (a bridge refusing media its protocol
          // has no form for) is recorded as an attempt and cleaned up exactly
          // like a failed fetch, instead of escaping with the timer still armed.
          const request = !translated
            ? buildUpstreamRequest(target, protocol, body, req.headers, { stream: wantsStream })
            : bridgeKind === "codex"
              ? buildCodexRequest(target, upstreamProtocol, body, req.headers)
              : bridgeKind === "chat"
                ? buildChatRequest(target, upstreamProtocol, body, req.headers)
                : bridgeKind === "gemini"
                  ? buildGeminiBridgeRequest(target, body, req.headers, { stream: wantsStream })
                  : buildBridgeRequest(target, upstreamProtocol, body, req.headers);
          const upstream = await fetch(request.url, { ...request.options, signal: controller.signal });
          if (!upstream.ok) {
            const text = await upstream.text();
            const error = new Error(text.slice(0, 2000) || ("Upstream HTTP " + upstream.status));
            error.status = upstream.status;
            // A rate limit may say how long to wait. The router uses it to cool
            // down only this key + model for that long, while the model's other
            // keys keep being tried.
            if (upstream.status === 429) {
              const retryAfterMs = parseRetryAfterMs(upstream.headers?.get?.("retry-after"));
              if (retryAfterMs !== null) error.retryAfterMs = retryAfterMs;
            }
            // An upstream 413 means this provider/tier cannot take a request of
            // this size (e.g. a small tokens-per-minute cap). Another provider
            // may well accept it, so fall back instead of failing the request.
            if (upstream.status === 413) error.retryable = true;
            // A 400 that complains about the model (bad/unknown/unsupported model
            // id) is a problem with this provider's configuration, not with the
            // client's request, so another provider can still answer it.
            if (upstream.status === 400 && isModelRejection(error.message)) error.retryable = true;
            // Any other 400 may still be specific to this provider (unsupported
            // parameter, tool schema, context window), so fall back to the next
            // target too. Either kind of 400 puts this model on an 8 minute
            // cooldown (see cooldownOptions in router.js). If every target
            // answers 400 the client gets the 400.
            else if (upstream.status === 400) error.retryable = true;
            // A signature rejection is about this request's history, not the model:
            // fall back, but do not put the Gemini models on an 8 minute cooldown.
            if (upstream.status === 400 && isSignatureRejection(error.message)) error.skipCooldown = true;
            attempt(false, upstream.status, error.message);
            throw error;
          }
          // The successful attempt is recorded too — otherwise the log would
          // show a chain of failures with no terminal success.
          attempt(true, upstream.status, null);
          return { upstream, target, upstreamProtocol, translated, attemptId };
        } catch (error) {
          if (isAbortError(error)) {
            if (clientDisconnected) {
              const cancelled = new Error("Client disconnected");
              cancelled.status = 499;
              cancelled.retryable = false;
              attempt(false, cancelled.status, cancelled.message);
              throw cancelled;
            }
            const timeout = toTimeoutError("Upstream request timed out");
            attempt(false, timeout.status, timeout.message);
            throw timeout;
          }
          // A transport-level rejection (DNS, TLS, socket) records here; an
          // HTTP error status was already recorded above.
          if (!recorded) {
            attempt(false, Number(error?.status) || null, error?.message);
            // No HTTP status means the provider never answered (DNS, refused or
            // reset connection, TLS). Another target may well succeed.
            if (error && typeof error === "object" && !Number.isInteger(error.status)) error.retryable = true;
          }
          throw error;
        } finally {
          clearTimeout(timer);
          req.off("aborted", abortForClient);
          res.off("close", onResponseClose);
        }
      },
      config.retryableStatus,
      // A pin is a one-off override (e.g. the Playground testing a key): its
      // success must not become the session's sticky target for normal traffic.
      pinned.pinned ? new RouteSession({ ttlMs: config.stickyTtlMs }) : sessionInfo.state.session,
      pinned.pinned ? pinnedHealth : healthRegistry,
      {
        plan: routePlan.steps,
        // Every walk records its success: the remembered target leads the next
        // request, whether the pool has a saved selection or is automatic. A pin
        // is a one-off override and stays stateless.
        remember: !pinned.pinned,
        // A skipped target never reaches the network, but it is still shown
        // in the timeline so the walk is explained, not guessed at.
        onSkip: (target, { phase, reason }) => {
          attempts.push({
            phase,
            provider: target.provider,
            model: target.model,
            keyIndex: target.keyIndex,
            protocol: null,
            ok: false,
            skipped: true,
            skipReason: reason,
            status: null,
            startedAt: Date.now(),
            latencyMs: 0,
            errorMessage: null
          });
          progressRequest(liveSeq, { attempts, inflight: null });
        }
      }
    );

    const sessionId = sessionInfo.id;

    if (result.translated) {
      const clientModel = typeof body.model === "string" ? body.model : result.target.model;
      const meta = {
        "x-multi-ai-provider": result.target.provider,
        "x-multi-ai-model": result.target.model,
        "x-multi-ai-key-index": String(result.target.keyIndex),
        "x-multi-ai-session-id": sessionId
      };
      let converted = null;
      if (!wantsStream) {
        const upstreamJson = await result.upstream.json();
        reportAttemptUsage(result.attemptId, usageFrom(upstreamJson));
        converted = bridgeKind === "codex"
          ? convertCodexJson(result.upstreamProtocol, upstreamJson, clientModel, bridgeCtx)
          : bridgeKind === "chat"
            ? convertChatJson(result.upstreamProtocol, upstreamJson, clientModel, bridgeCtx)
            : bridgeKind === "gemini"
              ? chatJsonToGemini(upstreamJson)
              : convertJsonResponse(result.upstreamProtocol, upstreamJson, clientModel);
      }

      recordRequest({
        pendingSeq: liveSeq,
        id: sessionId,
        receivedAt,
        protocol,
        pool,
        requestedModel,
        autoRouted: !selection.modelMatched,
        streamed: wantsStream,
        attempts,
        finalProvider: result.target.provider,
        finalModel: result.target.model,
        finalKeyIndex: result.target.keyIndex,
        httpStatus: 200,
        latencyMs: Date.now() - receivedAt,
        totalMs: Date.now() - receivedAt,
        tokens: converted ? convertedTokens(converted) : null,
        finishReason: converted?.stop_reason ?? converted?.incomplete_details?.reason ?? converted?.choices?.[0]?.finish_reason ?? converted?.status ?? null,
        outcome: "success"
      });

      if (converted) return json(res, 200, converted, meta);

      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", ...meta });
      // Watches the upstream events as they pass through; the client's stream is
      // produced from exactly the same events, in the same order.
      const usageTap = createSseUsageTap();
      try {
        const upstreamEvents = tapEvents(sseData(result.upstream.body), usageTap);
        const events = bridgeKind === "codex"
          ? streamToResponses(result.upstreamProtocol, upstreamEvents, clientModel, bridgeCtx)
          : bridgeKind === "chat"
            ? streamToChat(result.upstreamProtocol, upstreamEvents, clientModel, bridgeCtx)
            : bridgeKind === "gemini"
              ? streamToGemini(upstreamEvents)
              : streamToAnthropic(result.upstreamProtocol, upstreamEvents, clientModel);
        await pipeline(Readable.from(events), res);
      } catch {
        res.destroy();
      } finally {
        reportAttemptUsage(result.attemptId, usageTap.usage);
      }
      return undefined;
    }

    const contentType = result.upstream.headers.get("content-type") || "application/json";
    const declaredLength = Number(result.upstream.headers.get("content-length"));
    let usage = { tokens: null, finishReason: null, reported: null };
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
        // The body is consumed now, so it must be forwarded from this buffer even
        // when it is not valid JSON; only the usage lookup may fail.
        buffered = raw;
        try { usage = extractUsage(JSON.parse(raw.toString("utf8"))); } catch { /* usage stays unreported */ }
      } catch {
        buffered = null;
      }
    }

    reportAttemptUsage(result.attemptId, usage.reported);

    const latencyMs = Date.now() - receivedAt;

    // Recorded before the body is written: a client that reads the request log
    // immediately after this call would otherwise race the write and see a
    // stale list. `latencyMs` is time-to-upstream-response, which is the
    // figure an operator acts on; stream duration is not included.
    recordRequest({
      pendingSeq: liveSeq,
      id: sessionId,
      receivedAt,
      protocol,
      pool,
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
      // The usage tap only reads each chunk on its way past: the bytes the client
      // receives are the upstream's own, unchanged, with no whole-body buffering.
      const tap = contentType.includes("text/event-stream")
        ? createSseUsageTap()
        : contentType.includes("json") ? createJsonUsageTap({ maxBytes: MAX_INSPECT_BYTES }) : null;
      try {
        // pipeline() applies backpressure and tears down the upstream reader
        // when the client disconnects.
        const source = Readable.fromWeb(result.upstream.body);
        await pipeline(tap ? Readable.from(tapBytes(source, tap), { objectMode: false }) : source, res);
      } catch {
        // Headers are already on the wire, so the failure cannot be reported
        // as a JSON error response. Drop the connection instead.
        res.destroy();
      } finally {
        // Whatever the provider reported before the stream ended (or was cut) is kept.
        if (tap) reportAttemptUsage(result.attemptId, tap.usage);
      }
    } else {
      res.end();
    }
  } catch (error) {
    recordRequest({
      pendingSeq: liveSeq,
      id: sessionInfo.id,
      receivedAt,
      protocol,
      pool,
      requestedModel,
      autoRouted: !selection.modelMatched,
      attempts,
      finalProvider: lastRealAttempt(attempts)?.provider ?? null,
      finalModel: lastRealAttempt(attempts)?.model ?? null,
      finalKeyIndex: lastRealAttempt(attempts)?.keyIndex ?? null,
      httpStatus: error.status || 502,
      latencyMs: Date.now() - receivedAt,
      totalMs: Date.now() - receivedAt,
      errorType: error?.errorType ?? "upstream_error",
      errorMessage: sanitizeMessage(error?.message || "All routing targets failed"),
      outcome: "failed"
    });
    // `error.message` can be raw upstream text (an all-400 walk and non-retryable
    // statuses surface it), so it is scrubbed like every other outbound message.
    return json(res, error.status || 502, { error: { message: clientMessage(error.message) || "All routing targets failed", type: "upstream_error", failures: publicFailure(error) }, }, { "x-multi-ai-session-id": sessionInfo.id });
  }
}

const handleApi = createApi({
  config,
  fallbackChain,
  targets,
  health: healthRegistry,
  requestLog,
  monitor,
  // Reset Fallback clears what the router REMEMBERS, never what it was told:
  // the saved chain, the providers, the keys, the health measurements and any
  // genuine cooldown are all left exactly as they are.
  resetFallbackState: () => {
    const cleared = sessions.values().filter((entry) => {
      const had = Boolean(entry?.session?.targetId);
      entry?.session?.clear?.();
      return had;
    }).length;
    resetAutomaticOrderCache();
    return { clearedSessions: cleared, sessions: sessions.size };
  },
  // A chain edit invalidates what was remembered for THAT pool only: a text
  // edit never disturbs the vision pool's preference, or the reverse. Sessions
  // are kept (only their remembered target goes), and health is not touched.
  clearRememberedTargets: (pool) => {
    let cleared = 0;
    for (const entry of sessions.values()) {
      if ((entry?.pool ?? TEXT_POOL) !== pool) continue;
      if (entry?.session?.targetId) cleared += 1;
      entry?.session?.clear?.();
    }
    return { pool, clearedSessions: cleared };
  },
  // What is remembered right now, per pool. Read as the router reads it, so an
  // expired target is reported as absent rather than as still preferred.
  describeFallbackState: () => {
    const remembered = [];
    for (const entry of sessions.values()) {
      const targetId = entry?.session?.validTargetId?.() ?? null;
      if (!targetId) continue;
      remembered.push({ sessionId: entry.id, protocol: entry.protocol, pool: entry.pool, targetId });
    }
    return {
      sessions: sessions.size,
      remembered: {
        text: remembered.filter((item) => (item.pool ?? "text") === "text"),
        vision: remembered.filter((item) => item.pool === "vision")
      }
    };
  },
  refreshHealth: () => refreshAllHealth(targets, trackedCheckTargetHealth)
});

/** Paths the SPA must never shadow; they belong to the gateway itself. */
const RESERVED_PREFIXES = ["/api", "/v1", "/v1beta", "/health", "/healthz"];

function isReserved(pathname) {
  return RESERVED_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(prefix + "/")
  );
}

/**
 * Last line of defence for a request. Malformed client input is answered with a
 * 4xx at the point it is detected; anything that still escapes is a server-side
 * fault. Either way it must never take the process (and every other client's
 * routing) down, so it ends here as a JSON 500, or a dropped connection when
 * the response has already started. The log line carries the error name, a
 * credential-scrubbed message and a few stack frames, never the request.
 */
function respondUnexpected(res, error) {
  try {
    const frames = String(error?.stack || "").split("\n").slice(1, 4).map((line) => line.trim()).join(" | ");
    console.error(`[router] unhandled request error: ${error?.name || "Error"}: ${sanitizeMessage(error?.message) ?? ""} ${frames}`.trim());
  } catch { /* logging must not throw */ }
  try {
    if (res.headersSent || res.writableEnded) {
      res.destroy();
      return;
    }
    json(res, 500, { error: { message: "Internal server error", type: "internal_error" } });
  } catch {
    try { res.destroy(); } catch { /* nothing left to do */ }
  }
}

async function handleRequest(req, res) {
  // "//v1/models" (base URL with trailing slash + "/v1/...") must not parse as a host.
  // The request target is client-controlled and `new URL` throws on a malformed
  // one (e.g. an absolute-form target with a bad host), so it is parsed guardedly.
  let url;
  let pathname;
  try {
    url = new URL(String(req.url).replace(/^\/{2,}/, "/"), "http://localhost");
    pathname = url.pathname.replace(/\/{2,}/g, "/");
  } catch {
    return json(res, 400, { error: { message: "Invalid request target", type: "invalid_request_error" } });
  }

  // Uptime monitors (UptimeRobot, load balancers) often probe with HEAD, and a
  // tiny GET is cheaper than the full /health report. Both answer 200 with no
  // credentials and no target detail.
  if ((req.method === "HEAD" && (pathname === "/health" || pathname === "/healthz")) ||
      (req.method === "GET" && pathname === "/healthz")) {
    res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    return res.end(req.method === "HEAD" ? undefined : JSON.stringify({ ok: true, service: "apirouter" }));
  }

  if (req.method === "GET" && pathname === "/health") {
    // The real route order the Fallback Chain produces, not a health-score sort;
    // cooling targets are excluded exactly as routing skips them.
    const ranked = routeOrderByPool(targets, {
      chains: fallbackChain.snapshot(),
      health: healthRegistry,
      isEligible: (target) => healthRegistry.isAvailable(target)
    }).map((target, index) => ({ rank: index + 1, provider: target.provider, model: target.model, keyIndex: target.keyIndex, pool: target.pool ?? "text", protocols: target.protocols }));
    const health = describeHealth(targets);
    const inPool = (pool) => health.filter((entry) => entry.pool === pool);
    return json(res, 200, {
      ok: true,
      service: "apirouter",
      providers: PROVIDERS,
      configuredTargets: targets.length,
      configuredTextTargets: textTargets.length,
      configuredVisionTargets: visionTargets.length,
      health,
      // Per-pool counts, because the two pools fail independently.
      pools: {
        text: { targets: textTargets.length, health: inPool("text") },
        vision: { targets: visionTargets.length, health: inPool("vision") }
      },
      rankedTargets: ranked,
      // Which ordering the router is actually using right now, and how many
      // entries each pool's chain holds. A chain of zero entries in every pool
      // means the automatic health-based order is in force.
      fallback: {
        mode: fallbackChain.mode,
        remembersSuccess: remembersSuccess(fallbackChain.mode),
        chains: {
          text: fallbackChain.get("text").length,
          vision: fallbackChain.get("vision").length
        },
        // Per pool: `rankedTargets` going quiet for a pool is ambiguous on its
        // own, because an unusable chain and an unavailable provider look the
        // same there. This says which it is. `failClosed` means every request
        // for that pool will fail until the chain is fixed or cleared.
        pools: chainStatusByPool(targets, {
          chains: fallbackChain.snapshot(),
          health: healthRegistry
        })
      },
      retryableStatus: [...config.retryableStatus]
    });
  }

  if (req.method === "GET" && pathname === "/v1/models") {
    // One entry per unique model id (clients choke on duplicates), in ranked order.
    // Carries both OpenAI fields (object) and Anthropic fields (type, display_name,
    // created_at, has_more...) so Claude Desktop / Claude Code discovery accepts it.
    const seen = new Set();
    const data = [];
    for (const target of rankTargets(targets)) {
      if (seen.has(target.model)) continue;
      seen.add(target.model);
      data.push({ type: "model", id: target.model, display_name: target.model, created_at: "2026-01-01T00:00:00Z", object: "model", provider: target.provider });
    }
    return json(res, 200, { object: "list", data, has_more: false, first_id: data[0]?.id ?? null, last_id: data.at(-1)?.id ?? null });
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

  if (req.method === "POST" && pathname === "/v1/messages/count_tokens") {
    if (!authorized(req)) return json(res, 401, { error: { message: "Unauthorized", type: "authentication_error" } });
    try {
      // The same configured cap as every other JSON body: this endpoint is
      // authenticated, but an oversized body must still fail as a 413 here
      // rather than be buffered up to the (larger) hard-coded default.
      const body = await readJsonBody(req, config.maxBodyBytes);
      const shapeError = validateRequestShape("anthropic", body);
      if (shapeError) return json(res, 400, { error: { message: shapeError, type: "invalid_request_error" } });
      return json(res, 200, { input_tokens: estimateInputTokens(body) });
    } catch (error) {
      return json(res, error.status || 400, { error: { message: clientMessage(error.message), type: "invalid_request_error" } });
    }
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
}

const server = http.createServer((req, res) => {
  // handleRequest is async, so a synchronous throw inside it is also a rejection.
  handleRequest(req, res).catch((error) => respondUnexpected(res, error));
});

const stopHealthMonitor = startHealthMonitor(targets, trackedCheckTargetHealth, HEALTH_CHECK_INTERVAL_MS);
const stopKeepAlive = startKeepAlive();
process.once("SIGINT", () => {
  monitor.stop();
  stopHealthMonitor();
  stopKeepAlive();
  handleApi.closeStreams();
  server.close(() => process.exit(0));
});
process.once("SIGTERM", () => {
  monitor.stop();
  stopHealthMonitor();
  stopKeepAlive();
  handleApi.closeStreams();
  server.close(() => process.exit(0));
});

server.listen(config.port, () => {
  console.log("ApiRouter listening on http://localhost:" + config.port);
  console.log("Control Panel UI: http://localhost:" + config.port + "/");
});