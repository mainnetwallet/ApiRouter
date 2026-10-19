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

/** One entry per line or comma: the shape the model and key boxes accept. */
export function splitList(text) {
  return [...new Set(String(text ?? "").split(/[\n,]/).map((item) => item.trim()).filter(Boolean))];
}

const sameBase = (a, b) => String(a ?? "").trim().replace(/\/+$/, "").toLowerCase() === String(b ?? "").trim().replace(/\/+$/, "").toLowerCase();

/**
 * The Playground's "Save permanently" button. Saving the same base URL and API
 * style again ADDS the model and key to the endpoint already saved, instead of
 * creating a duplicate, so an endpoint grows one model / key at a time.
 * A blank key (a local model) is saved as the placeholder "none", because every
 * provider needs at least one key.
 */
export async function saveCustomEndpoint({ name, baseUrl, protocol, model, apiKey }) {
  const key = String(apiKey ?? "").trim() || "none";
  const modelId = String(model ?? "").trim();
  const existing = (await listCustomEndpoints())?.endpoints ?? [];
  const match = existing.find((endpoint) => endpoint.protocol === protocol && sameBase(endpoint.baseUrl, baseUrl));
  if (match) {
    const models = [...new Set([...match.models, modelId])];
    const result = await updateCustomEndpoint(match.id, { models, addApiKeys: [key] });
    return { ...result, created: false };
  }
  const result = await createCustomEndpoint({ name, baseUrl, protocol, models: [modelId], apiKeys: [key] });
  return { ...result, created: true };
}
