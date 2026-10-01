import { Icon } from "./Icon.jsx";
import { maskCredential } from "../../lib/mask.js";

/**
 * Shows that a secret exists without revealing it.
 *
 * There is intentionally no reveal or copy control. The backend never sends
 * provider key material, and for the one secret the client holds — the router
 * token — the operator already has the value elsewhere. A reveal button would
 * add exposure without adding capability.
 */
export function MaskedValue({ value = null, configured = true, noun = "credential" }) {
  if (!configured) {
    return (
      <span className="row">
        <Icon name="close" size={12} style={{ color: "var(--text-dim)" }} />
        <span className="dim">Not configured</span>
      </span>
    );
  }

  return (
    <span className="row">
      <Icon name="key" size={12} style={{ color: "var(--ok)" }} />
      <span className="masked" aria-hidden="true">{value ? maskCredential(value) : "••••••••"}</span>
      <span className="sr-only">{noun} configured; value hidden</span>
    </span>
  );
}
