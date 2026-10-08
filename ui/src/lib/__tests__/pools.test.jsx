import { describe, expect, it } from "vitest";

import {
  CROSS_POOL_FALLBACK, MATRIX_FILTERS, POOL_VIEWS, ROUTING_FLOW_STEPS,
  buildProviderMatrix, describeCapabilities, filterMatrixRows, groupRankedByPool,
  matchesMatrixFilter, poolBadgeClass, poolLabel, summarizePool
} from "../pools.js";

/**
 * The Dashboard's pool separation, tested at the pure-logic layer.
 *
 * The recurring risk this file guards against is a text figure and a vision
 * figure being silently added together — the exact confusion the redesign
 * exists to remove. Every payload here is shaped like `/api/providers` sends
 * it, including the case of one provider configured in both pools.
 */

const health = (overrides = {}) => ({
  targets: 0, healthy: 0, cooldown: 0, failed: 0, unknown: 0,
  successes: 0, failures: 0, successRate: null, latencyMs: null, status: "unknown",
  ...overrides
});

// Gemini: configured in BOTH pools, with different numbers on each side.
const GEMINI_TEXT = {
  id: "gemini", pool: "text", configured: true,
  capabilities: { text: true, vision: true },
  textModels: ["gemini-text-1", "gemini-text-2"],
  visionModels: ["gemini-vision-1", "gemini-vision-2"],
  models: ["gemini-text-1", "gemini-text-2"],
  modelCount: 2, keyCount: 4, targetCount: 24, envPrefix: "GEMINI",
  protocols: ["gemini"],
  health: health({ targets: 24, healthy: 20, cooldown: 2, failed: 1, unknown: 1, latencyMs: 800 }),
  targets: []
};

const GEMINI_VISION = {
  id: "gemini", pool: "vision", configured: true,
  capabilities: { text: true, vision: true },
  textModels: ["gemini-text-1", "gemini-text-2"],
  visionModels: ["gemini-vision-1", "gemini-vision-2"],
  models: ["gemini-vision-1", "gemini-vision-2"],
  modelCount: 2, keyCount: 2, targetCount: 12, envPrefix: "GEMINI_VISION",
  protocols: ["gemini"],
  health: health({ targets: 12, healthy: 10, cooldown: 1, failed: 1, latencyMs: 1600 }),
  targets: []
};

// Groq: text only.
const GROQ_TEXT = {
  id: "groq", pool: "text", configured: true,
  capabilities: { text: true, vision: false },
  textModels: ["llama-3.1-8b"], visionModels: [],
  models: ["llama-3.1-8b"], modelCount: 1, keyCount: 3, targetCount: 3, envPrefix: "GROQ",
  protocols: ["openai-chat"],
  health: health({ targets: 3, healthy: 2, cooldown: 0, failed: 1, latencyMs: 900 }),
  targets: []
};

// LLM7: present in the vision list only.
const LLM7_VISION = {
  id: "llm7", pool: "vision", configured: true,
  capabilities: { text: false, vision: true },
  textModels: [], visionModels: ["llm7-vision"],
  models: ["llm7-vision"], modelCount: 1, keyCount: 1, targetCount: 1, envPrefix: "LLM7_VISION",
  protocols: ["openai-chat"],
  health: health({ targets: 1, healthy: 1, latencyMs: 2400 }),
  targets: []
};

const matrix = () => buildProviderMatrix({
  textProviders: [GEMINI_TEXT, GROQ_TEXT],
  visionProviders: [GEMINI_VISION, LLM7_VISION]
});

