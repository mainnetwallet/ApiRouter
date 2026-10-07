import { describe, expect, it } from "vitest";

import { shouldRefreshOnResume } from "../polling.js";
import { HEALTH_REFRESH_TIMEOUT_MS } from "../../api/health.js";

describe("polling resume rule", () => {
  const on = { visible: true, enabled: true };

  it("does not fetch on mount (the data owner already fetches once)", () => {
    expect(shouldRefreshOnResume(on, on)).toBe(false);
  });

  it("fetches when a hidden tab becomes visible", () => {
    expect(shouldRefreshOnResume({ visible: false, enabled: true }, on)).toBe(true);
  });

  it("fetches when polling is switched back on", () => {
    expect(shouldRefreshOnResume({ visible: true, enabled: false }, on)).toBe(true);
  });

  it("does nothing while hidden or disabled", () => {
    expect(shouldRefreshOnResume(on, { visible: false, enabled: true })).toBe(false);
    expect(shouldRefreshOnResume(on, { visible: true, enabled: false })).toBe(false);
    expect(shouldRefreshOnResume({ visible: false, enabled: false }, { visible: false, enabled: true })).toBe(false);
  });
});

describe("manual health refresh timeout", () => {
  it("is longer than the default 15 s request limit and than a worst-case probe cycle", () => {
    expect(HEALTH_REFRESH_TIMEOUT_MS).toBeGreaterThan(15_000);
    // 100 targets, 4 at a time, 10 s each ≈ 250 s
    expect(HEALTH_REFRESH_TIMEOUT_MS).toBeGreaterThanOrEqual(250_000);
  });
});
