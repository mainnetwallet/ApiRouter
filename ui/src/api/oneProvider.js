import { apiRequest } from "./client.js";

export function getOneProvider({ signal } = {}) {
  return apiRequest("/api/one-model", { signal });
}

/**
 * Turns One Provider Fallback on or off, chooses its provider and the ordered
 * list of its models, and/or sets per-key cooldowns. Sends ids, a flag and
 * numbers only. While it is on, every request is served from that provider's
 * models (the first one leads) and nothing else.
 *
 * `models` is the whole ordered list and goes together with `provider`.
 * `cooldowns` is a partial `{ "model::text:0": 60000, "model::text:1": null }`:
 * milliseconds set that key's cooldown (it cools that long the moment it is
 * called), null removes it, and a key left out is unchanged.
 */
export function setOneProvider({ enabled, provider, models, cooldowns } = {}) {
  const body = {};
  if (typeof enabled === "boolean") body.enabled = enabled;
  if (provider !== undefined && models !== undefined) {
    body.provider = provider;
    body.models = models;
  }
  if (cooldowns !== undefined) body.cooldowns = cooldowns;
  return apiRequest("/api/one-model", { method: "PUT", body });
}

/** `"model:keyIndex"`: a key's id inside the chosen provider. */
export const keyIdOf = (key) => key.keyId ?? `${key.model}:${key.keyIndex}`;
