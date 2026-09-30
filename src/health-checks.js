/**
 * Provider-aware health probing.
 *
 * A generic `GET <baseUrl>` cannot establish that a provider is healthy: the
 * base URL may answer with 404/405 regardless of state, it never exercises the
 * API key, and the previous implementation sent `Authorization: Bearer` to
 * Gemini, which authenticates with `x-goog-api-key`.
 *
 * Instead each protocol capability gets an explicit, cheap probe against the
 * provider's own model-listing endpoint. Listing models is metadata-only, so a
 * probe never consumes generation quota and never sends a prompt.
 *
 * Probe results are normalized to:
 *
 *   { ok: true | false | null, status, latencyMs, reason }
 *
 *   ok: true   the provider answered and accepted our credentials
 *   ok: false  the provider is unreachable, rejected our credentials, is rate
 *              limiting us, or is failing
 *   ok: null   passive: the probe could not determine health (endpoint not
 *              implemented, or no safe probe exists for this provider)
 *
 * Passive results never mutate health state. The router must not invent a
 * health claim it cannot support.
 */

export const PROBE_TIMEOUT_MS = 10000;

const GEMINI_API_VERSION = "v1beta";
const OPENAI_API_VERSION = "v1";

/** Matches a trailing API version segment, e.g. `/v1`, `/v1beta`, `/v4`. */
const VERSION_SUFFIX = /\/v\d+(?:alpha|beta)?\d*$/i;

const trimBase = (baseUrl) => String(baseUrl || "").replace(/\/+$/, "");

/**
 * Append the API version only when the configured base URL does not already
 * carry one. This mirrors how `buildUpstreamRequest` resolves endpoint paths.
 */
function versionedBase(baseUrl, version) {
  const base = trimBase(baseUrl);
  if (!base) return "";
  return VERSION_SUFFIX.test(base) ? base : base + "/" + version;
}

/**
 * Choose a probe for a target based on the protocol capabilities it declares.
 * Returns null when no safe, quota-free probe is available.
 */
export function healthProbePlan(target) {
  const protocols = Array.isArray(target?.protocols) ? target.protocols : [];
  const base = trimBase(target?.baseUrl);

  if (!base || !target?.apiKey) return null;

  if (protocols.includes("gemini")) {
    return {
      provider: "gemini",
      // GET /v1beta/models — Google's ListModels. Metadata only, no generation.
      url: versionedBase(base, GEMINI_API_VERSION) + "/models",
      // Gemini authenticates with a header, never a `?key=` query parameter,
      // so the credential can never leak into a logged URL.
      headers: { accept: "application/json", "x-goog-api-key": target.apiKey }
    };
  }

  if (protocols.includes("openai-chat") || protocols.includes("openai-responses")) {
    return {
      provider: target.provider === "agentrouter" ? "agentrouter-openai" : "openai-compatible",
      // GET /v1/models — the OpenAI-compatible List Models endpoint, resolved
      // against the same base the request adapter targets.
      url: versionedBase(base, OPENAI_API_VERSION) + "/models",
      headers: { accept: "application/json", authorization: "Bearer " + target.apiKey }
    };
  }

  // Anthropic-only targets have no quota-free readiness endpoint in this
  // architecture. Report passive health rather than a fabricated claim.
  return null;
}

/**
 * Map an observed HTTP status onto a health verdict.
 *
 * 401/403 are authentication failures and must never read as healthy.
 * 404/405/501 mean the probe endpoint itself is unavailable, which says
 * nothing about the provider, so they stay passive rather than becoming
 * either a failure or a success.
 */
export function classifyProbeStatus(status) {
  const code = Number(status);

  if (!Number.isInteger(code)) {
    return { ok: null, reason: "probe returned no usable status" };
  }
  if (code >= 200 && code < 300) {
    return { ok: true, reason: "models endpoint reachable" };
  }
  if (code === 401 || code === 403) {
    return { ok: false, reason: "authentication rejected (HTTP " + code + ")" };
  }
  if (code === 402) {
    return { ok: false, reason: "payment required (HTTP 402)" };
  }
  if (code === 408) {
    return { ok: false, reason: "provider timed out (HTTP 408)" };
  }
  if (code === 429) {
    return { ok: false, reason: "rate limited (HTTP 429)" };
  }
  if (code === 501) {
    return { ok: null, reason: "probe endpoint not implemented (HTTP 501)" };
  }
  if (code === 404 || code === 405) {
    return { ok: null, reason: "probe endpoint not supported (HTTP " + code + ")" };
  }
  if (code >= 500) {
    return { ok: false, reason: "provider unavailable (HTTP " + code + ")" };
  }

  // Remaining 4xx: the provider rejected the probe request itself. That is
  // not evidence about provider health, so stay passive.
  return { ok: null, reason: "probe inconclusive (HTTP " + code + ")" };
}

const isAbortError = (error) =>
  error?.name === "AbortError" || error?.name === "TimeoutError";

/**
 * Run a provider-aware health probe.
 *
 * Never resolves to a rejection: every outcome is expressed as a normalized
 * result. `reason` is drawn from a fixed vocabulary and never interpolates
 * upstream error text, so credentials cannot leak into `/health` output.
 */
export async function probeTargetHealth(target, options = {}) {
  const { timeoutMs = PROBE_TIMEOUT_MS, fetchImpl = fetch } = options;
  const plan = healthProbePlan(target);

  if (!plan) {
    return {
      ok: null,
      status: null,
      latencyMs: null,
      reason: "no safe health probe for this provider"
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = Date.now();

  try {
    const upstream = await fetchImpl(plan.url, {
      method: "GET",
      headers: plan.headers,
      signal: controller.signal
    });

    const latencyMs = Date.now() - startedAt;

    // The probe only needs the status line; release the socket immediately.
    try {
      await upstream.body?.cancel();
    } catch {
      // Ignore: the verdict is already known.
    }

    const verdict = classifyProbeStatus(upstream.status);
    return { ...verdict, status: upstream.status, latencyMs };
  } catch (error) {
    return {
      ok: false,
      status: 408,
      latencyMs: Date.now() - startedAt,
      reason: isAbortError(error) ? "probe timed out" : "probe unreachable"
    };
  } finally {
    clearTimeout(timer);
  }
}
