import { Fragment } from "react";
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

/** `Provider · model`, without the key: the key sits with the figures in the card header. */
export function describeModel(target) {
  return [
    target?.provider ? providerLabel(target.provider) : null,
    target?.model ?? null
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
function StepBox({ step }) {
  const tone = STEP_TONE[step.state] ?? "neutral";
  const calling = step.state === STEP.CALLING;
  const target = step.state === STEP.ROUTING
    ? "Choosing next target…"
    : sanitizeText(describeModel(step));
  const why = step.state === STEP.FAILED
    ? sanitizeText([step.reason, step.detail].filter(Boolean).join(" · "))
    : "";

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
      </div>
      {why ? <div className="livelog__detail livelog__detail--failed mono" title={why}>{why}</div> : null}
    </div>
  );
}

/** The line between a failed model's card and the next model's card. */
function FallbackLink({ from }) {
  const why = sanitizeText([
    Number.isInteger(from.status) ? String(from.status) : null,
    from.reason
  ].filter(Boolean).join(" · "));
  return (
    <li className="livelog__fallback mono" aria-label="Fallback to the next model">
      <span aria-hidden="true">↓</span> FALLBACK{why ? ` · ${why}` : ""}
    </li>
  );
}

/** Time, state, protocol and request id: the top of every card. */
function CardHead({ time, state, tone, live, request, outcome, row, rid, onSelectRequest }) {
  const pool = row?.pool === "vision" ? "VISION" : "TEXT";
  return (
    <div className="livelog__card-head">
      <time className="livelog__time mono tabular">{formatClock(time)}</time>
      <span
        className={`livelog__type livelog__type--${tone}${live ? " livelog__type--live" : ""}`}
        title={STATE_HINT[state]}
      >
        {state}
      </span>
      {/* Which pool served the call: text and vision are routed independently. */}
      <span
        className={`livelog__pool livelog__pool--${pool === "VISION" ? "vision" : "text"}`}
        title={`${pool} routing pool`}
      >
        {pool}
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
  );
}

/**
 * One API call. Every model the router tries gets its own full card (header,
 * then the model's box), the same shape whether the call needed one model or
 * five, with a FALLBACK line between a failed card and the next. The last card
 * carries the call's overall state and total time. Missing optional fields
 * simply drop out; nothing here can throw on a sparse row.
 */
export function LiveLogRow({ row, now = Date.now(), onSelectRequest = null }) {
  if (!row) return null;

  const steps = Array.isArray(row.steps) ? row.steps : [];
  const request = sanitizeText(requestText(row));
  const rid = shortRequestId(row.requestId);
  const live = isLive(row);

  // Rejected before any provider was tried: one card, no model box.
  if (steps.length === 0) {
    const tone = STATE_TONE[row.state] ?? "neutral";
    const target = sanitizeText(describeTarget(row));
    const reason = row.reason ? sanitizeText(row.reason) : "";
    return (
      <li
        className={`livelog__card livelog__card--first livelog__card--${tone}${live ? " livelog__card--live" : ""}`}
        data-state={row.state}
        data-request-id={row.requestId ?? undefined}
      >
        <CardHead
          time={row.ts} state={row.state} tone={tone} live={live} request={request}
          outcome={describeOutcome(row, now)} row={row} rid={rid} onSelectRequest={onSelectRequest}
        />
        {target ? <div className="livelog__target mono livelog__lone" title={target}>{target}</div> : null}
        {reason ? <div className="livelog__detail mono livelog__reason" title={reason}>{reason}</div> : null}
      </li>
    );
  }

  return (
    <>
      {steps.map((step, index) => {
        const last = index === steps.length - 1;
        const state = last ? row.state : step.state;
        const tone = STEP_TONE[step.state] ?? "neutral";
        const badgeTone = STATE_TONE[state] ?? STEP_TONE[state] ?? "neutral";
        const cardLive = last && live;
        const time = Number.isFinite(step.startedAt) ? step.startedAt : (index === 0 ? row.ts : null);
        const reason = last && row.reason ? sanitizeText(row.reason) : "";
        // The figures live in the header only: key, then status and time (the
        // call's total on the last card, this model's own on the others).
        const figures = [
          Number.isInteger(step.keyIndex) ? `key ${step.keyIndex}` : null,
          last ? describeOutcome(row, now) : describeStepOutcome(step, now)
        ].filter(Boolean).join(" · ");

        return (
          <Fragment key={index}>
            {index > 0 && steps[index - 1].state === STEP.FAILED ? <FallbackLink from={steps[index - 1]} /> : null}
            <li
              className={`livelog__card${index === 0 ? " livelog__card--first" : ""} livelog__card--${tone}${cardLive ? " livelog__card--live" : ""}`}
              data-state={state}
              data-request-id={row.requestId ?? undefined}
            >
              <CardHead
                time={time} state={state} tone={badgeTone} live={cardLive} request={request}
                outcome={figures}
                row={row} rid={rid} onSelectRequest={onSelectRequest}
              />
              <div className="livelog__steps">
                <StepBox step={step} />
              </div>
              {reason ? <div className="livelog__detail mono livelog__reason" title={reason}>{reason}</div> : null}
            </li>
          </Fragment>
        );
      })}
    </>
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

/**
 * Plain-text transcript of the given calls (what is on screen), for pasting
 * into a bug report or chat. Free text is scrubbed like everything else shown;
 * only key indexes appear, never key values.
 */
export function formatRowsAsText(rows) {
  const clean = (value) => sanitizeText(value, { maxLength: 1000 });
  const blocks = (Array.isArray(rows) ? rows : []).filter(Boolean).map((row) => {
    const steps = Array.isArray(row.steps) ? row.steps : [];
    const head = [
      `[${formatClock(steps[0]?.startedAt ?? row.ts)}]`,
      row.state,
      row.pool === "vision" ? "VISION" : "TEXT",
      clean(requestText(row)),
      row.requestId ? `id ${row.requestId}` : null,
      describeOutcome(row, row.ts) ? `total ${describeOutcome(row, row.ts)}` : null
    ].filter(Boolean).join("  ");
    const lines = [head];

    if (steps.length === 0) {
      const target = clean(describeTarget(row));
      if (target) lines.push(`  ${target}`);
      if (row.reason) lines.push(`  ${clean(row.reason)}`);
      return lines.join("\n");
    }

    steps.forEach((step, index) => {
      if (index > 0 && steps[index - 1].state === STEP.FAILED) {
        const prev = steps[index - 1];
        const why = clean([Number.isInteger(prev.status) ? String(prev.status) : null, prev.reason].filter(Boolean).join(" · "));
        lines.push(`  ↓ FALLBACK${why ? ` · ${why}` : ""}`);
      }
      const figures = describeStepOutcome(step, step.startedAt);
      lines.push(`  ${index + 1}. ${step.state}  ${clean(describeTarget(step))}${figures ? `  (${figures})` : ""}`);
      if (step.state === STEP.FAILED) {
        const why = clean([step.reason, step.detail].filter(Boolean).join(" · "));
        if (why) lines.push(`     ${why}`);
      }
    });
    if (row.reason) lines.push(`  ${clean(row.reason)}`);
    return lines.join("\n");
  });
  return blocks.join("\n\n");
}
