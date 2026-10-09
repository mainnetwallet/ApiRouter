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

// Wording that says the shared credential or account itself is the problem. It
// is checked first, so a message that mentions both an account problem and a
// model/pool never gets narrowed to one target.
const SHARED_CREDENTIAL_MESSAGE = /\b(invalid|incorrect|expired|revoked|missing|disabled|suspended|banned|deactivated)\b[^.\n]{0,40}\b(api[ _-]?key|token|credential|account)\b|\b(api[ _-]?key|token|credential|account)\b[^.\n]{0,40}\b(invalid|incorrect|expired|revoked|disabled|suspended|banned|deactivated)\b|\binsufficient\b[^.\n]{0,30}\b(balance|credits?|funds)\b|\b(account|credit) balance\b|\bbilling\b/i;

// Wording that says the limit belongs to one budget pool or one model rather
// than to the whole key: a pool is selected per model, so another model on the
// same key can still be served from a different pool.
const TARGET_SCOPED_MESSAGE = [
  [/\bbudget pools?\b/i, "budget pool exhausted"],
  [/\b(do(?:es)? not|don't|doesn't|no) (?:have )?(?:access|permission)[^.\n]{0,30}\bmodel\b/i, "no access to this model"],
  [/\bmodel\b[^.\n]{0,60}\b(?:not (?:allowed|available|enabled|permitted|authori[sz]ed)|restricted|forbidden)\b/i, "model not permitted"],
  [/\b(?:quota|limit|budget)\b[^.\n]{0,40}\b(?:for|on) (?:the |this |requested )*model\b/i, "model quota exhausted"]
];

// Only these statuses are ever narrowed by message. 401 is always the
// credential, whatever the text says.
const MESSAGE_NARROWABLE_STATUS_CODES = new Set([402, 403]);

/**
 * Classifies a failed attempt and says why, from the metadata available.
 *
 * Returns `{ scope, kind }`; `kind` is a short fixed label (never upstream text,
 * which can carry anything and must not reach `/health`) set only when the
 * message was positive evidence that narrowed a key-level status to one target.
 */
export function describeFailure(status, error = null) {
  const explicit = error?.scope;
  if (explicit === FAILURE_SCOPE.KEY || explicit === FAILURE_SCOPE.PROVIDER || explicit === FAILURE_SCOPE.TARGET) {
    return { scope: explicit, kind: null };
  }
  const code = Number(status);
  if (KEY_LEVEL_STATUS_CODES.has(code)) {
    if (MESSAGE_NARROWABLE_STATUS_CODES.has(code) && typeof error?.message === "string") {
      const text = error.message;
      if (!SHARED_CREDENTIAL_MESSAGE.test(text)) {
        for (const [pattern, kind] of TARGET_SCOPED_MESSAGE) {
          if (pattern.test(text)) return { scope: FAILURE_SCOPE.TARGET, kind };
        }
      }
    }
    return { scope: FAILURE_SCOPE.KEY, kind: null };
  }
  return { scope: FAILURE_SCOPE.TARGET, kind: null };
}

/**
 * Classifies a failed attempt from the metadata actually available.
 *
 * A provider adapter that can read the upstream error body may state the scope
 * outright (`error.scope`); that wins, because it is the provider's own account
 * of what went wrong. Otherwise the status code decides — except that a 402/403
 * whose message shows the limit is a budget pool's or a model's, not the key's,
 * is target-scoped. Anything unrecognised is treated as target-scoped — the
 * narrow answer, which can only cost a retry, never a needlessly disabled model
 * — except the credential statuses (401/402/403), which stay key-level unless
 * the message positively says otherwise.
 */
export function classifyFailure(status, error = null) {
  return describeFailure(status, error).scope;
}

/**
 * A failure that says "not right now" rather than "not this request / not this
 * credential": a timeout, rate limit, server error, or a call that never got an
 * HTTP answer at all. Only these are worth a second look in a later manual
 * cycle. Everything else (400/404/413/422 about the request or model, 401/402/403
 * about the credential) would simply fail the same way again.
 */
function isTransientStatus(status) {
  const code = Number(status) || 0;
  return code === 0 || code === 408 || code === 425 || code === 429 || code >= 500;
}

