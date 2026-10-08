import { apiRequest } from "./client.js";

/** @param {{limit?: number, cursor?: number|null, outcome?: string, provider?: string,
 *           protocol?: string, pool?: "text"|"vision", status?: number|string}} query */
export function getRequests(query = {}, { signal } = {}) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== null && value !== undefined && value !== "") params.set(key, String(value));
  }
  const suffix = params.toString() ? `?${params}` : "";
  return apiRequest(`/api/requests${suffix}`, { signal });
}

export function getRequest(id, { signal } = {}) {
  return apiRequest(`/api/requests/${encodeURIComponent(id)}`, { signal });
}

/** Clear the router's request/attempt log on the server (running requests stay). */
export function clearRequests({ signal } = {}) {
  return apiRequest("/api/requests", { method: "DELETE", signal });
}
