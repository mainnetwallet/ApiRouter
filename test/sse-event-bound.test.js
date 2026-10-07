import test from "node:test";
import assert from "node:assert/strict";
import { sseData } from "../src/anthropic-bridge.js";
import { isUpstreamFault, UPSTREAM_SSE_EVENT_TOO_LARGE } from "../src/upstream-body.js";
import { DEFAULT_MAX_SSE_EVENT_BYTES, loadConfig } from "../src/config.js";

const enc = new TextEncoder();

/** A web stream that records whether the consumer cancelled it. */
function trackedStream(chunks) {
  const state = { cancelled: false, pulled: 0 };
  let i = 0;
  const stream = new ReadableStream({
    pull(controller) {
      if (i >= chunks.length) return controller.close();
      state.pulled += 1;
      controller.enqueue(enc.encode(chunks[i++]));
    },
    cancel() { state.cancelled = true; }
  });
  return { stream, state };
}

test("normal SSE events below the limit are delivered, including ones split across chunks", async () => {
  const { stream } = trackedStream(['data: {"a"', ":1}\n\ndata: ", "[DONE]\n\n"]);
  const got = [];
  for await (const d of sseData(stream, { maxEventBytes: 1024 })) got.push(d);
  assert.deepEqual(got, ['{"a":1}', "[DONE]"]);
});

test("many complete events whose total exceeds the limit are fine: only an INCOMPLETE event is bounded", async () => {
  const event = `data: ${"x".repeat(100)}\n\n`;
  const { stream } = trackedStream(Array.from({ length: 50 }, () => event));
  let count = 0;
  for await (const d of sseData(stream, { maxEventBytes: 512 })) { count += 1; assert.equal(d.length, 100); }
  assert.equal(count, 50);
});

test("an event of exactly the limit is accepted, one byte over is rejected", async () => {
  const limit = 64;
  const exact = trackedStream(["data: " + "y".repeat(limit - 6)]); // `limit` bytes, never delimited, then EOF
  const got = [];
  for await (const d of sseData(exact.stream, { maxEventBytes: limit })) got.push(d);
  assert.equal(got.length, 1, "the unterminated tail is still flushed at EOF");

  const over = trackedStream(["data: " + "y".repeat(limit - 5)]);
  await assert.rejects(async () => { for await (const _ of sseData(over.stream, { maxEventBytes: limit })); },
    (e) => e.code === UPSTREAM_SSE_EVENT_TOO_LARGE);
});

test("an oversized incomplete event fails deterministically WHILE receiving and cancels the upstream", async () => {
  const limit = 1024;
  const chunks = ["data: ", ...Array.from({ length: 1000 }, () => "z".repeat(512))]; // never a delimiter
  const { stream, state } = trackedStream(chunks);
  let error;
  try { for await (const _ of sseData(stream, { maxEventBytes: limit })); } catch (e) { error = e; }

  assert.ok(error, "must throw");
  assert.equal(error.code, UPSTREAM_SSE_EVENT_TOO_LARGE);
  assert.equal(error.status, 502);
  assert.equal(error.streamCause, "upstream", "classified as a provider fault, not a client abort");
  assert.equal(isUpstreamFault(error), true);
  assert.equal(state.cancelled, true, "the upstream stream was cancelled");
  assert.ok(state.pulled < 10, `stopped at the limit, not after buffering everything (pulled ${state.pulled} of ${chunks.length})`);
});

test("multi-byte text is measured in bytes, not characters", async () => {
  const { stream } = trackedStream(["data: " + "€".repeat(100)]); // 300 bytes, 100 chars
  await assert.rejects(async () => { for await (const _ of sseData(stream, { maxEventBytes: 200 })); },
    (e) => e.code === UPSTREAM_SSE_EVENT_TOO_LARGE);
});

test("MAX_SSE_EVENT_BYTES: safe default, validated, 0 disables", () => {
  assert.equal(loadConfig({}).maxSseEventBytes, DEFAULT_MAX_SSE_EVENT_BYTES);
  assert.equal(DEFAULT_MAX_SSE_EVENT_BYTES, 8 * 1024 * 1024);
  assert.equal(loadConfig({ MAX_SSE_EVENT_BYTES: "0" }).maxSseEventBytes, 0);
  assert.equal(loadConfig({ MAX_SSE_EVENT_BYTES: "4096" }).maxSseEventBytes, 4096);
  for (const bad of ["-1", "abc", "1.5"]) {
    assert.throws(() => loadConfig({ MAX_SSE_EVENT_BYTES: bad }), /Invalid MAX_SSE_EVENT_BYTES/, bad);
  }
  // Existing settings are untouched.
  assert.equal(loadConfig({}).maxUpstreamBodyBytes, 33554432);
  assert.equal(loadConfig({}).streamTotalTimeoutMs, 1800000);
});

// ---------------------------------------------------------------------------
// Hard byte bound regression tests. The limit must hold on the bytes of the
// INCOMPLETE event as they arrive, whatever size the incoming chunk is.
// ---------------------------------------------------------------------------

