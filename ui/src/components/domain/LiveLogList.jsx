import { STATE, STATE_TONE, isLive, shortRequestId } from "../../lib/liveLogs.js";
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
export function describeTarget(target) {
  return [
    target?.provider ? providerLabel(target.provider) : null,
    target?.model ?? null,
    Number.isInteger(target?.keyIndex) ? `key ${target.keyIndex}` : null
  ].filter(Boolean).join(" · ");
}

const isNum = (value) => typeof value === "number" && Number.isFinite(value);

/**
 * The right-hand figures. A finished row shows `200 · 1.09 s`; a running one
 * shows the time elapsed so far, which `now` keeps ticking.
 */
export function describeOutcome(row, now = Date.now()) {
  if (isLive(row)) {
    return isNum(row.ts) && isNum(now) ? formatLatency(Math.max(0, now - row.ts)) : "";
  }
  const parts = [];
  if (Number.isInteger(row.status)) parts.push(String(row.status));
  if (row.state === STATE.FAILED && !Number.isInteger(row.status)) parts.push("failed");
  if (isNum(row.durationMs)) parts.push(formatLatency(row.durationMs));
  return parts.join(" · ");
}

/** What the row says while it has no target yet, or besides the target. */
function requestText(row) {
  return [row.protocol, row.requestedModel].filter(Boolean).join(" · ");
}

const STATE_HINT = Object.freeze({
  [STATE.ROUTING]: "Choosing a target",
  [STATE.RUNNING]: "Waiting for the provider",
  [STATE.RETRYING]: "A target failed; trying the next one"
});

/**
 * One compact row per API call. Missing optional fields simply drop out of the
 * line; nothing here can throw on a sparse row.
 */
export function LiveLogRow({ row, now = Date.now(), onSelectRequest = null }) {
  if (!row) return null;

  const tone = STATE_TONE[row.state] ?? "neutral";
  const live = isLive(row);
  const outcome = describeOutcome(row, now);
  const target = sanitizeText(describeTarget(row));
  const request = sanitizeText(requestText(row));
  const reason = row.reason ? sanitizeText(row.reason) : "";
  const rid = shortRequestId(row.requestId);

  return (
    <li
      className={`livelog__row livelog__row--${tone}${live ? " livelog__row--live" : ""}`}
      data-state={row.state}
      data-request-id={row.requestId ?? undefined}
    >
      <time className="livelog__time mono tabular">{formatClock(row.ts)}</time>
      <span
        className={`livelog__type livelog__type--${tone}${live ? " livelog__type--live" : ""}`}
        title={STATE_HINT[row.state]}
      >
        {row.state}
      </span>

      <span className="livelog__main">
        {target ? <span className="livelog__target mono" title={target}>{target}</span> : null}
        {request ? <span className="livelog__sub dim mono" title={request}>{request}</span> : null}

        {row.chain.map((attempt, index) => {
          const via = sanitizeText(describeTarget(attempt));
          const why = sanitizeText([
            Number.isInteger(attempt.status) ? String(attempt.status) : null,
            attempt.reason,
            Number.isFinite(attempt.durationMs) ? formatLatency(attempt.durationMs) : null
          ].filter(Boolean).join(" · "));
          const text = `↳ ${via}${why ? ` · ${why}` : ""}`;
          return (
            <span
              key={index}
              className="livelog__detail livelog__detail--failed mono"
              title={attempt.detail ? sanitizeText(attempt.detail) : text}
            >
              {text}
            </span>
          );
        })}

        {reason ? <span className="livelog__detail mono" title={reason}>{reason}</span> : null}
      </span>

      <span className="livelog__outcome mono tabular">{outcome}</span>

      {rid ? (
        onSelectRequest ? (
          <button
            type="button"
            className="livelog__rid mono"
            title={`Filter to request ${row.requestId}`}
            onClick={() => onSelectRequest(row.requestId)}
          >
            {rid}
          </button>
        ) : (
          <span className="livelog__rid mono" title={row.requestId}>{rid}</span>
        )
      ) : (
        <span className="livelog__rid" />
      )}
    </li>
  );
}

/** The scrollable chronological list. Newest rows render last. */
export function LiveLogList({ rows, now = Date.now(), onSelectRequest = null }) {
  return (
    <ol className="livelog__list" role="log" aria-live="off" aria-label="API calls">
      {rows.map((row) => (
        <LiveLogRow key={row.key} row={row} now={now} onSelectRequest={onSelectRequest} />
      ))}
    </ol>
  );
}
