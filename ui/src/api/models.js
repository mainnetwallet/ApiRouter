import { apiRequest } from "./client.js";

export function getModels({ signal } = {}) {
  return apiRequest("/api/models", { signal });
}

/**
 * Switches one provider/model off or on for ALL routing (every key, both
 * pools). Sends ids and a flag only. A request still waiting on a model that is
 * switched off is aborted by the gateway and falls back to the next model.
 */
export function setModelDisabled(provider, model, disabled) {
  return apiRequest("/api/models/switch", { method: "PUT", body: { provider, model, disabled } });
}
