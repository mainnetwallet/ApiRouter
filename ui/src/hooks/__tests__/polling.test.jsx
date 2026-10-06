import { describe, expect, it } from "vitest";

import { needsFocusRefresh } from "../usePolling.js";

// The double-fetch regression: `useApi` owns the mount fetch through its
// dependency effect, and `usePolling` used to fire the same fetch again on its
// first visible pass, aborting the request it had just started.

describe("polling focus refresh", () => {
  it("does not refresh on the first pass, because the mount fetch already ran", () => {
    expect(needsFocusRefresh({ visible: true, enabled: true, wasVisible: true })).toBe(false);
  });

  it("refreshes only on a real hidden -> visible transition", () => {
    expect(needsFocusRefresh({ visible: true, enabled: true, wasVisible: false })).toBe(true);
  });

  it("never refreshes while the tab is hidden or the caller is disabled", () => {
    expect(needsFocusRefresh({ visible: false, enabled: true, wasVisible: false })).toBe(false);
    expect(needsFocusRefresh({ visible: true, enabled: false, wasVisible: false })).toBe(false);
    expect(needsFocusRefresh({ visible: false, enabled: false, wasVisible: true })).toBe(false);
  });
});
