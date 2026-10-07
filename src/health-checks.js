/**
 * Provider-aware health probing.
 */

import { geminiModelsProbeUrl, openAiModelsProbeUrl, trimBaseUrl } from "./upstream-url.js";
import { fetchUpstream } from "./upstream-fetch.js";

export const PROBE_TIMEOUT_MS = 10000;

function applyConfiguredClientHeaders(headers, target) {
  if (target?.provider !== "agentrouter") return;
  const configured = target.clientHeaders || {};
  if (configured.originator) headers.originator = configured.originator;
  if (configured.version) headers.version = configured.version;
  if (configured["user-agent"]) headers["user-agent"] = configured["user-agent"];
}

export function healthProbePlan(target) {
  const protocols = Array.isArray(target?.protocols) ? target.protocols : [];
  const base = trimBaseUrl(target?.baseUrl);
  if (!base || !target?.apiKey) return null;

  if (protocols.includes("gemini")) {
    return {
      provider: "gemini",
      url: geminiModelsProbeUrl(base),
      headers: { accept: "application/json", "x-goog-api-key": target.apiKey }
    };
  }

  // Workers AI has no /ai/v1/models; its model listing is /ai/models/search and
  // needs the account-scoped URL. Probing /models there only ever returned 404,
  // which left every Cloudflare target stuck at "unknown".
  if (target.provider === "cloudflare" && /\/accounts\/[^/]+\/ai\/v1$/i.test(base)) {
    return {
      provider: "cloudflare",
      url: base.replace(/\/v1$/i, "") + "/models/search?per_page=1",
      headers: { accept: "application/json", authorization: "Bearer " + target.apiKey }
    };
  }

  if (protocols.includes("openai-chat") || protocols.includes("openai-responses")) {
    const headers = { accept: "application/json", authorization: "Bearer " + target.apiKey };
    applyConfiguredClientHeaders(headers, target);
    return {
      provider: target.provider === "agentrouter" ? "agentrouter-openai" : "openai-compatible",
      url: openAiModelsProbeUrl(base),
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
    // fetchUpstream refuses to follow a redirect, so a probe can never replay
    // the key to a host the operator did not configure.
    const upstream = await fetchUpstream(plan.url, { method: "GET", headers: plan.headers, signal: controller.signal }, fetchImpl);
    const latencyMs = Date.now() - startedAt;
    try { await upstream.body?.cancel(); } catch {}
    return { ...classifyProbeStatus(upstream.status), status: upstream.status, latencyMs };
  } catch (error) {
    return { ok: false, status: 408, latencyMs: Date.now() - startedAt, reason: isAbortError(error) ? "probe timed out" : "probe unreachable" };
  } finally {
    clearTimeout(timer);
  }
}
