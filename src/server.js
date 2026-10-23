import "dotenv/config";
import { startKeepAlive } from "./keepalive.js";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { loadConfig, buildTargets, legacyVisionPrefixes } from "./config.js";
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
import { createCustomPlayground } from "./custom-playground.js";
import { CustomEndpointStore, applyCustomEndpoints, isCustomProviderId } from "./custom-endpoints.js";
import { createModelConfigStorage, createRemoteStorage } from "./remote-storage.js";
import { ModelConfigStore } from "./model-config.js";
import { analyzeRequest } from "./request-profile.js";
import {
  filterTargetsByRequirements,
  noCapableRouteMessage,
  requestedModelCapabilityMessage,
  validateRequestedModel
} from "./model-capabilities.js";
import { buildRoutePlan, chainStatus, routeOrder, resetAutomaticOrderCache } from "./fallback-plan.js";
import { ModelSwitchStore, modelSwitchId } from "./model-switch.js";
import { OneModelStore, KeyPacer, withOneModel, oneModelKeyId } from "./one-model.js";
import {
  FallbackChainStore,
  activeEntries,
  hasLegacyConfig,
  readLegacyConfig,
  remembersSuccess
} from "./fallback-chain.js";
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
import { GatewayState } from "./gateway-state.js";
import { sanitizeMessage, registerConfiguredSecrets } from "./observability/sanitize.js";
import { validateRequestShape } from "./request-validation.js";

let config;
try { config = loadConfig(); }
catch (error) {
  console.error(`Configuration error: ${error.message}`);
  process.exit(1);
}

// Custom endpoints the operator saved permanently from the control panel. Each
// one is merged into `config.providers` as a provider of its own (`custom-<name>`),
// so everything below treats it exactly like a provider configured in the env.
// With CUSTOM_ENDPOINTS_GITHUB_REPO set they are kept (encrypted) in a GitHub
// branch instead of only on the local disk, so a redeploy cannot lose them.
let customEndpointsRemote;
try { customEndpointsRemote = createRemoteStorage(config.customEndpointsRemote); }
catch (error) {
  console.error(`Configuration error: ${error.message}`);
  process.exit(1);
}
const customEndpoints = new CustomEndpointStore({
  file: config.customEndpointsFile,
  remote: customEndpointsRemote,
  allowPrivateHosts: config.playgroundAllowPrivateHosts
});
await customEndpoints.init();
customEndpoints.startRetry();
applyCustomEndpoints(config, customEndpoints.list());
if (customEndpointsRemote) console.log(`custom endpoints: stored in ${customEndpointsRemote.location} (encrypted)`);

// The Unified Model Configurator. It is an OVERLAY on the provider configuration
// above, not a second provider system: keys, base URLs and protocols keep
// coming from the environment or a saved custom endpoint, while this store holds
// what the operator declared — enabled flags and capabilities — as plain JSON
// (never a credential) in `data/model-config.json` and, when configured, a
// GitHub branch. It is loaded before the target lists are used so the very first
// request already sees the saved declarations.
let modelConfigRemote;
try { modelConfigRemote = createModelConfigStorage(config.modelConfigRemote); }
catch (error) {
  console.error(`Configuration error: ${error.message}`);
  process.exit(1);
}
const modelConfig = new ModelConfigStore({
  file: config.modelConfigFile,
  remote: modelConfigRemote
});
await modelConfig.init();
modelConfig.startRetry();
if (modelConfigRemote) {
  console.log(`model config: stored in ${modelConfigRemote.location} (plain JSON, no credentials)`);
  const storage = modelConfig.storageInfo();
  if (storage.error) {
    console.warn(`model config: using the local copy until GitHub answers (${storage.error})`);
  }
}

