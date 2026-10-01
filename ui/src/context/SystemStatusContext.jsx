import { createContext, useCallback, useContext, useMemo } from "react";
import { useApi } from "../hooks/useApi.js";
import { getSystem } from "../api/system.js";
import { getHealth } from "../api/health.js";
import { useConnection } from "./ConnectionContext.jsx";

/**
 * Gateway liveness and runtime identity.
 *
 * Polled slowly (30s): this drives the header's connection indicator and the
 * System page, neither of which needs second-by-second freshness. Health and
 * request data have their own, faster contexts so a slow-moving system poll
 * never re-renders a dashboard.
 */

const SystemStatusContext = createContext(null);

const POLL_MS = 30_000;

export function SystemStatusProvider({ children }) {
  const { generation, hasToken } = useConnection();

  const system = useApi(getSystem, { intervalMs: POLL_MS, deps: [generation] });

  /**
   * Connection state is derived, not guessed:
   *   ok        the last poll succeeded
   *   auth      the gateway answered but rejected our credential
   *   down      the gateway could not be reached at all
   */
  const connection = useMemo(() => {
    if (system.error) {
      if (system.error.category === "authentication") {
        return { state: "auth", label: "Authentication required", tone: "warn", error: system.error };
      }
      return { state: "down", label: "Gateway unreachable", tone: "danger", error: system.error };
    }
    if (system.loading) return { state: "connecting", label: "Connecting", tone: "neutral", error: null };
    return { state: "ok", label: "Connected", tone: "ok", error: null };
  }, [system.error, system.loading]);

  const value = useMemo(() => ({
    system: system.data,
    connection,
    loading: system.loading,
    refreshing: system.refreshing,
    lastUpdatedAt: system.lastUpdatedAt,
    reload: system.reload,
    hasToken
  }), [system.data, connection, system.loading, system.refreshing, system.lastUpdatedAt, system.reload, hasToken]);

  return <SystemStatusContext.Provider value={value}>{children}</SystemStatusContext.Provider>;
}

export function useSystemStatus() {
  const context = useContext(SystemStatusContext);
  if (!context) throw new Error("useSystemStatus must be used inside a SystemStatusProvider");
  return context;
}

/**
 * A cheap "is the gateway alive" probe for the header, used only when the
 * system poll has not yet produced a verdict.
 */
export function useLivenessProbe() {
  const { generation } = useConnection();
  return useApi(async ({ signal }) => {
    const health = await getHealth({ signal });
    return Boolean(health?.ok);
  }, { deps: [generation], intervalMs: null });
}

export const __testables = { POLL_MS };
