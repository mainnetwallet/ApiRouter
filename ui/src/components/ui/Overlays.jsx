import { useEffect, useRef } from "react";
import { Icon } from "./Icon.jsx";

/**
 * Focus management shared by the modal and the drawer.
 *
 * Three things are handled here because getting them wrong makes an overlay
 * unusable with a keyboard:
 *   - focus moves into the overlay on open, and returns to the trigger on close
 *   - Tab is trapped inside, so focus cannot wander onto the page behind
 *   - Escape closes, and background scroll is locked
 */
export function useOverlay({ open, onClose, initialFocusRef = null }) {
  const containerRef = useRef(null);
  const previouslyFocused = useRef(null);

  useEffect(() => {
    if (!open) return undefined;

    previouslyFocused.current = document.activeElement;

    const container = containerRef.current;
    const focusTarget =
      initialFocusRef?.current ??
      container?.querySelector("[data-autofocus]") ??
      container?.querySelector("button, [href], input, select, textarea, [tabindex]:not([tabindex='-1'])");

    focusTarget?.focus?.();

    const onKeyDown = (event) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose?.();
        return;
      }

      if (event.key !== "Tab" || !container) return;

      const focusable = [...container.querySelectorAll(
        "button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])"
      )].filter((element) => element.offsetParent !== null);

      if (focusable.length === 0) return;

      const first = focusable[0];
      const last = focusable.at(-1);

      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", onKeyDown, true);

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      document.body.style.overflow = previousOverflow;
      previouslyFocused.current?.focus?.();
    };
  }, [open, onClose, initialFocusRef]);

  return containerRef;
}

export function Drawer({ open, onClose, title, subtitle = null, children, footer = null, wide = false, actions = null }) {
  const containerRef = useOverlay({ open, onClose });

  if (!open) return null;

  return (
    <>
      <button type="button" className="scrim" onClick={onClose} aria-label="Close panel" tabIndex={-1} />
      <aside
        ref={containerRef}
        className={`drawer${wide ? " drawer--wide" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-label={typeof title === "string" ? title : "Details"}
      >
        <header className="overlay-head">
          <div className="grow">
            <div className="overlay-title truncate">{title}</div>
            {subtitle ? <div className="overlay-subtitle truncate">{subtitle}</div> : null}
          </div>
          <div className="overlay-head__actions">
            {actions}
            <button type="button" className="btn btn--ghost btn--icon" onClick={onClose} aria-label="Close">
              <Icon name="close" size={15} />
            </button>
          </div>
        </header>
        <div className="overlay-body">{children}</div>
        {footer ? <footer className="overlay-foot">{footer}</footer> : null}
      </aside>
    </>
  );
}

export function Modal({ open, onClose, title, children, footer = null, labelledBy = "modal-title" }) {
  const containerRef = useOverlay({ open, onClose });

  if (!open) return null;

  return (
    <>
      <button type="button" className="scrim" onClick={onClose} aria-label="Close dialog" tabIndex={-1} />
      <div ref={containerRef} className="modal" role="dialog" aria-modal="true" aria-labelledby={labelledBy}>
        <header className="overlay-head">
          <div className="overlay-title" id={labelledBy}>{title}</div>
          <div className="overlay-head__actions">
            <button type="button" className="btn btn--ghost btn--icon" onClick={onClose} aria-label="Close">
              <Icon name="close" size={15} />
            </button>
          </div>
        </header>
        <div className="overlay-body">{children}</div>
        {footer ? <footer className="overlay-foot">{footer}</footer> : null}
      </div>
    </>
  );
}
