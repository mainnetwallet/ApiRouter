export function isRetryableStatus(status, retryableStatus = new Set([402, 408, 429, 500, 502, 503, 504])) { return retryableStatus.has(Number(status)); }



export async function withFallback(targets, invoke, retryableStatus = new Set([402, 408, 429, 500, 502, 503, 504])) {
  if (!Array.isArray(targets) || targets.length === 0) {
    const err = new Error("No fully configured routing targets available");
    err.status = 503;
    throw err;
  }
  const failures = [];
  for (const target of targets) {
    try { return await invoke(target); }
    catch (error) {
      failures.push({ target, status: Number(error?.status || 0), message: error?.message || String(error) });
      if (!isRetryableStatus(error?.status, retryableStatus) && !error?.retryable) throw error;
    }
  }
  const err = new Error("All routing targets failed"); err.status = 502; err.failures = failures; throw err;
}