/**
 * A web stream of raw byte chunks (strings are UTF-8 encoded), recording cancellation.
 * `hold: true` keeps the stream open after the last chunk (a provider that has not
 * finished), so that a cancel reaches the source instead of hitting a closed stream.
 * A held stream is closed after 150 ms if nobody cancelled it, so an implementation
 * that wrongly accepts the data fails its assertions instead of hanging the run.
 */
function byteStream(chunks, { hold = false } = {}) {
  const state = { cancelled: false, pulled: 0 };
  let i = 0;
  let timer = null;
  const stream = new ReadableStream({
    pull(controller) {
      if (i >= chunks.length) {
        if (!hold) return controller.close();
        return new Promise((resolve) => {
          timer = setTimeout(() => { try { controller.close(); } catch { /* cancelled meanwhile */ } resolve(); }, 150);
        });
      }
      state.pulled += 1;
      const c = chunks[i++];
      controller.enqueue(typeof c === "string" ? enc.encode(c) : c);
    },
    cancel() { state.cancelled = true; clearTimeout(timer); }
  });
  return { stream, state };
}

async function collect(stream, maxEventBytes) {
  const got = [];
  let error = null;
  try { for await (const d of sseData(stream, { maxEventBytes })) got.push(d); } catch (e) { error = e; }
  return { got, error };
}

const tooLarge = (error) => error?.code === UPSTREAM_SSE_EVENT_TOO_LARGE;

/** Records the byte size of every input handed to TextDecoder#decode while `fn` runs. */
async function withDecodeSpy(fn) {
  const RealDecoder = globalThis.TextDecoder;
  const sizes = [];
  globalThis.TextDecoder = class SpyDecoder extends RealDecoder {
    decode(input, options) {
      sizes.push(input?.byteLength ?? 0);
      return super.decode(input, options);
    }
  };
  try { await fn(); } finally { globalThis.TextDecoder = RealDecoder; }
  return sizes;
}

test("event of exactly the limit followed by its delimiter is accepted; one byte over is rejected", async () => {
  const limit = 80;
  const exact = byteStream(["data: " + "y".repeat(limit - 6) + "\n\n", "data: next\n\n"]);
  const ok = await collect(exact.stream, limit);
  assert.equal(ok.error, null);
  assert.deepEqual(ok.got, ["y".repeat(limit - 6), "next"]);

  const over = byteStream(["data: " + "y".repeat(limit - 5) + "\n\n", "data: next\n\n"], { hold: true });
  const bad = await collect(over.stream, limit);
  assert.ok(tooLarge(bad.error), "one byte over the limit is rejected even though its delimiter is present");
  assert.deepEqual(bad.got, []);
  assert.equal(over.state.cancelled, true);
});

test("REGRESSION: a single upstream chunk larger than the limit is never decoded or buffered whole", async () => {
  const limit = 1024;
  const huge = "data: " + "x".repeat(8 * 1024 * 1024); // one 8 MiB chunk, no delimiter
  const { stream, state } = byteStream([huge, "x".repeat(64)], { hold: true });
  let result;
  const decodeSizes = await withDecodeSpy(async () => { result = await collect(stream, limit); });

  assert.ok(tooLarge(result.error), "rejected with UPSTREAM_SSE_EVENT_TOO_LARGE");
  assert.equal(result.error.streamCause, "upstream");
  assert.equal(state.cancelled, true, "the upstream stream was cancelled");
  assert.ok(state.pulled <= 2, `read ahead at most one chunk (pulled ${state.pulled})`);
  const largest = Math.max(0, ...decodeSizes);
  assert.ok(largest <= limit + 4, `no decode call may exceed the limit; the largest took ${largest} bytes`);
});

test("REGRESSION: a complete event larger than the limit inside ONE chunk is rejected, not yielded", async () => {
  const limit = 256;
  const { stream, state } = byteStream(["data: " + "x".repeat(limit * 40) + "\n\ndata: after\n\n"], { hold: true });
  const { got, error } = await collect(stream, limit);
  assert.ok(tooLarge(error));
  assert.deepEqual(got, [], "the oversized event was not delivered");
  assert.equal(state.cancelled, true);
});

test("an oversized event followed by a delimiter in a later chunk is rejected without buffering it", async () => {
  const limit = 128;
  const { stream, state } = byteStream(["data: " + "x".repeat(100), "x".repeat(100) + "\n\n", ...Array.from({ length: 20 }, () => "data: after\n\n")], { hold: true });
  const { got, error } = await collect(stream, limit);
  assert.ok(tooLarge(error));
  assert.deepEqual(got, []);
  assert.equal(state.cancelled, true);
  assert.ok(state.pulled <= 3, `stopped as soon as the limit was crossed (pulled ${state.pulled} of 22)`);
});

