import { describeAttempt } from "./errors.js";
import { sanitizeText } from "./sanitize.js";

/**
 * Live Logs: turns request-log entries into a chronological execution timeline.
 *
 * Nothing here is invented. The gateway records every real upstream attempt on
 * the request entry (`attempts[]`), in the order `withFallback` made them, so
 * each event below maps to something that actually happened:
 *
 *   REQUEST START  the request reached the gateway
 *   ATTEMPT        the first upstream call (provider / model / key index)
 *   FAILED         an attempt returned an error (status + reason)
 *   FALLBACK       routing moved on and the *next recorded attempt* began
 *   SUCCESS        an attempt returned 2xx
 *   COMPLETE       the request finished (success or exhausted)
 *
 * A FALLBACK is only emitted when a later attempt exists in the record, so a
 * planned-but-never-executed target can never appear. Two keys on the same
 * model are two attempts and therefore two separate events.
 *
 * Only key *indexes* are ever carried — the log has no key values, and every
 * free-text field is scrubbed again here before it can reach the DOM.
 */

export const EVENT = Object.freeze({
  START: "REQUEST START",
  ATTEMPT: "ATTEMPT",
  FAILED: "FAILED",
  FALLBACK: "FALLBACK",
  SUCCESS: "SUCCESS",
  COMPLETE: "COMPLETE"
});

/** Badge tone per event type. */
export const EVENT_TONE = Object.freeze({
  [EVENT.START]: "info",
  [EVENT.ATTEMPT]: "neutral",
  [EVENT.FAILED]: "danger",
  [EVENT.FALLBACK]: "warn",
  [EVENT.SUCCESS]: "ok",
  [EVENT.COMPLETE]: "neutral"
});

/** Cap on retained events, so a long-open tab cannot grow without bound. */
export const MAX_EVENTS = 1500;

const isNum = (value) => typeof value === "number" && Number.isFinite(value);
const optInt = (value) => (Number.isInteger(value) ? value : null);
const optText = (value, maxLength = 300) => {
  const text = sanitizeText(value, { maxLength });
  return text ? text : null;
};

/**
 * Derive the ordered events for one request-log entry.
 * Tolerates any missing optional field; a malformed entry yields `[]`.
 */
export function buildEvents(entry) {
  if (!entry || typeof entry !== "object") return [];

  const seq = isNum(entry.seq) ? entry.seq : 0;
  const requestId = entry.id ? String(entry.id) : null;
  const attempts = Array.isArray(entry.attempts) ? entry.attempts.filter(Boolean) : [];
  const received = isNum(entry.receivedAt) ? entry.receivedAt : null;

  const events = [];
  let order = 0;
  const push = (event) => {
    events.push({
      seq,
      requestId,
      provider: null,
      model: null,
      keyIndex: null,
      status: null,
      durationMs: null,
      reason: null,
      outcome: null,
      attempt: null,
      ...event,
      order,
      id: `${seq}:${order}`
    });
    order += 1;
  };

  push({
    type: EVENT.START,
    ts: received,
    protocol: entry.protocol ?? null,
    reason: optText(entry.requestedModel, 120)
  });

  // Walk the attempts keeping a running clock, so entries recorded without a
  // per-attempt `startedAt` still get a monotonic, plausible timeline.
  let clock = received;
  attempts.forEach((attempt, index) => {
    const start = isNum(attempt.startedAt) ? attempt.startedAt : clock;
    const latency = isNum(attempt.latencyMs) ? attempt.latencyMs : null;
    const end = start !== null && latency !== null ? start + latency : start;
    if (end !== null) clock = end;

    const target = {
      provider: attempt.provider ?? null,
      model: attempt.model ?? null,
      keyIndex: optInt(attempt.keyIndex),
      attempt: index + 1
    };

    push({
      type: index === 0 ? EVENT.ATTEMPT : EVENT.FALLBACK,
      ts: start,
      ...target
    });

    const status = optInt(attempt.status);
    if (attempt.ok === true) {
      push({
        type: EVENT.SUCCESS,
        ts: end,
        ...target,
        status,
        durationMs: latency,
        outcome: "success"
      });
    } else {
      const verdict = describeAttempt(attempt);
      push({
        type: EVENT.FAILED,
        ts: end,
        ...target,
        status,
        durationMs: latency,
        reason: verdict.label,
        detail: optText(attempt.errorMessage),
        outcome: "failed"
      });
    }
  });

  const total = isNum(entry.totalMs) ? entry.totalMs : isNum(entry.latencyMs) ? entry.latencyMs : null;
  const completedTs = isNum(entry.completedAt)
    ? entry.completedAt
    : received !== null && total !== null
      ? received + total
      : clock;
  const failed = entry.outcome === "failed";

  push({
    type: EVENT.COMPLETE,
    ts: completedTs,
    provider: entry.finalProvider ?? null,
    model: entry.finalModel ?? null,
    keyIndex: optInt(entry.finalKeyIndex),
    status: optInt(entry.httpStatus),
    durationMs: total,
    reason: failed ? optText(entry.errorMessage) ?? optText(entry.errorType, 60) : null,
    outcome: failed ? "failed" : "success"
  });

  return events;
}