const SIZE_LIMIT_COOLDOWN_MS = 5 * 60 * 1000;

// A 408 is a timeout (this router's own, or an upstream's). It says the call was
// slow right now, not that the provider is down, so cool the target down
// briefly instead of for the full 12 minute default. Otherwise one slow network
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
 * down in the shared health registry are skipped the same way.
 *
 * The one exception is a step flagged `retry`: every step of the second and
 * later Manual -> Health cycles of Manual Model Selection (see fallback-plan.js).
 * It is a bounded repeat visit to a target, with these rules:
 *
 *   - a target is invoked at most `maxTargetAttempts` times in one request (the
 *     plan lists it once per cycle, so this is the number of cycles);
 *   - a target already cooling down when this request reached it is NEVER
 *     retried: that cooldown is a real health verdict, and a repeat does not
 *     override it;
 *   - a target whose failure in this request was credential-level or
 *     non-transient (401/402/403, 400, 404, 413, 422 ..., or an error that opted
 *     out of health tracking), and every sibling that failure cooled, is NEVER
 *     retried — whatever its cooldown says by then;
 *   - the one cooldown a repeat looks past is the one THIS request put on a
 *     target through a transient, target-scoped failure (timeout, 429, 5xx,
 *     transport error), and only while nobody else has refreshed it since.
 *     Without this every target that failed in an earlier cycle would be sitting
 *     in the cooldown that failure just created, and a later cycle could never
 *     retry anything. A retry success clears the cooldown; a retry failure
 *     starts a fresh one, which a still-later cycle may look past again;
 *   - a cycle in which not one target could be invoked ends the walk: the next
 *     cycle would be eligible for exactly the same nothing.
 *
 * `maxAttempts` is the request's total budget of real upstream invocations. When
 * it is spent the walk stops and the ordinary "All routing targets failed" error
 * is returned (flagged `attemptBudgetExhausted`). Skips never count against it.
 * Both limits are optional: without them only the plan's own finite length
 * bounds the walk, which is what every non-manual mode relies on.
 *
 * Every success is recorded on the session as its remembered target when the
 * selected mode remembers one — the walker never edits the configured order, and
 * the record is per session, never global.
 */
