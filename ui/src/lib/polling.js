/**
 * Pure rules for the polling hook, kept out of React so they can be tested.
 */

/**
 * Should the poller fetch right now because the page became usable again?
 *
 * True on the hidden -> visible edge and when polling is switched back on. False
 * on mount: the hook that owns the data already issues its own first fetch, and
 * a second one here only doubled every page's initial request (the first of the
 * pair was aborted by the second).
 */
export function shouldRefreshOnResume(previous, next) {
  if (!previous || !next) return false;
  const usable = Boolean(next.visible && next.enabled);
  const wasUsable = Boolean(previous.visible && previous.enabled);
  return usable && !wasUsable;
}
