import {
  ApiError,
  apiErrorFromException,
  apiErrorFromResponse,
  isRetryableStatus
} from "../lib/errors.js";
import { getRouterToken } from "../lib/session.js";

/**
 * The single place this application calls `fetch`.
 *
 * Every component goes through here so that timeouts, retries, cancellation,
 * auth and error normalisation are implemented once. A component that reached
 * for `fetch` directly would silently lose all of the following:
 *
 *   timeout     every request is bounded, so a hung gateway cannot leave the
 *               UI spinning forever
 *   retry       only idempotent (GET) requests are retried, with exponential
 *               backoff and jitter. A generation POST is NEVER retried
 *               automatically — that would bill the operator twice for one
 *               click.
 *   ETag        conditional GETs return the previous object identity on 304,
 *               so a poll that changes nothing causes no React re-render
 *   errors      everything becomes a typed ApiError with a sanitized message
 */

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_ATTEMPTS = 3;
const BASE_BACKOFF_MS = 250;
const MAX_BACKOFF_MS = 4_000;

/** url -> { etag, data }, consulted for conditional GETs. */
const etagCache = new Map();

const now = () => Date.now();

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    }, { once: true });
  });
}

/** Exponential backoff with jitter, honouring a server `Retry-After`. */
function backoffMs(attempt, response) {
  const retryAfter = Number(response?.headers?.get?.("retry-after"));
  if (Number.isFinite(retryAfter) && retryAfter > 0) {
    return Math.min(retryAfter * 1000, MAX_BACKOFF_MS);
  }
  const base = Math.min(BASE_BACKOFF_MS * 2 ** attempt, MAX_BACKOFF_MS);
  // Jitter prevents a dashboard and a health poll from retrying in lockstep.
  return Math.round(base * (0.7 + Math.random() * 0.6));
}

function buildHeaders({ method, body, token, extra }) {
  const headers = { accept: "application/json", ...extra };

  // GETs must not carry a content-type; it makes them non-simple and can
  // trigger a preflight for no reason.
  if (body !== undefined) headers["content-type"] = "application/json";
  if (token) headers.authorization = `Bearer ${token}`;

  return headers;
}

/**
 * Perform an API request.
 *
 * @param {string} path         gateway-relative path, e.g. "/api/health"
 * @param {object} [options]
 * @param {AbortSignal} [options.signal]   caller cancellation
 * @param {number} [options.timeoutMs]     per-attempt timeout
 * @param {number} [options.retries]       override the GET-only default
 * @param {boolean} [options.conditional]  use ETag caching (default: GET only)
 */
export async function apiRequest(path, options = {}) {
  const {
    method = "GET",
    body,
    signal,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    retries,
    conditional,
    headers: extraHeaders,
    cacheKey = `${method} ${path}`
  } = options;

  const isGet = method === "GET";
  const maxAttempts = 1 + (retries ?? (isGet ? MAX_ATTEMPTS - 1 : 0));
  const useConditional = conditional ?? isGet;
  const token = getRouterToken();

  let lastError = null;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    // Each attempt gets its own controller so a timeout aborts only that try,
    // while a caller abort still cancels everything.
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    signal?.addEventListener("abort", onAbort, { once: true });

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);

    try {
      const cached = useConditional ? etagCache.get(cacheKey) : null;
      const requestHeaders = buildHeaders({ method, body, token, extra: extraHeaders });

      if (cached?.etag) requestHeaders["if-none-match"] = cached.etag;

      const response = await fetch(path, {
        method,
        headers: requestHeaders,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
        credentials: "same-origin"
      });

      // 304: the cached object is returned by identity, which lets React bail
      // out of the state update and skip the re-render entirely.
      if (response.status === 304 && cached) {
        return cached.data;
      }

      const text = await response.text();
      let envelope = null;
      if (text) {
        try {
          envelope = JSON.parse(text);
        } catch {
          envelope = null;
        }
      }

      if (!response.ok) {
        const error = apiErrorFromResponse(response.status, envelope, { rawText: text.slice(0, 300) });

        // Retry only when it is safe and the failure is transient.
        const canRetry = isGet && isRetryableStatus(response.status) && attempt < maxAttempts - 1;
        if (canRetry) {
          lastError = error;
          await sleep(backoffMs(attempt, response), signal);
          continue;
        }
        throw error;
      }

      const data = envelope;
      if (useConditional) {
        const etag = response.headers.get("etag");
        if (etag) etagCache.set(cacheKey, { etag, data });
      }

      return data;
    } catch (error) {
      const apiError = apiErrorFromException(error, { timedOut });

      // A caller-initiated abort is not an error to retry or report.
      if (apiError.kind === "abort" && !timedOut) throw apiError;

      const canRetry = isGet && apiError.retryable && attempt < maxAttempts - 1;
      if (canRetry) {
        lastError = apiError;
        await sleep(backoffMs(attempt), signal);
        continue;
      }
      throw apiError;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  }

  throw lastError ?? new ApiError({ kind: "network" });
}

export function postJson(path, body, options = {}) {
  return apiRequest(path, { ...options, method: "POST", body, retries: 0 });
}

/**
 * Open a streaming request and hand back the raw `Response`.
 *
 * Used only by the Playground. Streaming is intentionally not retried: a
 * partially consumed generation cannot be resumed, and re-issuing it would
 * duplicate upstream cost.
 */
export async function apiStream(path, { body, signal, timeoutMs = 180_000, headers: extraHeaders } = {}) {
  const token = getRouterToken();
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  signal?.addEventListener("abort", onAbort, { once: true });

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  try {
    const response = await fetch(path, {
      method: "POST",
      headers: buildHeaders({ method: "POST", body, token, extra: extraHeaders }),
      body: JSON.stringify(body ?? {}),
      signal: controller.signal,
      credentials: "same-origin"
    });

    if (!response.ok) {
      const text = await response.text();
      let envelope = null;
      try {
        envelope = JSON.parse(text);
      } catch {
        envelope = null;
      }
      throw apiErrorFromResponse(response.status, envelope, { rawText: text.slice(0, 300) });
    }

    return response;
  } catch (error) {
    throw apiErrorFromException(error, { timedOut });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

/** Drop cached ETags, e.g. after the operator changes the router token. */
export function invalidateCache() {
  etagCache.clear();
}
