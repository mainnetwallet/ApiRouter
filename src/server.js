import "dotenv/config";
import http from "node:http";
import { timingSafeEqual } from "node:crypto";
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
  healthRegistry,
  startHealthMonitor,
  refreshAllHealth
} from "./health.js";
import { probeTargetHealth, PROBE_TIMEOUT_MS } from "./health-checks.js";
import { fetchUpstream, isRedirectStatus } from "./upstream-fetch.js";
import { guardUpstreamStream, readBoundedBody, bufferUpTo, isUpstreamFault, MAX_ERROR_BODY_BYTES } from "./upstream-body.js";
import { ClientAbortError, RouteSession, SessionStore, withFallback } from "./router.js";
import { clientProtocol, buildUpstreamRequest, readJsonBody, isGeminiStream, parseGeminiPath } from "./adapters.js";
import { PROVIDERS } from "./providers/catalog.js";
import { createApi } from "./api.js";
import { createStaticHandler } from "./static-files.js";
import { createDevUiProxy, isReservedWhenDecoded } from "./dev-proxy.js";
import { selectTargetsForProtocol, pinTargets } from "./observability/route-select.js";
import { buildRoutePlan, routeOrderByPool } from "./routing-plan.js";
import { ManualSelection } from "./manual-selection.js";
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
import { INVALID_TOOL_ARGUMENTS } from "./bridge-errors.js";

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

// Operator-chosen model order (panel page "Manual Order"). Empty by default, in which
// case routing is exactly what it was before.
const manualSelection = new ManualSelection();
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
 * Development only. `npm run dev` sets MULTIAI_DEV_UI_ORIGIN to the private
 * Vite dev server so this gateway stays the one browser-facing origin. Unset
 * (as with `npm start`), this is null and `ui/dist` is served as before.
 */
const devUi = createDevUiProxy(process.env.MULTIAI_DEV_UI_ORIGIN);

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
 * Post-header body bounds (idle gap, absolute deadline, buffered size) live in
 * src/upstream-body.js. `fetch` resolves on headers, so the attempt timer only
 * bounds time-to-first-response; everything after is bounded there.
 */
export { guardUpstreamStream };

/**
 * Buffer a whole upstream body under the idle bound, the attempt's absolute
 * deadline and a byte ceiling. Failures carry the `streamCause` tag.
 */
