/**
 * Canonical upstream URL construction.
 *
 * Every place the gateway talks to a provider builds its URL here: the protocol
 * adapters, the three translation bridges and the health probes. Before this
 * module the same `joinUrl` existed in four files and only two of them stripped
 * a version segment that was already present in the configured base URL, so a
 * Gemini base of `.../v1beta` produced `/v1beta/v1beta/models/...` on the
 * bridges while the native adapter and the health probe used the correct path.
 * One builder means that class of divergence cannot come back.
 */

// A trailing API version: /v1, /v1beta, /v1alpha2, ...
const VERSION_SUFFIX = /\/v\d+(?:alpha|beta)?\d*$/i;

// A trailing plain numeric version (/v1, /v4). OpenAI-compatible bases that
// already carry one (Z.ai serves `.../paas/v4`) must not get another `/v1`.
const NUMERIC_VERSION = /\/v\d+$/i;

/** Trailing whitespace and slashes removed; never throws on a non-string. */
export function trimBaseUrl(baseUrl) {
  return String(baseUrl ?? "").trim().replace(/\/+$/, "");
}

/** Drop a version segment the operator already put on the base URL. */
export function stripVersionSuffix(baseUrl) {
  return trimBaseUrl(baseUrl).replace(VERSION_SUFFIX, "");
}

/** Base URL with exactly one `<version>` segment at the end. */
export function versionedBase(baseUrl, version) {
  const base = trimBaseUrl(baseUrl);
  if (!base) return "";
  return VERSION_SUFFIX.test(base) ? base : `${base}/${version}`;
}

export function joinUrl(baseUrl, suffix) {
  const base = trimBaseUrl(baseUrl);
  const path = String(suffix ?? "").replace(/^\/+/, "");
  if (!base) return path;
  return path ? `${base}/${path}` : base;
}

/**
 * Gemini native models endpoint. The configured base may be bare or may
 * already carry a version; both yield exactly one `/v1beta` segment.
 */
export function geminiModelsUrl(baseUrl, model, { stream = false } = {}) {
  const method = stream ? ":streamGenerateContent?alt=sse" : ":generateContent";
  return joinUrl(stripVersionSuffix(baseUrl), `v1beta/models/${encodeURIComponent(model)}${method}`);
}

/** `GET <base>/v1beta/models` — the quota-free Gemini probe. */
export function geminiModelsProbeUrl(baseUrl) {
  return joinUrl(versionedBase(baseUrl, "v1beta"), "models");
}

/** `GET <base>/v1/models` — the quota-free OpenAI-compatible probe. */
export function openAiModelsProbeUrl(baseUrl) {
  return joinUrl(versionedBase(baseUrl, "v1"), "models");
}

/** OpenAI-compatible chat completions, tolerating a base that ends in a numeric version (`/v1`, `/v4`). */
export function openAiChatUrl(baseUrl) {
  const base = trimBaseUrl(baseUrl);
  return joinUrl(base, NUMERIC_VERSION.test(base) ? "chat/completions" : "v1/chat/completions");
}

/** OpenAI-compatible responses endpoint. */
export function openAiResponsesUrl(baseUrl) {
  const base = trimBaseUrl(baseUrl);
  return joinUrl(base, NUMERIC_VERSION.test(base) ? "responses" : "v1/responses");
}

/** Anthropic Messages endpoint; AgentRouter serves it from the host root. */
export function anthropicMessagesUrl(baseUrl, { agentrouter = false } = {}) {
  const base = agentrouter ? trimBaseUrl(baseUrl).replace(/\/v1$/i, "") : trimBaseUrl(baseUrl);
  return joinUrl(base, "v1/messages");
}
