import { HealthRegistry } from "./health.js";

const DEFAULT_RETRY_STATUS_CODES = new Set([401, 402, 403, 404, 408, 409, 425, 429, 500, 501, 502, 503, 504, 520, 521, 522, 523, 524, 529]);

// Sessions are keyed by a client-supplied header, so the store must be bounded:
// an unbounded map would grow without limit on a long-running gateway.
const DEFAULT_MAX_SESSIONS = 10000;

/**
 * How far a failure reaches.
 *
 * This is the distinction that keeps one bad model from taking out its
 * siblings: a failure that names the model cools THAT target down, while a
 * failure that describes the credential or the account cools every model
 * sharing that key. Getting it wrong in either direction is expensive — too
 * narrow and a dead key is retried once per model, too wide and one withdrawn
 * model disables a provider's whole catalogue.
 */
export const FAILURE_SCOPE = Object.freeze({
  TARGET: "target",
  KEY: "key",
  PROVIDER: "provider"
});

// These statuses describe the API key / account, not the model: once one model
// rejects a key, every other model on that provider + key will too.
const KEY_LEVEL_STATUS_CODES = new Set([401, 402, 403]);

// These describe the request or the model rather than the credential or the
// provider, and must never reach a sibling: a withdrawn model (404) or a
// request this model cannot accept (400, 413, 422) says nothing about the
// other models on the same key.
const MODEL_LEVEL_STATUS_CODES = new Set([400, 404, 413, 422]);

/**
 * Classifies a failed attempt from the metadata actually available.
 *
 * A provider adapter that can read the upstream error body may state the scope
 * outright (`error.scope`); that wins, because it is the provider's own account
 * of what went wrong. Otherwise the status code decides, and anything
 * unrecognised is treated as target-scoped — the narrow answer, which can only
 * cost a retry, never a needlessly disabled model.
 */
export function classifyFailure(status, error = null) {
  const explicit = error?.scope;
  if (explicit === FAILURE_SCOPE.KEY || explicit === FAILURE_SCOPE.PROVIDER || explicit === FAILURE_SCOPE.TARGET) {
    return explicit;
  }
  const code = Number(status);
  if (KEY_LEVEL_STATUS_CODES.has(code)) return FAILURE_SCOPE.KEY;
  if (MODEL_LEVEL_STATUS_CODES.has(code)) return FAILURE_SCOPE.TARGET;
  return FAILURE_SCOPE.TARGET;
}

const SIZE_LIMIT_COOLDOWN_MS = 5 * 60 * 1000;

// A 408 is a timeout (this router's own, or an upstream's). It says the call was
// slow right now, not that the provider is down, so cool the target down
// briefly instead of for the full 20 minutes. Otherwise one slow network
// moment puts every provider and model into cooldown at once.
const TIMEOUT_COOLDOWN_MS = 60 * 1000;

// A 400 from upstream puts that model on a fixed 8 minute cooldown, so the
// router stops sending it requests it keeps rejecting and falls through to the
// next target instead.
const BAD_REQUEST_COOLDOWN_MS = 8 * 60 * 1000;

/** `markFailure` options for a failed attempt: short cooldowns for transient statuses. */
function cooldownOptions(status) {
  if (status === 400) return { cooldownMs: BAD_REQUEST_COOLDOWN_MS };
  if (status === 413) return { cooldownMs: SIZE_LIMIT_COOLDOWN_MS };
  if (status === 408) return { cooldownMs: TIMEOUT_COOLDOWN_MS };
  return {};
}

export function isRetryableStatus(status, retryableStatus = DEFAULT_RETRY_STATUS_CODES) {
  return retryableStatus.has(Number(status));
}

/** Insertion-ordered, least-recently-used bounded session store. */
export class SessionStore {
  constructor({ maxEntries = DEFAULT_MAX_SESSIONS } = {}) {
    this.maxEntries = maxEntries;
    this.entries = new Map();
  }

  get size() {
    return this.entries.size;
  }

  get(key) {
    const existing = this.entries.get(key);
    if (existing === undefined) return null;
    // Re-insert so Map insertion order tracks recency.
    this.entries.delete(key);
    this.entries.set(key, existing);
    return existing;
  }

  set(key, value) {
    this.entries.delete(key);
    this.entries.set(key, value);

    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      this.entries.delete(oldest);
    }

    return value;
  }

  values() {
    return [...this.entries.values()];
  }
}

/** A remembered target stays preferred for 20 minutes after its last success. */
export const STICKY_TTL_MS = 20 * 60 * 1000;

/**
 * Per-session "remember last successful". Scoped by the caller's key (protocol
 * + pool + session id), so a text success can never become a vision preference
 * and the two pools' remembered targets stay independent.
 */
export class RouteSession {
  constructor({ targetId = null, expiresAt = null, ttlMs = STICKY_TTL_MS } = {}) {
    this.targetId = targetId;
    // Absolute deadline (ms epoch), checked at request time. No timer: nothing
    // keeps the process alive and an idle session costs nothing.
    this.expiresAt = Number.isFinite(expiresAt) ? expiresAt : null;
    this.ttlMs = Number.isFinite(ttlMs) && ttlMs > 0 ? ttlMs : STICKY_TTL_MS;
  }