export async function readUpstreamBody(webStream, { idleMs = 0, deadlineAt = null, clientSignal = null, maxBytes = config.maxUpstreamBodyBytes } = {}) {
  const { body } = await readBoundedBody(webStream, { idleMs, deadlineAt, clientSignal, maxBytes });
  return body;
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

/** Is this request arriving over the loopback interface? */
function isLoopback(req) {
  const address = String(req.socket?.remoteAddress || "");
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

/**
 * With no `MULTIAI_ROUTER_API_KEYS`, the gateway is open for local trusted use
 * (the documented default), but a caller reaching it from another host must not
 * get the proxy or the admin/config surface for free. Loopback callers keep
 * full access, so local development and the panel are unaffected; anything
 * else is refused until an operator configures keys.
 */
function authorized(req) {
  if (config.routerApiKeys.length === 0) return isLoopback(req);
  const value = String(req.headers.authorization || "");
  const token = value.startsWith("Bearer ") ? value.slice(7).trim() : "";
  if (!token) return false;

  // Compare every configured key without early exit. Buffer length is checked
  // before timingSafeEqual so malformed/mismatched lengths cannot throw.
  // This avoids ordinary string equality as the final credential check.
  const tokenBytes = Buffer.from(token, "utf8");
  let matched = false;
  for (const configured of config.routerApiKeys) {
    const keyBytes = Buffer.from(configured, "utf8");
    if (keyBytes.length === tokenBytes.length && timingSafeEqual(keyBytes, tokenBytes)) {
      matched = true;
    }
  }
  return matched;
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
    errorType: item.errorType ?? null,
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

/** The log-minted id for this one request, or null when the log is unavailable. */
function requestIdOf(startSeq) {
  if (startSeq === null || startSeq === undefined) return null;
  try { return requestLog.requestIdOf(startSeq); } catch { return null; }
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
  // Set by the invoke callback for every 200: a 200 only carried the headers,
  // so the attempt is not settled as a success until the body has been consumed
  // and delivered (or has failed). Streamed and non-streamed attempts settle
  // through the same once-only finisher; see the terminals below.
  let settleAttempt = null;

  // One abort signal per request, driven by the client connection. It stops the
  // fallback walk before another target is invoked and cancels the in-flight
  // upstream call, so a client that walked away cannot spend more provider quota
  // and a mid-stream disconnect is not recorded as a provider failure.
  const clientGone = new AbortController();
  const onClientGone = () => { if (!res.writableEnded) clientGone.abort(); };
  req.on("aborted", onClientGone);
  res.on("close", onClientGone);
  res.once("close", () => {
    req.off("aborted", onClientGone);
    res.off("close", onClientGone);
  });
  const clientAborted = () => clientGone.signal.aborted;

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
  try { body = await readJsonBody(req, { maxBytes: config.maxBodyBytes }); }
  catch (error) {
    recordRequest({
      pendingSeq: liveSeq,
      receivedAt,
      protocol,
      httpStatus: error.status || 400,
      outcome: "failed",
      errorType: error.errorType || "invalid_request_error",
      errorMessage: sanitizeMessage(error.message),
      attempts
    });
    return json(res, error.status || 400, { error: { message: clientMessage(error.message), type: error.errorType || "invalid_request_error" } });
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

  // One parser decides the model, the method and whether this is a stream, so
  // the pathname can never be read three different ways in three places.
  const geminiPath = protocol === "gemini" ? parseGeminiPath(pathname) : null;
  const geminiPathModel = geminiPath?.model ?? "";
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

  // Name the two identities apart for the caller: `x-multi-ai-request-id`
  // identifies this one request (and the log row it becomes), while
  // `x-multi-ai-session-id` identifies the sticky session it belongs to and is
  // shared by every request from the same client.
  const requestId = requestIdOf(liveSeq);
  if (requestId) res.setHeader("x-multi-ai-request-id", requestId);

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
  // `sessionId` scopes the Gemini thought-signature store: a signature captured
  // for this session is only echoed back inside the same session (see
  // anthropic-bridge.js). The default session keeps the historical behaviour.
  const bridgeCtx = bridgeKind === "codex"
    ? { customTools: customToolNames(body), inputTokens: estimateResponsesInputTokens(body), sessionId: sessionInfo.id }
    : bridgeKind === "chat"
      ? { inputTokens: estimateChatInputTokens(body), includeUsage: body.stream_options?.include_usage === true, sessionId: sessionInfo.id }
      : { sessionId: sessionInfo.id };
  // Manual order -> Sticky (valid TTL) -> Priority -> Provider -> Key -> Models -> next Key ->
  // next Provider, built from this request's own pool only. A pinned request is strict and never
  // gets a priority phase.
  const routePlan = buildRoutePlan({
    targets: selection.selected,
    requestedModel,
    priority: pinned.pinned ? [] : (config.priority?.[pool] ?? []),
    // The operator's manual order leads everything; a pin is strict and ignores it.
    manual: pinned.pinned ? [] : manualSelection.get(pool),
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
    return json(res, 503, { error: { message: noRouteMessage, type: "no_route" } }, { "x-multi-ai-session-id": sessionInfo.id });
  }

  try {
    // `deferCommit` hands the health/sticky decision back to this function: a
    // 200 that only carried headers is not a success, so the walk must not mark
    // the target healthy (or make it sticky) until the body has been delivered.
    // `shouldStop` lets a client disconnect end the walk before another target
    // is invoked. The returned `commit` finalises the health/sticky outcome
    // exactly once, at the moment the real result is known.
    const { value: result, commit } = await withFallback(
      selection.selected,
      async (target, { phase } = {}) => {
        const upstreamProtocol = bridged
          ? upstreamProtocolFor(target)
          : protocol;
        const translated = bridged && upstreamProtocol !== nativeProtocol;
        const request = !translated
          ? buildUpstreamRequest(target, protocol, body, req.headers, { stream: wantsStream })
          : bridgeKind === "codex"
            ? buildCodexRequest(target, upstreamProtocol, body, req.headers, { sessionId: sessionInfo.id })
            : bridgeKind === "chat"
              ? buildChatRequest(target, upstreamProtocol, body, req.headers, { sessionId: sessionInfo.id })
              : bridgeKind === "gemini"
                ? buildGeminiBridgeRequest(target, body, req.headers, { stream: wantsStream, sessionId: sessionInfo.id })
                : buildBridgeRequest(target, upstreamProtocol, body, req.headers, { sessionId: sessionInfo.id });
        const controller = new AbortController();
        // fetch() resolves once response headers arrive, so for streaming
        // requests this is a time-to-first-response limit: a hung provider
        // fails over after connectTimeoutMs rather than the full request timeout.
        const attemptTimeoutMs = wantsStream && config.connectTimeoutMs > 0
          ? Math.min(config.timeoutMs, config.connectTimeoutMs)
          : config.timeoutMs;
        const timer = setTimeout(() => controller.abort(), attemptTimeoutMs);
        // The client's connection is a second abort source. Merging it into the
        // attempt signal cancels the in-flight upstream call on a disconnect,
        // instead of only noticing between steps that nobody is listening.
        const signal = AbortSignal.any([controller.signal, clientGone.signal]);
        const attemptStartedAt = Date.now();
        let bodyBuf = null;
        // Absolute deadlines, anchored at the attempt's start. A non-streamed
        // attempt owns REQUEST_TIMEOUT_MS end to end (headers and body). A
        // stream may legitimately outlive that, so it has its own much larger
        // ceiling (STREAM_TOTAL_TIMEOUT_MS, 0 = none) on top of the idle gap.
        const attemptDeadlineAt = attemptStartedAt + config.timeoutMs;
        const streamDeadlineAt = config.streamTotalTimeoutMs > 0 ? attemptStartedAt + config.streamTotalTimeoutMs : null;
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
          // An attempt settles exactly once: the first verdict is the real one.
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
          // fetchUpstream never follows a redirect: the target's credential
          // must not be replayed to a host the operator did not configure.
          const upstream = await fetchUpstream(request.url, { ...request.options, signal });
          // Headers are in: the connect/TTFB timer has done its job. What bounds
          // the body from here is the idle gap and the absolute deadline, not
          // this timer, so the three limits stay independent.
          clearTimeout(timer);
          if (!upstream.ok) {
            // Only the head of an error body is ever surfaced, so it is read
            // under a hard byte cap and the rest is cancelled. A failure to
            // read it must not hide the status the provider already sent; only
            // a client that left ends the attempt.
            let text = "";
            try {
              ({ body: bodyBuf } = await readBoundedBody(upstream.body, {
                maxBytes: MAX_ERROR_BODY_BYTES,
                overflow: "truncate",
                idleMs: config.streamIdleTimeoutMs,
                deadlineAt: attemptStartedAt + config.timeoutMs,
                clientSignal: clientGone.signal
              }));
              text = bodyBuf.toString("utf8");
            } catch (readError) {
              if (clientAborted()) throw readError;
            }
            const error = new Error(text.slice(0, 2000) || ("Upstream HTTP " + upstream.status));
            error.status = upstream.status;
            // A redirect the gateway refused to follow means this configured
            // base URL is not usable; another target may still answer.
            if (isRedirectStatus(upstream.status)) error.retryable = true;
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
          // A 200 so far only carried the headers. Hand the finisher back and
          // let the terminal settle the attempt once the body is consumed: a
          // body that truncates, stalls or cannot be parsed must be a FAILED
          // attempt, not an accepted one. The terminal records the success, so
          // the log still ends a chain of failures with a real terminal success.
          settleAttempt = attempt;
          return {
            upstream, target, upstreamProtocol, translated,
            deadlineAt: wantsStream ? streamDeadlineAt : attemptDeadlineAt
          };
        } catch (error) {
          if (isAbortError(error)) {
            // A client disconnect is not a provider fault: stop the walk without
            // cooling the target, and never convert it into a timeout (which
            // would have handed the request to the next provider).
            if (clientAborted()) {
              const aborted = new ClientAbortError();
              attempt(false, null, aborted.message);
              throw aborted;
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
        } finally { clearTimeout(timer); }
      },
      config.retryableStatus,
      // A pin is a one-off override (e.g. the Playground testing a key): its
      // success must not become the session's sticky target for normal traffic.
      pinned.pinned ? new RouteSession({ ttlMs: config.stickyTtlMs }) : sessionInfo.state.session,
      pinned.pinned ? pinnedHealth : healthRegistry,
      {
        plan: routePlan.steps,
        // The caller (this function) owns the health/sticky decision, because
        // only it knows whether the response body actually completed.
        deferCommit: true,
        // The client is gone: stop before invoking another target.
        shouldStop: clientAborted,
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
      // Every terminal outcome is recorded through one shape, so a failure
      // after the headers can never be filed as a success. `streamOutcome` is
      // only set for a streamed request.
      const record = (outcome, extra = {}) => recordRequest({
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
        outcome,
        ...extra
      });

      if (!wantsStream) {
        let converted;
        try {
          const upstreamJson = JSON.parse(new TextDecoder().decode(await readUpstreamBody(result.upstream.body, {
            idleMs: config.streamIdleTimeoutMs,
            deadlineAt: result.deadlineAt,
            clientSignal: clientGone.signal
          })));
          converted = bridgeKind === "codex"
            ? convertCodexJson(result.upstreamProtocol, upstreamJson, clientModel, bridgeCtx)
            : bridgeKind === "chat"
              ? convertChatJson(result.upstreamProtocol, upstreamJson, clientModel, bridgeCtx)
              : bridgeKind === "gemini"
                ? chatJsonToGemini(upstreamJson)
                : convertJsonResponse(result.upstreamProtocol, upstreamJson, clientModel, bridgeCtx);
        } catch (error) {
          // A provider that answered 200 but whose tool arguments cannot be
          // represented in the client's protocol is a translation-shape
          // mismatch, not provider ill health. Answer 4xx with the typed code
          // and leave health untouched — never a silent `{}` and never a
          // cooldown for a healthy target.
          if (error?.errorType === INVALID_TOOL_ARGUMENTS) {
            settleAttempt?.(false, clientAborted() ? null : (error.status || 400), clientAborted() ? "Client disconnected" : sanitizeMessage(error.message));
            commit(false, { status: error.status || 400, skipCooldown: true, reason: sanitizeMessage(error.message) });
            // The log carries what the client was actually answered, not the
            // upstream's 200: a failed row filed as 200 is invisible to the
            // status filter and lands in the "http 200" failure bucket.
            record("failed", {
              httpStatus: clientAborted() ? 499 : (error.status || 400),
              errorType: error.errorType,
              errorMessage: sanitizeMessage(error.message) || "Tool call arguments could not be translated"
            });
            if (clientAborted()) { res.destroy(); return undefined; }
            const message = clientMessage(error.message) || "Tool call arguments could not be translated";
            return json(res, error.status || 400, { error: { message, type: error.errorType } }, meta);
          }
          // A 200 that could not be read or translated is not a success: cool
          // the target instead of recording it healthy. A client that left is
          // not the provider's fault, but a provider fault (timeout, size) that
          // happened first still is.
          const bodyAborted = clientAborted() && error?.streamCause !== "upstream" && !isUpstreamFault(error);
          settleAttempt?.(
            false,
            bodyAborted ? null : 502,
            bodyAborted ? "Client disconnected" : (sanitizeMessage(error?.message) || "Upstream response could not be read")
          );
          commit(false, clientAborted() ? { clientAborted: true } : { status: 502 });
          record("failed", {
            httpStatus: clientAborted() ? 499 : 502,
            errorType: clientAborted() ? "client_aborted" : "upstream_error",
            errorMessage: sanitizeMessage(error?.message) || "Upstream response could not be read"
          });
          if (clientAborted()) { res.destroy(); return undefined; }
          const message = clientMessage(error?.message) || "Upstream response could not be read";
          return json(res, 502, { error: { message, type: "upstream_error" } }, meta);
        }
        settleAttempt?.(true, result.upstream.status, null);
        commit(true, { status: result.upstream.status });
        record("success", {
          tokens: convertedTokens(converted),
          finishReason: converted?.stop_reason ?? converted?.incomplete_details?.reason ?? converted?.choices?.[0]?.finish_reason ?? converted?.status ?? null
        });
        return json(res, 200, converted, meta);
      }

      // Streaming: the outcome is unknowable until the client stream ends, so
      // nothing is committed (health/sticky) or logged as a success yet.
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", ...meta });
      let streamOutcome = "truncated";
      let streamError = null;
      try {
        const upstreamEvents = sseData(guardUpstreamStream(result.upstream.body, {
          idleMs: config.streamIdleTimeoutMs,
          deadlineAt: result.deadlineAt,
          clientSignal: clientGone.signal
        }), { maxEventBytes: config.maxSseEventBytes });
        const events = bridgeKind === "codex"
          ? streamToResponses(result.upstreamProtocol, upstreamEvents, clientModel, bridgeCtx)
          : bridgeKind === "chat"
            ? streamToChat(result.upstreamProtocol, upstreamEvents, clientModel, bridgeCtx)
            : bridgeKind === "gemini"
              ? streamToGemini(upstreamEvents)
              : streamToAnthropic(result.upstreamProtocol, upstreamEvents, clientModel, bridgeCtx);
        await pipeline(Readable.from(events), res);
        streamOutcome = "completed";
      } catch (error) {
        streamError = error;
        // An upstream fault is this provider's failure, so the target is
        // cooled. A client that left is not the provider's fault.
        streamOutcome = (error?.streamCause === "upstream" || isUpstreamFault(error) || !clientAborted())
          ? "truncated"
          : "aborted";
      }

      if (streamOutcome === "completed") {
        settleAttempt?.(true, result.upstream.status, null);
        commit(true, { status: result.upstream.status });
        record("success", { streamOutcome });
      } else if (streamOutcome === "aborted") {
        settleAttempt?.(false, null, "Client disconnected");
        commit(false, { clientAborted: true });
        record("failed", { streamOutcome, errorType: "client_aborted", errorMessage: "Client disconnected" });
      } else {
        settleAttempt?.(
          false,
          result.upstream.status,
          sanitizeMessage(streamError?.message) || "Upstream stream ended before completion"
        );
        // A translated stream that died because the provider's tool arguments
        // cannot be represented in the client's protocol is a translation-shape
        // mismatch, not provider ill health: the request still fails (headers are
        // already on the wire) but the target is not cooled.
        const shapeMismatch = streamError?.errorType === INVALID_TOOL_ARGUMENTS;
        commit(false, shapeMismatch
          ? { status: result.upstream.status ?? 200, skipCooldown: true, reason: sanitizeMessage(streamError?.message) }
          : { status: 502, reason: sanitizeMessage(streamError?.message) });
        record("failed", {
          streamOutcome,
          errorType: shapeMismatch ? INVALID_TOOL_ARGUMENTS : "upstream_stream_error",
          errorMessage: sanitizeMessage(streamError?.message) || "Upstream stream ended before completion"
        });
      }
      if (streamOutcome !== "completed") res.destroy();
      return undefined;
    }

    const contentType = result.upstream.headers.get("content-type") || "application/json";
    // Content-Length is only a hint that lets an obviously large body skip
    // inspection; it is never the limit. A missing, wrong or chunked length is
    // held to the same byte ceiling, enforced on the bytes actually read.
    const lengthHeader = result.upstream.headers.get("content-length");
    const declaredLength = lengthHeader === null ? Number.NaN : Number(lengthHeader);
    let usage = { tokens: null, finishReason: null };
    let buffered = null;
    // When inspection read past the ceiling, the bytes already consumed plus
    // the rest of the body, still streamed (with backpressure) to the client.
    let replay = null;
    let bodyReadError = null;

    // Only small JSON bodies are inspected for usage. The bytes forwarded to
    // the client are unchanged either way.
    if (
      result.upstream.body &&
      contentType.includes("application/json") &&
      !(Number.isFinite(declaredLength) && declaredLength > MAX_INSPECT_BYTES)
    ) {
      try {
        const inspected = await bufferUpTo(result.upstream.body, {
          maxBytes: MAX_INSPECT_BYTES,
          idleMs: config.streamIdleTimeoutMs,
          deadlineAt: result.deadlineAt,
          clientSignal: clientGone.signal
        });
        if (inspected.buffered) {
          // The body is consumed now, so it must be forwarded from this buffer even
          // when it is not valid JSON; only the usage lookup may fail.
          buffered = inspected.buffered;
          try { usage = extractUsage(JSON.parse(buffered.toString("utf8"))); } catch { /* usage stays unreported */ }
        } else {
          replay = inspected.replay;
        }
      } catch (error) {
        // The body died after the headers said 200. Nothing has reached the
        // client yet, so this is still answerable and the target must be cooled.
        bodyReadError = error;
      }
    }

    const streamed = !buffered && Boolean(result.upstream.body);
    const latencyMs = Date.now() - receivedAt;

    // One shape for both terminal outcomes, so a post-header failure can never
    // be filed as a success. `latencyMs` is time-to-upstream-response, the
    // figure an operator acts on; stream duration is not included.
    const record = (outcome, extra = {}) => recordRequest({
      pendingSeq: liveSeq,
      id: sessionId,
      receivedAt,
      protocol,
      pool,
      requestedModel,
      autoRouted: !selection.modelMatched,
      streamed,
      attempts,
      finalProvider: result.target.provider,
      finalModel: result.target.model,
      finalKeyIndex: result.target.keyIndex,
      httpStatus: result.upstream.status,
      latencyMs,
      totalMs: Date.now() - receivedAt,
      tokens: usage.tokens,
      finishReason: usage.finishReason,
      outcome,
      ...extra
    });

    if (bodyReadError) {
      const aborted = clientAborted();
      settleAttempt?.(
        false,
        aborted ? null : 502,
        aborted ? "Client disconnected" : (sanitizeMessage(bodyReadError?.message) || "Upstream response could not be read")
      );
      commit(false, aborted ? { clientAborted: true } : { status: 502 });
      record("failed", {
        httpStatus: aborted ? 499 : 502,
        errorType: aborted ? "client_aborted" : "upstream_error",
        errorMessage: sanitizeMessage(bodyReadError?.message) || "Upstream response could not be read"
      });
      if (aborted) { res.destroy(); return undefined; }
      const message = clientMessage(bodyReadError?.message) || "Upstream response could not be read";
      return json(res, 502, { error: { message, type: "upstream_error" } }, {
        "x-multi-ai-provider": result.target.provider,
        "x-multi-ai-model": result.target.model,
        "x-multi-ai-key-index": String(result.target.keyIndex),
        "x-multi-ai-session-id": sessionId
      });
    }

    res.writeHead(result.upstream.status, {
      "content-type": contentType,
      "cache-control": "no-cache",
      "x-multi-ai-provider": result.target.provider,
      "x-multi-ai-model": result.target.model,
      "x-multi-ai-key-index": String(result.target.keyIndex),
      "x-multi-ai-session-id": sessionId
    });

    try {
      if (buffered) {
        res.end(buffered);
      } else if (result.upstream.body) {
        // pipeline() applies backpressure and tears down the upstream reader
        // when the client disconnects; the idle guard bounds the gap between
        // chunks after the headers have arrived.
        await pipeline(
          Readable.from(replay ?? guardUpstreamStream(result.upstream.body, {
            idleMs: config.streamIdleTimeoutMs,
            deadlineAt: result.deadlineAt,
            clientSignal: clientGone.signal
          })),
          res
        );
      } else {
        res.end();
      }
    } catch (error) {
      // Headers are already on the wire, so the failure cannot be reported as a
      // JSON error response. Cool the target (unless the client left) and drop
      // the connection instead.
      const aborted = error?.streamCause !== "upstream" && !isUpstreamFault(error) && clientAborted();
      settleAttempt?.(
        false,
        result.upstream.status,
        sanitizeMessage(error?.message) || "Upstream stream ended before completion"
      );
      commit(false, aborted ? { clientAborted: true } : { status: 502, reason: sanitizeMessage(error?.message) });
      record("failed", {
        streamOutcome: aborted ? "aborted" : "truncated",
        errorType: aborted ? "client_aborted" : "upstream_stream_error",
        errorMessage: sanitizeMessage(error?.message) || "Upstream stream ended before completion"
      });
      res.destroy();
      return undefined;
    }

    // Only now is the response actually delivered: commit health/sticky and
    // file the request as a success.
    settleAttempt?.(true, result.upstream.status, null);
    commit(true, { status: result.upstream.status });
    record("success", streamed ? { streamOutcome: "completed" } : {});
  } catch (error) {
    // The client walked away. Nothing can be sent, and the provider was not at
    // fault (no target was cooled), so this is recorded as a client abort
    // rather than an upstream failure.
    // Safety net: a 200 attempt whose terminal never ran (an unexpected throw
    // after the headers) must not be left looking like it is still in flight.
    // A no-op once the attempt has settled.
    settleAttempt?.(
      false,
      null,
      (error?.clientAborted === true || error instanceof ClientAbortError)
        ? "Client disconnected"
        : (sanitizeMessage(error?.message) || "Upstream response could not be read")
    );
    if (error?.clientAborted === true || error instanceof ClientAbortError) {
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
        httpStatus: 499,
        latencyMs: Date.now() - receivedAt,
        totalMs: Date.now() - receivedAt,
        errorType: "client_aborted",
        errorMessage: "Client disconnected",
        outcome: "failed"
      });
      if (res.headersSent || res.writableEnded) res.destroy();
      else json(res, 499, { error: { message: "Client disconnected", type: "client_aborted" } });
      return undefined;
    }
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
    // A routing walk that failed for one machine-readable reason (every target
    // rejected the request the same way, e.g. `unsupported_image_source`) keeps
    // that reason in the response; anything else stays a generic upstream error.
    const errorType = error?.errorType || "upstream_error";
    return json(res, error.status || 502, { error: { message: clientMessage(error.message) || "All routing targets failed", type: errorType, failures: publicFailure(error) }, }, { "x-multi-ai-session-id": sessionInfo.id });
  }
}

const handleApi = createApi({
  config,
  targets,
  health: healthRegistry,
  requestLog,
  monitor,
  manualSelection,
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
    // health-score sort. `rankedTargets` holds only what routing would consider
    // right now; `coolingTargets` keeps the targets in cooldown, with the
    // position they will occupy once eligible, so the panel can still show them
    // instead of having them silently disappear.
    const row = (target, rank) => ({ rank, provider: target.provider, model: target.model, keyIndex: target.keyIndex, pool: target.pool ?? "text", protocols: target.protocols });
    const fullOrder = routeOrderByPool(targets, config.priority, () => true, manualSelection.all());
    const ranked = [];
    const coolingTargets = [];
    fullOrder.forEach((target, index) => {
      if (healthRegistry.isAvailable(target)) ranked.push(row(target, ranked.length + 1));
      else coolingTargets.push({ ...row(target, index + 1), cooldownUntil: healthRegistry.get(healthRegistry.key(target))?.cooldownUntil ?? null });
    });
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
      coolingTargets,
      retryableStatus: [...config.retryableStatus]
    });
  }

  if (req.method === "GET" && pathname === "/v1/models") {
    // One entry per unique model id (clients choke on duplicates), in the same
    // deterministic order routing and /health use. A health-score sort here made
    // the catalogue a client discovers reshuffle as providers hiccuped, which a
    // model list must never do; cooling targets stay listed.
    // Carries both OpenAI fields (object) and Anthropic fields (type, display_name,
    // created_at, has_more...) so Claude Desktop / Claude Code discovery accepts it.
    const seen = new Set();
    const data = [];
    for (const target of routeOrderByPool(targets, config.priority, () => true, manualSelection.all())) {
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
      const body = await readJsonBody(req, { maxBytes: config.maxBodyBytes });
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
      if (devUi) {
        // An encoded gateway prefix (/api%2fconfig) is not a panel route; keep it away from Vite.
        if (isReservedWhenDecoded(pathname, isReserved)) return json(res, 404, { error: { message: "Not found", type: "not_found" } });
        return devUi.handle(req, res);
      }
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

// Vite HMR rides a WebSocket upgrade. Registered only in development, so the
// production server's upgrade behaviour is untouched.
if (devUi) {
  server.on("upgrade", (req, socket, head) => {
    let pathname = "";
    try {
      pathname = new URL(String(req.url).replace(/^\/{2,}/, "/"), "http://localhost").pathname.replace(/\/{2,}/g, "/");
    } catch {
      socket.destroy();
      return;
    }
    if (isReserved(pathname) || isReservedWhenDecoded(pathname, isReserved)) {
      socket.destroy();
      return;
    }
    devUi.upgrade(req, socket, head);
  });
}

const stopHealthMonitor = startHealthMonitor(targets, trackedCheckTargetHealth, HEALTH_CHECK_INTERVAL_MS);
process.once("SIGINT", () => {
  monitor.stop();
  stopHealthMonitor();
  handleApi.closeStreams();
  devUi?.close();
  server.close(() => process.exit(0));
});
process.once("SIGTERM", () => {
  monitor.stop();
  stopHealthMonitor();
  handleApi.closeStreams();
  devUi?.close();
  server.close(() => process.exit(0));
});

// With no API keys configured the gateway only answers loopback callers (see
// `authorized`), so binding beyond loopback is worth saying out loud.
if (config.routerApiKeys.length === 0 && config.host !== "127.0.0.1" && config.host !== "::1" && config.host !== "localhost") {
  console.warn(
    "[router] MULTIAI_ROUTER_API_KEYS is not set: requests from other hosts will be refused. " +
    "Set MULTIAI_ROUTER_API_KEYS (and optionally HOST=127.0.0.1) before exposing this gateway."
  );
}

server.listen({ port: config.port, host: config.host || undefined }, () => {
  console.log("MultiAI Router listening on http://localhost:" + config.port);
  console.log("Control Panel UI: http://localhost:" + config.port + "/");
});
