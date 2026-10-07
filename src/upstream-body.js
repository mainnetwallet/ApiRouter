/**
 * Bounded reading of upstream response bodies.
 *
 * Three independent bounds apply to a body after its headers arrived:
 *   - idle:     the gap between two chunks (`idleMs`, 0 disables)
 *   - deadline: an absolute wall-clock instant (`deadlineAt`, null disables)
 *   - size:     the bytes buffered in memory (`maxBytes`, 0 disables)
 *
 * Size is enforced WHILE reading, on the bytes actually received. A
 * `Content-Length` header is only ever used as an early hint to fail fast; a
 * chunked body, a body with no length and a body whose header lies are all held
 * to the same limit.
 *
 * Every failure carries `streamCause` ("client" when the client's own signal
 * aborted the read, "upstream" otherwise) so callers can cool a dead provider
 * without charging it for a client that walked away.
 */

export const DEFAULT_MAX_UPSTREAM_BODY_BYTES = 32 * 1024 * 1024;
/** Cap on a non-2xx body: only the first 2000 characters are ever surfaced. */
export const MAX_ERROR_BODY_BYTES = 64 * 1024;

export const STREAM_IDLE_TIMEOUT = "STREAM_IDLE_TIMEOUT";
export const UPSTREAM_DEADLINE_EXCEEDED = "UPSTREAM_DEADLINE_EXCEEDED";
export const UPSTREAM_BODY_TOO_LARGE = "UPSTREAM_BODY_TOO_LARGE";

const UPSTREAM_FAULT_CODES = new Set([STREAM_IDLE_TIMEOUT, UPSTREAM_DEADLINE_EXCEEDED, UPSTREAM_BODY_TOO_LARGE]);

/** True for failures that are the provider's doing even if the client also left. */
export function isUpstreamFault(error) {
  return UPSTREAM_FAULT_CODES.has(error?.code);
}

function bodyTooLarge(maxBytes) {
  const error = new Error(`Upstream response body exceeded the ${maxBytes} byte limit`);
  error.code = UPSTREAM_BODY_TOO_LARGE;
  error.status = 502;
  error.maxBytes = maxBytes;
  error.streamCause = "upstream";
  return error;
}

/**
 * Iterate a web stream under the idle and absolute-deadline bounds. The upstream
 * reader is cancelled when iteration ends for any reason, so a timeout, a size
 * limit or a client abort tears the provider connection down.
 */
export async function* guardUpstreamStream(webStream, { idleMs = 0, deadlineAt = null, clientSignal = null } = {}) {
  const reader = webStream.getReader();
  try {
    while (true) {
      let timer = null;
      let chunk;
      try {
        let waitMs = idleMs > 0 ? idleMs : null;
        let code = STREAM_IDLE_TIMEOUT;
        if (deadlineAt !== null && deadlineAt !== undefined) {
          const remaining = deadlineAt - Date.now();
          if (remaining <= 0) {
            const error = new Error("Upstream response exceeded the request deadline");
            error.code = UPSTREAM_DEADLINE_EXCEEDED;
            throw error;
          }
          if (waitMs === null || remaining < waitMs) { waitMs = remaining; code = UPSTREAM_DEADLINE_EXCEEDED; }
        }
        chunk = waitMs !== null
          ? await Promise.race([
            reader.read(),
            new Promise((_, reject) => {
              timer = setTimeout(() => {
                const error = new Error(code === STREAM_IDLE_TIMEOUT
                  ? "Upstream stream idle timeout"
                  : "Upstream response exceeded the request deadline");
                error.code = code;
                reject(error);
              }, waitMs);
            })
          ])
          : await reader.read();
      } catch (error) {
        error.streamCause = !isUpstreamFault(error) && clientSignal?.aborted ? "client" : "upstream";
        throw error;
      } finally {
        if (timer) clearTimeout(timer);
      }
      if (chunk.done) return;
      yield chunk.value;
    }
  } finally {
    try { await reader.cancel(); } catch { /* already closed */ }
  }
}

/**
 * Read a whole body into memory, never holding more than `maxBytes` (plus the
 * one chunk that crosses the line, which is dropped).
 *
 * `overflow: "throw"` (default) fails with UPSTREAM_BODY_TOO_LARGE;
 * `overflow: "truncate"` keeps the first `maxBytes` bytes and cancels the rest.
 * `declaredLength` is an optional early hint: a header that already promises
 * more than the limit fails before any byte is read. It is never trusted to
 * *allow* a body.
 */
export async function readBoundedBody(webStream, {
  maxBytes = DEFAULT_MAX_UPSTREAM_BODY_BYTES,
  overflow = "throw",
  declaredLength = null,
  idleMs = 0,
  deadlineAt = null,
  clientSignal = null
} = {}) {
  if (!webStream) return { body: Buffer.alloc(0), truncated: false };
  const limited = Number.isFinite(maxBytes) && maxBytes > 0;
  if (limited && overflow === "throw" && Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    try { await webStream.cancel(); } catch { /* already closed */ }
    throw bodyTooLarge(maxBytes);
  }
  const chunks = [];
  let total = 0;
  let truncated = false;
  for await (const chunk of guardUpstreamStream(webStream, { idleMs, deadlineAt, clientSignal })) {
    if (limited && total + chunk.length > maxBytes) {
      if (overflow === "truncate") {
        if (total < maxBytes) chunks.push(chunk.subarray(0, maxBytes - total));
        truncated = true;
        break; // leaving the loop closes the generator, which cancels the upstream
      }
      throw bodyTooLarge(maxBytes);
    }
    chunks.push(chunk);
    total += chunk.length;
  }
  return { body: Buffer.concat(chunks), truncated };
}

/**
 * Buffer a body only if it fits in `maxBytes`; otherwise hand back an iterable
 * that replays what was consumed and then continues with the rest, so the bytes
 * can still be streamed through unchanged. At most `maxBytes` plus one chunk is
 * ever held. Used for the usage-inspection of pass-through JSON bodies.
 *
 * Returns `{ buffered: Buffer }` when the body ended within the limit, or
 * `{ buffered: null, replay: AsyncIterable }` when it did not.
 */
export async function bufferUpTo(webStream, { maxBytes, idleMs = 0, deadlineAt = null, clientSignal = null } = {}) {
  const source = guardUpstreamStream(webStream, { idleMs, deadlineAt, clientSignal });
  const chunks = [];
  let total = 0;
  while (true) {
    const next = await source.next(); // a read failure propagates; the generator has cleaned up
    if (next.done) return { buffered: Buffer.concat(chunks) };
    chunks.push(next.value);
    total += next.value.length;
    if (total > maxBytes) {
      const consumed = chunks;
      return {
        buffered: null,
        replay: (async function* replay() {
          try {
            yield* consumed;
            yield* source;
          } finally {
            await source.return(); // cancel the upstream if the consumer stops early
          }
        })()
      };
    }
  }
}
