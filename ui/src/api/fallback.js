import { apiRequest } from "./client.js";

/**
 * The Fallback Chain: the single source of truth for routing order and mode.
 *
 * `GET /api/fallback` returns the saved chain per pool, the selected mode, and
 * the catalogue of configured models with their per-key health and measured
 * latency. Only provider/model ids and key indexes are ever sent.
 */
export function getFallback({ signal } = {}) {
  return apiRequest("/api/fallback", { signal });
}

/** Replaces one pool's ordered chain. Sends ids, key indexes and flags only. */
export function saveChain(pool, entries) {
  return apiRequest("/api/fallback", { method: "PUT", body: { pool, entries } });
}

/** Selects the fallback operating mode. */
export function saveMode(mode) {
  return apiRequest("/api/fallback", { method: "PUT", body: { mode } });
}

/**
 * Clears what the router remembers (the last successful model/key). It never
 * deletes the saved chain, the mode, the providers, the keys, the health
 * measurements or a genuine cooldown.
 */
export function resetFallback() {
  return apiRequest("/api/fallback/reset", { method: "POST" });
}
