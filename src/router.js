import { HealthRegistry } from "./health.js";

const DEFAULT_RETRY_STATUS_CODES = new Set([402, 408, 429, 500, 502, 503, 504]);

// Sessions are keyed by a client-supplied header, so the store must be bounded:
// an unbounded map would grow without limit on a long-running gateway.
const DEFAULT_MAX_SESSIONS = 10000;

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

  // Try the session's sticky target first, then every other ranked target.
  // Scanning forward from the sticky target's rank would silently abandon
  // better-ranked healthy targets whenever the sticky target fails.
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
