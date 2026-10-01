import { Icon } from "./Icon.jsx";
import { sanitizeText } from "../../lib/sanitize.js";

/**
 * Renders an ApiError with its taxonomy intact: a category label, the operator
 * hint, and the raw upstream message only as secondary detail. It never
 * collapses a failure into a generic "Offline", which would discard the one
 * piece of information that tells an operator what to do next.
 */
export function ErrorState({ error, title = null, onRetry = null, compact = false }) {
  if (!error) return null;

  const label = title ?? error.label ?? "Request failed";
  const message = sanitizeText(error.message ?? "");

  if (compact) {
    return (
      <div className="inline-error" role="alert">
        <Icon name="alert" className="inline-error__icon" size={15} />
        <div className="inline-error__body">
          <div className="inline-error__title">{label}</div>
          {error.hint ? <div className="inline-error__detail">{error.hint}</div> : null}
          {message ? <div className="inline-error__detail mono">{message}</div> : null}
        </div>
        {onRetry ? (
          <button type="button" className="btn btn--sm" onClick={onRetry}>Retry</button>
        ) : null}
      </div>
    );
  }

  return (
    <div className="state state--error" role="alert">
      <Icon name="alert" className="state__icon" size={26} />
      <div className="state__title">{label}</div>
      {error.hint ? <div className="state__body">{error.hint}</div> : null}
      {message ? <div className="state__body mono tiny">{message}</div> : null}
      {onRetry ? (
        <button type="button" className="btn" onClick={onRetry}>
          <Icon name="refresh" className="btn__icon" size={13} />
          Retry
        </button>
      ) : null}
    </div>
  );
}
