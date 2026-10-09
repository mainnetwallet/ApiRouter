import { apiRequest } from "./client.js";

/** Saved manual selection per pool, plus the selectable provider/model pairs. */
export function getManualSelection({ signal } = {}) {
  return apiRequest("/api/manual-selection", { signal });
}

/** Replaces one pool's ordered list. Sends provider + model ids only. */
export function saveManualSelection(pool, models) {
  return apiRequest("/api/manual-selection", { method: "PUT", body: { pool, models } });
}

export function clearManualSelection(pool) {
  return apiRequest(`/api/manual-selection?pool=${encodeURIComponent(pool)}`, { method: "DELETE" });
}
