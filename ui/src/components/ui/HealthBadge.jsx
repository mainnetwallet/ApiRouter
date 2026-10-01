import { StatusBadge } from "./StatusBadge.jsx";
import { healthTone } from "../../lib/errors.js";

const LABELS = {
  healthy: "healthy",
  cooldown: "cooldown",
  failed: "failed",
  unknown: "unknown"
};

/** Health state, using the same vocabulary the backend reports. */
export function HealthBadge({ status, title }) {
  return (
    <StatusBadge tone={healthTone(status)} title={title} pulse={status === "cooldown"}>
      {LABELS[status] ?? status ?? "unknown"}
    </StatusBadge>
  );
}
