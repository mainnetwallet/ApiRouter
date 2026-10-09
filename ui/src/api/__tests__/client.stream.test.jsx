import { describe, it, expect, vi, afterEach } from "vitest";

import { apiStream } from "../client.js";
import { sendPlaygroundRequest } from "../playground.js";
import { apiErrorFromException, apiErrorFromTimeout } from "../../lib/errors.js";

/**
 * Regression: streaming cancellation and timeout.
 *
 * `apiStream` used to clear its timeout and detach the caller's abort bridge in
 * a `finally` that ran the moment `fetch` resolved — i.e. when the response
 * HEADERS arrived. `fetch` resolves before the body is read, so for the whole
 * streaming phase (the entire point of the call):
 *
 *   - the timeout was already disarmed, so a body that stopped yielding hung
 *     the view forever;
 *   - the caller's signal had no listener, so the Playground's Stop button
 *     aborted a controller nothing was watching and the upstream call carried
 *     on, leaving `busy` true and the spinner turning.
 *
 * These tests assert on the signal actually handed to `fetch`, which is the
 * thing the fix controls.
 */

const SSE_HEADERS = { "content-type": "text/event-stream" };
const chatChunk = (text) => JSON.stringify({ choices: [{ index: 0, delta: { content: text } }] });
const sseFrame = (...payloads) => payloads.map((p) => `data: ${p}\n\n`).join("");

/** A `fetch` that records the signal it was given and returns `response`. */
function captureFetch(response) {
  const calls = [];
  const impl = (url, options) => {
    calls.push({ url, options, signal: options?.signal });
    return Promise.resolve(response);
  };
  return { impl, calls, signal: () => calls.at(-1)?.signal };
}

/** A body that yields `payload` and then stays open, erroring when `signal` aborts. */
function stallingStream(signal, payload) {
  return new ReadableStream({
    start(controller) {
      if (payload !== undefined) controller.enqueue(new TextEncoder().encode(payload));
      signal.addEventListener("abort", () => controller.error(new DOMException("Aborted", "AbortError")));
    }
  });
}

function streamingResponse(signal, payload) {
  return {
    ok: true,
    status: 200,
    headers: new Headers(SSE_HEADERS),
    body: stallingStream(signal, payload),
    text: async () => payload ?? ""
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("apiStream: the timer and the abort bridge outlive the headers", () => {
  it("keeps the fetch signal abortable by the caller after the headers arrive", async () => {
    const { impl, signal } = captureFetch(streamingResponse(new AbortController().signal, ""));
    vi.stubGlobal("fetch", impl);

    const caller = new AbortController();
    const { release } = await apiStream("/v1/chat/completions", { body: {}, signal: caller.signal, timeoutMs: 60_000 });

    expect(signal().aborted).toBe(false);
    caller.abort();
    // Before the fix the bridge had already been removed, so this stayed false.
    expect(signal().aborted).toBe(true);

    release();
  });

  it("keeps the timeout armed after the headers arrive (a stalled body is still bounded)", async () => {
    vi.useFakeTimers();
    const { impl, signal } = captureFetch(streamingResponse(new AbortController().signal, ""));
    vi.stubGlobal("fetch", impl);

    const { release } = await apiStream("/v1/chat/completions", { body: {}, timeoutMs: 5_000 });
    expect(signal().aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(5_001);
    // Before the fix the timer had been cleared when `fetch` resolved.
    expect(signal().aborted).toBe(true);

    release();
  });

  it("release drops both the timer and the abort bridge", async () => {
    vi.useFakeTimers();
    const { impl, signal } = captureFetch(streamingResponse(new AbortController().signal, ""));
    vi.stubGlobal("fetch", impl);

    const caller = new AbortController();
    const { release } = await apiStream("/v1/chat/completions", { body: {}, signal: caller.signal, timeoutMs: 5_000 });

    release();
    release(); // idempotent

    await vi.advanceTimersByTimeAsync(10_000);
    caller.abort();
    expect(signal().aborted).toBe(false);
  });

  it("reports a header-phase timeout as a timeout, not as a user cancellation", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", (_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
    }));

    const pending = apiStream("/v1/chat/completions", { body: {}, timeoutMs: 1_000 });
    const assertion = expect(pending).rejects.toMatchObject({ kind: "timeout", status: 408 });
    await vi.advanceTimersByTimeAsync(1_001);
    await assertion;
  });
});

