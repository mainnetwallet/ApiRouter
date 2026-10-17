import { apiRequest } from "./client.js";

export function getProviders({ signal } = {}) {
  return apiRequest("/api/providers", { signal });
}

/**
 * Switches a whole provider off or on for ALL routing (every model, every key,
 * both pools). Sends the provider id and a flag only. While it is off none of
 * its models is used or fallen back to; a request still waiting on it is
 * aborted by the gateway and falls back to the next model. Enabling it restores
 * the previous behaviour.
 */
export function setProviderDisabled(provider, disabled) {
  return apiRequest("/api/providers/switch", { method: "PUT", body: { provider, disabled } });
}
