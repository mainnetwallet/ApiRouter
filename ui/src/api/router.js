import { apiRequest } from "./client.js";

/** The backend's own routing decision for a given protocol/model/pool. */
export function getRoutingPreview({ protocol, model = "", session = "", pool = "" } = {}, { signal } = {}) {
  const params = new URLSearchParams({ protocol });
  if (model) params.set("model", model);
  if (session) params.set("session", session);
  // Omitted for the text pool so the request the panel has always sent is
  // unchanged; the backend defaults to text when the parameter is absent.
  if (pool && pool !== "text") params.set("pool", pool);
  return apiRequest(`/api/router/preview?${params}`, { signal });
}