describe("sendPlaygroundRequest: cancellation and timeouts reach the body reader", () => {
  it("streams a successful response, then releases the listener and the timer", async () => {
    const chunk = sseFrame(chatChunk("Hel"), chatChunk("lo"), "[DONE]");
    const { impl, signal } = captureFetch({
      ok: true,
      status: 200,
      headers: new Headers(SSE_HEADERS),
      text: async () => chunk,
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(chunk));
          controller.close();
        }
      })
    });
    vi.stubGlobal("fetch", impl);

    const caller = new AbortController();
    const deltas = [];
    const result = await sendPlaygroundRequest({
      protocol: "openai-chat",
      body: { model: "m", stream: true },
      signal: caller.signal,
      onDelta: (d) => deltas.push(d)
    });

    expect(result.text).toBe("Hello");
    expect(deltas).toEqual(["Hel", "lo"]);

    // Completion released everything: the finished request no longer reacts to
    // the caller's signal.
    caller.abort();
    expect(signal().aborted).toBe(false);
  });

  it("a caller abort during the body read is reported as a cancellation", async () => {
    vi.stubGlobal("fetch", (url, options) => Promise.resolve(streamingResponse(options.signal, sseFrame(chatChunk("par")))));

    const caller = new AbortController();
    const pending = sendPlaygroundRequest({
      protocol: "openai-chat",
      body: { model: "m", stream: true },
      signal: caller.signal
    });
    const assertion = expect(pending).rejects.toMatchObject({ kind: "abort" });
    // Let the request reach the body read, then press Stop.
    await Promise.resolve();
    caller.abort();
    await assertion;
  });

  it("a timeout during the body read is reported as a timeout, not a cancellation", async () => {
    // A real (short) deadline rather than fake timers: the point is that the
    // timer armed before the headers is still running while the body is read.
    vi.stubGlobal("fetch", (url, options) => Promise.resolve(streamingResponse(options.signal, sseFrame(chatChunk("par")))));

    await expect(
      sendPlaygroundRequest({ protocol: "openai-chat", body: { model: "m", stream: true }, timeoutMs: 50 })
    ).rejects.toMatchObject({ kind: "timeout", status: 408 });
  });

  it("a body stream error is normalized rather than escaping raw", async () => {
    vi.stubGlobal("fetch", () => Promise.resolve({
      ok: true,
      status: 200,
      headers: new Headers(SSE_HEADERS),
      text: async () => "",
      body: new ReadableStream({ start(controller) { controller.error(new Error("socket reset")); } })
    }));

    await expect(sendPlaygroundRequest({ protocol: "openai-chat", body: { model: "m", stream: true } }))
      .rejects.toMatchObject({ kind: "network" });
  });

  it("a non-SSE response takes the JSON path and still releases", async () => {
    vi.stubGlobal("fetch", () => Promise.resolve({
      ok: true,
      status: 200,
      headers: new Headers({ "content-type": "application/json" }),
      text: async () => JSON.stringify({ choices: [{ message: { content: "plain" } }] })
    }));

    const result = await sendPlaygroundRequest({ protocol: "openai-chat", body: { model: "m" } });
    expect(result.text).toBe("plain");
  });

  it("cancelling one request does not disturb a concurrent one", async () => {
    const signals = [];
    vi.stubGlobal("fetch", (url, options) => {
      signals.push(options.signal);
      return Promise.resolve(streamingResponse(options.signal, sseFrame(chatChunk("x"))));
    });

    const first = new AbortController();
    const pendingA = sendPlaygroundRequest({ protocol: "openai-chat", body: { model: "m", stream: true }, signal: first.signal });
    const assertionA = expect(pendingA).rejects.toMatchObject({ kind: "abort" });

    const second = new AbortController();
    const pendingB = sendPlaygroundRequest({ protocol: "openai-chat", body: { model: "m", stream: true }, signal: second.signal });

    await Promise.resolve();
    first.abort();
    await assertionA;

    expect(signals.length).toBe(2);
    expect(signals[0].aborted).toBe(true);
    // Each request gets its own fetch signal, so one cancellation is not the other's.
    expect(signals[1].aborted).toBe(false);

    second.abort();
    await expect(pendingB).rejects.toMatchObject({ kind: "abort" });
  });
});

describe("timeout classification", () => {
  it("a timeout is never classified as a user abort", () => {
    const timedOut = apiErrorFromTimeout();
    expect(timedOut.kind).toBe("timeout");
    expect(timedOut.category).toBe("timeout");
    expect(timedOut.kind).not.toBe("abort");
    expect(timedOut.message).toMatch(/timeout/i);
  });

  it("a real abort still classifies as an abort", () => {
    expect(apiErrorFromException(new DOMException("Aborted", "AbortError")).kind).toBe("abort");
  });
});
