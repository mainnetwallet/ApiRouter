import "dotenv/config";
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
import { RouteSession, SessionStore, withFallback } from "./router.js";
import { clientProtocol, buildUpstreamRequest, readJsonBody, parseGeminiPath, isGeminiNamespace } from "./adapters.js";
import { createMediaResolver } from "./media.js";
import { enterSignatureScope } from "./thought-signatures.js";
import { timingSafeEqual, createHash } from "node:crypto";
import { PROVIDERS } from "./providers/catalog.js";
import { createApi } from "./api.js";
import { createStaticHandler } from "./static-files.js";
import { selectTargetsForProtocol, pinTargets } from "./observability/route-select.js";
import { buildRoutePlan, routeOrderByPool } from "./routing-plan.js";
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
  if (res.destroyed || res.writableEnded) return;
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(payload), ...extraHeaders });
  res.end(payload);
}

/**
 * The credential a client presented. `Authorization: Bearer` is the standard
 * form; `x-api-key` (Anthropic SDKs) and `x-goog-api-key` (Gemini SDKs) are
 * accepted too, because those clients send their key there and cannot be
 * pointed at a router otherwise. A key in the URL query is deliberately NOT
 * accepted: URLs end up in access logs and browser history.
 */
function presentedToken(req) {
  const bearer = String(req.headers.authorization || "");
  if (bearer.startsWith("Bearer ")) return bearer.slice(7).trim();
  for (const name of ["x-api-key", "x-goog-api-key"]) {
    const value = req.headers[name];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

const digest = (value) => createHash("sha256").update(String(value)).digest();

function authorized(req) {
  if (config.routerApiKeys.length === 0) return true;
  const token = presentedToken(req);
  if (!token) return false;
  // Compare fixed-length digests in constant time, against every key without
  // stopping at the first match, so the response time reveals nothing about a key.
  const presented = digest(token);
  let ok = false;
  for (const key of config.routerApiKeys) {
    if (timingSafeEqual(presented, digest(key))) ok = true;
  }
  return ok;
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

/** Thrown (and never retried) when the client hung up before the answer was ready. */
function clientAbortError() {
  const error = new Error("Client disconnected");
  error.name = "ClientAbortError";
  error.status = 499;
  error.errorType = "client_aborted";
  error.clientAborted = true;
  return error;
}

/** A 3xx from a provider is an error: redirects are never followed with credentials attached. */
function redirectError(status) {
  const error = new Error(`Upstream redirected (HTTP ${status}); redirects are not followed`);
  error.status = 502;
  error.retryable = true;
  return error;
}

/**
 * Wraps the upstream event source of a translated stream. A bridge may turn an
 * upstream failure into a protocol-level error event (so the client is told),
 * after which the response ends "cleanly" from the socket's point of view. This
 * records the failure at its origin, so the request is still booked as failed.
 */
async function* trackUpstream(source, state) {
  try {
    yield* source;
  } catch (error) {
    if (!state.clientClosed) state.upstreamError = error;
    throw error;
  }
}

async function proxy(req, res, protocol, pathname) {
  const receivedAt = Date.now();
  const attempts = [];
  let liveSeq = null;

  // The client hanging up must stop the work done for it: the in-flight upstream
  // call is aborted and the fallback walk ends, instead of billing the next
  // provider for an answer nobody will read. (`res` closing before the response
  // finished is the reliable signal; `req` closes as soon as the body is read.)
  const clientGone = new AbortController();
  const streamState = { clientClosed: false, upstreamError: null };
  res.on("close", () => {
    if (!res.writableFinished) {
      streamState.clientClosed = true;
      clientGone.abort();
    }
  });

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
  try { body = await readJsonBody(req, { maxBytes: config.maxRequestBodyBytes }); }
  catch (error) {
    recordRequest({
      pendingSeq: liveSeq,
      receivedAt,
      protocol,
      httpStatus: error.status || 400,
      outcome: "failed",
      errorType: error.errorType ?? "invalid_request_error",
      errorMessage: sanitizeMessage(error.message),
      attempts
    });
    // After a 413 the rest of the body may still be arriving: end the connection
    // once the answer is out instead of reading on.
    return json(
      res,
      error.status || 400,
      { error: { message: clientMessage(error.message), type: error.errorType ?? "invalid_request_error" } },
      error.status === 413 ? { connection: "close" } : {}
    );
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

  const geminiPath = protocol === "gemini" ? parseGeminiPath(pathname) : null;
  const geminiPathModel = geminiPath?.model || "";
  const requestedModel = typeof body.model === "string" ? body.model : geminiPathModel;

  // A Gemini client selects streaming with the method name rather than a body
  // field, so both spellings have to be considered here.
  const wantsStream = body.stream === true || geminiPath?.stream === true;

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

  // Thought signatures are remembered per session, so one session's tool-call
  // ids can never pick up another's.
  enterSignatureScope(sessionInfo.id);

  liveSeq = beginRequest({ id: sessionInfo.id, receivedAt, protocol, pool, requestedModel });
  // The id of THIS request (the session id is shared by many), sent back so a
  // client can look the request up in /api/requests/:id.
  const requestId = liveSeq === null ? null : requestLog.requestIdOf(liveSeq);
  const idHeaders = { "x-multi-ai-session-id": sessionInfo.id, ...(requestId ? { "x-multi-ai-request-id": requestId } : {}) };
  const mediaResolver = createMediaResolver({ options: config.remoteImages });

  const pin = readPin(req);
  if (pin.error) {
    recordRequest({
      pendingSeq: liveSeq,
      id: sessionInfo.id, receivedAt, protocol, pool, requestedModel, httpStatus: 400,
      outcome: "failed", errorType: "invalid_request_error", errorMessage: pin.error, attempts
    });
    return json(res, 400, { error: { message: clientMessage(pin.error), type: "invalid_request_error" } }, idHeaders);
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
    return json(res, 503, { error: { message, type: "no_vision_route" } }, idHeaders);
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
    }, idHeaders);
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
    return json(res, 404, { error: { message, type: "no_route" } }, idHeaders);
  }

  const selection = selectTargetsForProtocol(pinned.targets, protocol, requestedModel);
  const bridgeCtx = bridgeKind === "codex"
    ? { customTools: customToolNames(body), inputTokens: estimateResponsesInputTokens(body) }
    : bridgeKind === "chat"
      ? { inputTokens: estimateChatInputTokens(body), includeUsage: body.stream_options?.include_usage === true }
      : null;
  // Sticky (valid TTL) -> Priority -> Provider -> Key -> Models -> next Key ->
  // next Provider, built from this request's own pool only. A pinned request is strict and never
  // gets a priority phase.
  const routePlan = buildRoutePlan({
    targets: selection.selected,
    requestedModel,
    priority: pinned.pinned ? [] : (config.priority?.[pool] ?? []),
    // Sticky is a first phase, only while its TTL is valid; a pin is strict.
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

  try {
    const clientModel = typeof body.model === "string" ? body.model : null;
    const result = await withFallback(
      selection.selected,
      async (target, { phase } = {}) => {
        // A client that already left gets no further provider calls.
        if (clientGone.signal.aborted) throw clientAbortError();

        const upstreamProtocol = bridged
          ? upstreamProtocolFor(target)
          : protocol;
        const translated = bridged && upstreamProtocol !== nativeProtocol;

        // Gemini only accepts inline image data, so a remote image URL from a
        // translated client request is downloaded first (once per request, with
        // SSRF protection). A URL that cannot be fetched is a 4xx for this
        // target — never an image silently removed from a request that then 200s.
        const media = translated && bridgeKind !== "gemini" && upstreamProtocol === "gemini"
          ? await mediaResolver.resolve(protocol, body, { signal: clientGone.signal })
          : null;

        const request = !translated
          ? buildUpstreamRequest(target, protocol, body, req.headers, { stream: wantsStream })
          : bridgeKind === "codex"
            ? buildCodexRequest(target, upstreamProtocol, body, req.headers, { media })
            : bridgeKind === "chat"
              ? buildChatRequest(target, upstreamProtocol, body, req.headers, { media })
              : bridgeKind === "gemini"
                ? buildGeminiBridgeRequest(target, body, req.headers, { stream: wantsStream })
                : buildBridgeRequest(target, upstreamProtocol, body, req.headers, { media });
        const controller = new AbortController();
        const abortForClient = () => controller.abort();
        clientGone.signal.addEventListener("abort", abortForClient, { once: true });
        // fetch() resolves once response headers arrive, so for streaming
        // requests this is a time-to-first-response limit: a hung provider
        // fails over after connectTimeoutMs rather than the full request timeout.
        // For a response read to the end inside this attempt, it covers the body too.
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
          if (recorded) return;
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
          const upstream = await fetch(request.url, { ...request.options, signal: controller.signal, redirect: "manual" });
          if (upstream.status >= 300 && upstream.status < 400) {
            // Never follow a redirect: it would carry this provider's credentials
            // to wherever the response points.
            await upstream.body?.cancel().catch(() => {});
            const error = redirectError(upstream.status);
            attempt(false, upstream.status, error.message);
            throw error;
          }
          if (!upstream.ok) {
            const text = await upstream.text();
            const error = new Error(text.slice(0, 2000) || ("Upstream HTTP " + upstream.status));
            error.status = upstream.status;
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
            // target too — without cooling this one down, since it is not
            // unhealthy. If every target answers 400 the client gets the 400.
            else if (upstream.status === 400) {
              error.retryable = true;
              error.skipCooldown = true;
            }
            attempt(false, upstream.status, error.message);
            throw error;
          }

          const headersLatencyMs = Date.now() - receivedAt;
          const base = { upstream, target, upstreamProtocol, translated, headersLatencyMs };

          // A translated, non-streamed answer is read and converted HERE, inside
          // the attempt: a body that cuts off or cannot be translated is this
          // target's failure, and nothing has been sent to the client yet, so the
          // walk can still move on to the next target.
          if (translated && !wantsStream) {
            const upstreamJson = await upstream.json();
            const modelName = clientModel ?? target.model;
            const converted = bridgeKind === "codex"
              ? convertCodexJson(upstreamProtocol, upstreamJson, modelName, bridgeCtx)
              : bridgeKind === "chat"
                ? convertChatJson(upstreamProtocol, upstreamJson, modelName, bridgeCtx)
                : bridgeKind === "gemini"
                  ? chatJsonToGemini(upstreamJson)
                  : convertJsonResponse(upstreamProtocol, upstreamJson, modelName);
            attempt(true, upstream.status, null);
            return { ...base, converted };
          }

          // Small, explicitly-sized JSON bodies are read here for the same reason
          // and inspected for usage. The bytes forwarded to the client are unchanged.
          const contentType = upstream.headers.get("content-type") || "application/json";
          // Number(null) is 0, which would make a chunked (length-less) body look
          // "small" and get buffered whole: only a body that declares its size is read here.
          const lengthHeader = upstream.headers.get("content-length");
          const declaredLength = lengthHeader === null ? Number.NaN : Number(lengthHeader);
          if (
            !translated &&
            upstream.body &&
            contentType.includes("application/json") &&
            Number.isFinite(declaredLength) &&
            declaredLength <= MAX_INSPECT_BYTES
          ) {
            const raw = Buffer.from(await upstream.arrayBuffer());
            let usage = { tokens: null, finishReason: null };
            try { usage = extractUsage(JSON.parse(raw.toString("utf8"))); } catch { /* usage stays unreported */ }
            attempt(true, upstream.status, null);
            return { ...base, buffered: raw, usage, contentType };
          }

          // Anything that will be streamed to the client: only the HEADERS have
          // arrived, which is not a success. The attempt stays "calling" and
          // health/sticky stay untouched until the body has actually finished;
          // the caller settles them (see settleResult in router.js).
          return { ...base, deferSettlement: true, completeAttempt: attempt, contentType };
        } catch (error) {
          if (clientGone.signal.aborted) {
            // The client left, not the provider: not a failure of this target.
            const gone = clientAbortError();
            attempt(false, null, gone.message);
            throw gone;
          }
          if (isAbortError(error)) {
            const timeout = toTimeoutError("Upstream request timed out");
            attempt(false, timeout.status, timeout.message);
            throw timeout;
          }
          // A transport-level rejection (DNS, TLS, socket) records here; an
          // HTTP error status was already recorded above.
          if (!recorded) {
            attempt(false, Number(error?.status) || null, error?.message);
            // No HTTP status means the provider never answered (DNS, refused or
            // reset connection, TLS) or its body could not be read/translated
            // before anything was sent. Another target may well succeed.
            if (error && typeof error === "object" && !Number.isInteger(error.status)) error.retryable = true;
          }
          throw error;
        } finally {
          clearTimeout(timer);
          clientGone.signal.removeEventListener("abort", abortForClient);
        }
      },
      config.retryableStatus,
      // A pin is a one-off override (e.g. the Playground testing a key): its
      // success must not become the session's sticky target for normal traffic.
      pinned.pinned ? new RouteSession({ ttlMs: config.stickyTtlMs }) : sessionInfo.state.session,
      pinned.pinned ? pinnedHealth : healthRegistry,
      {
        plan: routePlan.steps,
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
    const meta = {
      "x-multi-ai-provider": result.target.provider,
      "x-multi-ai-model": result.target.model,
      "x-multi-ai-key-index": String(result.target.keyIndex),
      ...idHeaders
    };
    const successFields = (extra = {}) => ({
      pendingSeq: liveSeq,
      id: sessionId,
      receivedAt,
      protocol,
      pool,
      requestedModel,
      autoRouted: !selection.modelMatched,
      attempts,
      finalProvider: result.target.provider,
      finalModel: result.target.model,
      finalKeyIndex: result.target.keyIndex,
      latencyMs: Date.now() - receivedAt,
      ...extra
    });

    // ---- answers that are complete before a byte is sent -------------------
    if (result.converted) {
      const converted = result.converted;
      recordRequest(successFields({
        streamed: false,
        httpStatus: 200,
        latencyMs: Date.now() - receivedAt,
        totalMs: Date.now() - receivedAt,
        tokens: convertedTokens(converted),
        finishReason: converted?.stop_reason ?? converted?.incomplete_details?.reason ?? converted?.choices?.[0]?.finish_reason ?? converted?.status ?? null,
        outcome: "success"
      }));
      return json(res, 200, converted, meta);
    }

    if (result.buffered) {
      recordRequest(successFields({
        streamed: false,
        httpStatus: result.upstream.status,
        latencyMs: Date.now() - receivedAt,
        totalMs: Date.now() - receivedAt,
        tokens: result.usage.tokens,
        finishReason: result.usage.finishReason,
        outcome: "success"
      }));
      res.writeHead(result.upstream.status, { "content-type": result.contentType, "cache-control": "no-cache", ...meta });
      res.end(result.buffered);
      return undefined;
    }

    // ---- streamed answers: success is decided when the body ENDS ------------
    const clientModelName = clientModel ?? result.target.model;
    const sourceEvents = () => trackUpstream(sseData(result.upstream.body), streamState);
    let readable;
    if (result.translated) {
      const upstreamEvents = sourceEvents();
      const events = bridgeKind === "codex"
        ? streamToResponses(result.upstreamProtocol, upstreamEvents, clientModelName, bridgeCtx)
        : bridgeKind === "chat"
          ? streamToChat(result.upstreamProtocol, upstreamEvents, clientModelName, bridgeCtx)
          : bridgeKind === "gemini"
            ? streamToGemini(upstreamEvents)
            : streamToAnthropic(result.upstreamProtocol, upstreamEvents, clientModelName);
      readable = Readable.from(events);
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", ...meta });
    } else if (result.upstream.body) {
      readable = Readable.fromWeb(result.upstream.body);
      readable.on("error", (error) => { if (!streamState.clientClosed) streamState.upstreamError = error; });
      res.writeHead(result.upstream.status, { "content-type": result.contentType, "cache-control": "no-cache", ...meta });
    } else {
      // No body at all: nothing can fail half-way.
      result.completeAttempt(true, result.upstream.status, null);
      result.settle.success();
      recordRequest(successFields({ streamed: false, httpStatus: result.upstream.status, latencyMs: result.headersLatencyMs, totalMs: Date.now() - receivedAt, outcome: "success" }));
      res.writeHead(result.upstream.status, { "cache-control": "no-cache", ...meta });
      res.end();
      return undefined;
    }

    let pipelineError = null;
    try {
      // pipeline() applies backpressure and tears down the upstream reader when
      // the client disconnects.
      await pipeline(readable, res);
    } catch (error) {
      pipelineError = error;
    }

    const streamFields = { streamed: true, httpStatus: result.upstream.status, latencyMs: result.headersLatencyMs, totalMs: Date.now() - receivedAt };
    if (!pipelineError && !streamState.upstreamError) {
      // The upstream body ended and everything reached the client: only now is it a success.
      result.completeAttempt(true, result.upstream.status, null);
      result.settle.success();
      recordRequest(successFields({ ...streamFields, outcome: "success" }));
    } else if (streamState.upstreamError) {
      // The provider's stream broke after the headers were sent. The answer is
      // truncated, so the request, the attempt and the target's health all say
      // so. Headers are out already: there is no safe way to retry elsewhere.
      const message = "Upstream stream ended before it completed: " + sanitizeMessage(streamState.upstreamError?.message || "stream error");
      result.completeAttempt(false, result.upstream.status, message);
      result.settle.failure();
      recordRequest(successFields({ ...streamFields, outcome: "failed", errorType: "stream_error", errorMessage: message }));
      if (!res.writableEnded) res.destroy();
    } else {
      // The client went away mid-stream: neither a success nor the provider's fault.
      result.completeAttempt(false, null, "Client disconnected before the stream finished");
      result.settle.abandon();
      recordRequest(successFields({ ...streamFields, outcome: "failed", errorType: "client_aborted", errorMessage: "client disconnected before the stream finished" }));
      if (!res.writableEnded) res.destroy();
    }
    return undefined;
  } catch (error) {
    const clientLeft = error?.clientAborted === true;
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
    // Nobody is listening any more.
    if (clientLeft) return undefined;
    // `error.message` can be raw upstream text (an all-400 walk and non-retryable
    // statuses surface it), so it is scrubbed like every other outbound message.
    return json(res, error.status || 502, { error: { message: clientMessage(error.message) || "All routing targets failed", type: error?.errorType ?? "upstream_error", failures: publicFailure(error) } }, idHeaders);
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

  if (req.method === "GET" && pathname === "/health") {
    // Deterministic route order (priority, then Provider -> Key -> Models), not a
    // health-score sort; cooling targets are excluded exactly as routing skips them.
    const ranked = routeOrderByPool(targets, config.priority, (target) => healthRegistry.isAvailable(target)).map((target, index) => ({ rank: index + 1, provider: target.provider, model: target.model, keyIndex: target.keyIndex, pool: target.pool ?? "text", protocols: target.protocols }));
    const health = describeHealth(targets);
    const inPool = (pool) => health.filter((entry) => entry.pool === pool);
    return json(res, 200, {
      ok: true,
      service: "multi-ai-router",
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
      const body = await readJsonBody(req, { maxBytes: config.maxRequestBodyBytes });
      const shapeError = validateRequestShape("anthropic", body);
      if (shapeError) return json(res, 400, { error: { message: shapeError, type: "invalid_request_error" } });
      return json(res, 200, { input_tokens: estimateInputTokens(body) });
    } catch (error) {
      return json(res, error.status || 400, { error: { message: clientMessage(error.message), type: error.errorType ?? "invalid_request_error" } }, error.status === 413 ? { connection: "close" } : {});
    }
  }

  const protocol = req.method === "POST" ? clientProtocol(pathname) : null;
  if (protocol) return proxy(req, res, protocol, pathname);

  // Inside Gemini's namespace but not an endpoint this router serves (another
  // casing, a ':' in the model, a trailing slash, an unsupported method): refuse
  // it by name rather than letting it fall through as an anonymous 404.
  if (req.method === "POST" && isGeminiNamespace(pathname)) {
    return json(res, 404, {
      error: {
        message: "Unsupported Gemini endpoint. Use /v1beta/models/<model>:generateContent or :streamGenerateContent (exact casing).",
        type: "invalid_gemini_endpoint"
      }
    });
  }

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
process.once("SIGINT", () => {
  monitor.stop();
  stopHealthMonitor();
  handleApi.closeStreams();
  server.close(() => process.exit(0));
});
process.once("SIGTERM", () => {
  monitor.stop();
  stopHealthMonitor();
  handleApi.closeStreams();
  server.close(() => process.exit(0));
});

const onListening = () => {
  console.log("MultiAI Router listening on http://localhost:" + config.port);
  console.log("Control Panel UI: http://localhost:" + config.port + "/");
  const loopbackOnly = config.host && /^(127\.|::1$|localhost$)/i.test(config.host);
  if (config.routerApiKeys.length === 0 && !loopbackOnly) {
    console.warn(
      "[router] MULTIAI_ROUTER_API_KEYS is empty and the router is not bound to a loopback address: anyone who can reach this port can use your provider keys. " +
      "Set MULTIAI_ROUTER_API_KEYS, or HOST=127.0.0.1 to accept local connections only."
    );
  }
};
if (config.host) server.listen(config.port, config.host, onListening);
else server.listen(config.port, onListening);
