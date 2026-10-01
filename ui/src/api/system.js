import { apiRequest } from "./client.js";

export function getSystem({ signal } = {}) {
  return apiRequest("/api/system", { signal });
}
