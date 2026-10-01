import { sanitizeText } from "./sanitize.js";

/**
 * Error taxonomy.
 *
 * The gateway can fail in ways that look identical in a status code but need
 * completely different responses from an operator: a 429 means wait, a 402
 * means top up, a 401 means fix the key. Collapsing them into "Offline" — as
 * the brief explicitly forbids — throws away the only actionable information.
 *
 * So every failure is described by three things:
 *   category  what class of problem it is
 *   label     a short human phrase
 *   hint      what the operator should actually do about it
 */

export const CATEGORY = Object.freeze({
  AUTH: "authentication",
  FORBIDDEN: "forbidden",
  QUOTA: "quota",
  RATE_LIMIT: "rate-limit",
  TIMEOUT: "timeout",
  PROVIDER: "provider-error",
  GATEWAY: "gateway",
  UNAVAILABLE: "unavailable",
  NO_ROUTE: "no-route",
  MODEL: "model-unavailable",
  COOLDOWN: "cooldown",
  NETWORK: "network",
  COOLDOWN_CLIENT: "client",
  INVALID: "invalid-request",
  UNKNOWN: "unknown"
});

const HTTP_STATUS = {
  400: { category: CATEGORY.INVALID, label: "Bad request", retryable: false, hint: "The gateway rejected the request body as malformed." },
  401: { category: CATEGORY.AUTH, label: "Authentication failed", retryable: false, hint: "The credential was missing or rejected. Check the API key for this provider." },
  402: { category: CATEGORY.QUOTA, label: "Quota exhausted", retryable: true, hint: "Payment is required. The provider will keep refusing until the plan or balance is restored." },
  403: { category: CATEGORY.FORBIDDEN, label: "Forbidden", retryable: false, hint: "The credential is valid but not permitted to use this model or endpoint." },
  404: { category: CATEGORY.MODEL, label: "Not found", retryable: false, hint: "The endpoint or model does not exist at this provider." },
  408: { category: CATEGORY.TIMEOUT, label: "Request timeout", retryable: true, hint: "The provider did not respond in time. Raising REQUEST_TIMEOUT_MS may help." },
  409: { category: CATEGORY.COOLDOWN_CLIENT, label: "Conflict", retryable: false, hint: "Another operation of the same kind is already in progress." },
  413: { category: CATEGORY.INVALID, label: "Payload too large", retryable: false, hint: "The request body exceeded the gateway limit of 10 MB." },
  429: { category: CATEGORY.RATE_LIMIT, label: "Rate limited", retryable: true, hint: "The provider is throttling this key. The target enters cooldown and routing moves on." },
  500: { category: CATEGORY.PROVIDER, label: "Provider error", retryable: true, hint: "The provider failed internally. This is not a problem with the request." },
  501: { category: CATEGORY.PROVIDER, label: "Not implemented", retryable: false, hint: "The provider does not implement this operation." },
  502: { category: CATEGORY.GATEWAY, label: "All targets failed", retryable: true, hint: "Every eligible target failed. Check the fallback chain for the individual reasons." },
  503: { category: CATEGORY.UNAVAILABLE, label: "Unavailable", retryable: true, hint: "No target could serve the request, or the provider is temporarily down." },
  504: { category: CATEGORY.TIMEOUT, label: "Gateway timeout", retryable: true, hint: "The upstream did not answer in time." }
};

const DEFAULT_STATUS = {
  category: CATEGORY.UNKNOWN,
  label: "Request failed",
  retryable: false,
  hint: "The gateway returned an unexpected response."
};

const NETWORK_STATUS = {
  category: CATEGORY.NETWORK,
  label: "Cannot reach the router",
  retryable: true,
  hint: "The control panel could not reach the gateway. Confirm the server is running and the address is correct."
};

const ABORT_STATUS = {
  category: CATEGORY.COOLDOWN_CLIENT,
  label: "Request cancelled",
  retryable: false,
  hint: "The request was cancelled before it completed."
};

export function describeStatus(status) {
  return HTTP_STATUS[Number(status)] ?? DEFAULT_STATUS;
}

export function isRetryableStatus(status) {
  return describeStatus(status).retryable === true;
}

/**
 * A normalized transport error.
 *
 * `message` is always sanitized, so an error object is safe to render, log or
 * copy anywhere in the UI without a second pass.
 */
export class ApiError extends Error {
  constructor({ status = null, type = null, message = null, details = null, failures = null, cause = null, kind = "http" } = {}) {
    const base = kind === "network" ? NETWORK_STATUS : kind === "abort" ? ABORT_STATUS : describeStatus(status);
    super(sanitizeText(message) || base.label);

    this.name = "ApiError";
    this.kind = kind;
    this.status = status;
    this.type = type;
    this.details = details;
    this.cause = cause;
    this.category = base.category;
    this.label = base.label;
    this.retryable = base.retryable;
    this.hint = base.hint;

    /**
     * Per-target failure detail. The gateway emits this as a sibling of
     * `message`/`type` inside the `error` object, so it is read from there
     * first and `details.failures` is accepted as a fallback shape.
     */
    const list = Array.isArray(failures)
      ? failures
      : Array.isArray(details?.failures)
        ? details.failures
        : [];
    this.failures = list;
  }
}

/**
 * Turn a gateway error envelope (`{ error: { message, type, details } }`) into
 * an ApiError. The `type` field is more specific than the status, so it wins
 * when the two disagree — notably `503 + no_route`, which is a configuration
 * problem rather than a provider outage.
 */
