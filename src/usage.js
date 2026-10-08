/**
 * Provider-reported token usage, normalised to `{ inputTokens, outputTokens, tokens }`.
 *
 * Only what the provider itself reports is ever returned. Nothing is estimated,
 * and a missing figure is `null`, never `0`.
 *
 * Shapes understood (the ones this gateway speaks):
 *   OpenAI chat       usage.prompt_tokens / completion_tokens / total_tokens
 *   OpenAI Responses  usage.input_tokens  / output_tokens     / total_tokens
 *   Anthropic         usage.input_tokens  / output_tokens
 *   Gemini            usageMetadata.promptTokenCount / candidatesTokenCount / totalTokenCount
 *
 * `tokens` is the provider's own total when it reports one; otherwise it is
 * input + output, and only when BOTH are known.
 */

const isCount = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0;
const count = (value) => (isCount(value) ? Math.round(value) : null);
const firstCount = (...values) => {
  for (const value of values) if (isCount(value)) return Math.round(value);
  return null;
};

export const NO_USAGE = Object.freeze({ inputTokens: null, outputTokens: null, tokens: null });

/** Does this usage carry at least one reported figure? */
export function hasUsage(usage) {
  return Boolean(usage) && (isCount(usage.inputTokens) || isCount(usage.outputTokens) || isCount(usage.tokens));
}

/**
 * Clean any `{ inputTokens, outputTokens, tokens | totalTokens }` into the
 * canonical shape. Invalid values become `null`; the total is derived only when
 * the provider gave none and both input and output are known.
 */
export function normalizeUsage(raw) {
  const inputTokens = count(raw?.inputTokens);
  const outputTokens = count(raw?.outputTokens);
  let tokens = firstCount(raw?.tokens, raw?.totalTokens);
  if (tokens === null && inputTokens !== null && outputTokens !== null) tokens = inputTokens + outputTokens;
  return { inputTokens, outputTokens, tokens };
}

/** One provider `usage` / `usageMetadata` object, or null when it reports nothing. */
function fromUsageObject(u) {
  if (!u || typeof u !== "object") return null;
  const found = {
    inputTokens: firstCount(u.prompt_tokens, u.input_tokens, u.promptTokenCount),
    outputTokens: firstCount(u.completion_tokens, u.output_tokens, u.candidatesTokenCount),
    tokens: firstCount(u.total_tokens, u.totalTokenCount)
  };
  return hasUsage(found) ? found : null;
}

/**
 * Usage reported more than once in a stream is cumulative, so a later figure
 * replaces an earlier one field by field; a field the later event omits keeps
 * the earlier value (Anthropic sends input in `message_start`, output in `message_delta`).
 */
export function mergeUsage(previous, next) {
  if (!previous) return next ?? null;
  if (!next) return previous;
  return {
    inputTokens: next.inputTokens ?? previous.inputTokens,
    outputTokens: next.outputTokens ?? previous.outputTokens,
    tokens: next.tokens ?? previous.tokens
  };
}

/**
 * Usage from a whole response body, or from one stream event, wherever the
 * protocol puts it. Returns the normalised shape, or `null` when none was reported.
 */
export function usageFrom(body) {
  const raw = reportedUsage(body);
  return raw ? normalizeUsage(raw) : null;
}

/**
 * What the body reported, WITHOUT a derived total. A stream merges these and derives
 * the total once at the end, so an early input + output sum can never outlive the
 * later figures it was computed from.
 */
function reportedUsage(body) {
  if (!body || typeof body !== "object") return null;
  let found = null;
  for (const candidate of [
    body.message?.usage,
    body.response?.usage,
    body.response?.usageMetadata,
    body.usage,
    body.usageMetadata
  ]) {
    found = mergeUsage(found, fromUsageObject(candidate));
  }
  return found;
}

/** Most characters of ONE SSE event's `data:` payload that are ever held while looking for usage. */
const MAX_EVENT_CHARS = 1 << 20;

/** Room for the `data:` field name, its optional space and a trailing CR around a payload of the limit. */
const LINE_OVERHEAD_CHARS = 8;

