import { apiRequest } from "./client.js";

export function getModels({ signal } = {}) {
  return apiRequest("/api/models", { signal });
}
