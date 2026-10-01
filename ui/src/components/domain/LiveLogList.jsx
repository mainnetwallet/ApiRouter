import { STATE, STATE_TONE, STEP, STEP_TONE, isLive, shortRequestId } from "../../lib/liveLogs.js";
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

/** The figures on the right of one attempt box. */
export function describeStepOutcome(step, now = Date.now()) {
  if (step.state === STEP.CALLING) {
    return isNum(step.startedAt) && isNum(now) ? formatLatency(Math.max(0, now - step.startedAt)) : "";
  }
  if (step.state === STEP.ROUTING) return "";
  return [
    Number.isInteger(step.status) ? String(step.status) : null,
    isNum(step.durationMs) ? formatLatency(step.durationMs) : null
  ].filter(Boolean).join(" · ");
}

const STEP_HINT = Object.freeze({
  [STEP.ROUTING]: "Choosing the next target",
  [STEP.CALLING]: "Calling this model",
  [STEP.FAILED]: "This model failed",
  [STEP.SUCCESS]: "This model answered"
});

/** One attempt: its own box with CALLING / FAILED / SUCCESS. */
function StepBox({ step, now }) {
  const tone = STEP_TONE[step.state] ?? "neutral";
  const calling = step.state === STEP.CALLING;
  const target = step.state === STEP.ROUTING
    ? "Choosing next target…"
    : sanitizeText(describeTarget(step));
  const why = step.state === STEP.FAILED
    ? sanitizeText([step.reason, step.detail].filter(Boolean).join(" · "))
    : "";
  const outcome = describeStepOutcome(step, now);

  return (
    <div
      className={`livelog__step livelog__step--${tone}${calling ? " livelog__step--calling" : ""}`}
      data-step-state={step.state}
    >
      <div className="livelog__step-head">
        <span
          className={`livelog__type livelog__type--${tone}${calling ? " livelog__type--live" : ""}`}
          title={STEP_HINT[step.state]}
        >
          {step.state}
        </span>
        <span className="livelog__target mono" title={target}>{target}</span>
        <span className="livelog__outcome mono tabular">{outcome}</span>
      </div>
      {why ? <div className="livelog__detail livelog__detail--failed mono" title={why}>{why}</div> : null}
    </div>
  );
}

/** The line between a failed box and the one the router fell back to. */
function FallbackLink({ from }) {
  const why = sanitizeText([
    Number.isInteger(from.status) ? String(from.status) : null,
    from.reason
  ].filter(Boolean).join(" · "));
  return (
    <div className="livelog__fallback mono" aria-label="Fallback to the next model">
      <span aria-hidden="true">↓</span> FALLBACK{why ? ` · ${why}` : ""}
    </div>
  );
}

/**
 * One card per API call. The header carries the call as a whole; below it every
 * model the router tried gets its own box, with a FALLBACK line between a
 * failed box and the next one. Missing optional fields simply drop out;
 * nothing here can throw on a sparse row.
 */
export function LiveLogRow({ row, now = Date.now(), onSelectRequest = null }) {
  if (!row) return null;

  const tone = STATE_TONE[row.state] ?? "neutral";
  const live = isLive(row);
  const steps = Array.isArray(row.steps) ? row.steps : [];
  const outcome = describeOutcome(row, now);
  const request = sanitizeText(requestText(row));
  // With no boxes (rejected before any provider was tried) the target, if any,
  // is the only thing to name.
  const target = steps.length === 0 ? sanitizeText(describeTarget(row)) : "";
  const reason = row.reason ? sanitizeText(row.reason) : "";
  const rid = shortRequestId(row.requestId);

  return (
    <li
      className={`livelog__card livelog__card--${tone}${live ? " livelog__card--live" : ""}`}
      data-state={row.state}
      data-request-id={row.requestId ?? undefined}
    >
      <div className="livelog__card-head">
        <time className="livelog__time mono tabular">{formatClock(row.ts)}</time>
        <span
          className={`livelog__type livelog__type--${tone}${live ? " livelog__type--live" : ""}`}
          title={STATE_HINT[row.state]}
        >
          {row.state}
        </span>
        <span className="livelog__sub dim mono" title={request}>{request}</span>
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
      </div>

      {target ? <div className="livelog__target mono livelog__lone" title={target}>{target}</div> : null}

      {steps.length > 0 ? (
        <div className="livelog__steps">
          {steps.map((step, index) => (
            <div className="livelog__stepwrap" key={index}>
              {index > 0 && steps[index - 1].state === STEP.FAILED ? <FallbackLink from={steps[index - 1]} /> : null}
              <StepBox step={step} now={now} />
            </div>
          ))}
        </div>
      ) : null}

      {reason ? <div className="livelog__detail mono livelog__reason" title={reason}>{reason}</div> : null}
    </li>
  );
}

/** The scrollable chronological list. Newest cards render last. */
export function LiveLogList({ rows, now = Date.now(), onSelectRequest = null }) {
  return (
    <ol className="livelog__list" role="log" aria-live="off" aria-label="API calls">
      {rows.map((row) => (
        <LiveLogRow key={row.key} row={row} now={now} onSelectRequest={onSelectRequest} />
      ))}
    </ol>
  );
}