export function apiErrorFromResponse(status, envelope, { rawText = null } = {}) {
  const error = envelope?.error ?? null;
  const type = error?.type ?? null;

  if (type === "no_route") {
    const apiError = new ApiError({
      status,
      type,
      message: sanitizeText(error?.message) || "No configured target supports this protocol",
      details: error?.details,
      failures: error?.failures
    });
    apiError.category = CATEGORY.NO_ROUTE;
    apiError.label = "No route available";
    apiError.retryable = false;
    apiError.hint = "No configured provider supports this client protocol. Add a provider that speaks it, or change the request.";
    return apiError;
  }

  if (type === "authentication_error") {
    const apiError = new ApiError({
      status,
      type,
      message: error?.message,
      details: error?.details,
      failures: error?.failures
    });
    apiError.category = CATEGORY.AUTH;
    apiError.label = "Router authentication failed";
    apiError.hint = "This gateway requires a client token. Set it in the connection settings.";
    return apiError;
  }

  const message = error?.message || rawText || null;
  return new ApiError({
    status,
    type,
    message,
    details: error?.details ?? null,
    failures: error?.failures ?? null
  });
}

/** Convert anything thrown by `fetch` into an ApiError. */
export function apiErrorFromException(error, { timedOut = false } = {}) {
  if (error instanceof ApiError) return error;

  if (error?.name === "AbortError") {
    return new ApiError({
      kind: "abort",
      message: timedOut ? "The gateway did not respond before the timeout" : null
    });
  }

  return new ApiError({
    kind: "network",
    message: sanitizeText(error?.message),
    cause: error
  });
}

// ---------------------------------------------------------------------------
// Provider-level failure description
// ---------------------------------------------------------------------------

/**
 * Classify a single upstream attempt, which is what the fallback visualiser
 * labels each hop with. Cooldown is inferred from the health registry rather
 * than the status code, because a cooled-down target never produced a status.
 */
export function describeAttempt(attempt) {
  if (!attempt) return { label: "unknown", category: CATEGORY.UNKNOWN, tone: "neutral" };

  if (attempt.ok) return { label: "success", category: "ok", tone: "ok" };

  const status = Number(attempt.status);
  const message = String(attempt.errorMessage ?? "").toLowerCase();

  if (status === 401 || status === 403) return { label: "auth rejected", category: CATEGORY.AUTH, tone: "danger" };
  if (status === 402) return { label: "quota exhausted", category: CATEGORY.QUOTA, tone: "danger" };
  if (status === 429) return { label: "rate limited", category: CATEGORY.RATE_LIMIT, tone: "warn" };
  if (status === 408 || status === 504) return { label: "timeout", category: CATEGORY.TIMEOUT, tone: "warn" };
  if (status === 404) return { label: "model unavailable", category: CATEGORY.MODEL, tone: "danger" };
  if (status >= 500) return { label: `provider error ${status}`, category: CATEGORY.PROVIDER, tone: "danger" };
  if (status) return { label: `HTTP ${status}`, category: CATEGORY.PROVIDER, tone: "warn" };

  if (message.includes("timed out")) return { label: "timeout", category: CATEGORY.TIMEOUT, tone: "warn" };
  if (message.includes("unreachable")) return { label: "network failure", category: CATEGORY.NETWORK, tone: "danger" };

  return { label: "failed", category: CATEGORY.UNKNOWN, tone: "danger" };
}

/** Tone for a health status, using the same vocabulary as the badges. */
export function healthTone(status) {
  if (status === "healthy") return "ok";
  if (status === "cooldown") return "warn";
  if (status === "failed") return "danger";
  return "neutral";
}

// ---------------------------------------------------------------------------
// Failure attribution for logged requests
// ---------------------------------------------------------------------------

/**
 * Classify a logged request by the reason an operator can act on, rather than
 * by raw status code. Mirrors `classifyFailure` in
 * `src/observability/metrics.js` so the failure donut and the failure drawer
 * agree on their labels.
 *
 * A 429 and a 402 are both "the provider refused", but only one of them is
 * fixed by waiting.
 */
export function classifyFailure(entry) {
  const status = Number(entry?.httpStatus);
  const errorType = String(entry?.errorType ?? "").toLowerCase();

  if (errorType === "no_route") return "no route";
  if (status === 401 || status === 403) return "authentication";
  if (status === 402) return "quota exhausted";
  if (status === 408 || status === 504) return "timeout";
  if (status === 429) return "rate limited";
  if (status === 503) return "unavailable";
  if (status === 500 || status === 502) return "provider error";

  const attemptMessage = String(entry?.attempts?.at(-1)?.errorMessage ?? "").toLowerCase();
  const message = String(entry?.errorMessage ?? "").toLowerCase() || attemptMessage;

  if (message.includes("timed out")) return "timeout";
  if (message.includes("unreachable")) return "network failure";
  if (message.includes("model")) return "model unavailable";

  return status ? `http ${status}` : "unknown";
}

/** Operator-facing label for a failure category. */
export function failureLabel(category) {
  switch (category) {
    case "authentication": return "Authentication failure";
    case "quota exhausted": return "Quota exhaustion";
    case "rate limited": return "Rate limiting";
    case "timeout": return "Timeout";
    case "no route": return "No route available";
    case "unavailable": return "Provider unavailable";
    case "network failure": return "Network failure";
    case "model unavailable": return "Model unavailable";
    case "provider error": return "Provider error";
    default: return "Request failed";
  }
}