// Everything the router holds that must never be echoed back: provider keys
// (saved custom endpoints included), Cloudflare account ids (they
// sit in the upstream URL path) and the router's own client keys. Registered
// before any request is served and again whenever a custom endpoint changes.
function registerSecrets() {
  registerConfiguredSecrets([
    ...(config.routerApiKeys || []),
    config.customEndpointsRemote?.token,
    config.customEndpointsRemote?.secret,
    config.modelConfigRemote?.token,
    ...Object.values(config.providers || {}).flatMap((p) => p?.apiKeys || []),
    ...Object.values(config.providers || {}).flatMap((p) => p?.cloudflare?.accountIds || [])
  ]);
}
registerSecrets();
// The Fallback Chain: the single source of truth for routing order.
// On first run it is seeded from the legacy manual-selection file and priority
// env vars, so an upgrade keeps the operator's routing; after that the legacy
// sources are never read again and cannot override what is configured here.
const fallbackChain = new FallbackChainStore({
  file: config.fallbackChainFile,
  migrate: () => readLegacyConfig({ manualFile: config.legacyManualSelectionFile, env: process.env })
});
// The Model Switch: models the operator turned OFF from the control panel. It
// is applied to the candidate targets before any plan is built, so it works in
// the automatic order and in Manual Model Selection alike.
const modelSwitch = new ModelSwitchStore({ file: config.disabledModelsFile });
// The configurator's `enabled` flag and the Models page switch are one decision
// with two storages. A declaration is authoritative for its model, including
// after a GitHub refresh or a restart, so every adopted configuration projects
// its flag onto the switch. Entries a refresh removed are switched back on
// (their environment default); environment-only models are never touched.
function syncModelSwitches(entries, previousEntries = []) {
  const current = new Set();
  for (const entry of entries) {
    current.add(`${entry.provider}/${entry.model}`);
    try { modelSwitch.set(entry.provider, entry.model, entry.enabled === false); }
    catch { /* the config still filters routing; the switch is the abort/UI mirror */ }
  }
  for (const entry of previousEntries) {
    if (current.has(`${entry.provider}/${entry.model}`)) continue;
    try { modelSwitch.set(entry.provider, entry.model, false); }
    catch { /* same best-effort mirror */ }
  }
}
modelConfig.onChange(syncModelSwitches);
syncModelSwitches(modelConfig.list(), []);
// One Provider Fallback: when on, every request is served from ONE chosen
// provider (its listed models in priority order, all of their keys, nothing
// else). A key the operator gave a cooldown cools for that long the moment it is
// called; see one-model.js.
const oneModelStore = new OneModelStore({ file: config.oneModelFile });
const keyPacer = new KeyPacer();
oneModelStore.onChange(({ scope, reset, changedKeys }) => {
  resetAutomaticOrderCache();
  if (reset) {
    // The mode was turned on or off, or another provider was chosen: start from a clean slate.
    keyPacer.clear();
    return;
  }
  if (scope === "selection") {
    // Only the model list changed: a model that was dropped keeps no cooldown.
    for (const target of targets) {
      if (!oneModelStore.matches(target)) keyPacer.release(target);
    }
    return;
  }
  // Only a key's cooldown was edited: that key is ready again at once, so a
  // shorter (or removed) cooldown takes effect immediately.
  for (const target of targets) {
    if (oneModelStore.matches(target) && changedKeys.includes(oneModelKeyId(target))) keyPacer.release(target);
  }
});
// Upstream attempts that are still waiting for a response, so switching a model
// off can abort them and let their request fall back to the next model.
const pendingAttempts = new Set();
modelSwitch.onChange(({ provider, model, disabled, scope }) => {
  resetAutomaticOrderCache();
  if (!disabled) return;
  for (const attempt of [...pendingAttempts]) {
    // A provider switch aborts every pending attempt on that provider; a model
    // switch only the attempts on that model.
    const hit = scope === "provider"
      ? String(attempt.provider ?? "").trim().toLowerCase() === provider
      : modelSwitchId(attempt.provider, attempt.model) === modelSwitchId(provider, model);
    if (hit) attempt.abortForSwitch();
  }
});
if (fallbackChain.migrated) {
  console.log("fallback chain: migrated the legacy manual selection / priority configuration");
}
if (hasLegacyConfig({ manualFile: config.legacyManualSelectionFile, env: process.env })) {
  console.warn(
    "fallback chain: MANUAL_SELECTION_FILE / TEXT_PRIORITY_MODELS / VISION_PRIORITY_MODELS are legacy: they only seed the "
    + "unified chain once, when none is saved, and are never read again. Configure the fallback chain in the control panel."
  );
}
const retiredVisionPrefixes = legacyVisionPrefixes(process.env);
if (retiredVisionPrefixes.length > 0) {
  console.warn(
    `config: ${retiredVisionPrefixes.map((prefix) => `${prefix}_VISION_*`).join(", ")} is retired and ignored. `
    + "List those models under the provider's *_MODELS and declare image_input for them in the Model Configurator."
  );
}
// The Text/Vision split is gone: `<PROVIDER>_VISION_*` variables are no longer
// read. Say so once at startup (provider names only, never a value) so an
// operator who still has them knows those models are not being routed to. The
// variables are left exactly as they are; they are never edited or removed.
const retiredVisionPrefixes = legacyVisionPrefixes(process.env)
  .filter((prefix) => ["API_KEYS", "MODELS", "BASE_URL", "ACCOUNT_IDS"]
    .some((name) => String(process.env[`${prefix}_VISION_${name}`] ?? "").trim() !== ""));
