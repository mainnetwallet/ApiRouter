import { apiRequest } from "./client.js";

/**
 * Saved custom endpoints. A saved endpoint becomes a provider (`custom-<name>`)
 * in the Fallback Chain. Keys are sent TO the gateway and never come back: the
 * list only reports how many keys each endpoint has.
 */

export function listCustomEndpoints({ signal } = {}) {
  return apiRequest("/api/custom-endpoints", { signal });
}

export function createCustomEndpoint(input) {
  return apiRequest("/api/custom-endpoints", { method: "POST", body: input });
}

export function updateCustomEndpoint(id, input) {
  return apiRequest(`/api/custom-endpoints/${encodeURIComponent(id)}`, { method: "PUT", body: input });
}

export function deleteCustomEndpoint(id) {
  return apiRequest(`/api/custom-endpoints/${encodeURIComponent(id)}`, { method: "DELETE" });
}

/** Commas, semicolons, spaces or new lines (any mix): what the model and key boxes accept. */
export function splitList(text) {
  return [...new Set(String(text ?? "").split(/[\s,;]+/).map((item) => item.trim()).filter(Boolean))];
}
