import { HealthRegistry } from "./health.js";

const DEFAULT_RETRY_STATUS_CODES = new Set([401, 402, 403, 404, 408, 409, 425, 429, 500, 501, 502, 503, 504, 520, 521, 522, 523, 524, 529]);

// Sessions are keyed by a client-supplied header, so the store must be bounded:
// an unbounded map would grow without limit on a long-running gateway.
const DEFAULT_MAX_SESSIONS = 10000;

// These statuses describe the API key / account, not the model: once one
// model rejects a key, every other model on that provider + key will too.
const KEY_LEVEL_STATUS_CODES = new Set([401, 402, 403]);

// Some providers report an exhausted balance / missing resource package as a
// 429 (Z.ai answers business code 1113 that way), which is indistinguishable
// from a per-model rate limit by status alone. Only bodies that clearly say the
// account is out of balance count: a plain 429 stays a per-model failure.
const ACCOUNT_LEVEL_MESSAGE = /"code"\s*:\s*"?1113"?|insufficient\s+balance|no\s+resource\s+package|insufficient[_\s]quota|exceeded\s+your\s+current\s+quota/i;

/**
 * True when a failure describes the API key / account rather than one model:
 * every other model on the same provider + key will fail the same way.
 */
export function isKeyLevelFailure(status, message = "") {
  const code = Number(status);
  if (KEY_LEVEL_STATUS_CODES.has(code)) return true;
  return code === 429 && ACCOUNT_LEVEL_MESSAGE.test(String(message ?? ""));
}

const SIZE_LIMIT_COOLDOWN_MS = 60 * 1000;

/**
 * The client went away before its response was delivered. Distinguishable from
 * a provider failure so the walk stops without cooling a healthy target, and so
 * `server.js` can answer 499 instead of 502.
 */
export class ClientAbortError extends Error {
  constructor(message = "Client disconnected") {
    super(message);
    this.name = "ClientAbortError";
    this.status = 499;
    this.clientAborted = true;
  }
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
}

/** A sticky target stays preferred for 20 minutes after its last success. */
export const STICKY_TTL_MS = 20 * 60 * 1000;

export class RouteSession {
  constructor({ targetId = null, expiresAt = null, ttlMs = STICKY_TTL_MS } = {}) {
    this.targetId = targetId;
    // Absolute deadline (ms epoch), checked at request time. No timer: nothing
    // keeps the process alive and an idle session costs nothing.
    this.expiresAt = Number.isFinite(expiresAt) ? expiresAt : null;
    this.ttlMs = Number.isFinite(ttlMs) && ttlMs > 0 ? ttlMs : STICKY_TTL_MS;
  }

  /**
   * The sticky target id, only while its TTL is active. An expired (or never
   * timestamped) sticky is cleared and reported as absent, so the request
   * routes Priority -> Normal and the expired target is never used again.
   */
  validTargetId(now = Date.now(), { notBefore = 0 } = {}) {
    if (!this.targetId) return null;
    // `notBefore`: a sticky saved before the operator last changed the manual
    // order is dropped, so a removed or cleared model is not revived by it.
    const savedAt = this.expiresAt === null ? null : this.expiresAt - this.ttlMs;
    if (this.expiresAt === null || !(now < this.expiresAt) || (notBefore > 0 && savedAt < notBefore)) {
      this.targetId = null;
      this.expiresAt = null;
      return null;
    }
    return this.targetId;
  }

  current(targets, health) {
    if (!Array.isArray(targets) || targets.length === 0) {
      const err = new Error("No fully configured routing targets available");
      err.status = 503;
      throw err;
    }

    if (this.targetId) {
      const target = targets.find((item) => health.key(item) === this.targetId);
      if (target && health.isAvailable(target)) return target;
    }

    return health.rank(targets)[0];
  }

  /** A success makes this target sticky and starts a fresh TTL from `now`. */
  saveSuccess(target, health, now = Date.now()) {
    this.targetId = health.key(target);
    this.expiresAt = now + this.ttlMs;
  }
}

/**
 * Walks the candidate targets until one answers.
 *
 * `groups` — supplied by the caller as `fallbackGroups(selection)` — splits the
 * candidates into ordered tiers. Every target in a tier is exhausted, whether
 * by being tried or by being skipped while it cools down, before the next tier
 * is looked at. That is what keeps an available exact model match ahead of a
 * different-model fallback no matter what the health scores say, while ranking
 * and the session's sticky target still decide the order *within* a tier.
 *
 * Without `groups` the whole target list behaves as a single tier, which is
 * what the callers that have no notion of an exact match want.
 */
