import { useState } from "react";
import { Modal } from "../ui/Overlays.jsx";
import { Icon } from "../ui/Icon.jsx";
import { MaskedValue } from "../ui/MaskedValue.jsx";
import { useConnection } from "../../context/ConnectionContext.jsx";
import { useToast } from "../../context/ToastContext.jsx";

/**
 * Connection settings.
 *
 * The only credential the browser ever holds is the gateway's own client
 * token. Provider keys stay server-side, which is why this dialog has exactly
 * one secret field and a link to `.env` for everything else.
 *
 * The token is held in sessionStorage and shown masked; nothing here writes it
 * to localStorage, a URL, or the console.
 */
export function ConnectionSettings({ open, onClose }) {
  const { token, setToken, hasToken } = useConnection();
  const toast = useToast();
  const [draft, setDraft] = useState("");

  const save = () => {
    setToken(draft);
    setDraft("");
    toast.success(
      draft.trim() ? "Router token saved for this tab" : "Router token cleared",
      { detail: "Provider API keys are configured server-side and never reach the browser." }
    );
    onClose();
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Connection"
      labelledBy="connection-title"
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="button" className="btn btn--primary" onClick={save} data-autofocus="true">
            Save
          </button>
        </>
      }
    >
      <div className="stack">
        <div className="notice notice--info">
          <Icon name="info" className="notice__icon" size={15} />
          <div>
            Only needed when the gateway is configured with <code>MULTIAI_ROUTER_API_KEYS</code>.
            Provider API keys stay on the server and are never exposed here.
          </div>
        </div>

        <div className="field">
          <span className="field__label">Current token</span>
          <div>
            <MaskedValue configured={hasToken} value={token} noun="router token" />
          </div>
        </div>

        <div className="field">
          <label className="field__label" htmlFor="router-token">Set / replace token</label>
          <input
            id="router-token"
            className="input input--mono"
            type="password"
            autoComplete="off"
            spellCheck="false"
            placeholder="Leave blank to clear"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
          />
          <span className="field__hint">
            Stored in this tab's session only — it is cleared when the tab closes and is never
            written to disk.
          </span>
        </div>

        <div className="field">
          <span className="field__label">Gateway address</span>
          <div className="mono small">{typeof window !== "undefined" ? window.location.origin : ""}</div>
          <span className="field__hint">
            The panel is served by the gateway itself, so requests are same-origin.
          </span>
        </div>
      </div>
    </Modal>
  );
}
