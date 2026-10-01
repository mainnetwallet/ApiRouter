import { useCallback, useEffect, useRef, useState } from "react";
import { usePolling } from "./usePolling.js";

/**
 * Fetch-once-or-poll data hook.
 *
 * Deliberately conservative: it never sets state from a stale response, never
 * leaves a request in flight after unmount, and treats a 304 (which the client
 * resolves to the *same object identity*) as "nothing changed", so polling a
 * quiet gateway does not re-render the page.
 */
export function useApi(fetcher, { deps = [], enabled = true, intervalMs = null, initial = null } = {}) {
  const [data, setData] = useState(initial);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(enabled && initial === null);
  const [refreshing, setRefreshing] = useState(false);
  const [lastUpdatedAt, setLastUpdatedAt] = useState(null);

  // Guards against a slow earlier request overwriting a newer result.
  const requestId = useRef(0);
  const controller = useRef(null);
  const mounted = useRef(true);
  const consecutiveErrors = useRef(0);

  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  const hasData = useRef(initial !== null);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      controller.current?.abort();
    };
  }, []);

  const run = useCallback(async ({ reason = "manual" } = {}) => {
    if (!enabled) return;

    controller.current?.abort();
    const localController = new AbortController();
    controller.current = localController;

    const id = ++requestId.current;
    if (hasData.current || reason === "manual") setRefreshing(true);

    try {
      const result = await fetcherRef.current({ signal: localController.signal });

      if (!mounted.current || id !== requestId.current) return;

      consecutiveErrors.current = 0;
      // Identity comparison: a 304 returns the cached object, so this branch
      // avoids a needless re-render on unchanged polls.
      setData((previous) => (previous === result ? previous : result));
      hasData.current = true;
      setError(null);
      setLastUpdatedAt(Date.now());
    } catch (caught) {
      if (!mounted.current || id !== requestId.current) return;
      // A superseded or caller-cancelled request is not a failure to report.
      if (caught?.kind === "abort") return;

      consecutiveErrors.current += 1;
      setError(caught);
    } finally {
      if (mounted.current && id === requestId.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, [enabled]);

  // Refetch whenever the caller's dependencies change.
  useEffect(() => {
    if (!enabled) {
      setLoading(false);
      return;
    }
    void run({ reason: "deps" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, run, ...deps]);

  // Stretch the interval while requests keep failing, up to 8x the base.
  const backoffFactor = Math.min(2 ** Math.max(0, consecutiveErrors.current - 1), 8);
  const effectiveInterval = intervalMs ? intervalMs * backoffFactor : null;

  const { paused } = usePolling(run, { intervalMs: effectiveInterval, enabled });

  const reload = useCallback(() => run({ reason: "manual" }), [run]);
  const reset = useCallback((next = null) => {
    hasData.current = next !== null;
    setData(next);
    setError(null);
    setLoading(next === null);
  }, []);

  return {
    data,
    error,
    loading,
    refreshing,
    lastUpdatedAt,
    paused,
    reload,
    reset,
    isEmpty: data === null || data === undefined
  };
}