test("one chunk holding a partial event, several normal events and an oversized event", async () => {
  const limit = 64;
  const first = byteStream(["data: par", `tial\n\ndata: one\n\ndata: two\r\n\r\ndata: three\n\ndata: ${"z".repeat(500)}\n\ndata: never\n\n`], { hold: true });
  const a = await collect(first.stream, limit);
  assert.deepEqual(a.got, ["partial", "one", "two", "three"], "everything before the oversized event is delivered intact");
  assert.ok(tooLarge(a.error));
  assert.equal(first.state.cancelled, true);

  // The same chunk without the oversized event passes in full, in order.
  const second = byteStream(["data: par", "tial\n\ndata: one\n\ndata: two\r\n\r\ndata: three\n\ndata: tail"]);
  const b = await collect(second.stream, limit);
  assert.equal(b.error, null);
  assert.deepEqual(b.got, ["partial", "one", "two", "three", "tail"]);
});

test("multiple normal events in one chunk, far above the limit in total, are all delivered", async () => {
  const limit = 128;
  const events = Array.from({ length: 200 }, (_, i) => `data: {"n":${i}}\n\n`);
  const { stream } = byteStream([events.join("")]);
  const { got, error } = await collect(stream, limit);
  assert.equal(error, null);
  assert.equal(got.length, 200);
  assert.equal(got[199], '{"n":199}');
});

test("the limit counts UTF-8 bytes, not UTF-16 characters, with and without a delimiter", async () => {
  // "data: " (6) + 10 x "€" (3 bytes each) = 36 bytes, but only 16 characters.
  const body = "data: " + "€".repeat(10);
  const ok = await collect(byteStream([body + "\n\n"]).stream, 36);
  assert.equal(ok.error, null);
  assert.deepEqual(ok.got, ["€".repeat(10)]);

  const bad = await collect(byteStream([body + "\n\n"]).stream, 35);
  assert.ok(tooLarge(bad.error), "36 bytes exceed 35 although 16 characters do not");

  const badNoDelimiter = await collect(byteStream([body]).stream, 35);
  assert.ok(tooLarge(badNoDelimiter.error));

  // Astral characters (4 bytes, 2 UTF-16 units) count as 4.
  const astral = await collect(byteStream(["data: " + "😀".repeat(5) + "\n\n"]).stream, 6 + 19);
  assert.ok(tooLarge(astral.error), "6 + 5 x 4 = 26 bytes exceed 25");
});

test("a multi-byte character split across chunks is reassembled at every possible split", async () => {
  const payload = enc.encode("data: a€😀é\n\ndata: ok\n\n");
  for (let cut = 1; cut < payload.length; cut += 1) {
    const { stream } = byteStream([payload.slice(0, cut), payload.slice(cut)]);
    const { got, error } = await collect(stream, 1024);
    assert.equal(error, null, `cut at ${cut}`);
    assert.deepEqual(got, ["a€😀é", "ok"], `cut at ${cut}`);
  }
  // One byte at a time.
  const singles = Array.from(payload, (b) => Uint8Array.of(b));
  const { got } = await collect(byteStream(singles).stream, 1024);
  assert.deepEqual(got, ["a€😀é", "ok"]);
});

test("the limit still applies when a multi-byte character is split across the limit boundary", async () => {
  const payload = enc.encode("data: " + "€".repeat(40)); // 126 bytes, no delimiter
  const { stream, state } = byteStream([payload.slice(0, 50), payload.slice(50, 51), payload.slice(51)], { hold: true });
  const { got, error } = await collect(stream, 100);
  assert.ok(tooLarge(error));
  assert.deepEqual(got, []);
  assert.equal(state.cancelled, true);
});

test("event delimiters split across chunks (LF, CRLF, mixed) are recognised", async () => {
  for (const delimiter of ["\n\n", "\r\n\r\n", "\n\r\n", "\r\n\n"]) {
    for (let cut = 1; cut < delimiter.length; cut += 1) {
      const { stream } = byteStream(["data: a" + delimiter.slice(0, cut), delimiter.slice(cut) + "data: b" + delimiter]);
      const { got, error } = await collect(stream, 64);
      assert.equal(error, null);
      assert.deepEqual(got, ["a", "b"], JSON.stringify({ delimiter, cut }));
    }
  }
});

test("chunks that are views into a larger buffer (non-zero byteOffset) are read correctly", async () => {
  const backing = Buffer.concat([Buffer.from("JUNKJUNK"), Buffer.from("data: view\n\ndata: two\n\n"), Buffer.from("JUNK")]);
  const view = backing.subarray(8, 8 + "data: view\n\ndata: two\n\n".length);
  const { got, error } = await collect(byteStream([view]).stream, 64);
  assert.equal(error, null);
  assert.deepEqual(got, ["view", "two"]);
});

test("limit 0 (or unset) leaves behaviour unchanged: a huge event passes", async () => {
  const big = "x".repeat(3 * 1024 * 1024);
  for (const options of [{ maxEventBytes: 0 }, {}]) {
    const { stream } = byteStream(["data: " + big + "\n\ndata: ", "tail"]);
    const got = [];
    for await (const d of sseData(stream, options)) got.push(d);
    assert.equal(got.length, 2);
    assert.equal(got[0].length, big.length);
    assert.equal(got[1], "tail");
  }
});

test("an unterminated final event within the limit is flushed at end of stream", async () => {
  const { got, error } = await collect(byteStream(["data: one\n\ndata: tail"]).stream, 64);
  assert.equal(error, null);
  assert.deepEqual(got, ["one", "tail"]);
});
