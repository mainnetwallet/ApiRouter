import { useState } from "react";
import { Icon } from "../ui/Icon.jsx";
import { ConfirmDialog } from "../ui/ConfirmDialog.jsx";
import { useSystemStatus } from "../../context/SystemStatusContext.jsx";
import { shutdownGateway, resumeGateway } from "../../api/gateway.js";

/**
 * Master on/off switch for the whole backend.
 *
 * Shutting down pauses the gateway: every proxy request is refused with a 503
 * and the health monitor stops probing, so nothing reaches an upstream. The
 * Control Panel itself stays up so this same button can turn it back on.
 */
export function GatewayControl() {
  const { system, reload } = useSystemStatus();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [error, setError] = useState(null);

  // Unknown (older backend, or not loaded yet): render nothing rather than guess.
  if (!system?.gateway) return null;
  const paused = Boolean(system.gateway.paused);

  const run = async (action) => {
    setError(null);
    try {
      await action();
      await reload();
    } catch (e) {
      // Surface the failure next to the button; never leave it unhandled.
      setError(e?.message || "Request failed");
    }
  };

  return (
    <>
      {error ? <span className="gateway-error" role="alert">{error}</span> : null}
      <button
        type="button"
        className={`btn ${paused ? "btn--primary" : "btn--danger"}`}
        onClick={() => (paused ? run(resumeGateway) : setConfirmOpen(true))}
        title={error ?? (paused ? "Turn the backend back on" : "Shut down the backend: no calls will be made")}
      >
        <Icon name={paused ? "play" : "stop"} size={14} />
        <span className="nowrap">{paused ? "Resume" : "Shutdown"}</span>
      </button>

      <ConfirmDialog
        open={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        onConfirm={() => run(shutdownGateway)}
        title="Shut down the backend?"
        confirmLabel="Shut down"
        destructive
        body={
          <p>
            All API requests will be refused (503) and no health probes will run, so no call reaches any
            provider. The Control Panel stays available and you can resume at any time.
          </p>
        }
      />
    </>
  );
}

/** Persistent banner shown while the gateway is shut down. */
export function GatewayPausedBanner() {
  const { system } = useSystemStatus();
  if (!system?.gateway?.paused) return null;
  return (
    <div className="gateway-banner" role="status">
      <Icon name="alert" size={16} />
      <span>
        Backend is shut down. All API calls are refused and no health probes run. Use Resume in the top bar to turn it back on.
      </span>
    </div>
  );
}