export async function withFallback(
  targets,
  invoke,
  retryableStatus = DEFAULT_RETRY_STATUS_CODES,
  session = new RouteSession(),
  health = new HealthRegistry(),
  { groups = null, plan: steps = null, onSkip = null, deferCommit = false, shouldStop = null } = {}
) {
  if (Array.isArray(steps)) {
    return walkPlan(steps, invoke, retryableStatus, session, health, onSkip, { deferCommit, shouldStop });
  }

  const plan = (Array.isArray(groups) && groups.length > 0 ? groups : [targets])
    .filter((group) => Array.isArray(group) && group.length > 0);

  if (plan.length === 0) {
    const err = new Error("No fully configured routing targets available");
    err.status = 503;
    throw err;
  }

  const failures = [];
  let available = 0;

  for (const group of plan) {
    const ranked = health.rank(group);
    if (ranked.length === 0) continue;
    available += ranked.length;

    // Try the session's sticky target first, then every other ranked target.
    // Scanning forward from the sticky target's rank would silently abandon
    // better-ranked healthy targets whenever the sticky target fails. A sticky
    // target outside this group is simply not found, so it cannot reach across
    // the tier boundary.
    const preferred = session.current(ranked, health);
    const preferredId = health.key(preferred);
    const order = [
      preferred,
      ...ranked.filter((target) => health.key(target) !== preferredId)
    ];

    for (const target of order) {
      if (!health.isAvailable(target)) continue;

      const startedAt = Date.now();

      try {
        const result = await invoke(target);
        health.markSuccess(target, { latencyMs: Date.now() - startedAt });
        session.saveSuccess(target, health);
        return result;
      } catch (error) {
        const status = Number(error?.status || 0);

        failures.push({
          target,
          status,
          errorType: error?.errorType ?? null,
          message: error?.message || String(error)
        });

        if (!isRetryableStatus(status, retryableStatus) && !error?.retryable) {
          throw error;
        }

        // A generic 400 says this provider rejected this particular request
        // (unsupported parameter, schema quirk, context window), not that the
        // provider is unhealthy. Try the next target, but leave this one's
        // health and cooldown alone so it keeps serving requests it accepts.
        if (error?.skipCooldown) continue;

        // A 413 depends on the size of this one request (per-minute token caps
        // reset quickly), so cool the target down briefly, not for 20 minutes.
        health.markFailure(target, status, status === 413 ? { cooldownMs: SIZE_LIMIT_COOLDOWN_MS } : {});

        // Quota/auth failures hit the whole key. Cool the sibling models on the
        // same provider + key down too, so this request (and the next ones)
        // skip them instead of burning time on a guaranteed failure or a hang.
        if (isKeyLevelFailure(status, error?.message)) {
          const reason = `${status} on ${target.model} applies to the whole key`;
          for (const sibling of plan.flat()) {
            if (sibling === target) continue;
            if (sibling.provider !== target.provider || sibling.keyIndex !== target.keyIndex) continue;
            if (health.key(sibling) === health.key(target)) continue;
            health.markFailure(sibling, status, { reason });
          }
        }
      }
    }
  }

  if (available === 0) {
    const err = new Error("No routing targets are currently available");
    err.status = 503;
    err.failures = [];
    throw err;
  }

  // Every target answered 400: the request itself is almost certainly invalid,
  // so report that to the client instead of masking it as a 502 gateway error.
  const allBadRequest = failures.length > 0 && failures.every((failure) => failure.status === 400);
  const err = new Error(allBadRequest
    ? failures[failures.length - 1].message
    : "All routing targets failed");
  err.status = allBadRequest ? 400 : 502;
  err.failures = failures;
  // When every target rejected the request the same way, keep the machine
  // readable reason (e.g. unsupported_image_source) instead of flattening it
  // into a generic upstream error.
  if (allBadRequest) {
    const types = new Set(failures.map((failure) => failure.errorType).filter(Boolean));
    if (types.size === 1) err.errorType = [...types][0];
  }
  throw err;
}

/**
 * Walks an explicit, already-ordered plan (see routing-plan.js) sequentially.
 *
 * The order is authoritative: nothing is re-ranked, so a key's models run in
 * configured order and the next key restarts at its own first model. Per
 * request, a target (pool + provider + model + keyIndex, i.e. the health id)
 * is invoked at most once; a repeat is reported through `onSkip`, never called.
 * Targets cooling down in the shared health registry are skipped the same way.
 * A priority entry is one provider/model group: ALL of its eligible keys are
 * attempted, in key order, before the walk advances to the next configured
 * entry. Priority is not remembered:
 * a failure only affects this request and whatever cooldown the health
 * registry itself decides on. Every success is recorded on the session as its
 * sticky target (provider + key + model, via the health id). The sticky target
 * leads the NEXT request of that same session as the plan's first phase; this
 * walker never reorders anything itself, and the record is per session, never
 * global.
 */
