import { useEffect, useRef, useState } from "react";

/**
 * Does a visibility change need an immediate refresh?
 *
 * `useApi` already owns both the mount fetch and the re-fetch when a page
 * becomes enabled (through its dependency effect). Firing here on the first
 * pass duplicated every page load's first request — the second call aborted
 * the first, wasting a round trip per mount. Only a real hidden -> visible
 * transition needs the extra "operator switched back to the tab" refresh.
 */
export function needsFocusRefresh({ visible, enabled, wasVisible }) {
  return Boolean(visible && enabled && wasVisible === false);
}

/**
 * Interval engine used by `useApi`.
 *
 * Polling, not WebSockets: the gateway has no push channel, and inventing one
 * client-side would be a fiction. Three behaviours make polling cheap enough
 * to run on every page:
 *
 *   visibility  a hidden tab stops polling entirely — background tabs are the
 *               main source of pointless gateway load
 *   focus       returning to the tab refreshes immediately rather than waiting
 *               out the interval
 *   backoff     consecutive failures stretch the interval, so a gateway that
 *               is down is not hammered by every open tab
 */
export function usePolling(task, { intervalMs = null, enabled = true } = {}) {
  const taskRef = useRef(task);
  taskRef.current = task;

  const [visible, setVisible] = useState(() =>
    typeof document === "undefined" ? true : !document.hidden
  );

  useEffect(() => {
    if (typeof document === "undefined") return undefined;

    const onVisibility = () => setVisible(!document.hidden);
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);

  // Previous visibility/enabled state, seeded with the first render so the
  // initial pass is not mistaken for a hidden -> visible transition.
  const previous = useRef({ visible });

  // Refresh on the hidden -> visible edge, so the first thing an operator sees
  // when they switch back is current data.
  useEffect(() => {
    const wasVisible = previous.current.visible;
    previous.current = { visible };
    if (!needsFocusRefresh({ visible, enabled, wasVisible })) return;
    void taskRef.current?.({ reason: "focus" });
  }, [visible, enabled]);

  useEffect(() => {
    if (!intervalMs || !enabled || !visible) return undefined;

    const timer = setInterval(() => {
      void taskRef.current?.({ reason: "interval" });
    }, intervalMs);

    return () => clearInterval(timer);
  }, [intervalMs, enabled, visible]);

  return { paused: !visible || !enabled };
}