describe("buildProviderMatrix", () => {
  it("produces one row per provider, not one per pool record", () => {
    expect(matrix().map((row) => row.id)).toEqual(["gemini", "groq", "llm7"]);
  });

  it("keeps the two pools' records separate — never a merged total", () => {
    const gemini = matrix().find((row) => row.id === "gemini");
    expect(gemini.text.health.targets).toBe(24);
    expect(gemini.vision.health.targets).toBe(12);
    expect(gemini.text.keyCount).toBe(4);
    expect(gemini.vision.keyCount).toBe(2);
    // No combined 36/6 leaked onto the row.
    expect(gemini.targets).toBeUndefined();
    expect(gemini.keyCount).toBeUndefined();
  });

  it("derives capabilities per side, including a text-only provider", () => {
    const rows = matrix();
    expect(rows.find((row) => row.id === "gemini").capabilities).toEqual({ text: true, vision: true });
    expect(rows.find((row) => row.id === "groq").capabilities).toEqual({ text: true, vision: false });
    expect(rows.find((row) => row.id === "llm7").capabilities).toEqual({ text: false, vision: true });
  });

  it("leaves the absent side null rather than fabricating a record", () => {
    const rows = matrix();
    expect(rows.find((row) => row.id === "groq").vision).toBeNull();
    expect(rows.find((row) => row.id === "llm7").text).toBeNull();
  });

  it("tolerates an empty or malformed payload", () => {
    expect(buildProviderMatrix()).toEqual([]);
    expect(buildProviderMatrix({ textProviders: null, visionProviders: [null, {}] })).toEqual([]);
  });
});

describe("summarizePool", () => {
  const summary = {
    textCapableProviders: 2, visionCapableProviders: 2,
    configuredTargets: 27, configuredVisionTargets: 13
  };
  const poolSummary = {
    text: health({ total: 27, healthy: 22, cooldown: 2, failed: 2, unknown: 1, averageLatencyMs: 850 }),
    vision: health({ total: 13, healthy: 11, cooldown: 1, failed: 1, averageLatencyMs: 1700 })
  };

  it("counts only the requested pool's models, never the union", () => {
    const text = summarizePool({ pool: "text", providers: [GEMINI_TEXT, GROQ_TEXT], poolSummary: poolSummary.text });
    expect(text.models).toBe(3); // gemini-text-1/2 + llama, not the vision models
    const vision = summarizePool({ pool: "vision", providers: [GEMINI_VISION, LLM7_VISION], poolSummary: poolSummary.vision });
    expect(vision.models).toBe(3); // gemini-vision-1/2 + llm7-vision
  });

  it("deduplicates a model configured by two providers in the same pool", () => {
    const shared = { ...GROQ_TEXT, id: "other", textModels: ["gemini-text-1"] };
    const result = summarizePool({ pool: "text", providers: [GEMINI_TEXT, shared] });
    expect(result.models).toBe(2);
  });

  it("excludes the other pool's targets from the text summary", () => {
    const text = summarizePool({
      pool: "text", providers: [GEMINI_TEXT, GROQ_TEXT], summary, poolSummary: poolSummary.text
    });
    expect(text.targets).toBe(27); // configuredTargets, not 27 + 13
    expect(text.healthy).toBe(22);
    expect(text.healthPercent).toBeCloseTo(22 / 27);
  });

  it("prefers backend provider/target counts and falls back when absent", () => {
    const backed = summarizePool({ pool: "text", providers: [GEMINI_TEXT, GROQ_TEXT], summary });
    expect(backed.providers).toBe(2);
    expect(backed.targets).toBe(27);

    const recounted = summarizePool({ pool: "text", providers: [GEMINI_TEXT, GROQ_TEXT] });
    expect(recounted.providers).toBe(2);
    expect(recounted.targets).toBe(27); // 24 + 3 from the health rollups
  });

  it("reports a null health percentage when there are no targets", () => {
    const empty = summarizePool({ pool: "vision", providers: [] });
    expect(empty.targets).toBe(0);
    expect(empty.healthPercent).toBeNull();
  });

  it("ignores providers that are not configured", () => {
    const unconfigured = { ...GROQ_TEXT, id: "off", configured: false, health: health({ targets: 5, healthy: 5 }) };
    const result = summarizePool({ pool: "text", providers: [GROQ_TEXT, unconfigured] });
    expect(result.providers).toBe(1);
  });
});

