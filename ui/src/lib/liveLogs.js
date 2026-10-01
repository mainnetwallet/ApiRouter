import { describeAttempt } from "./errors.js";
import { sanitizeText } from "./sanitize.js";

/**
 * Live Logs: one row per API call, updated in place as the call progresses.
 *
 * Nothing here is invented. The gateway reports every request twice over the
 * life of the call: while it runs (`pending[]`: the attempts finished so far
 * and the attempt currently on the wire) and once it finishes (`entries[]`).
 * Both carry the same `startSeq`, so a row simply changes state:
 *
 *   ROUTING   the request reached the gateway, no upstream call has started
 *   RUNNING   the first upstream attempt is on the wire
 *   RETRYING  an earlier attempt failed and the router moved to another target
 *   SUCCESS   an attempt returned 2xx
 *   FAILED    every target failed (or the request was rejected up front)
 *
 * Every attempt is also kept as a box (`steps`) inside the row, so the card
 * shows each model the router tried: failed ones, the one on the wire, and the
 * one that answered.
 *
 * Only key *indexes* are ever carried — the log has no key values, and every
 * free-text field is scrubbed again here before it can reach the DOM.
 */

export const STATE = Object.freeze({
  ROUTING: "ROUTING",
  RUNNING: "RUNNING",
  RETRYING: "RETRYING",
  SUCCESS: "SUCCESS",
  FAILED: "FAILED"
});

/**
 * Inside a call, every attempt is its own box (a "step"):
 *
 *   ROUTING   waiting for the router to pick the (next) target
 *   CALLING   this target is on the wire right now
 *   FAILED    this target answered with an error or timed out; the router
 *             falls back to the next box
 *   SUCCESS   this target answered; the call is done
 */
export const STEP = Object.freeze({
  ROUTING: "ROUTING",
  CALLING: "CALLING",
  FAILED: "FAILED",
  SUCCESS: "SUCCESS"
});

export const STEP_TONE = Object.freeze({
  [STEP.ROUTING]: "neutral",
  [STEP.CALLING]: "info",
  [STEP.FAILED]: "danger",
  [STEP.SUCCESS]: "ok"
});

/** Badge tone per state. */
export const STATE_TONE = Object.freeze({
  [STATE.ROUTING]: "neutral",
  [STATE.RUNNING]: "info",
  [STATE.RETRYING]: "warn",
  [STATE.SUCCESS]: "ok",
  [STATE.FAILED]: "danger"
});

/** States in which a row is still changing. */
export const LIVE_STATES = Object.freeze([STATE.ROUTING, STATE.RUNNING, STATE.RETRYING]);
export const isLive = (row) => LIVE_STATES.includes(row?.state);

/**
 * Live Logs keeps the last 50 calls. When a newer call arrives past that, the
 * oldest one is dropped, so the view stays short and a long-open tab cannot grow.
 */
export const MAX_ROWS = 50;

const isNum = (value) => typeof value === "number" && Number.isFinite(value);
const optInt = (value) => (Number.isInteger(value) ? value : null);
const optText = (value, maxLength = 300) => {
  const text = sanitizeText(value, { maxLength });
  return text ? text : null;
};

function buildAttempt(attempt) {
  if (!attempt || typeof attempt !== "object") return null;
  const ok = attempt.ok === true;
  return {
    provider: attempt.provider ?? null,
    model: attempt.model ?? null,
    keyIndex: optInt(attempt.keyIndex),
    status: optInt(attempt.status),
    ok,
    startedAt: isNum(attempt.startedAt) ? attempt.startedAt : null,
    durationMs: isNum(attempt.latencyMs) ? attempt.latencyMs : null,
    reason: ok ? null : describeAttempt(attempt).label,
    detail: ok ? null : optText(attempt.errorMessage)
  };
}

/**
 * One box per attempt, in the order the router tried them. A running call adds
 * a CALLING box for the target on the wire, or a ROUTING placeholder while the
 * router is choosing the next one after a failure.
 */
