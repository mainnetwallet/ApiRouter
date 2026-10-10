import { describe, expect, it } from "vitest";
import {
  LATENCY_ORDERED_PHASES, latencyDecidesOrder, latencyOf, orderLatencyInfo, validLatencyMs
} from "../fallbackChain.js";

const step = (phase, extra = {}) => ({
  provider: "a", model: "m", keyIndex: 0, phase, orderLatencyMs: 900, orderLatencySource: "request", ...extra
});

describe("when latency decides a position", () => {
  it("only the phases the planner actually sorts by latency claim it", () => {
    expect([...LATENCY_ORDERED_PHASES].sort()).toEqual(["auto", "health-fallback", "health-retry"]);
    for (const phase of ["auto", "health-fallback", "health-retry"]) {
      expect(latencyDecidesOrder(step(phase)), phase).toBe(true);
    }
    for (const phase of ["chain", "manual-selection", "manual-retry", "sticky", null, undefined, "something-new"]) {
      expect(latencyDecidesOrder(step(phase)), String(phase)).toBe(false);
    }
    expect(latencyDecidesOrder(undefined)).toBe(false);
  });

  it("a saved selection: the figure is latency information, never 'ordered by'", () => {
    const info = orderLatencyInfo(step("manual-selection"));
    expect(info.decides).toBe(false);
    expect(info.label).toBe("latency");
    expect(info.ms).toBe(900);
    expect(info.title).toContain("saved Manual Model Selection order");
    expect(`${info.label} ${info.title}`.toLowerCase()).not.toContain("ordered by");
  });

  it("Manual Model Selection: saved steps never claim latency, the health batch does", () => {
    for (const phase of ["manual-selection", "manual-retry"]) {
      const info = orderLatencyInfo(step(phase));
      expect(info.label, phase).toBe("latency");
      expect(info.title, phase).toContain("Manual Model Selection order");
      expect(info.title.toLowerCase(), phase).not.toContain("ordered by");
    }
    for (const phase of ["health-fallback", "health-retry"]) {
      const info = orderLatencyInfo(step(phase));
      expect(info.label, phase).toBe("ordered by latency");
      expect(info.decides, phase).toBe(true);
    }
  });

  it("Automatic: the sorted steps claim latency, the remembered lead does not", () => {
    expect(orderLatencyInfo(step("auto")).label).toBe("ordered by latency");
    const lead = orderLatencyInfo(step("sticky"));
    expect(lead.label).toBe("latency");
    expect(lead.title).toContain("remembered target");
  });

  it("names the source honestly, and an unmeasured model never gets a number or a false claim", () => {
    expect(orderLatencyInfo(step("auto", { orderLatencySource: "probe" })).title).toContain("health-probe");
    expect(orderLatencyInfo(step("auto")).title).toContain("request-measured");

    const unmeasuredAuto = orderLatencyInfo(step("auto", { orderLatencyMs: null, orderLatencySource: null }));
    expect(unmeasuredAuto.ms).toBeNull();
    expect(unmeasuredAuto.title).toBe("Not measured — placed after measured models");

    // In a saved order an unmeasured model keeps its saved place: it is NOT "placed after measured models".
    const unmeasuredSaved = orderLatencyInfo(step("manual-selection", { orderLatencyMs: null, orderLatencySource: null }));
    expect(unmeasuredSaved.ms).toBeNull();
    expect(unmeasuredSaved.title).not.toContain("placed after");
  });

  it("ignores a non-numeric figure instead of showing it", () => {
    for (const bad of [null, undefined, NaN, "900", Infinity]) {
      expect(orderLatencyInfo(step("auto", { orderLatencyMs: bad })).ms, String(bad)).toBeNull();
    }
  });
});

describe("latencyOf with a key-restricted entry", () => {
  it("does not borrow the provider-wide figure once the gateway has reported the ordering figure as unmeasured", () => {
    // Eligible keys unmeasured; an excluded key was measured at 50 ms. The gateway says
    // `latencySource: null`, so the panel must say "not measured", not show 50 ms.
    expect(latencyOf({ latencyMs: null, latencySource: null, measuredLatencyMs: 50, probeLatencyMs: null }))
      .toEqual({ ms: null, source: null, label: "not measured" });
  });

  it("still falls back to the component figures for a payload that predates latencySource", () => {
    expect(latencyOf({ measuredLatencyMs: 120, probeLatencyMs: 900 }))
      .toEqual({ ms: 120, source: "request", label: "measured from requests" });
  });
});

describe("an unusable latency is never shown as a measurement", () => {
  const unusable = [0, -1, NaN, Infinity, -Infinity, null, undefined, "25", {}, true];

  it("validLatencyMs accepts only finite numbers above zero", () => {
    for (const v of unusable) expect(validLatencyMs(v), String(v)).toBeNull();
    expect(validLatencyMs(25)).toBe(25);
    expect(validLatencyMs(0.5)).toBe(0.5);
  });

  it("orderLatencyInfo: unusable figures are unmeasured, 25 is valid", () => {
    for (const v of unusable) {
      expect(orderLatencyInfo(step("auto", { orderLatencyMs: v })).ms, String(v)).toBeNull();
      expect(orderLatencyInfo(step("auto", { orderLatencyMs: v })).title).toContain("Not measured");
    }
    expect(orderLatencyInfo(step("auto", { orderLatencyMs: 25 })).ms).toBe(25);
  });

  it("latencyOf: unusable figures are unmeasured in every field, 25 is valid", () => {
    const none = { ms: null, source: null, label: "not measured" };
    for (const v of unusable) {
      expect(latencyOf({ latencyMs: v, latencySource: "request" }), `latencyMs ${String(v)}`).toEqual(none);
      expect(latencyOf({ measuredLatencyMs: v, probeLatencyMs: v }), `legacy ${String(v)}`).toEqual(none);
    }
    expect(latencyOf({ latencyMs: 25, latencySource: "request" }))
      .toEqual({ ms: 25, source: "request", label: "measured from requests" });
    expect(latencyOf({ latencyMs: 25, latencySource: "probe" }))
      .toEqual({ ms: 25, source: "probe", label: "from the health probe" });
  });

  it("legacy payload: an unusable request figure falls through to a valid probe figure; precedence unchanged", () => {
    expect(latencyOf({ measuredLatencyMs: 0, probeLatencyMs: 900 }))
      .toEqual({ ms: 900, source: "probe", label: "from the health probe" });
    expect(latencyOf({ measuredLatencyMs: 120, probeLatencyMs: 900 }))
      .toEqual({ ms: 120, source: "request", label: "measured from requests" });
  });
});
