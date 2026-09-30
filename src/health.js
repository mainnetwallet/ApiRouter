const DEFAULT_COOLDOWN_MS = 15 * 60 * 1000;
const DEFAULT_HEALTH_CHECK_INTERVAL_MS = 15 * 60 * 1000;

export const targetId = (target) =>
  target.id || `${target.provider}:${target.model}:key-${target.keyIndex}`;

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
        status: "unknown",
        score: 50,
        cooldownUntil: 0,
        successes: 0,
        failures: 0,
        consecutiveFailures: 0,
        latencyMs: null,
        lastStatus: null,
        updatedAt: new Date().toISOString()
      });
    }
    return this.states.get(id);
  }

  get(id) {
    return this.states.get(id) || { id, status: "unknown" };
  }

  all() {
    return [...this.states.values()].map((state) => ({ ...state }));
  }

  isAvailable(target, now = Date.now()) {
    return this.ensureTarget(target).cooldownUntil <= now;
  }

  markSuccess(target, { latencyMs = null } = {}, now = Date.now()) {
    const state = this.ensureTarget(target);
    state.status = "healthy";
    state.score = Math.min(100, state.score * 0.75 + 25);
    state.cooldownUntil = 0;
    state.successes += 1;
    state.consecutiveFailures = 0;
    state.lastStatus = 200;
    state.latencyMs = Number.isFinite(latencyMs) ? latencyMs : state.latencyMs;
    state.updatedAt = new Date(now).toISOString();
    return state;
  }

  markFailure(target, status, { cooldownMs = this.cooldownMs } = {}, now = Date.now()) {
    const state = this.ensureTarget(target);
    state.status = "failed";
    state.score = Math.max(0, state.score * 0.7 - 10);
    state.cooldownUntil = now + cooldownMs;
    state.failures += 1;
    state.consecutiveFailures += 1;
    state.lastStatus = Number(status) || null;
    state.updatedAt = new Date(now).toISOString();
    return state;
  }

  recordHealthCheck(target, { ok, status = ok ? 200 : 503, latencyMs = null } = {}, now = Date.now()) {
    return ok
      ? this.markSuccess(target, { latencyMs }, now)
      : this.markFailure(target, status, {}, now);
  }

  rank(targets, now = Date.now()) {
    return [...targets]
      .filter((target) => this.isAvailable(target, now))
      .sort((a, b) => {
        const aState = this.ensureTarget(a);
        const bState = this.ensureTarget(b);
        return (bState.score - aState.score)
          || String(a.provider).localeCompare(String(b.provider))
          || String(a.model).localeCompare(String(b.model))
          || Number(a.keyIndex) - Number(b.keyIndex);
      });
  }
}

export const healthRegistry = new HealthRegistry();

export function getAllHealth() {
  return healthRegistry.all();
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

export async function refreshAllHealth(targets, check) {
  if (!Array.isArray(targets) || typeof check !== "function") {
    throw new TypeError("refreshAllHealth requires targets[] and check(target)");
  }

  const results = [];

  for (const target of targets) {
    const startedAt = Date.now();

    try {
      const result = await check(target);
      const state = recordHealthCheck(target, {
        ...result,
        latencyMs: result?.latencyMs ?? Date.now() - startedAt
      });
      results.push({ target, state });
    } catch (error) {
      const status = Number(error?.status || 503);
      const state = markFailure(target, status);
      results.push({
        target,
        state,
        error: error?.message || String(error)
      });
    }
  }

  return results;
}

export function startHealthMonitor(
  targets,
  check,
  intervalMs = DEFAULT_HEALTH_CHECK_INTERVAL_MS
) {
  const run = () => refreshAllHealth(targets, check).catch(() => []);
  void run();
  const timer = setInterval(run, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