function buildSteps(attempts, inflight, pending) {
  const steps = attempts.map((attempt) => ({
    ...attempt,
    state: attempt.ok ? STEP.SUCCESS : STEP.FAILED
  }));
  const last = attempts.at(-1) ?? null;

  if (pending && inflight) {
    steps.push({
      provider: inflight.provider ?? null,
      model: inflight.model ?? null,
      keyIndex: optInt(inflight.keyIndex),
      status: null,
      ok: false,
      startedAt: isNum(inflight.startedAt) ? inflight.startedAt : null,
      durationMs: null,
      reason: null,
      detail: null,
      state: STEP.CALLING
    });
  } else if (pending && (!last || !last.ok)) {
    steps.push({
      provider: null, model: null, keyIndex: null, status: null, ok: false,
      startedAt: null, durationMs: null, reason: null, detail: null,
      state: STEP.ROUTING
    });
  }
  return steps;
}

/**
 * Derive one row from a request-log entry or a pending entry.
 * Tolerates any missing optional field; a malformed entry yields `null`.
 */
export function buildRow(entry) {
  if (!entry || typeof entry !== "object") return null;

  const seq = isNum(entry.seq) ? entry.seq : 0;
  const key = isNum(entry.startSeq) ? entry.startSeq : seq;
  const pending = entry.outcome === "pending";
  const attempts = (Array.isArray(entry.attempts) ? entry.attempts : []).map(buildAttempt).filter(Boolean);
  const inflight = pending && entry.inflight && typeof entry.inflight === "object" ? entry.inflight : null;
  const lastAttempt = attempts.at(-1) ?? null;

  let state;
  if (pending) {
    // Earlier attempts only ever exist because they failed, so a target on the
    // wire after one is a retry. With nothing on the wire, a successful last
    // attempt means the body is still arriving (RUNNING), not another retry.
    if (inflight) state = attempts.length > 0 ? STATE.RETRYING : STATE.RUNNING;
    else if (attempts.length === 0) state = STATE.ROUTING;
    else state = lastAttempt.ok ? STATE.RUNNING : STATE.RETRYING;
  } else {
    state = entry.outcome === "failed" ? STATE.FAILED : STATE.SUCCESS;
  }

  // The target to show: the one on the wire, else the one that last answered.
  const target = pending
    ? (inflight ?? lastAttempt)
    : { provider: entry.finalProvider, model: entry.finalModel, keyIndex: entry.finalKeyIndex };

  const steps = buildSteps(attempts, inflight, pending);

  const total = isNum(entry.totalMs) ? entry.totalMs : isNum(entry.latencyMs) ? entry.latencyMs : null;
  const received = isNum(entry.receivedAt) ? entry.receivedAt : null;

  return {
    key,
    seq,
    requestId: entry.id ? String(entry.id) : null,
    state,
    pending,
    ts: received,
    protocol: entry.protocol ?? null,
    requestedModel: optText(entry.requestedModel, 120),
    provider: target?.provider ?? null,
    model: target?.model ?? null,
    keyIndex: optInt(target?.keyIndex),
    status: pending ? null : optInt(entry.httpStatus),
    durationMs: pending ? null : total,
    attemptStartedAt: inflight && isNum(inflight.startedAt) ? inflight.startedAt : null,
    attemptCount: attempts.length,
    // How far a running call has got: each finished attempt, then the one on
    // the wire. Lets an older snapshot be told apart from a newer event.
    progress: attempts.length * 2 + (inflight ? 1 : 0),
    steps,
    reason: state === STATE.FAILED ? (optText(entry.errorMessage) ?? optText(entry.errorType, 60)) : null
  };
}

/** Chronological order by start time; ties fall back to start order. */
export function compareRows(a, b) {
  const at = isNum(a.ts) ? a.ts : null;
  const bt = isNum(b.ts) ? b.ts : null;
  if (at !== null && bt !== null && at !== bt) return at - bt;
  return a.key - b.key;
}

/**
 * Does `next` describe the call at least as far along as `prev`? Rows arrive
 * from two places (pushed events and snapshots), and a snapshot taken a moment
 * earlier can land after a newer event. A finished call is never turned back
 * into a running one, and a running call never moves backwards.
 */
function supersedes(next, prev) {
  if (!prev) return true;
  if (!prev.pending && next.pending) return false;
  if (prev.pending && next.pending) return (next.progress ?? 0) >= (prev.progress ?? 0);
  return true;
}

/**
 * Upsert incoming rows by key (a running row is replaced by its next state),
 * sorted chronologically with the newest last, capped at `MAX_ROWS`.
 */