if (retiredVisionPrefixes.length > 0) {
  console.warn(
    `config: ${retiredVisionPrefixes.map((prefix) => `${prefix}_VISION_*`).join(", ")} are retired and ignored. `
    + "Add those models to the provider's ordinary *_MODELS list and declare image_input on them in the Model Configurator."
  );
}
const targets = buildTargets(config.providers);
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

/** Master switch controlled from the Control Panel (see src/gateway-state.js). */
const gateway = new GatewayState({ file: config.gatewayStateFile });
if (gateway.paused) {
  console.warn("gateway: starting SHUT DOWN (restored from saved state); use Resume in the Control Panel to turn it on");
}

function respondPaused(res) {
  const snap = gateway.snapshot();
  return json(res, 503, {
    error: { message: "Gateway is shut down from the Control Panel. Resume it to accept requests.", type: "gateway_paused" },
    gateway: snap
  }, { "retry-after": "30" });
}

function json(res, status, body, extraHeaders = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(payload), ...extraHeaders });
  res.end(payload);
}

function authorized(req) {
  if (config.routerApiKeys.length === 0) return true;
  const value = String(req.headers.authorization || "");
  const bearer = value.startsWith("Bearer ") ? value.slice(7).trim() : "";
  // Anthropic-style clients send the key in x-api-key instead of Bearer.
  const token = bearer || String(req.headers["x-api-key"] || "").trim();
  return Boolean(token && config.routerApiKeys.includes(token));
}

// Clients such as Claude Code, Codex and the OpenAI SDKs never send
// x-multi-ai-session-id. A random id per request meant every such request
// started a brand-new session, so the last successful model + key was never
// found again. Requests without the header now share one stable session per
// protocol + pool; an explicit header still selects its own isolated session.
const DEFAULT_SESSION_ID = "default";