async function walkPlan(
  steps,
  invoke,
  retryableStatus,
  session,
  health,
  onSkip,
  { deferCommit = false, shouldStop = null } = {}
) {
  if (steps.length === 0) {
    const err = new Error("No fully configured routing targets available");
    err.status = 503;
    throw err;
  }

  const attempted = new Set();
  const cooldownReported = new Set();
  const failures = [];
  // Unique targets only: a priority target also appears in the normal phase,
  // and a sibling must be marked failed once, not once per appearance.
  const allTargets = [...new Map(steps.map((step) => [health.key(step.target), step.target])).values()];
  let eligible = 0;

  const skip = (step, reason) => {
    if (typeof onSkip === "function") onSkip(step.target, { phase: step.phase, reason });
  };

  const stopRequested = () => typeof shouldStop === "function" && shouldStop() === true;

  /** 401/402/403 (and balance-exhausted 429s) describe the key, not the model: cool its sibling models too. */
  const coolKeySiblings = (target, status) => {
    const reason = `${status} on ${target.model} applies to the whole key`;
    for (const sibling of allTargets) {
      if (sibling.provider !== target.provider || sibling.keyIndex !== target.keyIndex) continue;
      if ((sibling.pool ?? "text") !== (target.pool ?? "text")) continue;
      if (health.key(sibling) === health.key(target)) continue;
      health.markFailure(sibling, status, { reason });
    }
  };

  for (const step of steps) {
    const target = step.target;
    const id = health.key(target);

    // The client is gone: stop before invoking another target. Checked before
    // every step, so a disconnect during a fallback cannot spend more quota.
    if (stopRequested()) throw new ClientAbortError();

    if (attempted.has(id)) {
      skip(step, "already_attempted");
      continue;
    }
    if (!health.isAvailable(target)) {
      // A priority target in cooldown is skipped here; the normal phase will
      // meet it again and skip it for the same reason, which is not a retry.
      if (!cooldownReported.has(id)) {
        cooldownReported.add(id);
        skip(step, "cooldown");
      }
      continue;
    }

    eligible += 1;
    attempted.add(id);
    const startedAt = Date.now();

    let committed = false;
    /**
     * Finalise this step's health/sticky decision exactly once. With
     * `deferCommit` the caller owns the moment the outcome is actually known —
     * a 200 that only carried headers is NOT a success — and calls this once
     * the body has been delivered or has failed. A client abort is never
     * charged to the provider.
     *
     * `skipCooldown` mirrors the walk's own `error.skipCooldown` rule: a
     * translation-shape mismatch (e.g. a provider response whose tool arguments
     * the client's protocol cannot represent) is not provider ill health, so
     * the target is left untouched instead of being cooled.
     */
    const commit = (ok, { status = 200, reason = null, clientAborted = false, skipCooldown = false, message = "" } = {}) => {
      if (committed) return;
      committed = true;
      if (ok) {
        health.markSuccess(target, { latencyMs: Date.now() - startedAt, status });
        session.saveSuccess(target, health);
        return;
      }
      if (clientAborted) return;
      if (skipCooldown) return;
      const code = Number(status) || 0;
      health.markFailure(target, code, code === 413 ? { cooldownMs: SIZE_LIMIT_COOLDOWN_MS } : { reason });
      if (isKeyLevelFailure(code, message)) coolKeySiblings(target, code);
    };

    try {
      const result = await invoke(target, { phase: step.phase });
      if (deferCommit) return { value: result, target, phase: step.phase, commit };
      commit(true, { status: result?.upstream?.status ?? 200 });
      return result;
    } catch (error) {
      const status = Number(error?.status || 0);
      failures.push({ target, status, errorType: error?.errorType ?? null, message: error?.message || String(error) });

      if (!isRetryableStatus(status, retryableStatus) && !error?.retryable) throw error;
      if (error?.skipCooldown) continue;

      commit(false, { status, message: error?.message });
    }
  }

  if (eligible === 0) {
    const err = new Error("No routing targets are currently available");
    err.status = 503;
    err.failures = [];
    throw err;
  }

  const allBadRequest = failures.length > 0 && failures.every((failure) => failure.status === 400);
  const err = new Error(allBadRequest ? failures[failures.length - 1].message : "All routing targets failed");
  err.status = allBadRequest ? 400 : 502;
  err.failures = failures;
  if (allBadRequest) {
    const types = new Set(failures.map((failure) => failure.errorType).filter(Boolean));
    if (types.size === 1) err.errorType = [...types][0];
  }
  throw err;
}
