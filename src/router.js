import { HealthRegistry } from "./health.js";

const DEFAULT_RETRY_STATUS_CODES = new Set([402, 408, 429, 500, 502, 503, 504]);

export function isRetryableStatus(status, retryableStatus = DEFAULT_RETRY_STATUS_CODES) {
  return retryableStatus.has(Number(status));
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
  const start = Math.max(
    0,
    ranked.findIndex((target) => health.key(target) === preferredId)
  );

  for (let index = start; index < ranked.length; index += 1) {
    const target = ranked[index];
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
        message: error?.message || String(error)
      });

      if (!isRetryableStatus(status, retryableStatus) && !error?.retryable) {
        throw error;
      }

      health.markFailure(target, status);
    }
  }

  const err = new Error("All routing targets failed");
  err.status = 502;
  err.failures = failures;
  throw err;
}
