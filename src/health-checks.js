/**
 * Provider-aware health probing.
 */

import { API_VERSION_SUFFIX } from "./url-utils.js";

export const PROBE_TIMEOUT_MS = 10000;
const GEMINI_API_VERSION = "v1beta";
const OPENAI_API_VERSION = "v1";
const trimBase = (baseUrl) => String(baseUrl || "").replace(/\/+$/, "");

function versionedBase(baseUrl, version) {
  const base = trimBase(baseUrl);
  if (!base) return "";
  return API_VERSION_SUFFIX.test(base) ? base : base + "/" + version;
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

  // Workers AI has no /ai/v1/models; its model listing is /ai/models/search and
  // needs the account-scoped URL. Probing /models there only ever returned 404,
  // which left every Cloudflare target stuck at "unknown".
  if (target.provider === "cloudflare" && /\/accounts\/[^/]+\/ai\/v1$/i.test(base)) {
    return {
      provider: "cloudflare",
      method: "GET",
      url: base.replace(/\/v1$/i, "") + "/models/search?per_page=1",
      headers: { accept: "application/json", authorization: "Bearer " + target.apiKey }
    };
  }

  // Cohere's OpenAI Compatibility API is chat-first: the compatibility base
  // is guaranteed for chat completions, while a generic GET /models probe is
  // not a reliable health signal. Probe the exact route used by Playground,
  // with the smallest useful generation request.
  if (target.provider === "cohere" && protocols.includes("openai-chat")) {
    return {
      provider: "cohere-chat",
      method: "POST",
      url: base + "/chat/completions",
      headers: {
        accept: "application/json",
        authorization: "Bearer " + target.apiKey,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model: target.model,
        messages: [{ role: "user", content: "health" }],
        max_tokens: 1,
        stream: false
      })
    };
  }

  if (protocols.includes("openai-chat") || protocols.includes("openai-responses")) {
    const headers = { accept: "application/json", authorization: "Bearer " + target.apiKey };
    applyConfiguredClientHeaders(headers, target);
    return {
      provider: target.provider === "agentrouter" ? "agentrouter-openai" : "openai-compatible",
      method: "GET",
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

/**
 * The largest model catalogue the probe will read to look for the configured
 * model id. A catalogue larger than this is left unread and reported as
 * "cannot tell" rather than buffered.
 */
const MAX_MODEL_LIST_BYTES = 512 * 1024;

/**
 * Model ids named by a provider's catalogue response.
 *
 * Only the shapes this router actually probes are read: OpenAI's
 * `{ data: [{ id }] }` (the generic compatibility branch) and Gemini's
 * `{ models: [{ name }] }`. Any other shape yields `null` — "cannot tell", which
 * must never be read as "the model is missing".
 */
export function listedModelIds(body) {
  if (Array.isArray(body?.data)) {
    return body.data.map((entry) => entry?.id).filter((id) => typeof id === "string");
  }
  if (Array.isArray(body?.models)) {
    return body.models
      .map((entry) => (typeof entry?.name === "string" ? entry.name : entry?.id))
      .filter((id) => typeof id === "string");
  }
  return null;
}

/**
 * Does a read catalogue name `model`? `null` when the catalogue could not be
 * read at all. Gemini lists its models as `models/<id>`, so both spellings
 * match.
 */
export function modelInCatalogue(ids, model) {
  if (!Array.isArray(ids)) return null;
  const wanted = String(model ?? "").trim();
  if (!wanted) return null;
  return ids.some((id) => id === wanted || id.replace(/^models\//, "") === wanted);
}

/**
 * Read a bounded model catalogue off an OK probe response and report whether the
 * configured model appears in it.
 *
 * Every failure path answers `null`. A provider that paginates, hides models, or
 * replies with a shape this router does not recognise must never be reported as
 * missing the model it is configured with — the probe has no evidence either way,
 * and a false negative would be worse than the silence it replaces.
 */
async function readModelListing(response, model) {
  if (Number(response?.status) !== 200) return null;
  const declared = Number(response?.headers?.get?.("content-length"));
  if (Number.isFinite(declared) && declared > MAX_MODEL_LIST_BYTES) return null;
  try {
    const text = await response.text();
    if (typeof text !== "string" || Buffer.byteLength(text) > MAX_MODEL_LIST_BYTES) return null;
    return modelInCatalogue(listedModelIds(JSON.parse(text)), model);
  } catch {
    return null;
  }
}

export async function probeTargetHealth(target, options = {}) {
  const { timeoutMs = PROBE_TIMEOUT_MS, fetchImpl = fetch } = options;
  const plan = healthProbePlan(target);
  if (!plan) return { ok: null, status: null, latencyMs: null, reason: "no safe health probe for this provider" };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = Date.now();
  try {
    const upstream = await fetchImpl(plan.url, {
      method: plan.method || "GET",
      headers: plan.headers,
      ...(plan.body ? { body: plan.body } : {}),
      signal: controller.signal
    });
    const latencyMs = Date.now() - startedAt;
    // Read the catalogue the probe already fetched to see whether the model this
    // target is configured with is actually offered. This costs no extra
    // request; it only stops the body being discarded unread.
    let modelListed = null;
    try {
      modelListed = await readModelListing(upstream, target.model);
    } finally {
      // Nothing else consumes this body; release the socket either way.
      try { await upstream.body?.cancel(); } catch {}
    }
    return { ...classifyProbeStatus(upstream.status), status: upstream.status, latencyMs, modelListed };
  } catch (error) {
    return { ok: false, status: 408, latencyMs: Date.now() - startedAt, reason: isAbortError(error) ? "probe timed out" : "probe unreachable" };
  } finally {
    clearTimeout(timer);
  }
}
