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
