const DEFAULT_COOLDOWN_MS = 20 * 60 * 1000;
const DEFAULT_HEALTH_CHECK_INTERVAL_MS = 15 * 60 * 1000;

// Health probes run in parallel, but never unbounded: a large target list must
// not turn one refresh cycle into a burst of outbound connections.
const DEFAULT_REFRESH_CONCURRENCY = 4;

/**
 * Externally visible health states.
 *
 * `status` records the outcome of the last accepted observation, while
 * `cooldown` is derived from `cooldownUntil` at read time.
 */
export const HEALTH_STATES = Object.freeze({
  UNKNOWN: "unknown",
  HEALTHY: "healthy",
  FAILED: "failed",
  COOLDOWN: "cooldown"
});

export const targetId = (target) =>
  target.id || `${target.provider}:${target.model}:key-${target.keyIndex}`;

/**
 * Time-aware state: a failed target that is still cooling down reads as
 * `cooldown`. Routing never consults this — it uses `isAvailable` — so this
 * only affects reporting.
 */
export function healthState(state, now = Date.now()) {
  if (!state) return HEALTH_STATES.UNKNOWN;
  if (Number(state.cooldownUntil) > now) return HEALTH_STATES.COOLDOWN;
  return state.status || HEALTH_STATES.UNKNOWN;
}

export class HealthRegistry {
  constructor({ cooldownMs = DEFAULT_COOLDOWN_MS } = {}) {
    this.cooldownMs = cooldownMs;
    this.states = new Map();
  }

  key(target) {
    return targetId(target);
  }

  ensureTarget(target) {
    const id = this.key(target);
    if (!this.states.has(id)) {
      this.states.set(id, {
        id,
        provider: target.provider,
        model: target.model,
        keyIndex: target.keyIndex,
        pool: target.pool ?? "text",
        status: HEALTH_STATES.UNKNOWN,
        score: 50,
        cooldownUntil: 0,
        successes: 0,
        failures: 0,
        consecutiveFailures: 0,
        latencyMs: null,
        lastStatus: null,
        lastReason: null,
        // Timestamp of the newest accepted observation. Starts at 0 so the
        // first observation is always accepted, whatever its timestamp.
        observedAt: 0,
        updatedAt: new Date().toISOString()
      });
    }
    return this.states.get(id);
  }

  get(id) {
    return this.states.get(id) || { id, status: HEALTH_STATES.UNKNOWN };
  }

  /**
   * Reporting view for a concrete target list. Built as an explicit allow-list
   * so credentials or upstream bodies can never reach `/health`, even if the
   * internal state grows new fields later.
   *
   * `pool` is included because the two pools are independent: a reader has to
   * be able to tell a text target from a vision target, or a provider's text
   * health and its vision health cannot be reported apart.
   */
  describe(targets, now = Date.now()) {
    return (Array.isArray(targets) ? targets : []).map((target) => {
      const state = this.ensureTarget(target);
      return {
        id: state.id,
        provider: state.provider,
        model: state.model,
        keyIndex: state.keyIndex,
        pool: state.pool,
        protocols: Array.isArray(target.protocols) ? [...target.protocols] : [],
        status: healthState(state, now),
        score: state.score,
        cooldownUntil: state.cooldownUntil,
        successes: state.successes,
        failures: state.failures,
        consecutiveFailures: state.consecutiveFailures,
        latencyMs: state.latencyMs,
        lastStatus: state.lastStatus,
        lastReason: state.lastReason,
        updatedAt: state.updatedAt
      };
    });
  }

  /**
   * Accept an observation only if it is at least as new as the newest one
   * already applied. This is what stops a slow health probe that started
   * before a routing failure from overwriting that failure — and from
   * clearing the cooldown it established.
   */
  acceptObservation(state, observedAt) {
    if (!Number.isFinite(observedAt)) return true;
    if (observedAt < state.observedAt) return false;
    state.observedAt = observedAt;
    return true;
  }

  isAvailable(target, now = Date.now()) {
    return this.ensureTarget(target).cooldownUntil <= now;
  }

  markSuccess(
    target,
    { latencyMs = null, status = 200, reason = null } = {},
    now = Date.now()
  ) {
    const state = this.ensureTarget(target);
    if (!this.acceptObservation(state, now)) return state;

    state.status = HEALTH_STATES.HEALTHY;
    state.score = Math.min(100, state.score * 0.75 + 25);
    state.cooldownUntil = 0;
    state.successes += 1;
    state.consecutiveFailures = 0;
    // Record the status actually observed; a 2xx success defaults to 200.
    state.lastStatus = Number.isInteger(status) ? status : 200;
    state.lastReason = reason;
    state.latencyMs = Number.isFinite(latencyMs) ? latencyMs : state.latencyMs;
    state.updatedAt = new Date(now).toISOString();
    return state;
  }

  markFailure(
    target,
    status,
    { cooldownMs = this.cooldownMs, reason = null } = {},
    now = Date.now()
  ) {
    const state = this.ensureTarget(target);
    if (!this.acceptObservation(state, now)) return state;

    state.status = HEALTH_STATES.FAILED;
    state.score = Math.max(0, state.score * 0.7 - 10);
    state.cooldownUntil = now + cooldownMs;
    state.failures += 1;
    state.consecutiveFailures += 1;
    state.lastStatus = Number(status) || null;
    state.lastReason = reason;
    state.updatedAt = new Date(now).toISOString();
    return state;
  }

