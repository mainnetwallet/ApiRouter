/**
 * Provider-aware health probing.
 */

export const PROBE_TIMEOUT_MS = 10000;
const GEMINI_API_VERSION = "v1beta";
const OPENAI_API_VERSION = "v1";
const VERSION_SUFFIX = /\/v\d+(?:alpha|beta)?\d*$/i;
const trimBase = (baseUrl) => String(baseUrl || "").replace(/\/+$/, "");

function versionedBase(baseUrl, version) {
  const base = trimBase(baseUrl);
  if (!base) return "";
  return VERSION_SUFFIX.test(base) ? base : base + "/" + version;
}

function applyConfiguredClientHeaders(headers, target) {
  if (target?.provider !== "agentrouter") return;
  const configured = target.clientHeaders || {};
  if (configured.originator) headers.originator = configured.originator;
  if (configured.version) headers.version = configured.version;
  if (configured["user-agent"]) headers["user-agent"] = configured["user-agent"];
}

export function healthProbePlan(target) {
  const protocols = Array.isArray(target?.protocols) ? target.protocols : [];
  const base = trimBase(target?.baseUrl);
  if (!base || !target?.apiKey) return null;

  if (protocols.includes("gemini")) {
    return {
      provider: "gemini",
      url: versionedBase(base, GEMINI_API_VERSION) + "/models",
      headers: { accept: "application/json", "x-goog-api-key": target.apiKey }
    };
  }

  if (protocols.includes("openai-chat") || protocols.includes("openai-responses")) {
    const headers = { accept: "application/json", authorization: "Bearer " + target.apiKey };
    applyConfiguredClientHeaders(headers, target);
    return {
      provider: target.provider === "agentrouter" ? "agentrouter-openai" : "openai-compatible",
      url: versionedBase(base, OPENAI_API_VERSION) + "/models",
      headers
    };
  }
  return null;
}

export function classifyProbeStatus(status) {
  const code = Number(status);
  if (!Number.isInteger(code)) return { ok: null, reason: "probe returned no usable status" };
  if (code >= 200 && code < 300) return { ok: true, reason: "models endpoint reachable" };
  if (code === 401 || code === 403) return { ok: false, reason: "authentication rejected (HTTP " + code + ")" };
  if (code === 402) return { ok: false, reason: "payment required (HTTP 402)" };
  if (code === 408) return { ok: false, reason: "provider timed out (HTTP 408)" };
  if (code === 429) return { ok: false, reason: "rate limited (HTTP 429)" };
  if (code === 501) return { ok: null, reason: "probe endpoint not implemented (HTTP 501)" };
  if (code === 404 || code === 405) return { ok: null, reason: "probe endpoint not supported (HTTP " + code + ")" };
  if (code >= 500) return { ok: false, reason: "provider unavailable (HTTP " + code + ")" };
  return { ok: null, reason: "probe inconclusive (HTTP " + code + ")" };
}

const isAbortError = (error) => error?.name === "AbortError" || error?.name === "TimeoutError";

export async function probeTargetHealth(target, options = {}) {
  const { timeoutMs = PROBE_TIMEOUT_MS, fetchImpl = fetch } = options;
  const plan = healthProbePlan(target);
  if (!plan) return { ok: null, status: null, latencyMs: null, reason: "no safe health probe for this provider" };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = Date.now();
  try {
    const upstream = await fetchImpl(plan.url, { method: "GET", headers: plan.headers, signal: controller.signal });
    const latencyMs = Date.now() - startedAt;
    try { await upstream.body?.cancel(); } catch {}
    return { ...classifyProbeStatus(upstream.status), status: upstream.status, latencyMs };
  } catch (error) {
    return { ok: false, status: 408, latencyMs: Date.now() - startedAt, reason: isAbortError(error) ? "probe timed out" : "probe unreachable" };
  } finally {
    clearTimeout(timer);
  }
}
