import { apiRequest, postJson } from "./client.js";

/** Rich health view: targets, per-provider rollups, ranking and monitor cycle. */
export function getHealth({ signal } = {}) {
  return apiRequest("/api/health", { signal });
}

/**
 * Trigger one health cycle. Refused with 409 while another is running.
 *
 * A manual cycle probes every target (up to 10 s each, a few at a time), so it
 * can legitimately outlast the default 15 s request timeout. A shorter limit
 * reported a failure for a cycle that was still running fine.
 */
export const HEALTH_REFRESH_TIMEOUT_MS = 300_000;

export function refreshHealth() {
  return postJson("/api/health/refresh", {}, { timeoutMs: HEALTH_REFRESH_TIMEOUT_MS });
}
