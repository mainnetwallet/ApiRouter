/**
 * Provider-aware health probing.
 */

import { API_VERSION_SUFFIX } from "./url-utils.js";

export const PROBE_TIMEOUT_MS = 10000;
const GEMINI_API_VERSION = "v1beta";
const OPENAI_API_VERSION = "v1";
// `https://api.cohere.com/compatibility/v1` and the same path on a Model Vault or
// `api.cohere.ai` host: the OpenAI-compatible base, whose parent is the native API.
const COHERE_COMPATIBILITY_SUFFIX = /\/compatibility(?:\/v\d+)?$/i;
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

  // Cohere. Its OpenAI Compatibility API has no model listing, so the generic
  // `GET {base}/models` below answers 404 there and the target never leaves
  // "unknown". Probing with a 1-token chat completion instead works, but it is a
  // generation request: it spends the key's chat quota (20 requests a minute and
  // 1,000 calls a month on a trial key) for every model and key, every cycle,
  // and answers 429 as soon as that budget is gone.
  //
  // Cohere's own API has the right call: "Get a Model",
  // `GET https://api.cohere.com/v1/models/{model}` (docs.cohere.com/reference/get-model).
  // It needs only the API key, generates nothing, answers 200 with the model's
  // details when the key is accepted and the model exists, and sits outside the
  // chat rate limit. The compatibility base (`.../compatibility/v1`) is a path
  // under the same host, so the native root is that base without it. A base that
  // is not a compatibility base (a custom gateway) is left to the generic probe.
  if (target.provider === "cohere" && COHERE_COMPATIBILITY_SUFFIX.test(base)) {
    return {
      provider: "cohere-model",
      method: "GET",
      url: base.replace(COHERE_COMPATIBILITY_SUFFIX, "") + "/v1/models/" + encodeURIComponent(target.model),
      // One model is asked about, so a 200 answers the model question itself
      // (see probeTargetHealth) instead of a catalogue being searched.
      modelLookup: true,
      headers: { accept: "application/json", authorization: "Bearer " + target.apiKey }
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
 * "cannot tell" rather than buffered. Enforced while the body is consumed, not
 * after it has been buffered.
 */
export const MAX_MODEL_LIST_BYTES = 512 * 1024;

/**
 * How many catalogue pages the probe will walk before giving up and reporting
 * "cannot tell". Bounds the work a paginated catalogue can cause.
 */
export const MAX_MODEL_LIST_PAGES = 5;

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
 * What a catalogue page says about further pages.
 *
 * `token` is a page this probe can actually request (`nextPageToken`, the
 * documented cursor on Gemini's `models.list`). `more` is true whenever the page
 * says further models exist — including a shape whose cursor this router cannot
 * follow, such as a malformed token or OpenAI's `has_more` without one. A page
 * that reports `more` without a usable `token` is not proof that the model is
 * absent, so it is reported as "cannot tell" rather than "missing".
 *
 * The rule for anything present but unusable is deliberately `more: true`. A
 * provider that was trying to tell us about further pages must never be read as
 * having told us there are none.
 */
export function nextPageOf(body) {
  if (!body || typeof body !== "object") return { token: null, more: false };

  // `undefined` and `null` both mean the field was not set. An empty string is
  // the documented end of a Google list, not a malformed cursor, so it is
  // treated as absent too and the `has_more` hint below still gets a say.
  const raw = body.nextPageToken ?? body.next_page_token;
  if (raw !== undefined && raw !== null && raw !== "") {
    // Present but not a string: the provider signalled further pages in a form
    // this router cannot follow, so the catalogue's completeness is unverified.
    if (typeof raw !== "string") return { token: null, more: true };
    return { token: raw, more: true };
  }

  // The OpenAI-style hint carries no way to ask for the next page, and a
  // non-boolean value is as unusable as a malformed cursor. Only an explicit
  // `false` is evidence that the catalogue ended.
  if (body.has_more !== undefined && body.has_more !== null) {
    return { token: null, more: body.has_more !== false };
  }

  return { token: null, more: false };
}

/** The probe URL for a follow-up page, or null when the URL cannot be extended. */
function pageUrlFor(url, token) {
  try {
    const next = new URL(String(url));
    next.searchParams.set("pageToken", token);
    return next.toString();
  } catch {
    return null;
  }
}

/**
 * Read a response body up to `limit` bytes, WITHOUT buffering the whole thing.
 *
 * `response.text()` would read an unbounded body into memory and only then allow
 * a size check, which is useless against a provider that omits `Content-Length`
 * or understates it. This consumes the stream incrementally and stops, cancelling
 * the reader, the moment the limit is passed.
 *
 * Returns `{ text, bytes }` on success, `{ tooLarge: true }` past the limit, or
 * `{ failed: true }` when the body is missing, not a string, or the stream
 * errors (which is also how the probe timeout surfaces here).
 */
async function readBoundedBody(response, limit) {
  // A trustworthy length is still worth respecting before spending a byte, but
  // it is only ever a fast path — never the enforcement.
  const declared = Number(response?.headers?.get?.("content-length"));
  if (Number.isFinite(declared) && declared > limit) return { tooLarge: true };

  const body = response?.body;
  if (!body || typeof body.getReader !== "function") {
    // Responses without a body stream (non-streaming stubs) fall back to text().
    try {
      const text = await response.text();
      if (typeof text !== "string") return { failed: true };
      const bytes = Buffer.byteLength(text);
      return bytes > limit ? { tooLarge: true } : { text, bytes };
    } catch {
      return { failed: true };
    }
  }

  const reader = body.getReader();
  const chunks = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      bytes += value.byteLength ?? value.length ?? 0;
      if (bytes > limit) {
        await reader.cancel().catch(() => {});
        return { tooLarge: true };
      }
      chunks.push(Buffer.from(value));
    }
  } catch {
    await reader.cancel().catch(() => {});
    return { failed: true };
  }
  return { text: Buffer.concat(chunks).toString("utf8"), bytes };
}

/**
 * Read the provider's model catalogue and report whether it names `model`.
 *
 * Returns `true` / `false` only on evidence, and `null` whenever the catalogue
 * could not be inspected to the end:
 *
 *   - the first page is unreadable, oversized, non-200 or not a known shape;
 *   - a later page cannot be fetched, is not OK, or fails to parse;
 *   - a page advertises further pages in a form this router cannot follow
 *     (a malformed cursor, or `has_more` with no token);
 *   - the page budget is exhausted, or the remaining byte budget is gone, while
 *     the provider is still advertising further pages.
 *
 * `false` therefore means "a complete catalogue was read and the model is not in
 * it" — never "the model was not on the first page". Gemini serves 50 models per
 * page by default, so a busy account routinely has more.
 *
 * Follow-up pages reuse the probe's own `fetchImpl`, `headers` and `signal`, so
 * the request stays authenticated and the probe timeout bounds the whole walk.
 */
async function readModelListing(response, model, { url, headers, fetchImpl, signal } = {}) {
  if (Number(response?.status) !== 200) return null;

  let page = response;
  let pageUrl = url;
  let remaining = MAX_MODEL_LIST_BYTES;

  for (let index = 0; index < MAX_MODEL_LIST_PAGES; index += 1) {
    const read = await readBoundedBody(page, remaining);
    if (!read.text) return null;
    remaining -= read.bytes;

    let body;
    try {
      body = JSON.parse(read.text);
    } catch {
      return null;
    }

    const ids = listedModelIds(body);
    // An unrecognized shape is "cannot tell" on any page, and stops the walk:
    // there is no evidence to weigh either way.
    if (ids === null) return null;
    if (modelInCatalogue(ids, model) === true) return true;

    const next = nextPageOf(body);
    if (!next.token) return next.more ? null : false;

    // Further pages exist but this probe cannot reach them: the model might be
    // on one of them, so absence is unproven.
    const lastPage = index === MAX_MODEL_LIST_PAGES - 1;
    if (lastPage || remaining <= 0) return null;
    if (typeof fetchImpl !== "function" || !pageUrl) return null;
    const nextUrl = pageUrlFor(pageUrl, next.token);
    if (!nextUrl) return null;

    let nextResponse;
    try {
      // The REQUEST headers, not `page.headers`: `page` is the response, so its
      // `headers` are the provider's own response headers. Sending those would
      // drop the credential (`x-goog-api-key` / `Authorization`) and hand the
      // provider its own `content-type`, `date` and `server` back as request
      // headers — so every follow-up page failed as unauthorized.
      nextResponse = await fetchImpl(nextUrl, { method: "GET", headers, signal });
    } catch {
      return null;
    }
    if (Number(nextResponse?.status) !== 200) return null;

    // Release the page just consumed before moving on.
    try { await page.body?.cancel(); } catch {}
    page = nextResponse;
    pageUrl = nextUrl;
  }

  return null;
}

/**
 * What a single-model lookup (Cohere's "Get a Model") says about the model.
 *
 * `true` only when the provider answered 200 with that very model's record. Any
 * other answer is `null`, "cannot tell": a 404 from a lookup could as well be a
 * wrong base URL as a missing model, and `false` is reserved for a complete
 * catalogue that was read and did not name the model.
 */
async function readModelLookup(response, model) {
  if (Number(response?.status) !== 200) return null;
  const read = await readBoundedBody(response, 64 * 1024);
  if (!read.text) return null;
  try {
    const body = JSON.parse(read.text);
    return typeof body?.name === "string" && body.name === String(model ?? "").trim() ? true : null;
  } catch {
    return null;
  }
}

export async function probeTargetHealth(target, options = {}) {
  const { timeoutMs = PROBE_TIMEOUT_MS, fetchImpl = fetch } = options;
  const plan = healthProbePlan(target);
  // No probe means no catalogue observation either, so the key is present and
  // indeterminate rather than missing: every probe result has the same shape.
  if (!plan) return { ok: null, status: null, latencyMs: null, modelListed: null, reason: "no safe health probe for this provider" };

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
    // target is configured with is actually offered. This costs no extra request
    // for the common single-page catalogue; a paginated one is walked with the
    // same fetch and signal, so the probe timeout bounds it too.
    let modelListed = null;
    try {
      modelListed = plan.modelLookup
        ? await readModelLookup(upstream, target.model)
        : await readModelListing(upstream, target.model, {
          url: plan.url,
          headers: plan.headers,
          fetchImpl,
          signal: controller.signal
        });
    } catch {
      // Unreadable is "cannot tell", never a health failure: the endpoint
      // answered, which is all the health verdict is about.
      modelListed = null;
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
