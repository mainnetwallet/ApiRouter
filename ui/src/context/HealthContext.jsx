import { createContext, useCallback, useContext, useMemo, useState } from "react";
import { useApi } from "../hooks/useApi.js";
import { getHealth, refreshHealth } from "../api/health.js";
import { useConnection } from "./ConnectionContext.jsx";
import { useToast } from "./ToastContext.jsx";

/**
 * Target health, shared by every page that shows it.
 *
 * This context exists specifically so that health updates do not re-render the
 * whole application: only components that call `useHealth()` re-render when a
 * poll lands. The shell, the sidebar and unrelated pages are untouched.
 *
 * Health moves on a 15-minute monitor cycle by default, so polling faster than
 * 10s would only burn requests — and conditional ETags mean an unchanged poll
 * costs a 304 and produces no state update at all.
 */

const HealthContext = createContext(null);

const POLL_MS = 10_000;

export function HealthProvider({ children }) {
  const { generation } = useConnection();
  const toast = useToast();
  const [manualBusy, setManualBusy] = useState(false);
  const [autoRefresh, setAutoRefresh] = useState(true);

  // The interval lives here rather than on the page so that turning polling
  // off actually stops the requests, instead of merely hiding their results.
  const health = useApi(getHealth, {
    intervalMs: autoRefresh ? POLL_MS : null,
    deps: [generation]
  });

  const runManualRefresh = useCallback(async () => {
    setManualBusy(true);
    try {
      await refreshHealth();
      health.reload();
    } catch (error) {
      if (error?.category === "cooldown") {
        toast.info("A health cycle is already running");
      } else if (error?.kind === "abort") {
        // Even the long limit ran out: the server is still working through the
        // targets, which is not a failed refresh. Show what it has so far.
        toast.info("The health cycle is still running; results will appear as it finishes");
        health.reload();
      } else {
        toast.error(error?.label ?? "Health refresh failed", { detail: error?.hint ?? error?.message });
      }
    } finally {
      setManualBusy(false);
    }
  }, [health, toast]);

  const value = useMemo(() => ({
    health: health.data,
    targets: health.data?.targets ?? [],
    summary: health.data?.summary ?? null,
    providers: health.data?.providers ?? [],
    ranked: health.data?.ranked ?? [],
    monitor: health.data?.monitor ?? null,
    error: health.error,
    loading: health.loading,
    refreshing: health.refreshing,
    lastUpdatedAt: health.lastUpdatedAt,
    paused: health.paused || !autoRefresh,
    autoRefresh,
    setAutoRefresh,
    reload: health.reload,
    runManualRefresh,
    manualBusy
  }), [health, runManualRefresh, manualBusy, autoRefresh]);

  return <HealthContext.Provider value={value}>{children}</HealthContext.Provider>;
}

export function useHealth() {
  const context = useContext(HealthContext);
  if (!context) throw new Error("useHealth must be used inside a HealthProvider");
  return context;
}

export const HEALTH_POLL_MS = POLL_MS;
