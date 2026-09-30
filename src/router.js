export function isRetryableStatus(status, retryableStatus = new Set([402, 408, 429, 500, 502, 503, 504])) {
  return retryableStatus.has(Number(status));
}

export class RouteSession {
  constructor() {
    this.cursor = 0;
  }

  current(targets) {
    if (!Array.isArray(targets) || targets.length === 0) {
      const err = new Error("No fully configured routing targets available");
      err.status = 503;
      throw err;
    }
    return targets[Math.min(this.cursor, targets.length - 1)];
  }

  advance(targets) {
    if (this.cursor < targets.length - 1) this.cursor += 1;
    return this.current(targets);
  }

  markSuccess(target) {
    return target;
  }
}

export async function withFallback(
  targets,
  invoke,
  retryableStatus = new Set([402, 408, 429, 500, 502, 503, 504]),
  session = new RouteSession()
) {
  if (!Array.isArray(targets) || targets.length === 0) {
    const err = new Error("No fully configured routing targets available");
    err.status = 503;
    throw err;
  }

  const failures = [];
  let index = Math.min(session.cursor, targets.length - 1);

  while (index < targets.length) {
    const target = targets[index];
    try {
      const result = await invoke(target);
      session.cursor = index;
      session.markSuccess(target);
      return result;
    } catch (error) {
      failures.push({
        target,
        status: Number(error?.status || 0),
        message: error?.message || String(error)
      });

      if (!isRetryableStatus(error?.status, retryableStatus) && !error?.retryable) {
        throw error;
      }

      index += 1;
      session.cursor = Math.min(index, targets.length - 1);
    }
  }

  const err = new Error("All routing targets failed");
  err.status = 502;
  err.failures = failures;
  throw err;
}
