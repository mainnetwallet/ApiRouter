/**
 * Smooth streaming reveal.
 *
 * Network chunks arrive in bursts (a provider may send 40 characters, then
 * nothing for 300 ms, then 200 characters). Rendering each chunk as it lands
 * looks jerky. This keeps a backlog of received text and reveals it a few
 * characters per animation frame, speeding up when the backlog grows so the
 * display never falls far behind the network — the way ChatGPT's reply flows.
 *
 * `emit(visibleText)` is called with the full text revealed so far.
 * `drain()` resolves once everything received has been revealed.
 * `flush()` reveals everything immediately (cancel / error / hidden tab).
 */

const MIN_CHARS_PER_FRAME = 2;
const CATCH_UP_DIVISOR = 10;
const FRAME_MS = 1000 / 60;

export function createSmoothStream(emit, {
  raf = (fn) => requestAnimationFrame(fn),
  caf = (id) => cancelAnimationFrame(id),
  now = () => performance.now(),
  isHidden = () => typeof document !== "undefined" && document.hidden
} = {}) {
  let received = "";
  let shown = 0;
  let frame = null;
  let last = 0;
  let waiters = [];

  const settle = () => {
    const pending = waiters;
    waiters = [];
    for (const resolve of pending) resolve();
  };

  const show = (count) => {
    shown = count;
    emit(received.slice(0, shown));
  };

  const tick = () => {
    frame = null;
    const time = now();
    const elapsed = last ? Math.min(time - last, 100) : FRAME_MS;
    last = time;

    const backlog = received.length - shown;
    if (backlog <= 0) {
      last = 0;
      settle();
      return;
    }

    const perFrame = Math.max(MIN_CHARS_PER_FRAME, Math.ceil(backlog / CATCH_UP_DIVISOR));
    const step = Math.max(1, Math.round(perFrame * (elapsed / FRAME_MS)));
    show(Math.min(received.length, shown + step));

    if (shown < received.length) frame = raf(tick);
    else {
      last = 0;
      settle();
    }
  };

  const schedule = () => {
    if (frame === null) frame = raf(tick);
  };

  return {
    push(delta) {
      if (!delta) return;
      received += delta;
      // Animation frames do not run in a background tab; do not stall there.
      if (isHidden()) {
        this.flush();
        return;
      }
      schedule();
    },
    flush() {
      if (frame !== null) {
        caf(frame);
        frame = null;
      }
      last = 0;
      if (shown < received.length) show(received.length);
      settle();
    },
    drain() {
      if (shown >= received.length) return Promise.resolve();
      schedule();
      return new Promise((resolve) => waiters.push(resolve));
    },
    get text() {
      return received;
    }
  };
}
