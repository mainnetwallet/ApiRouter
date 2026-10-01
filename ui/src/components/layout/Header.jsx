import { Icon } from "../ui/Icon.jsx";
import { StatusBadge } from "../ui/StatusBadge.jsx";
import { useSystemStatus } from "../../context/SystemStatusContext.jsx";
import { formatRelativeTime } from "../../lib/format.js";

/**
 * Top bar: page identity on the left, live system state on the right.
 *
 * Two distinct indicators, because they answer different questions and fail
 * independently:
 *   connection  can the browser reach the gateway at all?
 *   health      is the gateway's own upstream fleet healthy?
 *
 * A gateway that is reachable but has every provider in cooldown is a very
 * different situation from one that is not running, and showing a single
 * "status" dot would conflate them.
 */
export function Header({ route, onOpenNav, onOpenSettings, theme, onToggleTheme }) {
  const { connection, system, reload, refreshing } = useSystemStatus();

  const healthCounts = system?.healthMonitor ?? null;

  return (
    <header className="header">
      <div className="mobile-bar">
        <button type="button" className="btn btn--ghost btn--icon" onClick={onOpenNav} aria-label="Open navigation">
          <Icon name="menu" size={16} />
        </button>
      </div>

      <div className="header__title" title={route?.description ?? route?.label}>
        {route?.label ?? "Not found"}
      </div>

      <div className="header__spacer" />

      <div className="header__actions">
        <StatusBadge
          tone={connection.tone}
          pulse={refreshing}
          title={
            connection.error
              ? `${connection.error.label}: ${connection.error.hint ?? connection.error.message ?? ""}`
              : `Gateway ${connection.label.toLowerCase()} at ${system?.address ?? "unknown address"}`
          }
        >
          <span className="nowrap">
            {connection.state === "ok" ? "API connected" : connection.label}
          </span>
        </StatusBadge>

        {healthCounts ? (
          <StatusBadge
            tone={healthCounts.lastCycle?.outcomes?.failed > 0 ? "warn" : "neutral"}
            dot={false}
            title="Health monitor cycle status"
          >
            <span className="nowrap mono">
              probe {formatRelativeTime(healthCounts.lastCycle?.completedAt)}
            </span>
          </StatusBadge>
        ) : null}

        <button
          type="button"
          className="btn btn--ghost btn--icon"
          onClick={reload}
          disabled={refreshing}
          aria-label="Refresh connection status"
          title="Refresh"
        >
          <Icon name="refresh" size={14} />
        </button>

        <button
          type="button"
          className="btn btn--ghost btn--icon"
          onClick={onToggleTheme}
          aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}
          title={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}
        >
          <Icon name={theme === "dark" ? "sun" : "moon"} size={14} />
        </button>

        <button
          type="button"
          className="btn btn--ghost btn--icon"
          onClick={onOpenSettings}
          aria-label="Connection settings"
          title="Connection settings"
        >
          <Icon name="lock" size={14} />
        </button>
      </div>
    </header>
  );
}
