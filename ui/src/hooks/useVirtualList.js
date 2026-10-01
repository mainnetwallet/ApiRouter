import { useMemo, useState } from "react";

/**
 * Fixed-height windowing for long tables.
 *
 * The request log can grow into the thousands of rows, and rendering them all
 * would make every poll expensive. Only the visible slice is rendered; the
 * spacer rows keep the scrollbar honest.
 *
 * `itemHeight` must match the CSS row height — the `.table--virtual` class
 * pins it so the two cannot drift.
 */
export function useVirtualList(rows, { itemHeight = 30, overscan = 8, viewportHeight = 480 } = {}) {
  const [scrollTop, setScrollTop] = useState(0);

  const total = rows.length;
  const visibleCount = Math.ceil(viewportHeight / itemHeight);

  const window = useMemo(() => {
    const start = Math.max(0, Math.floor(scrollTop / itemHeight) - overscan);
    const end = Math.min(total, start + visibleCount + overscan * 2);

    return {
      start,
      end,
      rows: rows.slice(start, end),
      paddingTop: start * itemHeight,
      paddingBottom: Math.max(0, (total - end) * itemHeight)
    };
  }, [rows, scrollTop, itemHeight, overscan, visibleCount, total]);

  const onScroll = (event) => setScrollTop(event.currentTarget.scrollTop);

  return {
    ...window,
    total,
    itemHeight,
    viewportHeight,
    onScroll,
    // Windowing only pays off past a certain size; below it, plain rendering
    // is simpler and avoids the spacer artefacts.
    enabled: total > visibleCount + overscan * 2
  };
}