  /**
   * Apply a normalized health-probe result.
   *
   * `ok: null` (or absent) is a passive observation: the probe could not
   * determine health, so the previous state is preserved untouched.
   */
  recordHealthCheck(
    target,
    { ok = null, status = null, latencyMs = null, reason = null } = {},
    now = Date.now()
  ) {
    if (ok === true) {
      // A probe talks to a metadata endpoint, not to the chat endpoint that
      // failed. Its success proves reachability, not that the failure which put
      // this target in cooldown is gone, so it must not cut that cooldown short:
      // only the cooldown timer, or a real request that succeeds, revives it.
      const current = this.ensureTarget(target);
      if (current.cooldownUntil > now) return current;
      return this.markSuccess(
        target,
        { latencyMs, status: Number.isInteger(status) ? status : 200, reason },
        now
      );
    }

    if (ok === false) {
      return this.markFailure(
        target,
        Number.isInteger(status) ? status : 503,
        { reason },
        now
      );
    }

    const state = this.ensureTarget(target);
    // Keep the operator-visible reason current without touching health.
    if (!Number.isFinite(now) || now >= state.observedAt) {
      state.lastReason = reason ?? state.lastReason;
    }
    return state;
  }

  rank(targets, now = Date.now()) {
    // Sorted by score alone. The sort is stable, so targets with equal scores
    // keep the order the caller passed in, and callers order their candidates
    // deliberately: the bridges put an exact model match ahead of fallbacks.
    // Re-sorting ties by provider/model name would silently discard that
    // preference and route a request to a model the client did not ask for.
    // Input order is itself deterministic (configuration order), so ranking
    // stays reproducible.
    return [...targets]
      .filter((target) => this.isAvailable(target, now))
      .sort((a, b) => this.ensureTarget(b).score - this.ensureTarget(a).score);
  }
}

export const healthRegistry = new HealthRegistry();

export function describeHealth(targets, now = Date.now()) {
  return healthRegistry.describe(targets, now);
}

export function isAvailable(target, now = Date.now()) {
  return healthRegistry.isAvailable(target, now);
}

export function markSuccess(target, options = {}, now = Date.now()) {
  return healthRegistry.markSuccess(target, options, now);
}

export function markFailure(target, status, options = {}, now = Date.now()) {
  return healthRegistry.markFailure(target, status, options, now);
}

export function recordHealthCheck(target, result = {}, now = Date.now()) {
  return healthRegistry.recordHealthCheck(target, result, now);
}

export function rankTargets(targets, now = Date.now()) {
  return healthRegistry.rank(targets, now);
}

async function refreshTarget(target, check) {
  // Timestamp the observation before the probe runs. A routing failure that
  // lands while the probe is in flight is therefore newer, and wins.
  const observedAt = Date.now();

  try {
    const result = await check(target);
    const latencyMs = Number.isFinite(result?.latencyMs)
      ? result.latencyMs
      : Date.now() - observedAt;

    const state = recordHealthCheck(target, {
      ok: result?.ok ?? null,
      status: result?.status ?? null,
      reason: result?.reason ?? null,
      latencyMs
    }, observedAt);

    return { target, state, reason: result?.reason ?? null };
  } catch (error) {
    // A probe that throws is an unavailable provider, not a crash.
    const status = Number(error?.status || 503);
    const state = markFailure(target, status, {}, observedAt);
    return {
      target,
      state,
      error: error?.message || String(error)
    };
  }
}

/**
 * Refresh every target, with bounded concurrency so one slow provider delays
 * only its own slot instead of the whole cycle. Result order matches `targets`.
 */
export async function refreshAllHealth(
  targets,
  check,
  { concurrency = DEFAULT_REFRESH_CONCURRENCY } = {}
) {
  if (!Array.isArray(targets) || typeof check !== "function") {
    throw new TypeError("refreshAllHealth requires targets[] and check(target)");
  }

  const results = new Array(targets.length);
  let cursor = 0;

  const worker = async () => {
    while (cursor < targets.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await refreshTarget(targets[index], check);
    }
  };

  const workers = Math.max(1, Math.min(concurrency, targets.length));
  await Promise.all(Array.from({ length: workers }, () => worker()));

  return results;
}

/**
 * Start the periodic refresh. Runs once immediately, then on an interval.
 * Cycles never overlap and are stopped by the returned function.
 */
export function startHealthMonitor(
  targets,
  check,
  intervalMs = DEFAULT_HEALTH_CHECK_INTERVAL_MS
) {
  let running = false;

  const run = async () => {
    if (running) return;
    running = true;
    try {
      await refreshAllHealth(targets, check);
    } catch {
      // A failed cycle must never take the server down.
    } finally {
      running = false;
    }
  };

  void run();
  const timer = setInterval(run, intervalMs);
  timer.unref?.();

  return () => clearInterval(timer);
}
