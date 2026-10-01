import { apiRequest } from "./client.js";

/** Safe configuration projection. Contains key *counts*, never key values. */
export function getConfig({ signal } = {}) {
  return apiRequest("/api/config", { signal });
}
