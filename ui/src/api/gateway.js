import { apiRequest, postJson, invalidateCache } from "./client.js";

/** Master switch state: { state: "running" | "paused", paused, pausedAt, ... }. */
export function getGateway({ signal } = {}) {
  return apiRequest("/api/gateway", { signal });
}

/** Pause the whole backend: no proxy request or health probe reaches an upstream. */
export async function shutdownGateway() {
  const result = await postJson("/api/gateway/shutdown", {});
  invalidateCache();
  return result;
}

/** Turn the backend back on. */
export async function resumeGateway() {
  const result = await postJson("/api/gateway/resume", {});
  invalidateCache();
  return result;
}
