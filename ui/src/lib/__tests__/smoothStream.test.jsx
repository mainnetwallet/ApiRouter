import { describe, expect, it } from "vitest";
import { createSmoothStream } from "../smoothStream.js";

function harness() {
  let clock = 0;
  let queued = null;
  const seen = [];
  const stream = createSmoothStream((text) => seen.push(text), {
    raf: (fn) => { queued = fn; return 1; },
    caf: () => { queued = null; },
    now: () => clock,
    isHidden: () => false
  });
  const frame = () => {
    clock += 1000 / 60;
    const fn = queued;
    queued = null;
    fn?.();
  };
  return { stream, seen, frame, pending: () => queued !== null };
}

describe("smooth streaming", () => {
  it("reveals a burst a few characters per frame, never all at once", () => {
    const { stream, seen, frame } = harness();
    stream.push("hello world, this is a burst");
    frame();
    expect(seen.at(-1).length).toBeGreaterThan(0);
    expect(seen.at(-1).length).toBeLessThan("hello world, this is a burst".length);
  });

  it("always reveals a prefix of the received text, in order", () => {
    const { stream, seen, frame, pending } = harness();
    const full = "The quick brown fox jumps over the lazy dog.";
    stream.push(full);
    for (let i = 0; i < 200 && pending(); i += 1) frame();
    expect(seen.at(-1)).toBe(full);
    for (const text of seen) expect(full.startsWith(text)).toBe(true);
    for (let i = 1; i < seen.length; i += 1) expect(seen[i].length).toBeGreaterThan(seen[i - 1].length);
  });

  it("speeds up when the backlog is large so it does not lag behind", () => {
    const small = harness();
    small.stream.push("x".repeat(20));
    small.frame();
    const large = harness();
    large.stream.push("x".repeat(5000));
    large.frame();
    expect(large.seen.at(-1).length).toBeGreaterThan(small.seen.at(-1).length);
  });

  it("drain resolves once everything is revealed", async () => {
    const { stream, frame, pending } = harness();
    stream.push("some streamed reply text");
    let done = false;
    const drained = stream.drain().then(() => { done = true; });
    for (let i = 0; i < 200 && pending(); i += 1) frame();
    await drained;
    expect(done).toBe(true);
  });

  it("flush reveals everything immediately and resolves drain", async () => {
    const { stream, seen } = harness();
    stream.push("cancelled mid reply");
    const drained = stream.drain();
    stream.flush();
    await drained;
    expect(seen.at(-1)).toBe("cancelled mid reply");
  });
});
