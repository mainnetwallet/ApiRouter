import { sanitizeMessage } from "./sanitize.js";

export const DEFAULT_MAX_ENTRIES = 500;

export const OUTCOMES = Object.freeze({
  SUCCESS: "success",
  FAILED: "failed"
});

/** The routing pool a request was served from. Anything unrecognised is text. */
export const POOLS = Object.freeze({
  TEXT: "text",
  VISION: "vision"
});

const normalizePool = (value) => (value === POOLS.VISION ? POOLS.VISION : POOLS.TEXT);

/**
 * In-flight requests are kept apart from completed ones (`entries`), so
 * analytics, the model catalogue and the Requests page never see a request
 * that has not finished. A request that never reports back is dropped after
 * this long, and the set is capped, so a leak cannot grow without bound.
 */
const PENDING_TTL_MS = 10 * 60 * 1000;
const MAX_PENDING = 200;

function normalizeAttempts(list) {
  return (Array.isArray(list) ? list : []).map((attempt, index) => ({
    index: index + 1,
    // "priority" | "fallback" | null (older callers); and whether this row was
    // skipped without a network call (cooldown / already attempted).
    phase: attempt?.phase === "priority" || attempt?.phase === "fallback" ? attempt.phase : null,
    skipped: attempt?.skipped === true,
    skipReason: attempt?.skipped === true && typeof attempt?.skipReason === "string" ? attempt.skipReason : null,
    provider: attempt?.provider ?? null,
    model: attempt?.model ?? null,
    keyIndex: Number.isInteger(attempt?.keyIndex) ? attempt.keyIndex : null,
    protocol: attempt?.protocol ?? null,
    // A skipped attempt never reached the network; only real attempts count
    // toward the fallback total the UI shows.
    ok: attempt?.ok === true,
    status: Number.isInteger(attempt?.status) ? attempt.status : null,
    startedAt: Number.isFinite(attempt?.startedAt) ? attempt.startedAt : null,
    latencyMs: Number.isFinite(attempt?.latencyMs) ? attempt.latencyMs : null,
    errorMessage: sanitizeMessage(attempt?.errorMessage)
  }));
}

/**
 * Bounded, in-memory record of routed requests.
 *
 * Bounded because the gateway is long-running: an unbounded log would grow
 * without limit and eventually take the process down. The oldest entry is
 * evicted once `maxEntries` is reached, which is the right trade-off for an
 * operational view (recent history beats complete history for debugging).
 *
 * The stored shape is an explicit allow-list, in the same defensive style as
 * `HealthRegistry.describe`: request bodies, upstream bodies, headers and
 * credentials are never copied in, so they cannot leak later even if the
 * upstream error text contained them.
 */
export class RequestLog {
  constructor({ maxEntries = DEFAULT_MAX_ENTRIES } = {}) {
    this.maxEntries = maxEntries;
    this.entries = new Map();
    this.pendingEntries = new Map();
    this.sequence = 0;
    this.listeners = new Set();
  }

  /**
   * Be told the moment a request starts, moves, or finishes, so a live view can
   * be pushed to instead of polled. The listener gets `{ type, entry }` where
   * `type` is "pending" (a running request, as `pending()` lists it) or "entry"
   * (a completed one, as `list()` returns it). It is called synchronously, so it
   * must serialize `entry` before returning rather than hold on to it: pending
   * entries are updated in place. A throwing listener never affects the request.
   * Returns the function that unsubscribes.
   */
  subscribe(listener) {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  #emit(type, entry) {
    for (const listener of this.listeners) {
      try { listener({ type, entry }); } catch { /* observability only */ }
    }
  }

