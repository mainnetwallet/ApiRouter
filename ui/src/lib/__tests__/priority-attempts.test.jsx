import { describe, it, expect } from "vitest";
import { describeAttempt } from "../errors.js";
import { buildLifecycle, phaseLabel } from "../../components/domain/RequestTimeline.jsx";
import { ROUTING_FLOW_STEPS } from "../pools.js";

describe("fallback-chain attempts and skipped rows", () => {
  it("labels skipped rows by reason without calling them failures", () => {
    expect(describeAttempt({ ok: false, skipped: true, skipReason: "already_attempted" }).label).toBe("skipped · already attempted");
    expect(describeAttempt({ ok: false, skipped: true, skipReason: "cooldown" }).label).toBe("skipped · cooldown");
  });

  it("renders real recorded attempts with their phase, never inventing hops", () => {
    const entry = {
      protocol: "openai-chat", outcome: "success", finalProvider: "gemini", finalModel: "G2", httpStatus: 200, fallbackCount: 1,
      attempts: [
        { index: 1, phase: "chain", provider: "gemini", model: "G1", keyIndex: 0, ok: false, status: 429 },
        { index: 2, phase: "chain", provider: "gemini", model: "G1", keyIndex: 0, ok: false, skipped: true, skipReason: "already_attempted" },
        { index: 3, phase: "chain", provider: "gemini", model: "G2", keyIndex: 0, ok: true, status: 200 }
      ]
    };
    const stages = buildLifecycle(entry).filter((s) => s.key.startsWith("attempt-"));
    expect(stages.map((s) => s.stage)).toEqual([
      "Fallback chain · Target failed 1", "Fallback chain · Skipped 2", "Fallback chain · Target 3"
    ]);
    expect(stages[1].meta).toContain("skipped · already attempted");
    expect(phaseLabel({})).toBe("");
  });

  it("names the remembered phase distinctly from the chain phase", () => {
    expect(phaseLabel({ phase: "sticky" })).toBe("Remembered");
    expect(phaseLabel({ phase: "chain" })).toBe("Fallback chain");
    expect(phaseLabel({ phase: "auto" })).toBe("Automatic (health + latency)");
    expect(phaseLabel({ phase: "priority" })).toBe("", "a phase the router no longer emits is not labelled");
  });

  it("the routing flow walks the chain before falling back to the automatic order", () => {
    const keys = ROUTING_FLOW_STEPS.map((s) => s.key);
    expect(keys.indexOf("chain")).toBeLessThan(keys.indexOf("auto"));
    expect(keys.at(-1)).toBe("fallback");
    // The removed systems must not survive anywhere in the narrative.
    expect(keys).not.toContain("priority");
    expect(keys).not.toContain("select");
  });
});
