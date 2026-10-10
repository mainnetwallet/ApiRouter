import { apiRequest } from "./client.js";

/**
 * The Fallback Chain: the single source of truth for routing order.
 *
 * `GET /api/fallback` returns the saved selection per pool and the catalogue of
 * configured models with their per-key health and measured latency. Only
 * provider/model ids and key indexes are ever sent. The routing mode is derived
 * from the selection — a pool with a saved selection is walked manually, an
 * empty one automatically — so there is nothing to switch.
 */
export function getFallback({ signal } = {}) {
  return apiRequest("/api/fallback", { signal });
}

/** Replaces one pool's ordered selection. Sends ids, key indexes and flags only. */
export function saveChain(pool, entries) {
  return apiRequest("/api/fallback", { method: "PUT", body: { pool, entries } });
}

/**
 * Clears what the router remembers (the last successful model/key). It never
 * deletes the saved selection, the providers, the keys, the health
 * measurements or a genuine cooldown.
 */
export function resetFallback() {
  return apiRequest("/api/fallback/reset", { method: "POST" });
}
