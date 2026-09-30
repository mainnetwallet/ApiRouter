const DEFAULT_COOLDOWN_MS = 15 * 60 * 1000;
const DEFAULT_HEALTH_CHECK_INTERVAL_MS = 15 * 60 * 1000;

const states = new Map();

export const targetId = (target) =>
  target.id || `${target.provider}:${target.model}:key-${target.keyIndex}`;

export function setHealth(id, status, extra = {}) {
  const previous = states.get(id) || {};
  states.set(id, {
    ...previous,
    id,
    status,
    updatedAt: new Date().toISOString(),
    ...extra
  });
}

export function getHealth(id) {
  return states.get(id) || { id, status: "unknown" };
}

export function getAllHealth() {
  return [...states.values()];
}

export function ensureTargetHealth(target) {
  const id = targetId(target);
  if (!states.has(id)) {
    setHealth(id, "unknown", {
      provider: target.provider,
      model: target.model,
      keyIndex: target.keyIndex,
      score: 50,
      cooldownUntil: 0,
      successes: 0,
      failures: 0,
      consecutiveFailures: 0,
      latencyMs: null,
      lastStatus: null
    });
  }
  return states.get(id);
}

export function isAvailable(target, now = Date.now()) {
  return ensureTargetHealth(target).cooldownUntil <= now;
}

export function markSuccess(target, { latencyMs = null } = {}) {
  const state = ensureTargetHealth(target);
  state.status = "healthy";
  state.score = Math.min(100, state.score * 0.75 + 25);
  state.cooldownUntil = 0;
  state.successes += 1;
  state.consecutiveFailures = 0;
  state.lastStatus = 200;
  state.latencyMs = Number.isFinite(latencyMs) ? latencyMs : state.latencyMs;
  state.updatedAt = new Date().toISOString();
  return state;
}

export function markFailure(target, status, { cooldownMs = DEFAULT_COOLDOWN_MS } = {}) {
  const state = ensureTargetHealth(target);
  state.status = "failed";
  state.score = Math.max(0, state.score * 0.7 - 10);
  state.cooldownUntil = Date.now() + cooldownMs;
  state.failures += 1;
  state.consecutiveFailures += 1;
  state.lastStatus = Number(status) || null;
  state.updatedAt = new Date().toISOString();
  return state;
}

export function recordHealthCheck(target, { ok, status = ok ? 200 : 503, latencyMs = null } = {}) {
  return ok
    ? markSuccess(target, { latencyMs })
    : markFailure(target, status);
}

export function rankTargets(targets, now = Date.now()) {
  return [...targets]
    .filter((target) => isAvailable(target, now))
    .sort((a, b) => {
      const aState = ensureTargetHealth(a);
      const bState = ensureTargetHealth(b);
      return (bState.score - aState.score)
        || String(a.provider).localeCompare(String(b.provider))
        || String(a.model).localeCompare(String(b.model))
        || Number(a.keyIndex) - Number(b.keyIndex);
    });
}

// Run one health check for every configured provider/model/key target.
// check(target) must return { ok, status?, latencyMs? }.
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
      results.push({ target, state, error: error?.message || String(error) });
    }
  }
  return results;
}

// Start the automatic 15-minute health refresh cycle.
// The caller supplies the protocol-aware provider health check because
// providers do not share one request protocol.
export function startHealthMonitor(targets, check, intervalMs = DEFAULT_HEALTH_CHECK_INTERVAL_MS) {
  const run = () => refreshAllHealth(targets, check).catch(() => []);
  void run();
  const timer = setInterval(run, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
