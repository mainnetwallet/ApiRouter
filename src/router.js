import { RETRYABLE_STATUS } from "./config.js";

export function isRetryableStatus(status) { return RETRYABLE_STATUS.has(Number(status)); }

export async function withFallback(targets, invoke) {
  const failures = [];
  for (const target of targets) {
    try { return await invoke(target); }
    catch (error) {
      failures.push({ target, status: Number(error?.status || 0), message: error?.message || String(error) });
      if (!isRetryableStatus(error?.status) && !error?.retryable) throw error;
    }
  }
  const err = new Error("All routing targets failed"); err.status = 502; err.failures = failures; throw err;
}