  #prunePending(now = Date.now()) {
    for (const [key, entry] of this.pendingEntries) {
      if (now - (entry.receivedAt ?? now) > PENDING_TTL_MS) this.pendingEntries.delete(key);
    }
    while (this.pendingEntries.size > MAX_PENDING) {
      this.pendingEntries.delete(this.pendingEntries.keys().next().value);
    }
  }

  /**
   * Register a request that has started but not finished, so a live view can
   * show it while it runs. Returns its `startSeq`; pass that as `pendingSeq`
   * to `record()` when the request completes and the pending entry is retired.
   * Same allow-list rule as `record()`: no bodies, headers or credentials.
   */
  begin(entry = {}) {
    this.sequence += 1;
    const startSeq = this.sequence;
    this.pendingEntries.set(startSeq, {
      startSeq,
      id: entry.id ?? null,
      receivedAt: Number.isFinite(entry.receivedAt) ? entry.receivedAt : Date.now(),
      protocol: entry.protocol ?? null,
      pool: normalizePool(entry.pool),
      requestedModel: sanitizeMessage(entry.requestedModel, { maxLength: 120 }),
      outcome: "pending",
      attempts: [],
      attemptCount: 0,
      fallbackCount: 0,
      inflight: null
    });
    this.#prunePending();
    this.#emit("pending", this.pendingEntries.get(startSeq));
    return startSeq;
  }

  /**
   * Update a pending request: the attempts finished so far, and/or the attempt
   * currently on the wire (`inflight`, or `null` once it has answered).
   */
  progress(startSeq, { attempts, inflight } = {}) {
    const pending = this.pendingEntries.get(startSeq);
    if (!pending) return;
    if (attempts !== undefined) {
      pending.attempts = normalizeAttempts(attempts);
      const real = pending.attempts.filter((a) => !a.skipped).length;
      pending.attemptCount = real;
      pending.fallbackCount = Math.max(0, real - 1);
    }
    if (inflight !== undefined) {
      pending.inflight = inflight
        ? {
          provider: inflight.provider ?? null,
          model: inflight.model ?? null,
          keyIndex: Number.isInteger(inflight.keyIndex) ? inflight.keyIndex : null,
          protocol: inflight.protocol ?? null,
          startedAt: Number.isFinite(inflight.startedAt) ? inflight.startedAt : null
        }
        : null;
    }
    this.#emit("pending", pending);
  }

  /** Requests currently in flight, oldest first. */
  pending() {
    this.#prunePending();
    return [...this.pendingEntries.values()];
  }

  get size() {
    return this.entries.size;
  }

  /** Evict oldest-first by insertion order, which Map preserves. */
  #trim() {
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      this.entries.delete(oldest);
    }
  }

  /**
   * Store one completed request. `id` is caller-supplied so the id already
   * returned to the client in `x-multi-ai-session-id` can be reused as the
   * request id, keeping the UI and the wire in agreement.
   */
  record(entry = {}) {
    this.sequence += 1;

    const attempts = normalizeAttempts(entry.attempts);
    const startSeq = Number.isInteger(entry.pendingSeq) ? entry.pendingSeq : null;
    if (startSeq !== null) this.pendingEntries.delete(startSeq);

    const stored = {
      seq: this.sequence,
      // Order the request *began* in. Equals `seq` for a request that was never
      // registered as pending, so it is a stable key for a live view either way.
      startSeq: startSeq ?? this.sequence,
      id: entry.id ?? null,
      receivedAt: entry.receivedAt ?? null,
      completedAt: entry.completedAt ?? null,
      protocol: entry.protocol ?? null,
      pool: normalizePool(entry.pool),
      requestedModel: sanitizeMessage(entry.requestedModel, { maxLength: 120 }),
      autoRouted: entry.autoRouted === true,
      streamed: entry.streamed === true,
      attempts,
      attemptCount: attempts.filter((a) => !a.skipped).length,
      fallbackCount: Math.max(0, attempts.filter((a) => !a.skipped).length - 1),
      finalProvider: entry.finalProvider ?? null,
      finalModel: entry.finalModel ?? null,
      finalKeyIndex: Number.isInteger(entry.finalKeyIndex) ? entry.finalKeyIndex : null,
      httpStatus: Number.isInteger(entry.httpStatus) ? entry.httpStatus : null,
      latencyMs: Number.isFinite(entry.latencyMs) ? entry.latencyMs : null,
      totalMs: Number.isFinite(entry.totalMs) ? entry.totalMs : null,
      bytes: Number.isFinite(entry.bytes) ? entry.bytes : null,
      tokens: Number.isFinite(entry.tokens) ? entry.tokens : null,
      finishReason: sanitizeMessage(entry.finishReason, { maxLength: 60 }),
      errorType: entry.errorType ?? null,
      errorMessage: sanitizeMessage(entry.errorMessage),
      outcome: entry.outcome === OUTCOMES.FAILED ? OUTCOMES.FAILED : OUTCOMES.SUCCESS
    };

    this.entries.set(this.#keyOf(stored), stored);
    this.#trim();
    this.#emit("entry", stored);
    return stored;
  }

  /**
   * Entries are keyed by a synthetic monotonic key rather than by `id`, so a
   * request with no id (or a duplicated id) still occupies its own slot.
   */
  #keyOf(entry) {
    return `${entry.seq}`;
  }

  get(seq) {
    const key = String(seq);
    return this.entries.get(key) ?? null;
  }

  /** Look an entry up by its client-visible request id. */
  findById(id) {
    const wanted = String(id ?? "");
    if (!wanted) return null;
    for (const entry of this.entries.values()) {
      if (entry.id === wanted) return entry;
    }
    return null;
  }

  /**
   * Newest-first, cursor-paginated listing.
   *
   * The cursor is the `seq` to resume *after*, so a client paging with
   * `nextCursor` never sees a shifting window: new requests arriving
   * mid-pagination have higher sequence numbers and cannot reorder the page.
   */
  list({ limit = 50, cursor = null, status = null, provider = null, protocol = null, outcome = null, pool = null } = {}) {
    const size = Math.max(1, Math.min(Number(limit) || 50, this.maxEntries));

    // `Number(null)` is 0, which would match every sequence number and return
    // an empty page. Only a real cursor value constrains the window.
    const hasCursor = cursor !== null && cursor !== undefined && cursor !== "";
    const after = hasCursor ? Number(cursor) : NaN;

    const all = [...this.entries.values()].reverse();
    const filtered = all.filter((entry) => {
      if (Number.isFinite(after) && entry.seq >= after) return false;
      if (outcome && entry.outcome !== outcome) return false;
      if (protocol && entry.protocol !== protocol) return false;
      if (provider && entry.finalProvider !== provider) return false;
      // "text"/"vision" are the only pools; any other value is ignored rather
      // than treated as an empty filter, so a typo cannot silently hide rows.
      if ((pool === POOLS.TEXT || pool === POOLS.VISION) && entry.pool !== pool) return false;
      if (status && String(entry.httpStatus) !== String(status)) return false;
      return true;
    });

    const entries = filtered.slice(0, size);
    const last = entries.at(-1);
    const nextCursor = filtered.length > size && last ? last.seq : null;

    return {
      entries,
      returned: entries.length,
      matched: filtered.length,
      total: this.entries.size,
      nextCursor
    };
  }

  clear() {
    this.entries.clear();
    this.pendingEntries.clear();
  }
}

export const requestLog = new RequestLog();
