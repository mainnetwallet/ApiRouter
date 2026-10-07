import { apiRequest } from "./client.js";

/** The saved manual order per pool, plus every provider/model that can be picked. */
export function getManualSelection({ signal } = {}) {
  return apiRequest("/api/manual-selection", { signal });
}

/**
 * Replaces the manual order. A pool left out keeps its list; `[]` clears it.
 * Not retried automatically: it is a write.
 */
export function saveManualSelection(selection, { signal } = {}) {
  return apiRequest("/api/manual-selection", { method: "PUT", body: selection, signal });
}