  /**
   * The remembered target id, only while its TTL is active. An expired (or
   * never timestamped) target is cleared and reported as absent, so the request
   * walks the chain from its start and the stale target is never used again.
   */
  validTargetId(now = Date.now()) {
    if (!this.targetId) return null;
    if (this.expiresAt === null || !(now < this.expiresAt)) {
      this.clear();
      return null;
    }
    return this.targetId;
  }

  /** A success makes this target the remembered one and starts a fresh TTL. */
  saveSuccess(target, health, now = Date.now()) {
    this.targetId = health.key(target);
    this.expiresAt = now + this.ttlMs;
  }

  /** Forgets the remembered target. Used by Reset Fallback. */
  clear() {
    this.targetId = null;
    this.expiresAt = null;
  }
}

/**
 * Walks an explicit, already-ordered plan (see fallback-plan.js) sequentially.
 *
 * The order is authoritative: nothing is re-ranked. A model's eligible keys are
 * all tried, in key order, before the walk advances to the next model, and the
 * next model starts at its own first eligible key.
 *
 * Per request, a target (pool + provider + model + keyIndex) is invoked at most
 * once; a repeat is reported through `onSkip`, never called. Targets cooling
 * down in the shared health registry are skipped the same way. Every success is
 * recorded on the session as its remembered target when the selected mode
 * remembers one — the walker never edits the configured order, and the record
 * is per session, never global.
 */
export async function withFallback(
  targets,
  invoke,
  retryableStatus = DEFAULT_RETRY_STATUS_CODES,
  session = new RouteSession(),
  health = new HealthRegistry(),
  { plan: steps = null, onSkip = null, remember = true } = {}
) {
  const ordered = Array.isArray(steps) && steps.length > 0
    ? steps
    : (Array.isArray(targets) ? targets : []).map((target) => ({ target, phase: null }));

  if (ordered.length === 0) {
    const err = new Error("No fully configured routing targets available");
    err.status = 503;
    throw err;
  }

  const attempted = new Set();
  const cooldownReported = new Set();
  const failures = [];
  // Unique targets only: a target can appear in more than one phase, and a
  // sibling must be marked failed once, not once per appearance.
  const allTargets = [...new Map(ordered.map((step) => [health.key(step.target), step.target])).values()];
  let eligible = 0;

  const skip = (step, reason) => {
    if (typeof onSkip === "function") onSkip(step.target, { phase: step.phase, reason });
  };

  for (const step of ordered) {
    const target = step.target;
    const id = health.key(target);

    if (attempted.has(id)) {
      skip(step, "already_attempted");
      continue;
    }
    if (!health.isAvailable(target)) {
      // A cooling target is skipped here; it may appear again later in the
      // plan, which is the same skip, not a retry.
      if (!cooldownReported.has(id)) {
        cooldownReported.add(id);
        skip(step, "cooldown");
      }
      continue;
    }

    eligible += 1;
    attempted.add(id);
    const startedAt = Date.now();

    try {
      const result = await invoke(target, { phase: step.phase });
      health.markSuccess(target, { latencyMs: Date.now() - startedAt });
      if (remember) session.saveSuccess(target, health);
      return result;
    } catch (error) {
      const status = Number(error?.status || 0);
      failures.push({ target, status, message: error?.message || String(error) });

      if (!isRetryableStatus(status, retryableStatus) && !error?.retryable) throw error;

      // An error can opt out of health tracking entirely (skipCooldown). A
      // target that refused the request for its own reasons — an image it
      // cannot carry, say — is not unhealthy, so it is not cooled down.
      if (error?.skipCooldown) continue;

      health.markFailure(target, status, cooldownOptions(status));

      const scope = classifyFailure(status, error);
      if (scope === FAILURE_SCOPE.TARGET) continue;

      // Key- and account-level failures describe the credential, so the sibling
      // models sharing it are cooled down too and this request stops burning
      // time on requests that are guaranteed to fail. Model-level failures
      // deliberately do NOT do this.
      const reason = `${status} on ${target.model} applies to the whole ${scope === FAILURE_SCOPE.PROVIDER ? "provider" : "key"}`;
      for (const sibling of allTargets) {
        if (health.key(sibling) === id) continue;
        if ((sibling.pool ?? "text") !== (target.pool ?? "text")) continue;
        if (sibling.provider !== target.provider) continue;
        if (scope === FAILURE_SCOPE.KEY && sibling.keyIndex !== target.keyIndex) continue;
        health.markFailure(sibling, status, { reason });
      }
    }
  }

  if (eligible === 0) {
    const err = new Error("No routing targets are currently available");
    err.status = 503;
    err.failures = [];
    throw err;
  }

  // Every target answered 400: the request itself is almost certainly invalid,
  // so report that to the client instead of masking it as a 502 gateway error.
  const allBadRequest = failures.length > 0 && failures.every((failure) => failure.status === 400);
  const err = new Error(allBadRequest ? failures[failures.length - 1].message : "All routing targets failed");
  err.status = allBadRequest ? 400 : 502;
  err.failures = failures;
  throw err;
}
