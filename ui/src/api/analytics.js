import { apiRequest } from "./client.js";

export const RANGES = ["5m", "15m", "1h", "6h", "24h", "7d"];

export function getAnalytics({ range = "1h", buckets } = {}, { signal } = {}) {
  const params = new URLSearchParams({ range });
  if (buckets) params.set("buckets", String(buckets));
  return apiRequest(`/api/analytics?${params}`, { signal });
}
