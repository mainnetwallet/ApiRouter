import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "../components/ui/Icon.jsx";
import { sanitizeText } from "../lib/sanitize.js";

/**
 * Global notification system.
 *
 * Every message passes through `sanitizeText` before it reaches the DOM, so a
 * provider error that somehow contained credential-shaped text cannot be
 * surfaced by a toast — the last place a secret could realistically escape.
 */

const ToastContext = createContext(null);

const DEFAULT_TTL = 6000;
const ERROR_TTL = 12000;

const ICONS = {
  success: "check",
  error: "alert",
  warning: "alert",
  info: "info"
};

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);
  const timers = useRef(new Map());
  const nextId = useRef(0);

  const dismiss = useCallback((id) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
    const timer = timers.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timers.current.delete(id);
    }
  }, []);

  const push = useCallback((level, message, { detail = null, ttl, action = null } = {}) => {
    const id = ++nextId.current;
    const toast = {
      id,
      level,
      message: sanitizeText(message, { maxLength: 200 }) || "Something went wrong",
      detail: detail ? sanitizeText(detail, { maxLength: 300 }) : null,
      action
    };

    setToasts((current) => {
      // Collapse an identical message rather than stacking duplicates, which
      // a failing poll would otherwise do once per tick.
      const duplicate = current.find(
        (item) => item.level === toast.level && item.message === toast.message && item.detail === toast.detail
      );
      if (duplicate) return current;
      return [...current.slice(-4), toast];
    });

    const lifetime = ttl ?? (level === "error" ? ERROR_TTL : DEFAULT_TTL);
    timers.current.set(id, setTimeout(() => dismiss(id), lifetime));
    return id;
  }, [dismiss]);

  useEffect(() => () => {
    for (const timer of timers.current.values()) clearTimeout(timer);
    timers.current.clear();
  }, []);

  const api = useMemo(() => ({
    success: (message, options) => push("success", message, options),
    error: (message, options) => push("error", message, options),
    warning: (message, options) => push("warning", message, options),
    info: (message, options) => push("info", message, options),
    dismiss,
    clear: () => setToasts([])
  }), [push, dismiss]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="toasts" role="region" aria-label="Notifications">
        {toasts.map((toast) => (
          <Toast key={toast.id} toast={toast} onDismiss={dismiss} />
        ))}
      </div>
    </ToastContext.Provider>
  );
}

function Toast({ toast, onDismiss }) {
  return (
    <div className={`toast toast--${toast.level}`} role={toast.level === "error" ? "alert" : "status"}>
      <Icon name={ICONS[toast.level] ?? "info"} className="toast__icon" size={15} />
      <div className="toast__body">
        <div className="toast__title">{toast.message}</div>
        {toast.detail ? <div className="toast__detail">{toast.detail}</div> : null}
      </div>
      <button type="button" className="toast__close" onClick={() => onDismiss(toast.id)} aria-label="Dismiss notification">
        <Icon name="close" size={13} />
      </button>
    </div>
  );
}

export function useToast() {
  const context = useContext(ToastContext);
  if (!context) throw new Error("useToast must be used inside a ToastProvider");
  return context;
}

/** Report an ApiError-shaped failure consistently across every page. */
export function toastApiError(toast, error, fallback = "Request failed") {
  if (!error) return;
  toast.error(error.label ?? fallback, {
    detail: error.hint ?? error.message ?? null
  });
}