/** Chronological order; ties fall back to arrival (seq) then in-request order. */
export function compareEvents(a, b) {
  const at = isNum(a.ts) ? a.ts : null;
  const bt = isNum(b.ts) ? b.ts : null;
  if (at !== null && bt !== null && at !== bt) return at - bt;
  if (a.seq !== b.seq) return a.seq - b.seq;
  return a.order - b.order;
}

/**
 * Merge freshly derived events into the current list: de-duplicated by event
 * id, sorted chronologically, newest last, and capped at `MAX_EVENTS`.
 */
export function mergeEvents(current, incoming, { max = MAX_EVENTS } = {}) {
  if (!incoming || incoming.length === 0) return current;

  const byId = new Map(current.map((event) => [event.id, event]));
  for (const event of incoming) byId.set(event.id, event);

  const merged = [...byId.values()].sort(compareEvents);
  return merged.length > max ? merged.slice(merged.length - max) : merged;
}

/**
 * Convert a newest-first page from `/api/requests` into new events.
 *
 * `afterSeq` is the highest sequence already ingested, so polling the same page
 * twice adds nothing. If the newest entry's seq is *lower* than `afterSeq` the
 * gateway restarted (its counter reset) and ingestion starts over.
 */
export function ingestEntries(entries, afterSeq = 0) {
  const list = Array.isArray(entries) ? entries.filter((entry) => entry && isNum(entry.seq)) : [];
  if (list.length === 0) return { events: [], maxSeq: afterSeq, restarted: false };

  const newest = Math.max(...list.map((entry) => entry.seq));
  const restarted = newest < afterSeq;
  const floor = restarted ? 0 : afterSeq;

  const fresh = list.filter((entry) => entry.seq > floor).sort((a, b) => a.seq - b.seq);
  return {
    events: fresh.flatMap(buildEvents),
    maxSeq: newest,
    restarted
  };
}

/** Text a search box matches against. Never includes anything but display fields. */
function haystack(event) {
  return [
    event.type, event.requestId, event.provider, event.model,
    Number.isInteger(event.keyIndex) ? `key ${event.keyIndex}` : "",
    event.status, event.reason, event.detail
  ].filter((part) => part !== null && part !== undefined).join(" ").toLowerCase();
}

/**
 * Apply the panel filters. `status` is "success" or "failed" and matches the
 * event's own outcome, so "failed" shows FAILED events (and failed COMPLETEs)
 * while neutral events such as ATTEMPT are hidden.
 */
export function filterEvents(events, { provider = null, status = null, search = "", requestId = "" } = {}) {
  const needle = String(search ?? "").trim().toLowerCase();
  const rid = String(requestId ?? "").trim().toLowerCase();

  return events.filter((event) => {
    if (provider && event.provider !== provider) return false;
    if (status && event.outcome !== status) return false;
    if (rid && !String(event.requestId ?? "").toLowerCase().includes(rid)) return false;
    if (needle && !haystack(event).includes(needle)) return false;
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
