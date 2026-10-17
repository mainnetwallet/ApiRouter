import { apiRequest } from "./client.js";

export function getOneModel({ signal } = {}) {
  return apiRequest("/api/one-model", { signal });
}

/**
 * Turns One Model Fallback on or off, chooses its model and/or sets per-key
 * cooldowns. Sends ids, a flag and numbers only. While it is on, every request is
 * served from that one model and nothing else.
 *
 * `cooldowns` is a partial `{ "text:0": 60000, "text:1": null }`: milliseconds
 * set that key's cooldown (it cools that long the moment it is called), null
 * removes it, and a key left out is unchanged.
 */
export function setOneModel({ enabled, provider, model, cooldowns } = {}) {
  const body = {};
  if (typeof enabled === "boolean") body.enabled = enabled;
  if (provider !== undefined && model !== undefined) {
    body.provider = provider;
    body.model = model;
  }
  if (cooldowns !== undefined) body.cooldowns = cooldowns;
  return apiRequest("/api/one-model", { method: "PUT", body });
}

/** `"text:0"`: a key's id inside the chosen model. */
export const keyIdOf = (key) => `${key.pool}:${key.keyIndex}`;
