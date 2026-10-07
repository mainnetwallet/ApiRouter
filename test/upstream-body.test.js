import test from "node:test";
import assert from "node:assert/strict";
import {
  readBoundedBody,
  bufferUpTo,
  guardUpstreamStream,
  STREAM_IDLE_TIMEOUT,
  UPSTREAM_DEADLINE_EXCEEDED,
  UPSTREAM_BODY_TOO_LARGE
} from "../src/upstream-body.js";

/**
 * A web stream that yields `chunks`, optionally paced, and records how many
 * chunks were pulled and whether the consumer cancelled it. Nothing here has a
 * Content-Length: the reader must bound the bytes it actually receives.
 */
function source(chunks, { delayMs = 0, hang = false } = {}) {
  const state = { pulled: 0, cancelled: false };
  let i = 0;
  const stream = new ReadableStream({
    async pull(controller) {
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
      if (i >= chunks.length) {
        if (hang) return new Promise(() => {});
        return controller.close();
      }
      state.pulled += 1;
      controller.enqueue(chunks[i++]);
    },
    cancel() { state.cancelled = true; }
  }, { highWaterMark: 0 });
  return { stream, state };
}
const bytes = (n, fill = 97) => new Uint8Array(n).fill(fill);

test("a small body is returned whole", async () => {
  const { stream } = source([Buffer.from("hello "), Buffer.from("world")]);
  const { body, truncated } = await readBoundedBody(stream, { maxBytes: 1024 });
  assert.equal(body.toString(), "hello world");
  assert.equal(truncated, false);
});

test("a body of exactly maxBytes is accepted", async () => {
  const { stream } = source([bytes(60), bytes(40)]);
  const { body } = await readBoundedBody(stream, { maxBytes: 100 });
  assert.equal(body.length, 100);
});

test("one byte over maxBytes is rejected", async () => {
  const { stream, state } = source([bytes(60), bytes(41), bytes(10)]);
  await assert.rejects(readBoundedBody(stream, { maxBytes: 100 }), (error) => {
    assert.equal(error.code, UPSTREAM_BODY_TOO_LARGE);
    assert.equal(error.streamCause, "upstream");
    return true;
  });
  assert.equal(state.cancelled, true, "the upstream is cancelled, not drained");
  assert.equal(state.pulled, 2, "nothing was read past the chunk that crossed the line");
});

test("an oversized chunked body with no length is stopped while it is being read", async () => {
  // 400 chunks of 1 MiB, the shape of the confirmed ~400 MB repro, against a 4 MiB limit.
  const { stream, state } = source(Array.from({ length: 400 }, () => bytes(1024 * 1024)));
  await assert.rejects(readBoundedBody(stream, { maxBytes: 4 * 1024 * 1024 }), { code: UPSTREAM_BODY_TOO_LARGE });
  assert.ok(state.pulled <= 5, `reading stopped at the limit, pulled ${state.pulled} chunks`);
  assert.equal(state.cancelled, true);
});

test("a Content-Length that lies low does not widen the limit", async () => {
  const { stream, state } = source([bytes(80), bytes(80)]);
  await assert.rejects(
    readBoundedBody(stream, { maxBytes: 100, declaredLength: 10 }),
    { code: UPSTREAM_BODY_TOO_LARGE }
  );
  assert.equal(state.pulled, 2, "the bytes were counted even though the header promised 10");
});

test("a Content-Length above the limit fails before any byte is read", async () => {
  const { stream, state } = source([bytes(10)]);
  await assert.rejects(
    readBoundedBody(stream, { maxBytes: 100, declaredLength: 5000 }),
    { code: UPSTREAM_BODY_TOO_LARGE }
  );
  assert.equal(state.pulled, 0);
  assert.equal(state.cancelled, true);
});

test("a Content-Length that lies high does not reject a body that fits", async () => {
  const { stream } = source([bytes(10)]);
  const { body } = await readBoundedBody(stream, { maxBytes: 100, declaredLength: 50 });
  assert.equal(body.length, 10);
});

test("overflow: truncate keeps the head, cancels the rest and does not throw", async () => {
  const { stream, state } = source([bytes(60, 97), bytes(60, 98), bytes(60, 99)]);
  const { body, truncated } = await readBoundedBody(stream, { maxBytes: 100, overflow: "truncate" });
  assert.equal(body.length, 100);
  assert.equal(truncated, true);
  assert.equal(body.subarray(60).toString(), "b".repeat(40));
  assert.equal(state.cancelled, true);
  assert.equal(state.pulled, 2);
});

