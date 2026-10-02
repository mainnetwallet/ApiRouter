import { HealthRegistry } from "./health.js";

const DEFAULT_RETRY_STATUS_CODES = new Set([401, 402, 403, 404, 408, 409, 425, 429, 500, 501, 502, 503, 504, 520, 521, 522, 523, 524, 529]);

// Sessions are keyed by a client-supplied header, so the store must be bounded:
// an unbounded map would grow without limit on a long-running gateway.
const DEFAULT_MAX_SESSIONS = 10000;

// These statuses describe the API key / account, not the model: once one
// model rejects a key, every other model on that provider + key will too.
const KEY_LEVEL_STATUS_CODES = new Set([401, 402, 403]);

const SIZE_LIMIT_COOLDOWN_MS = 60 * 1000;

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
  { groups = null } = {}
) {
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
        // reset quickly), so cool the target down briefly, not for 15 minutes.
        health.markFailure(target, status, status === 413 ? { cooldownMs: SIZE_LIMIT_COOLDOWN_MS } : {});

        // Quota/auth failures hit the whole key. Cool the sibling models on the
        // same provider + key down too, so this request (and the next ones)
        // skip them instead of burning time on a guaranteed failure or a hang.
        if (KEY_LEVEL_STATUS_CODES.has(status)) {
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
  throw err;
}
