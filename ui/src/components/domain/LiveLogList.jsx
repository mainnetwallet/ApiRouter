import { EVENT, EVENT_TONE, shortRequestId } from "../../lib/liveLogs.js";
import { sanitizeText } from "../../lib/sanitize.js";
import { EMPTY, formatLatency, providerLabel } from "../../lib/format.js";

/** 24-hour local clock, `HH:MM:SS`; an explicit placeholder when unknown. */
export function formatClock(ts) {
  if (typeof ts !== "number" || !Number.isFinite(ts)) return EMPTY;
  const date = new Date(ts);
  const pad = (value) => String(value).padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/** `Provider · model · key N` — every part optional, key shown by index only. */
export function describeTarget(event) {
  return [
    event.provider ? providerLabel(event.provider) : null,
    event.model ?? null,
    Number.isInteger(event.keyIndex) ? `key ${event.keyIndex}` : null
  ].filter(Boolean).join(" · ");
}

/** The right-hand figures: `429 · rate limited`, `200 · 612 ms`, `200 · 1.82 s`. */
export function describeOutcome(event) {
  const parts = [];
  if (Number.isInteger(event.status)) parts.push(String(event.status));
  if (event.type === EVENT.FAILED && event.reason) parts.push(event.reason);
  if (event.type === EVENT.COMPLETE && event.outcome === "failed" && !Number.isInteger(event.status)) {
    parts.push("failed");
  }
  if (Number.isFinite(event.durationMs)) parts.push(formatLatency(event.durationMs));
  return parts.join(" · ");
}

function mainText(event) {
  const target = describeTarget(event);

  switch (event.type) {
    case EVENT.START: {
      const detail = [event.protocol, event.reason].filter(Boolean).join(" · ");
      return detail ? `request ${detail}` : "request received";
    }
    case EVENT.FALLBACK:
      return target ? `→ ${target}` : "→ next target";
    case EVENT.COMPLETE:
      return target ? `${target}` : "";
    default:
      return target;
  }
}

/**
 * One compact timeline row. Missing optional fields simply drop out of the
 * line; nothing here can throw on a sparse event.
 */
export function LiveLogRow({ event, onSelectRequest = null }) {
  if (!event) return null;

  const tone = EVENT_TONE[event.type] ?? "neutral";
  const outcome = describeOutcome(event);
  const main = sanitizeText(mainText(event));
  const detail = event.detail ? sanitizeText(event.detail) : "";
  const completeReason = event.type === EVENT.COMPLETE && event.reason ? sanitizeText(event.reason) : "";
  const rid = shortRequestId(event.requestId);

  return (
    <li
      className={`livelog__row livelog__row--${tone}`}
      data-event-type={event.type}
      data-request-id={event.requestId ?? undefined}
    >
      <time className="livelog__time mono tabular">{formatClock(event.ts)}</time>
      <span className={`livelog__type livelog__type--${tone}`}>{event.type}</span>

      <span className="livelog__main">
        {main ? <span className="livelog__target mono" title={main}>{main}</span> : null}
        {event.type === EVENT.COMPLETE && event.requestId ? (
          <span className="livelog__sub dim mono">request {rid}</span>
        ) : null}
        {detail || completeReason ? (
          <span className="livelog__detail mono" title={detail || completeReason}>
            {detail || completeReason}
          </span>
        ) : null}
      </span>

      <span className="livelog__outcome mono tabular">{outcome}</span>

      {rid && event.type !== EVENT.COMPLETE ? (
        onSelectRequest ? (
          <button
            type="button"
            className="livelog__rid mono"
            title={`Filter to request ${event.requestId}`}
            onClick={() => onSelectRequest(event.requestId)}
          >
            {rid}
          </button>
        ) : (
          <span className="livelog__rid mono" title={event.requestId}>{rid}</span>
        )
      ) : (
        <span className="livelog__rid" />
      )}
    </li>
  );
}

/** The scrollable chronological list. Newest events render last. */
export function LiveLogList({ events, onSelectRequest = null }) {
  return (
    <ol className="livelog__list" role="log" aria-live="off" aria-label="Execution events">
      {events.map((event) => (
        <LiveLogRow key={event.id} event={event} onSelectRequest={onSelectRequest} />
      ))}
    </ol>
  );
}