function getSession(req, protocol) {
  const requested = String(req.headers["x-multi-ai-session-id"] || "").trim();
  const id = requested || DEFAULT_SESSION_ID;
  const key = protocol + ":" + id;

  let state = sessions.get(key);
  if (!state) {
    state = sessions.set(key, { id, protocol, session: new RouteSession({ ttlMs: config.stickyTtlMs }) });
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

  // Shut down from the UI: refuse before reading the body, picking a target
  // or touching any upstream provider.
  if (gateway.paused) return respondPaused(res);

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

  // Basic request-shape check, before the session or any target is
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

  // WHAT this request needs, derived from the endpoint and the payload — never
  // from the model name. A capability is required only when the payload
  // unambiguously needs it (a media part, tools, a response format, an explicit
  // output modality, streaming). `reasoning` is reported separately as a
  // preference and never hard-filters a working route.
  const profile = analyzeRequest({ protocol, pathname, body, stream: wantsStream });

  // Routing is capability-based: every configured target is a candidate, and
  // the request's required capabilities decide which ones are eligible.
  // There is no separate text/vision pool — a model that declares image_input
  // can serve image requests, and one that does not cannot.

  // A pinned request is an explicit one-off (the Playground testing one key).
  // It already ignores the Models page switch and cooldowns, so it must ignore
  // the same `enabled` flag when the configurator owns it. Capabilities still
  // apply: a pin can choose a target, not make it able to carry an image.
  const pin = readPin(req);
  const pinnedRequest = Boolean(pin.provider) && !pin.error;

  // The unified configuration, read once per request. `targets` is the same
  // array the router walks (a saved custom endpoint is spliced into it), so a
  // model declared in the Model Configurator is considered from this request on.
  const modelIndex = modelConfig.index(targets);
  // A stored protocol hint is a real constraint, not a label: when the provider
  // offers that wire format, the model is reached through it alone. A hint the
  // provider does not offer is ignored (the row warns about it) rather than
  // forcing a call the provider cannot serve.
  const configuredTargets = targets.map((target) => {
    const configured = modelIndex.get(`${target.provider}/${target.model}`)?.protocol;
    const protocols = target.protocols ?? [];
    return configured && protocols.length > 1 && protocols.includes(configured)
      ? { ...target, protocols: [configured] }
      : target;
  });
  // Models switched off in the Model Configurator are removed first: "off" is
  // not a capability verdict, and reporting it as "cannot serve this request"
  // would hide the real reason from the operator.
  const enabledTargets = pinnedRequest
    ? configuredTargets
    : configuredTargets.filter((target) => !modelConfig.explicitlyDisabled(target.provider, target.model));
  const capabilityLookup = (target) => {
    const entry = modelIndex.get(`${target.provider}/${target.model}`);
    return pinnedRequest && entry ? { ...entry, enabled: true } : entry;
  };
  const { eligible: capableTargets, exclusions } = filterTargetsByRequirements(
    enabledTargets,
    profile.required,
    capabilityLookup
  );
  // Bounded and de-duplicated by provider/model by the filter itself. Logged,
  // never echoed with payload or credential detail.
  const excludedCandidates = exclusions.slice(0, 20);

  const sessionInfo = getSession(req, protocol);

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

  liveSeq = beginRequest({
    id: sessionInfo.id,
    receivedAt,
    protocol,
    requestedModel,
    // Stored with the request so the live view can explain a route that was
    // never taken without keeping any part of the payload.
    requiredCapabilities: profile.required,
    excludedCandidates
  });

  if (pin.error) {
    recordRequest({
      pendingSeq: liveSeq,
      id: sessionInfo.id, receivedAt, protocol, requestedModel, httpStatus: 400,
      outcome: "failed", errorType: "invalid_request_error", errorMessage: pin.error, attempts
    });
    return json(res, 400, { error: { message: clientMessage(pin.error), type: "invalid_request_error" } }, { "x-multi-ai-session-id": sessionInfo.id });
  }

  // A model the unified configuration knows is rejected when none of its
  // provider entries can DECLARE and EXECUTE what this payload needs. Never
  // silently answer with another model.
  const modelRejection = validateRequestedModel(modelIndex, requestedModel, profile.required);
  if (modelRejection) {
    const message = requestedModelCapabilityMessage(modelRejection);
    recordRequest({
      pendingSeq: liveSeq,
      id: sessionInfo.id, receivedAt, protocol, requestedModel, httpStatus: 400,
      outcome: "failed", errorType: "model_capability_mismatch", errorMessage: message, attempts
    });
    return json(res, 400, {
      error: {
        message,
        type: "model_capability_mismatch",
        model: modelRejection.model,
        required_capabilities: modelRejection.required
      }
    }, { "x-multi-ai-session-id": sessionInfo.id });
  }

  // Every model is switched off in the Model Configurator. This is not a
  // capability failure: the operator explicitly disabled them, and that is
  // the reason the client is told.
  if (!pinnedRequest && enabledTargets.length > 0 && capableTargets.length === 0) {
    const message = "Every model is switched off in the Model Configurator";
    recordRequest({
      pendingSeq: liveSeq,
      id: sessionInfo.id, receivedAt, protocol, requestedModel, httpStatus: 503,
      outcome: "failed", errorType: "models_disabled", errorMessage: message, attempts
    });
    return json(res, 503, { error: { message, type: "models_disabled" } }, { "x-multi-ai-session-id": sessionInfo.id });
  }

  // Targets exist, but none declares (and can execute) what the payload needs.
  // Answering 503 here — instead of sending the request to a model that will
  // reject or mangle it — is the whole point of the capability layer.
  if (enabledTargets.length > 0 && capableTargets.length === 0) {
    const message = noCapableRouteMessage(profile.required);
    recordRequest({
      pendingSeq: liveSeq,
      id: sessionInfo.id, receivedAt, protocol, requestedModel, httpStatus: 503,
      outcome: "failed", errorType: "no_capable_route", errorMessage: message, attempts
    });
    return json(res, 503, {
      error: {
        message,
        type: "no_capable_route",
        required_capabilities: profile.required,
        excluded_candidates: excludedCandidates
      }
    }, { "x-multi-ai-session-id": sessionInfo.id });
  }

  const pinned = pinTargets(capableTargets, pin, requestedModel);
  if (pinned.pinned && pinned.targets.length === 0) {
    const where = `${pinned.provider}${pinned.keyIndex !== null ? ` key ${pinned.keyIndex}` : ""}${pinned.model ? ` / ${pinned.model}` : ""}`;
    const message = `No configured target matches the pinned selection (${sanitizeMessage(where)})`;
    recordRequest({
      pendingSeq: liveSeq,
      id: sessionInfo.id, receivedAt, protocol, requestedModel, httpStatus: 404,
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
  // The saved Manual Model Selection: those models
  // in their saved order (the remembered target leading when it is one of them),
  // then every model not selected, by health — or the automatic health-based
  // order when nothing is selected. Either way the remembered target
  // target is tried first. A pinned request is strict and walks its targets in
  // key order with no selection, no automatic order and no memory.
  // Models switched off from the control panel never reach the planner, so they
  // are absent from the selected batch, the health batch and the automatic
  // order alike. A pinned request is an explicit one-off (the Playground testing
  // a key) and ignores the switch.
  const selectable = pinned.pinned
    ? selection.selected
    : selection.selected.filter((target) => !modelSwitch.isDisabled(target.provider, target.model));
  // One Provider Fallback overrides the saved chain and the automatic order: only
  // the chosen provider's listed models (and their keys) are candidates, and
  // nothing else is ever tried. A pinned request is an explicit one-off and
  // ignores it, like the switch.
  const oneModel = pinned.pinned ? null : oneModelStore.active();
  const oneModelTargets = oneModel
    ? selectable.filter((target) => oneModelStore.matches(target))
    : [];

  // A saved selection can be structurally usable and still contain no model
  // that declares the capability THIS request needs (for example, a tool call
  // when every selected model only declares text). That is a capability
  // exclusion, not a broken selection: the capability filter has already
  // removed those models, so the eligible unselected models are the correct
  // automatic fallback. Keep fail-closed for the other case — a selection whose
  // models are unreachable, switched off, or restricted to keys that do not
  // exist — by checking reachability WITHOUT the capability filter first.
  const savedSelection = activeEntries(fallbackChain.get());
  let planChain = fallbackChain.get();
  if (!pinned.pinned && !oneModel && savedSelection.length > 0) {
    const capableIds = new Set(selection.selected.map((target) => `${target.provider}/${target.model}`));
    const anyCapable = savedSelection.some((entry) => capableIds.has(`${entry.provider}/${entry.model}`));
    if (!anyCapable) {
      const structuralTargets = enabledTargets.filter(
        (target) => !modelSwitch.isDisabled(target.provider, target.model)
      );
      const structuralPinned = pinTargets(structuralTargets, pin, requestedModel);
      const structuralSelection = selectTargetsForProtocol(structuralPinned.targets, protocol, requestedModel);
      const structuralIds = new Set(
        structuralSelection.selected.map((target) => `${target.provider}/${target.model}`)
      );
      if (savedSelection.some((entry) => structuralIds.has(`${entry.provider}/${entry.model}`))) {
        planChain = [];
      }
    }
  }

  const routePlan = oneModel
    ? { steps: [], failClosed: false, entries: 0 }
    : buildRoutePlan({
      targets: selectable,
      chain: planChain,
      pinned: pinned.pinned,
      health: pinned.pinned ? null : healthRegistry,
      cacheKey: "unified",
      stickyTargetId: pinned.pinned ? null : sessionInfo.state.session.validTargetId()
    });

  if (selection.compatible.length === 0) {
    const noRouteMessage = "No configured provider targets support this client protocol";
    recordRequest({
      pendingSeq: liveSeq,
      id: sessionInfo.id,
      receivedAt,
      protocol,
      requestedModel,
      httpStatus: 503,
      outcome: "failed",
      errorType: "no_route",
      errorMessage: noRouteMessage,
      attempts
    });
    return json(res, 503, { error: { message: noRouteMessage, type: "no_route" } });
  }

  if (selectable.length === 0) {
    const offMessage = "Every model that could serve this request is switched off in the Control Panel";
    recordRequest({
      pendingSeq: liveSeq,
      id: sessionInfo.id, receivedAt, protocol, requestedModel, httpStatus: 503,
      outcome: "failed", errorType: "models_disabled", errorMessage: offMessage, attempts
    });
    return json(res, 503, { error: { message: offMessage, type: "models_disabled" } }, { "x-multi-ai-session-id": sessionInfo.id });
  }

  // One Provider Fallback is on but none of the chosen provider's models can
  // serve THIS request. The mode never falls back to another provider, so say so plainly.
  if (oneModel && oneModelTargets.length === 0) {
    const label = sanitizeMessage(`${oneModel.provider} (${oneModel.models.join(", ")})`);
    const allOff = oneModel.models.every((model) => modelSwitch.isDisabled(oneModel.provider, model));
    const oneMessage = allOff
      ? `One Provider Fallback is on and every chosen model of ${label} is switched off in the Control Panel`
      : `One Provider Fallback is on and ${label} cannot serve this request (none speaks this client protocol)`;
    recordRequest({
      pendingSeq: liveSeq,
      id: sessionInfo.id, receivedAt, protocol, requestedModel, httpStatus: 503,
      outcome: "failed", errorType: "one_model_unavailable", errorMessage: oneMessage, attempts
    });
    return json(res, 503, { error: { message: oneMessage, type: "one_model_unavailable" } }, { "x-multi-ai-session-id": sessionInfo.id });
  }

  // A Manual Model Selection is saved but nothing in it can serve this request.
  // The plan is deliberately empty: reaching for a model the selection does not
  // name, or a key an entry excludes, would be the silent fallback the selection
  // exists to prevent. Say so plainly instead of reporting a generic outage.
  if (routePlan.failClosed) {
    const chainMessage = `The saved Manual Model Selection has no usable target for this request `
      + `(${routePlan.entries} entr${routePlan.entries === 1 ? "y" : "ies"} saved, none reachable for this protocol). `
      + (selection.selected.length > selectable.length ? " Some models are switched off in the Control Panel. " : "")
      + "Clear the selection to use the automatic order instead.";
    recordRequest({
      pendingSeq: liveSeq,
      id: sessionInfo.id,
      receivedAt,
      protocol,
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
    const invokeTarget = async (target, { phase } = {}) => {
        // Shut down from the UI while this request was already walking its
        // fallback chain: stop before the next upstream attempt. `retryable:
        // false` ends the walk, and because this runs before any attempt is
        // recorded no target is cooled down or marked unhealthy for it.
        if (gateway.paused) {
          const paused = new Error("Gateway was shut down from the Control Panel");
          paused.status = 503;
          paused.retryable = false;
          paused.errorType = "gateway_paused";
          throw paused;
        }
        // Switched off after this request's plan was built: skip it and fall
        // through to the next model. `skipCooldown` keeps it out of the health
        // registry — turning a model off is not a failure, so turning it back
        // on restores it exactly as it was.
        if (!pinned.pinned && modelSwitch.isDisabled(target.provider, target.model)) {
          attempts.push({
            phase, provider: target.provider, model: target.model, keyIndex: target.keyIndex,
            protocol: null, ok: false, skipped: true, skipReason: "model_disabled",
            status: null, startedAt: Date.now(), latencyMs: 0, errorMessage: null
          });
          progressRequest(liveSeq, { attempts, inflight: null });
          const off = new Error("Model is switched off in the Control Panel");
          off.status = 503;
          off.skipCooldown = true;
          off.errorType = "model_disabled";
          throw off;
        }
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
        // While this attempt waits for the upstream response, switching its model
        // off aborts it so the walk moves on to the next model right away. Once
        // headers arrive the attempt is done (the `finally` below removes it): a
        // response that has started streaming to the client cannot be replaced.
        let switchedOffWhileWaiting = false;
        const pendingAttempt = {
          provider: target.provider,
          model: target.model,
          abortForSwitch: () => {
            switchedOffWhileWaiting = true;
            controller.abort();
          }
        };
        if (!pinned.pinned) pendingAttempts.add(pendingAttempt);
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
            if (switchedOffWhileWaiting) {
              const off = new Error("Model was switched off in the Control Panel while this request was waiting");
              off.status = 503;
              off.skipCooldown = true;
              off.errorType = "model_disabled";
              attempt(false, off.status, off.message);
              throw off;
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
          pendingAttempts.delete(pendingAttempt);
          req.off("aborted", abortForClient);
          res.off("close", onResponseClose);
        }
    };

    // The request's own abort signal for waits that happen outside an upstream
    // call (a key that is still cooling): a client that goes away ends the wait.
    let waitClientGone = false;
    const markWaitClientGone = () => { waitClientGone = true; };
    if (oneModel) {
      req.once("aborted", markWaitClientGone);
      res.once("close", () => { if (!res.writableEnded) markWaitClientGone(); });
    }
    const oneModelCheckpoint = () => {
      if (waitClientGone) {
        const gone = new Error("Client disconnected");
        gone.status = 499;
        gone.retryable = false;
        throw gone;
      }
      if (gateway.paused) {
        const paused = new Error("Gateway was shut down from the Control Panel");
        paused.status = 503;
        paused.retryable = false;
        paused.errorType = "gateway_paused";
        throw paused;
      }
      const nowActive = oneModelStore.active();
      if (!nowActive || nowActive.provider !== oneModel.provider) {
        const changed = new Error("One Provider Fallback was changed in the Control Panel while this request was waiting");
        changed.status = 503;
        changed.retryable = false;
        changed.errorType = "one_model_changed";
        throw changed;
      }
      // A model that was switched off, or dropped from the list, is skipped by
      // the walk (see invokeTarget); only when none is left does the request end.
      const stillUsable = oneModelTargets.some((target) =>
        oneModelStore.matches(target) && !modelSwitch.isDisabled(target.provider, target.model));
      if (!stillUsable) {
        const off = new Error("Every chosen model was switched off or removed in the Control Panel while this request was waiting");
        off.status = 503;
        off.retryable = false;
        off.errorType = "model_disabled";
        throw off;
      }
    };

    const result = oneModel
      ? await withOneModel(oneModelTargets, invokeTarget, {
        pacer: keyPacer,
        models: oneModel.models,
        cooldownFor: (target) => oneModelStore.cooldownFor(target),
        health: healthRegistry,
        checkpoint: oneModelCheckpoint,
        onSkip: (target, { phase, reason }) => {
          attempts.push({
            phase, provider: target.provider, model: target.model, keyIndex: target.keyIndex,
            protocol: null, ok: false, skipped: true, skipReason: reason,
            status: null, startedAt: Date.now(), latencyMs: 0, errorMessage: null
          });
          progressRequest(liveSeq, { attempts, inflight: null });
        }
      })
      : await withFallback(
      selectable,
      invokeTarget,
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

    const sse = contentType.includes("text/event-stream");
    if (sse) res.socket?.setNoDelay?.(true);
    res.writeHead(result.upstream.status, {
      "content-type": contentType,
      // `no-transform` and `x-accel-buffering` stop proxies in front of the
      // gateway from compressing or buffering the stream into big chunks.
      "cache-control": sse ? "no-cache, no-transform" : "no-cache",
      ...(sse ? { "x-accel-buffering": "no" } : {}),
      "x-multi-ai-provider": result.target.provider,
      "x-multi-ai-model": result.target.model,
      "x-multi-ai-key-index": String(result.target.keyIndex),
      "x-multi-ai-session-id": sessionId
    });
    if (sse) res.flushHeaders?.();

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
    return json(res, error.status || 502, { error: { message: clientMessage(error.message) || "All routing targets failed", type: PASSTHROUGH_ERROR_TYPES.has(error?.errorType) ? error.errorType : "upstream_error", failures: publicFailure(error) }, }, { "x-multi-ai-session-id": sessionInfo.id });
  }
}

// Error types the client is told verbatim; every other failure reads "upstream_error".
const PASSTHROUGH_ERROR_TYPES = new Set([
  "gateway_paused", "one_model_cooldown", "one_model_failed", "one_model_changed", "model_disabled"
]);

const customPlayground = createCustomPlayground({
  timeoutMs: config.timeoutMs,
  maxBodyBytes: config.maxBodyBytes,
  allowPrivateHosts: config.playgroundAllowPrivateHosts,
  isPaused: () => gateway.paused
});

// A saved custom endpoint takes effect at once, with no restart: its old targets
// are dropped, the new ones are added to the live target lists (the health
// monitor, the router and the control panel all read these same arrays), and
// the new targets are probed straight away.
customEndpoints.onChange((endpoints) => {
  for (let index = targets.length - 1; index >= 0; index -= 1) {
    if (isCustomProviderId(targets[index].provider)) targets.splice(index, 1);
  }
  applyCustomEndpoints(config, endpoints);
  const onlyCustom = (group) => Object.fromEntries(Object.entries(group ?? {}).filter(([id]) => isCustomProviderId(id)));
  const fresh = buildTargets(onlyCustom(config.providers));
  targets.push(...fresh);
  monitor.targetCount = targets.length;
  registerSecrets();
  resetAutomaticOrderCache();
  if (fresh.length > 0 && !gateway.paused) {
    refreshAllHealth(fresh, trackedCheckTargetHealth).catch(() => {});
  }
});

const handleApi = createApi({
  config,
  customPlayground,
  customEndpoints,
  fallbackChain,
  modelSwitch,
  modelConfig,
  oneModel: oneModelStore,
  keyPacer,
  targets,
  health: healthRegistry,
  requestLog,
  monitor,
  gateway,
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
  // A chain edit invalidates what was remembered: sessions are kept (only their
  // remembered target goes), and health is not touched.
  clearRememberedTargets: () => {
    let cleared = 0;
    for (const entry of sessions.values()) {
      if (entry?.session?.targetId) cleared += 1;
      entry?.session?.clear?.();
    }
    return { clearedSessions: cleared };
  },
  // What is remembered right now. Read as the router reads it, so an expired
  // target is reported as absent rather than as still preferred.
  describeFallbackState: () => {
    const remembered = [];
    for (const entry of sessions.values()) {
      const targetId = entry?.session?.validTargetId?.() ?? null;
      if (!targetId) continue;
      remembered.push({ sessionId: entry.id, protocol: entry.protocol, targetId });
    }
    return {
      sessions: sessions.size,
      remembered
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
    // cooling targets and models switched off (Model Switch or the unified Model
    // Configurator) are excluded exactly as routing skips them.
    const routable = targets.filter((target) =>
      !modelSwitch.isDisabled(target.provider, target.model)
      && !modelConfig.explicitlyDisabled(target.provider, target.model));
    const ranked = routeOrder(routable, {
      chain: fallbackChain.get(),
      health: healthRegistry,
      isEligible: (target) => healthRegistry.isAvailable(target)
    }).map((target, index) => ({ rank: index + 1, provider: target.provider, model: target.model, keyIndex: target.keyIndex, protocols: target.protocols }));
    const health = describeHealth(targets);
    return json(res, 200, {
      ok: true,
      service: "apirouter",
      gateway: gateway.snapshot(),
      providers: [...PROVIDERS, ...Object.keys(config.providers).filter(isCustomProviderId)],
      configuredTargets: targets.length,
      health,
      rankedTargets: ranked,
      // Which ordering the router is actually using right now. A chain of zero
      // entries means the automatic health-based order is in force.
      fallback: {
        mode: fallbackChain.mode,
        remembersSuccess: remembersSuccess(fallbackChain.mode),
        chains: fallbackChain.get().length,
        status: chainStatus(routable, {
          chain: fallbackChain.get(),
          health: healthRegistry
        })
      },
      disabledModels: modelSwitch.list(),
      disabledProviders: modelSwitch.listProviders(),
      oneModel: oneModelStore.get(),
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
    if (gateway.paused) return respondPaused(res);
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

const stopHealthMonitor = startHealthMonitor(targets, trackedCheckTargetHealth, HEALTH_CHECK_INTERVAL_MS, { isPaused: () => gateway.paused });
const stopKeepAlive = startKeepAlive();
process.once("SIGINT", () => {
  monitor.stop();
  stopHealthMonitor();
  stopKeepAlive();
  modelConfig.stopRetry();
  handleApi.closeStreams();
  server.close(() => process.exit(0));
});
process.once("SIGTERM", () => {
  monitor.stop();
  stopHealthMonitor();
  stopKeepAlive();
  modelConfig.stopRetry();
  handleApi.closeStreams();
  server.close(() => process.exit(0));
});

server.listen(config.port, () => {
  console.log("ApiRouter listening on http://localhost:" + config.port);
  console.log("Control Panel UI: http://localhost:" + config.port + "/");
});