/**
 * Watches an SSE stream for usage WITHOUT touching it. Feed it the raw bytes
 * (`pushChunk`, any chunk boundaries, including inside a line or a multi-byte
 * character) or already-split event payloads (`pushData`), call `end()` when the
 * stream is over, and read `usage`. A malformed or oversized event is ignored.
 *
 * Memory is bounded, never by the length of the response or of one event:
 *   - the `data:` payload of the event being read is accumulated in ONE string
 *     that never exceeds `maxEventChars` (no per-line array, no join copy);
 *   - the unterminated line being read never exceeds `maxEventChars` plus a few
 *     characters of field name;
 *   - an event that would pass `maxEventChars` is dropped, its buffer is freed
 *     at once, and the rest of that event (up to its blank line) is discarded as
 *     it arrives, so a fragment of an oversized event is never parsed as a whole one.
 * Usage events are a few hundred characters, far below the limit. The limit
 * is counted in JS string characters (UTF-16 code units), not bytes.
 *
 * `maxLineChars` is accepted as the former name of `maxEventChars`.
 */
export function createSseUsageTap({ maxEventChars, maxLineChars } = {}) {
  const limit = maxEventChars ?? maxLineChars ?? MAX_EVENT_CHARS;
  const lineLimit = limit + LINE_OVERHEAD_CHARS;
  let merged = null;
  let carry = "";            // the unterminated line so far
  let skippingLine = false;  // an oversized line is being discarded up to its newline
  let eventData = "";        // the `data:` payload of the current event, <= limit
  let hasData = false;       // the current event has had a `data:` line
  let eventOverflow = false; // the current event passed the limit: ignore it to its blank line
  const decoder = new TextDecoder();

  const pushData = (data) => {
    // Cheap pre-filter: only events that mention usage are worth parsing.
    if (typeof data !== "string" || !data.includes("usage")) return;
    try { merged = mergeUsage(merged, reportedUsage(JSON.parse(data))); } catch { /* not JSON, or no usage */ }
  };

  const dropEvent = () => {
    eventData = "";
    eventOverflow = true;
  };

  const flushEvent = () => {
    if (hasData && !eventOverflow) pushData(eventData);
    eventData = "";
    hasData = false;
    eventOverflow = false;
  };

  const handleLine = (line) => {
    if (line === "") return flushEvent();
    if (eventOverflow || !line.startsWith("data:")) return undefined;
    const value = line.slice(5).replace(/^ /, "");
    if (eventData.length + (hasData ? 1 : 0) + value.length > limit) return dropEvent();
    eventData = hasData ? `${eventData}\n${value}` : value;
    hasData = true;
    return undefined;
  };

  const feed = (text) => {
    carry += text;
    let newline;
    while ((newline = carry.indexOf("\n")) !== -1) {
      const line = carry.slice(0, newline).replace(/\r$/, "");
      carry = carry.slice(newline + 1);
      if (skippingLine) skippingLine = false;
      else handleLine(line);
    }
    if (carry.length > lineLimit) {
      // An oversized `data:` line poisons its whole event; any other field is irrelevant.
      if (!skippingLine && carry.startsWith("data:")) dropEvent();
      carry = "";
      skippingLine = true;
    }
  };

  return {
    pushData,
    pushChunk(chunk) {
      feed(typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true }));
    },
    end() {
      feed(decoder.decode());
      if (carry && !skippingLine) handleLine(carry.replace(/\r$/, ""));
      carry = "";
      flushEvent();
    },
    /** Characters currently held (the partial line plus the current event's payload). */
    get retainedChars() { return carry.length + eventData.length; },
    get usage() { return merged ? normalizeUsage(merged) : null; }
  };
}

/**
 * Watches a plain JSON body (one that arrived without a usable Content-Length)
 * for usage. Holds at most `maxBytes`; a larger body is simply not inspected.
 */
export function createJsonUsageTap({ maxBytes = 1024 * 1024 } = {}) {
  const parts = [];
  let size = 0;
  let overflow = false;
  return {
    pushChunk(chunk) {
      if (overflow) return;
      const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      size += buffer.length;
      if (size > maxBytes) { overflow = true; parts.length = 0; return; }
      parts.push(buffer);
    },
    end() {},
    get usage() {
      if (overflow || parts.length === 0) return null;
      try { return usageFrom(JSON.parse(Buffer.concat(parts).toString("utf8"))); } catch { return null; }
    }
  };
}

/** Pass every byte chunk through UNCHANGED while the tap watches it. */
export async function* tapBytes(source, tap) {
  try {
    for await (const chunk of source) {
      try { tap.pushChunk(chunk); } catch { /* observability only */ }
      yield chunk;
    }
  } finally {
    try { tap.end(); } catch { /* observability only */ }
  }
}

/** Pass every SSE `data:` payload through UNCHANGED while the tap watches it. */
export async function* tapEvents(source, tap) {
  try {
    for await (const data of source) {
      try { tap.pushData(data); } catch { /* observability only */ }
      yield data;
    }
  } finally {
    try { tap.end(); } catch { /* observability only */ }
  }
}
