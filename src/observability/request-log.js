import { sanitizeMessage } from "./sanitize.js";

export const DEFAULT_MAX_ENTRIES = 500;

export const OUTCOMES = Object.freeze({
  SUCCESS: "success",
  FAILED: "failed"
});

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
    this.sequence = 0;
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

    const attempts = (Array.isArray(entry.attempts) ? entry.attempts : []).map((attempt, index) => ({
      index: index + 1,
      provider: attempt?.provider ?? null,
      model: attempt?.model ?? null,
      keyIndex: Number.isInteger(attempt?.keyIndex) ? attempt.keyIndex : null,
      protocol: attempt?.protocol ?? null,
      // A skipped attempt never reached the network; only real attempts count
      // toward the fallback total the UI shows.
      ok: attempt?.ok === true,
      status: Number.isInteger(attempt?.status) ? attempt.status : null,
      latencyMs: Number.isFinite(attempt?.latencyMs) ? attempt.latencyMs : null,
      errorMessage: sanitizeMessage(attempt?.errorMessage)
    }));

    const stored = {
      seq: this.sequence,
      id: entry.id ?? null,
      receivedAt: entry.receivedAt ?? null,
      completedAt: entry.completedAt ?? null,
      protocol: entry.protocol ?? null,
      requestedModel: sanitizeMessage(entry.requestedModel, { maxLength: 120 }),
      autoRouted: entry.autoRouted === true,
      streamed: entry.streamed === true,
      attempts,
      attemptCount: attempts.length,
      fallbackCount: Math.max(0, attempts.length - 1),
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
  list({ limit = 50, cursor = null, status = null, provider = null, protocol = null, outcome = null } = {}) {
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
  }
}

export const requestLog = new RequestLog();
