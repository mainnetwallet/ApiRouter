import { apiRequest } from "./client.js";

export const RANGES = ["5m", "15m", "1h", "6h", "24h", "7d"];

export function getAnalytics({ range = "1h", buckets, pool } = {}, { signal } = {}) {
  const params = new URLSearchParams({ range });
  if (buckets) params.set("buckets", String(buckets));
  // "text" | "vision" scopes every figure to that pool; omitted means all traffic.
  if (pool) params.set("pool", pool);
  return apiRequest(`/api/analytics?${params}`, { signal });
}
