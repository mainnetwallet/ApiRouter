import { apiRequest } from "./client.js";

export function getProviders({ signal } = {}) {
  return apiRequest("/api/providers", { signal });
}
