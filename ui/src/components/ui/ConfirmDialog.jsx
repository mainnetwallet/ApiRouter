import { useState } from "react";
import { Modal } from "./Overlays.jsx";
import { Icon } from "./Icon.jsx";

/**
 * Confirmation for irreversible actions.
 *
 * The confirm button names the action ("Clear log") rather than saying "OK",
 * and destructive confirmations default focus to Cancel — so an operator
 * holding Enter cannot destroy something by reflex.
 */
export function ConfirmDialog({
  open,
  onClose,
  onConfirm,
  title,
  body,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  destructive = false
}) {
  const [busy, setBusy] = useState(false);

  const confirm = async () => {
    setBusy(true);
    try {
      await onConfirm?.();
      onClose?.();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      labelledBy="confirm-title"
      footer={
        <>
          <button type="button" className="btn" onClick={onClose} disabled={busy} data-autofocus={destructive ? "true" : undefined}>
            {cancelLabel}
          </button>
          <button
            type="button"
            className={`btn ${destructive ? "btn--danger" : "btn--primary"}`}
            onClick={confirm}
            disabled={busy}
            data-autofocus={destructive ? undefined : "true"}
          >
            {busy ? <span className="spinner" aria-hidden="true" /> : null}
            {confirmLabel}
          </button>
        </>
      }
    >
      <div className="row" style={{ alignItems: "flex-start", gap: "var(--sp-3)" }}>
        {destructive ? <Icon name="alert" size={18} style={{ color: "var(--danger)", flex: "none" }} /> : null}
        <div className="grow">{body}</div>
      </div>
    </Modal>
  );
}