describe("matrix filtering", () => {
  it("exposes the four capability filters and three pool views", () => {
    expect(MATRIX_FILTERS.map((filter) => filter.key))
      .toEqual(["all", "textOnly", "visionOnly", "both"]);
    expect(POOL_VIEWS.map((view) => view.key)).toEqual(["all", "text", "vision"]);
  });

  it("matches each capability filter", () => {
    expect(matchesMatrixFilter({ capabilities: { text: true, vision: true } }, "textOnly")).toBe(false);
    expect(matchesMatrixFilter({ capabilities: { text: true, vision: false } }, "textOnly")).toBe(true);
    expect(matchesMatrixFilter({ capabilities: { text: false, vision: true } }, "textOnly")).toBe(false);
    expect(matchesMatrixFilter({ capabilities: { text: true, vision: true } }, "both")).toBe(true);
    expect(matchesMatrixFilter({ capabilities: { text: false, vision: true } }, "visionOnly")).toBe(true);
    expect(matchesMatrixFilter({ capabilities: { text: true, vision: true } }, "visionOnly")).toBe(false);
  });

  it("filters rows by capability and by pool", () => {
    const rows = matrix();
    expect(filterMatrixRows(rows, { filterKey: "textOnly" }).map((r) => r.id)).toEqual(["groq"]);
    expect(filterMatrixRows(rows, { filterKey: "both" }).map((r) => r.id)).toEqual(["gemini"]);
    expect(filterMatrixRows(rows, { filterKey: "visionOnly" }).map((r) => r.id)).toEqual(["llm7"]);
    expect(filterMatrixRows(rows, { pool: "text" }).map((r) => r.id)).toEqual(["gemini", "groq"]);
    expect(filterMatrixRows(rows, { pool: "vision" }).map((r) => r.id)).toEqual(["gemini", "llm7"]);
  });

  it("searches provider ids, env prefixes and model names", () => {
    const rows = matrix();
    expect(filterMatrixRows(rows, { search: "llm7" }).map((r) => r.id)).toEqual(["llm7"]);
    expect(filterMatrixRows(rows, { search: "gemini-text-1" }).map((r) => r.id)).toEqual(["gemini"]);
    expect(filterMatrixRows(rows, { search: "  " }).map((r) => r.id)).toEqual(["gemini", "groq", "llm7"]);
  });
});

describe("describeCapabilities", () => {
  it("labels a text-only provider's missing side 'No vision'", () => {
    const described = describeCapabilities({ text: true, vision: false });
    expect(described.text).toMatchObject({ configured: true, label: "Text" });
    expect(described.vision).toMatchObject({ configured: false, label: "No vision" });
  });

  it("labels a vision-only provider's missing side 'No text'", () => {
    expect(describeCapabilities({ text: false, vision: true }).text.label).toBe("No text");
  });
});

describe("routing flow", () => {
  it("groups ranked targets by pool", () => {
    const grouped = groupRankedByPool([
      { rank: 1, pool: "text", provider: "groq" },
      { rank: 2, pool: "vision", provider: "gemini" },
      { rank: 3, provider: "groq" } // missing pool defaults to text
    ]);
    expect(grouped.text.map((entry) => entry.provider)).toEqual(["groq", "groq"]);
    expect(grouped.vision.map((entry) => entry.provider)).toEqual(["gemini"]);
  });

  it("carries an explicit no-cross-pool warning", () => {
    expect(CROSS_POOL_FALLBACK.blocked).toBe(true);
    expect(CROSS_POOL_FALLBACK.label).toBe("NO CROSS-POOL FALLBACK");
    const fallback = ROUTING_FLOW_STEPS.find((step) => step.key === "fallback");
    expect(fallback.warn).toBe(true);
    expect(fallback.detail).toBe(CROSS_POOL_FALLBACK.label);
  });
});

describe("pool labels", () => {
  it("labels and classes the two pools", () => {
    expect(poolLabel("text")).toBe("Text");
    expect(poolLabel("vision")).toBe("Vision");
    expect(poolBadgeClass("vision")).toBe("pool-badge--vision");
    expect(poolBadgeClass("text")).toBe("pool-badge--text");
  });
});