export function mergeRows(current, incoming, { max = MAX_ROWS } = {}) {
  if (!incoming || incoming.length === 0) return current;

  const byKey = new Map(current.map((row) => [row.key, row]));
  for (const row of incoming) {
    if (supersedes(row, byKey.get(row.key))) byKey.set(row.key, row);
  }

  const merged = [...byKey.values()].sort(compareRows);
  return merged.length > max ? merged.slice(merged.length - max) : merged;
}

/**
 * Turn one `/api/requests` payload into rows.
 *
 * `floor` is the highest sequence number the operator cleared, so cleared
 * requests do not come back on the next poll. `maxSeq` is the highest sequence
 * seen so far; a payload whose highest sequence is *lower* means the gateway
 * restarted (its counter reset) and the view starts over.
 */
export function ingestPayload(payload, { floor = 0, maxSeq = 0 } = {}) {
  const entries = Array.isArray(payload?.entries) ? payload.entries : [];
  const pending = Array.isArray(payload?.pending) ? payload.pending : [];
  const all = [...entries, ...pending].filter((entry) => entry && isNum(entry.seq ?? entry.startSeq));

  if (all.length === 0) return { rows: [], maxSeq, restarted: false };

  const newest = Math.max(...all.map((entry) => Math.max(entry.seq ?? 0, entry.startSeq ?? 0)));
  const restarted = newest < maxSeq;
  const lowest = restarted ? 0 : floor;

  const rows = all
    .map(buildRow)
    .filter((row) => row && row.key > lowest);

  return { rows, maxSeq: restarted ? newest : Math.max(newest, maxSeq), restarted };
}

/**
 * Turn one pushed event (`pending` or `entry`) into rows. Unlike a full
 * payload, a single event says nothing about the rest of the log, so it cannot
 * signal a gateway restart: an old call that is still running legitimately has
 * a lower sequence number than newer calls that already finished.
 */
export function ingestEvent(event, { floor = 0, maxSeq = 0 } = {}) {
  const entry = event?.data;
  if (!entry || typeof entry !== "object" || !isNum(entry.seq ?? entry.startSeq)) {
    return { rows: [], maxSeq };
  }
  const row = buildRow(entry);
  const newest = Math.max(entry.seq ?? 0, entry.startSeq ?? 0);
  return {
    rows: row && row.key > floor ? [row] : [],
    maxSeq: Math.max(newest, maxSeq)
  };
}

/** Text a search box matches against. Never includes anything but display fields. */
function haystack(row) {
  return [
    row.state, row.requestId, row.provider, row.model, row.protocol, row.requestedModel,
    Number.isInteger(row.keyIndex) ? `key ${row.keyIndex}` : "",
    row.status, row.reason,
    ...(row.steps ?? []).flatMap((attempt) => [
      attempt.provider, attempt.model, Number.isInteger(attempt.keyIndex) ? `key ${attempt.keyIndex}` : "",
      attempt.status, attempt.reason, attempt.detail
    ])
  ].filter((part) => part !== null && part !== undefined && part !== "").join(" ").toLowerCase();
}

/**
 * Apply the panel filters. `status` is "running", "success" or "failed";
 * "running" covers every row that has not finished yet.
 */
export function filterRows(rows, { provider = null, status = null, search = "", requestId = "" } = {}) {
  const needle = String(search ?? "").trim().toLowerCase();
  const rid = String(requestId ?? "").trim().toLowerCase();

  return rows.filter((row) => {
    if (provider && row.provider !== provider) return false;
    if (status === "running" && !row.pending) return false;
    if (status === "success" && row.state !== STATE.SUCCESS) return false;
    if (status === "failed" && row.state !== STATE.FAILED) return false;
    if (rid && !String(row.requestId ?? "").toLowerCase().includes(rid)) return false;
    if (needle && !haystack(row).includes(needle)) return false;
    return true;
  });
}

/** Is a scroll container within `threshold` px of its bottom edge? */
export function isNearBottom({ scrollTop, scrollHeight, clientHeight }, threshold = 24) {
  if (![scrollTop, scrollHeight, clientHeight].every(isNum)) return true;
  return scrollHeight - scrollTop - clientHeight <= threshold;
}

export function shortRequestId(id, length = 8) {
  if (!id) return null;
  const text = String(id);
  return text.length > length ? text.slice(0, length) : text;
}
