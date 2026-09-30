const DEFAULT_RETRY_STATUS_CODES = new Set([402, 408, 429, 500, 502, 503, 504]);
const DEFAULT_COOLDOWN_MS = 15 * 60 * 1000;

export function isRetryableStatus(status, retryableStatus = DEFAULT_RETRY_STATUS_CODES) {
  return retryableStatus.has(Number(status));
}

export class HealthRegistry {
  constructor({ cooldownMs = DEFAULT_COOLDOWN_MS } = {}) {
    this.cooldownMs = cooldownMs;
    this.states = new Map();
  }

  key(target) {
    return target.id || `${target.provider}:${target.model}:key-${target.keyIndex}`;
  }

  ensure(target) {
    const id = this.key(target);
    if (!this.states.has(id)) {
      this.states.set(id, {
        id,
        provider: target.provider,
        model: target.model,
        keyIndex: target.keyIndex,
        status: "unknown",
        score: 50,
        successes: 0,
        failures: 0,
        consecutiveFailures: 0,
        latencyMs: null,
        cooldownUntil: 0,
        updatedAt: 0,
        lastStatus: null
      });
    }
    return this.states.get(id);
  }

  isAvailable(target, now = Date.now()) {
    return this.ensure(target).cooldownUntil <= now;
  }

  score(target, now = Date.now()) {
    const state = this.ensure(target);
    return state.cooldownUntil > now ? -Infinity : state.score;
  }

  recordSuccess(target, latencyMs = null, now = Date.now()) {
    const state = this.ensure(target);
    state.successes += 1;
    state.consecutiveFailures = 0;
    state.score = Math.min(100, state.score * 0.75 + 25);
    state.latencyMs = Number.isFinite(latencyMs) ? latencyMs : state.latencyMs;
    state.status = "healthy";
    state.cooldownUntil = 0;
    state.updatedAt = now;
    state.lastStatus = 200;
    return state;
  }

  recordFailure(target, status, now = Date.now()) {
    const state = this.ensure(target);
    state.failures += 1;
    state.consecutiveFailures += 1;
    state.score = Math.max(0, state.score * 0.7 - 10);
    state.status = "failed";
    state.cooldownUntil = now + this.cooldownMs;
    state.updatedAt = now;
    state.lastStatus = Number(status) || null;
    return state;
  }

  recordHealth(target, { ok, status = ok ? 200 : 503, latencyMs = null } = {}, now = Date.now()) {
    return ok
      ? this.recordSuccess(target, latencyMs, now)
      : this.recordFailure(target, status, now);
  }

  rank(targets, now = Date.now()) {
    return [...targets]
      .filter((target) => this.isAvailable(target, now))
      .sort((a, b) => {
        const scoreDiff = this.score(b, now) - this.score(a, now);
        if (scoreDiff !== 0) return scoreDiff;
        return String(a.provider).localeCompare(String(b.provider))
          || String(a.model).localeCompare(String(b.model))
          || Number(a.keyIndex) - Number(b.keyIndex);
      });
  }

  getAll() {
    return [...this.states.values()].map((state) => ({ ...state }));
  }
}

export class RouteSession {
  constructor({ targetId = null } = {}) {
    this.targetId = targetId;
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

  saveSuccess(target, health) {
    this.targetId = health.key(target);
  }
}

export async function withFallback(
  targets,
  invoke,
  retryableStatus = DEFAULT_RETRY_STATUS_CODES,
  session = new RouteSession(),
  health = new HealthRegistry()
) {
  if (!Array.isArray(targets) || targets.length === 0) {
    const err = new Error("No fully configured routing targets available");
    err.status = 503;
    throw err;
  }

  const failures = [];
  const ranked = health.rank(targets);

  if (ranked.length === 0) {
    const err = new Error("No routing targets are currently available");
    err.status = 503;
    err.failures = [];
    throw err;
  }

  const preferred = session.current(ranked, health);
  const preferredId = health.key(preferred);
  const start = Math.max(0, ranked.findIndex((target) => health.key(target) === preferredId));

  for (let index = start; index < ranked.length; index += 1) {
    const target = ranked[index];
    if (!health.isAvailable(target)) continue;

    const startedAt = Date.now();

    try {
      const result = await invoke(target);
      health.recordSuccess(target, Date.now() - startedAt);
      session.saveSuccess(target, health);
      return result;
    } catch (error) {
      const status = Number(error?.status || 0);

      failures.push({
        target,
        status,
        message: error?.message || String(error)
      });

      if (!isRetryableStatus(status, retryableStatus) && !error?.retryable) {
        throw error;
      }

      // A retryable failure removes this exact provider/model/key target
      // from routing for the next 15 minutes.
      health.recordFailure(target, status);
    }
  }

  const err = new Error("All routing targets failed");
  err.status = 502;
  err.failures = failures;
  throw err;
}
