import { apiRequest, postJson } from "./client.js";

/** Rich health view: targets, per-provider rollups, ranking and monitor cycle. */
export function getHealth({ signal } = {}) {
  return apiRequest("/api/health", { signal });
}

/** Trigger one health cycle. Refused with 409 while another is running. */
export function refreshHealth() {
  return postJson("/api/health/refresh", {});
}
