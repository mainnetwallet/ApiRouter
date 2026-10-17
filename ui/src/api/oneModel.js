import { apiRequest } from "./client.js";

export function getOneModel({ signal } = {}) {
  return apiRequest("/api/one-model", { signal });
}

/**
 * Turns One Model Fallback on or off and/or chooses its model. Sends ids and a
 * flag only. While it is on, every request is served from that one model and
 * nothing else; each of its keys cools down the moment it is called.
 */
export function setOneModel({ enabled, provider, model }) {
  const body = {};
  if (typeof enabled === "boolean") body.enabled = enabled;
  if (provider !== undefined && model !== undefined) {
    body.provider = provider;
    body.model = model;
  }
  return apiRequest("/api/one-model", { method: "PUT", body });
}