test("maxBytes 0 disables the size limit", async () => {
  const { stream } = source([bytes(1000), bytes(1000)]);
  const { body } = await readBoundedBody(stream, { maxBytes: 0 });
  assert.equal(body.length, 2000);
});

test("an absolute deadline cuts a body that keeps trickling in", async () => {
  // A byte every 30 ms never trips a 500 ms idle bound; only the deadline can end it.
  const { stream, state } = source(Array.from({ length: 200 }, () => bytes(1)), { delayMs: 30 });
  const startedAt = Date.now();
  await assert.rejects(
    readBoundedBody(stream, { maxBytes: 1024, idleMs: 500, deadlineAt: Date.now() + 250 }),
    (error) => {
      assert.equal(error.code, UPSTREAM_DEADLINE_EXCEEDED);
      assert.equal(error.streamCause, "upstream");
      return true;
    }
  );
  assert.ok(Date.now() - startedAt < 1500, "ended near the deadline, not after the whole body");
  assert.equal(state.cancelled, true);
});

test("the idle bound still fires on a stalled body, independently of the deadline", async () => {
  const { stream } = source([bytes(1)], { hang: true });
  await assert.rejects(
    readBoundedBody(stream, { idleMs: 100, deadlineAt: Date.now() + 60_000 }),
    { code: STREAM_IDLE_TIMEOUT }
  );
});

test("a body that finishes before the deadline is not affected by it", async () => {
  const { stream } = source(Array.from({ length: 5 }, () => bytes(2)), { delayMs: 20 });
  const { body } = await readBoundedBody(stream, { idleMs: 500, deadlineAt: Date.now() + 5000 });
  assert.equal(body.length, 10);
});

test("an already-passed deadline fails immediately", async () => {
  const { stream } = source([bytes(1)]);
  await assert.rejects(readBoundedBody(stream, { deadlineAt: Date.now() - 1 }), { code: UPSTREAM_DEADLINE_EXCEEDED });
});

test("a read failure is tagged client when the client's signal aborted, upstream otherwise", async () => {
  const failing = () => new ReadableStream({ pull(controller) { controller.error(new Error("socket closed")); } });

  const gone = new AbortController();
  gone.abort();
  await assert.rejects(readBoundedBody(failing(), { clientSignal: gone.signal }), { streamCause: "client" });
  await assert.rejects(readBoundedBody(failing(), { clientSignal: new AbortController().signal }), { streamCause: "upstream" });
});

test("an upstream fault stays an upstream fault even when the client also left", async () => {
  const gone = new AbortController();
  gone.abort();
  const { stream } = source([bytes(1)], { hang: true });
  await assert.rejects(
    readBoundedBody(stream, { idleMs: 50, clientSignal: gone.signal }),
    { code: STREAM_IDLE_TIMEOUT, streamCause: "upstream" }
  );
});

test("guardUpstreamStream cancels the upstream when the consumer stops early", async () => {
  const { stream, state } = source([bytes(1), bytes(1), bytes(1)]);
  for await (const _ of guardUpstreamStream(stream, {})) break;
  assert.equal(state.cancelled, true);
});

test("bufferUpTo returns the body when it fits", async () => {
  const { stream } = source([Buffer.from("abc"), Buffer.from("def")]);
  const result = await bufferUpTo(stream, { maxBytes: 6 });
  assert.equal(result.buffered.toString(), "abcdef");
});

test("bufferUpTo past the limit replays every byte, in order, and holds at most limit + one chunk", async () => {
  const chunks = Array.from({ length: 10 }, (_, i) => Buffer.from(String(i).repeat(10)));
  const { stream, state } = source(chunks);
  const result = await bufferUpTo(stream, { maxBytes: 25 });
  assert.equal(result.buffered, null);
  assert.equal(state.pulled, 3, "inspection stopped one chunk after the limit");
  const out = [];
  for await (const chunk of result.replay) out.push(Buffer.from(chunk));
  assert.equal(Buffer.concat(out).toString(), Buffer.concat(chunks).toString(), "nothing lost or reordered");
});

test("bufferUpTo replay cancels the upstream if the consumer stops early", async () => {
  const { stream, state } = source(Array.from({ length: 10 }, () => bytes(10)));
  const result = await bufferUpTo(stream, { maxBytes: 5 });
  for await (const _ of result.replay) break;
  assert.equal(state.cancelled, true);
});
