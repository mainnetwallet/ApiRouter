import { describe, it, expect } from "vitest";
import { describeAttempt } from "../errors.js";
import { buildLifecycle, phaseLabel } from "../../components/domain/RequestTimeline.jsx";
import { ROUTING_FLOW_STEPS } from "../pools.js";

describe("priority + skipped attempts", () => {
  it("labels skipped rows by reason without calling them failures", () => {
    expect(describeAttempt({ ok: false, skipped: true, skipReason: "already_attempted" }).label).toBe("skipped · already attempted");
    expect(describeAttempt({ ok: false, skipped: true, skipReason: "cooldown" }).label).toBe("skipped · cooldown");
  });

  it("renders real recorded attempts with their phase, never inventing hops", () => {
    const entry = {
      protocol: "openai-chat", outcome: "success", finalProvider: "gemini", finalModel: "G2", httpStatus: 200, fallbackCount: 1,
      attempts: [
        { index: 1, phase: "priority", provider: "gemini", model: "G1", keyIndex: 0, ok: false, status: 429 },
        { index: 2, phase: "fallback", provider: "gemini", model: "G1", keyIndex: 0, ok: false, skipped: true, skipReason: "already_attempted" },
        { index: 3, phase: "fallback", provider: "gemini", model: "G2", keyIndex: 0, ok: true, status: 200 }
      ]
    };
    const stages = buildLifecycle(entry).filter((s) => s.key.startsWith("attempt-"));
    expect(stages.map((s) => s.stage)).toEqual([
      "Priority · Target failed 1", "Normal fallback · Skipped 2", "Normal fallback · Target 3"
    ]);
    expect(stages[1].meta).toContain("skipped · already attempted");
    expect(phaseLabel({})).toBe("");
  });

  it("the routing flow shows priority before the Provider → Key → Models fallback", () => {
    const keys = ROUTING_FLOW_STEPS.map((s) => s.key);
    expect(keys.indexOf("priority")).toBeLessThan(keys.indexOf("select"));
    expect(keys.at(-1)).toBe("fallback");
  });
});