export async function withFallback(
  targets,
  invoke,
  retryableStatus = DEFAULT_RETRY_STATUS_CODES,
  session = new RouteSession(),
  health = new HealthRegistry(),
  { plan: steps = null, onSkip = null, remember = true, maxAttempts = null, maxTargetAttempts = null } = {}
) {
  const ordered = Array.isArray(steps) && steps.length > 0
    ? steps
    : (Array.isArray(targets) ? targets : []).map((target) => ({ target, phase: null }));

  if (ordered.length === 0) {
    const err = new Error("No fully configured routing targets available");
    err.status = 503;
    throw err;
  }

  const attemptBudget = Number.isInteger(maxAttempts) && maxAttempts > 0 ? maxAttempts : Infinity;
  const perTargetLimit = Number.isInteger(maxTargetAttempts) && maxTargetAttempts > 0 ? maxTargetAttempts : Infinity;

  // target id -> how many times THIS request has invoked it.
  const invocations = new Map();
  // Targets that must never be repeated in this request: their failure was not
  // a transient, target-scoped one (see the `retry` rules above).
  const noRetry = new Set();
  // target id -> the cooldownUntil THIS request set through a transient failure.
  const ownTransientCooldown = new Map();
  const reported = new Set();
  const invokedInCycle = new Map();
  const failures = [];
  // Unique targets only: a target can appear in more than one phase, and a
  // sibling must be marked failed once, not once per appearance.
  const allTargets = [...new Map(ordered.map((step) => [health.key(step.target), step.target])).values()];
  let eligible = 0;
  let budgetExhausted = false;
  let currentCycle = null;

  const cycleOf = (step) => (Number.isInteger(step.cycle) && step.cycle > 0 ? step.cycle : null);
  const skip = (step, reason) => {
    // A cooling or refused target is reported once per request, not once per
    // cycle: the repeat would be the same skip, and a long walk should not bury
    // the timeline in copies of it.
    const key = `${health.key(step.target)}|${reason}`;
    if (reported.has(key)) return;
    reported.add(key);
    if (typeof onSkip === "function") onSkip(step.target, { phase: step.phase, cycle: cycleOf(step), reason });
  };

  for (const step of ordered) {
    const target = step.target;
    const id = health.key(target);
    const cycle = cycleOf(step);

    // Entering a new cycle: if the one that just ended could not invoke anything,
    // the next would not either (same targets, same cooldowns), so stop here.
    if (cycle !== null && cycle !== currentCycle) {
      if (currentCycle !== null && (invokedInCycle.get(currentCycle) ?? 0) === 0) break;
      currentCycle = cycle;
    }

    const isRetry = step.retry === true;
    const used = invocations.get(id) ?? 0;
    if (!isRetry && used > 0) {
      skip(step, "already_attempted");
      continue;
    }
    if (isRetry) {
      if (noRetry.has(id)) {
        skip(step, "not_retryable");
        continue;
      }
      if (used >= perTargetLimit) {
        skip(step, "retry_limit");
        continue;
      }
    }
    // The cooldown this request itself created by a transient failure does not
    // block a repeat, as long as it is still exactly that cooldown.
    const ownCooldown = isRetry
      && ownTransientCooldown.has(id)
      && Number(health.get(id)?.cooldownUntil) === ownTransientCooldown.get(id);
    if (!ownCooldown && !health.isAvailable(target)) {
      skip(step, "cooldown");
      continue;
    }

    if (eligible >= attemptBudget) {
      budgetExhausted = true;
      break;
    }

    eligible += 1;
    invocations.set(id, used + 1);
    if (cycle !== null) invokedInCycle.set(cycle, (invokedInCycle.get(cycle) ?? 0) + 1);
    ownTransientCooldown.delete(id);
    const startedAt = Date.now();

    try {
      const result = await invoke(target, { phase: step.phase, cycle });
      health.markSuccess(target, { latencyMs: Date.now() - startedAt });
      if (remember) session.saveSuccess(target, health);
      return result;
    } catch (error) {
      const status = Number(error?.status || 0);
      failures.push({ target, status, message: error?.message || String(error) });

      if (!isRetryableStatus(status, retryableStatus) && !error?.retryable) throw error;

      // An error can opt out of health tracking entirely (skipCooldown). A
      // target that refused the request for its own reasons — an image it
      // cannot carry, say — is not unhealthy, so it is not cooled down, and it
      // is not a transient failure either: repeating it would only be refused
      // again.
      if (error?.skipCooldown) {
        noRetry.add(id);
        continue;
      }

      const { scope, kind } = describeFailure(status, error);
      // A failure narrowed to this target by its message carries a fixed,
      // non-upstream reason so the Models page can say why it is cooling down.
      health.markFailure(target, status, {
        ...cooldownOptions(status),
        ...(kind ? { reason: `${status} ${kind} on ${target.model}` } : {})
      });
      if (scope === FAILURE_SCOPE.TARGET) {
        if (isTransientStatus(status)) {
          ownTransientCooldown.set(id, Number(health.get(id)?.cooldownUntil) || 0);
        } else {
          noRetry.add(id);
        }
        continue;
      }

      // Key- and account-level failures describe the credential, so the sibling
      // models sharing it are cooled down too and this request stops burning
      // time on requests that are guaranteed to fail. Model-level failures
      // deliberately do NOT do this. None of them is ever repeated.
      noRetry.add(id);
      const reason = `${status} on ${target.model} applies to the whole ${scope === FAILURE_SCOPE.PROVIDER ? "provider" : "key"}`;
      for (const sibling of allTargets) {
        if (health.key(sibling) === id) continue;
        if ((sibling.pool ?? "text") !== (target.pool ?? "text")) continue;
        if (sibling.provider !== target.provider) continue;
        if (scope === FAILURE_SCOPE.KEY && sibling.keyIndex !== target.keyIndex) continue;
        health.markFailure(sibling, status, { reason });
        noRetry.add(health.key(sibling));
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
  if (budgetExhausted) err.attemptBudgetExhausted = true;
  throw err;
}
