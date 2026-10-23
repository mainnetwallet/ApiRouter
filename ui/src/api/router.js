import { apiRequest } from "./client.js";

/** The backend's own routing decision for a given protocol/model. */
export function getRoutingPreview({ protocol, model = "", session = "" } = {}, { signal } = {}) {
  const params = new URLSearchParams({ protocol });
  if (model) params.set("model", model);
  if (session) params.set("session", session);
  return apiRequest(`/api/router/preview?${params}`, { signal });
}
