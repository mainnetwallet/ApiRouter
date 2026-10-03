import { describe, expect, it } from "vitest";

import {
  POOLS, filterChoices, filterTargets, findTarget, isRoutable, normalizeHealthPayload,
  normalizeModelPayload, normalizeTarget, providerOptions, summarizeTargets
} from "../targets.js";
import { sortRows } from "../table.js";

/**
 * These cover the two target-shaped pages: Models (`/api/models`) and Health
 * Monitor (`/api/health`).
 *
 * The recurring theme is the failure the Providers page once had — a page
 * reading a shape it did not actually receive. Every hostile payload below is
 * one the gateway could legitimately produce (an empty catalogue, a provider
 * with no health rollup, a target that has never been probed), plus the shapes
 * a proxy or a truncated response can produce.
 */

// A row exactly as `/api/models` sends it.
const MODEL_ROW = {
  id: "groq:llama-3.1-8b:key-0",
  provider: "groq",
  model: "llama-3.1-8b",
  keyIndex: 0,
  protocols: ["openai-chat"],
  status: "healthy",
  score: 82.5,
  latencyMs: 240,
  successes: 12,
  failures: 1,
  consecutiveFailures: 0,
  lastStatus: 200,
  lastReason: null,
  cooldownUntil: 0,
  updatedAt: "2026-01-01T12:00:00.000Z",
  successRate: 12 / 13,
  requests: 40,
  requestFailures: 2
};

const MODEL_PAYLOAD = {
  generatedAt: "2026-01-01T12:00:00.000Z",
  models: [
    MODEL_ROW,
    { ...MODEL_ROW, id: "groq:llama-3.1-8b:key-1", keyIndex: 1, status: "cooldown", cooldownUntil: 9e15, latencyMs: null },
    { ...MODEL_ROW, id: "zai:glm-4:key-0", provider: "zai", model: "glm-4", protocols: ["anthropic"], status: "failed", failures: 5, latencyMs: 900 }
  ],
  filters: { providers: ["groq", "zai"], protocols: ["anthropic", "openai-chat"], statuses: ["healthy", "cooldown", "failed", "unknown"] },
  summary: { total: 3, healthy: 1, cooldown: 1, failed: 1, unknown: 0, available: 2, averageLatencyMs: 570 }
};

const HEALTH_PAYLOAD = {
  ok: true,
  generatedAt: "2026-01-01T12:00:00.000Z",
  summary: { total: 3, healthy: 1, cooldown: 1, failed: 1, unknown: 0, available: 2, averageLatencyMs: 570 },
  providers: [{ provider: "groq", targets: 2 }],
  targets: [
    { ...MODEL_ROW, successRate: undefined, requests: undefined, requestFailures: undefined },
    { ...MODEL_ROW, id: "groq:llama-3.1-8b:key-1", keyIndex: 1, status: "cooldown", cooldownUntil: 9e15, latencyMs: null },
    { ...MODEL_ROW, id: "zai:glm-4:key-0", provider: "zai", model: "glm-4", protocols: ["anthropic"], status: "failed" }
  ],
  ranked: [{ rank: 1, id: "groq:llama-3.1-8b:key-0" }],
  monitor: { enabled: true, running: false, intervalMs: 900000 }
};

// ---------------------------------------------------------------------------
// Models page — GET /api/models
// ---------------------------------------------------------------------------

describe("Models page view model", () => {
  it("normalizes the catalogue the endpoint actually returns", () => {
    const view = normalizeModelPayload(MODEL_PAYLOAD);

    expect(view.rows).toHaveLength(3);
    expect(view.filters.providers).toEqual(["groq", "zai"]);
    expect(view.rows[0].protocols).toEqual(["openai-chat"]);
    expect(view.rows[0].successRate).toBeCloseTo(12 / 13);
  });

  it("builds the five summary cards the page renders", () => {
    const { summary } = normalizeModelPayload(MODEL_PAYLOAD);

    expect(summary.total).toBe(3);
    expect(summary.healthy).toBe(1);
    expect(summary.failed).toBe(1);
    expect(summary.providers).toBe(2);
    expect(summary.available).toBe(2);
  });

  it("renders an empty catalogue as zeros rather than throwing", () => {
    const view = normalizeModelPayload({ models: [], filters: { providers: [], protocols: [], statuses: [] }, summary: { total: 0, healthy: 0, cooldown: 0, failed: 0, unknown: 0, available: 0, averageLatencyMs: null } });

    expect(view.rows).toEqual([]);
    expect(view.summary.total).toBe(0);
    expect(view.summary.providers).toBe(0);
    expect(view.summary.available).toBe(0);
  });

  it("survives a failed or absent response", () => {
    // The page is rendered while `useApi` holds a null payload after an error.
    for (const payload of [null, undefined, {}, { models: null }, { models: "nope" }]) {
      const view = normalizeModelPayload(payload);
      expect(view.rows).toEqual([]);
      expect(view.summary.total).toBe(0);
      expect(view.summary.providers).toBe(0);
      // Latency with no samples is unavailable, not 0 ms.
      expect(view.summary.averageLatencyMs).toBeNull();
    }
  });

  it("recounts the cards when the backend sends no summary", () => {
    const { models } = MODEL_PAYLOAD;
    const view = normalizeModelPayload({ models });

    expect(view.summary.total).toBe(3);
    expect(view.summary.providers).toBe(2);
    expect(view.summary.available).toBe(2);
  });

  it("counts availability from the router's own predicate", () => {
    // A failed target whose cooldown has already elapsed is routable again.
    expect(isRoutable({ status: "failed", cooldownUntil: Date.now() - 1000 })).toBe(true);
    expect(isRoutable({ status: "cooldown", cooldownUntil: Date.now() + 60000 })).toBe(false);
    // No timestamp to compare: fall back to the reported status.
    expect(isRoutable({ status: "healthy", cooldownUntil: 0 })).toBe(true);
    expect(isRoutable({ status: "cooldown" })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Health Monitor page — GET /api/health
// ---------------------------------------------------------------------------

describe("Health Monitor page view model", () => {
  it("normalizes targets, rollups and monitor state", () => {
    const view = normalizeHealthPayload(HEALTH_PAYLOAD);

    expect(view.rows).toHaveLength(3);
    expect(view.providers).toHaveLength(1);
    expect(view.monitor.intervalMs).toBe(900000);
  });

  it("builds the six summary cards, including average latency", () => {
    const { summary } = normalizeHealthPayload(HEALTH_PAYLOAD);

    expect(summary).toMatchObject({
      total: 3, healthy: 1, failed: 1, cooldown: 1, unknown: 0, averageLatencyMs: 570
    });
  });

  it("treats a missing health object as unknown rather than crashing", () => {
    const view = normalizeHealthPayload({ targets: [{ provider: "groq", model: "m", keyIndex: 0 }] });

    expect(view.rows[0].status).toBe("unknown");
    expect(view.rows[0].score).toBeNull();
    expect(view.rows[0].latencyMs).toBeNull();
    expect(view.rows[0].successes).toBe(0);
    expect(view.rows[0].lastReason).toBeNull();
    expect(view.rows[0].updatedAt).toBeNull();
  });

  it("survives a failed or absent response", () => {
    for (const payload of [null, undefined, {}, { targets: null }, { targets: "nope" }]) {
      const view = normalizeHealthPayload(payload);
      expect(view.rows).toEqual([]);
      expect(view.summary.total).toBe(0);
      expect(view.summary.averageLatencyMs).toBeNull();
      // A null monitor must not be rendered as a monitor that is stopped.
      expect(view.monitor).toBeNull();
    }
  });

  it("never fabricates a zero for a measurement that was not taken", () => {
    const [row] = normalizeHealthPayload({ targets: [{ provider: "groq", model: "m", keyIndex: 0 }] }).rows;

    // "no latency recorded" and "0 ms" are different claims.
    expect(row.latencyMs).toBeNull();
    expect(row.score).toBeNull();
    expect(row.lastStatus).toBeNull();
    // Observation counters genuinely are zero.
    expect(row.successes).toBe(0);
    expect(row.failures).toBe(0);
  });

  it("averages latency over measuring targets only", () => {
    // `summarizeTargets` *is* the summary — the normalizers are what wrap it.
    const summary = summarizeTargets([
      { status: "healthy", latencyMs: 100 },
      { status: "unknown", latencyMs: null }
    ], null);

    expect(summary.averageLatencyMs).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// Hostile rows
// ---------------------------------------------------------------------------

describe("malformed rows", () => {
  const HOSTILE = [
    null,
    undefined,
    42,
    "a string",
    [],
    {},
    { provider: null, model: null, keyIndex: "zero", protocols: "openai-chat", status: "banana" },
    { provider: "groq", model: "m", keyIndex: 0, protocols: [null, "openai-chat", 7] },
    { provider: "groq", model: "m", keyIndex: 0, score: NaN, latencyMs: "fast", cooldownUntil: null }
  ];

  it("narrows any row to a safe shape", () => {
    for (const raw of HOSTILE) {
      const row = normalizeTarget(raw);

      expect(typeof row.id).toBe("string");
      expect(row.id.length).toBeGreaterThan(0);
      expect(typeof row.provider).toBe("string");
      expect(Array.isArray(row.protocols)).toBe(true);
      // An unrecognised status must not leak through to the badge.
      expect(["healthy", "cooldown", "failed", "unknown"]).toContain(row.status);
    }
  });

  it("drops non-string protocol entries rather than rendering them", () => {
    const row = normalizeTarget({ protocols: [null, "openai-chat", 7, ""] });
    expect(row.protocols).toEqual(["openai-chat"]);
  });

  it("keeps a synthetic id unique when the backend sent none", () => {
    const rows = [normalizeTarget({ provider: "a", model: "m" }, 0), normalizeTarget({ provider: "a", model: "m" }, 1)];
    expect(rows[0].id).not.toBe(rows[1].id);
  });

  it("does not throw in any accessor a table column or drawer reads", () => {
    // Mirrors every `get`/render accessor on both pages. This is the regression
    // guard for "Cannot read properties of undefined".
    const accessors = [
      (r) => r.provider, (r) => r.model, (r) => r.keyIndex, (r) => r.protocols[0] ?? "",
      (r) => r.status, (r) => r.score, (r) => r.latencyMs, (r) => r.successes,
      (r) => r.failures, (r) => r.consecutiveFailures, (r) => r.lastStatus,
      (r) => r.lastReason ?? "", (r) => r.updatedAt, (r) => r.cooldownUntil,
      (r) => r.protocols.map((p) => p).join(", "), (r) => r.id
    ];

    for (const raw of HOSTILE) {
      const row = normalizeTarget(raw);
      for (const accessor of accessors) {
        expect(() => accessor(row)).not.toThrow();
      }
    }
  });

  it("normalizes a payload full of hostile rows without throwing", () => {
    const view = normalizeModelPayload({ models: HOSTILE, filters: { providers: [null, "groq", 7] } });

    expect(view.rows).toHaveLength(HOSTILE.length);
    expect(view.filters.providers).toEqual(["groq"]);
    expect(view.summary.total).toBe(HOSTILE.length);
  });
});

// ---------------------------------------------------------------------------
// Filtering and sorting
// ---------------------------------------------------------------------------

describe("target filtering", () => {
  const rows = normalizeModelPayload(MODEL_PAYLOAD).rows;

  it("filters by provider, protocol and status", () => {
    expect(filterTargets(rows, { provider: "zai" })).toHaveLength(1);
    expect(filterTargets(rows, { protocol: "anthropic" })).toHaveLength(1);
    expect(filterTargets(rows, { status: "cooldown" })).toHaveLength(1);
  });

  it("combines filters as AND", () => {
    expect(filterTargets(rows, { provider: "groq", status: "healthy" })).toHaveLength(1);
    expect(filterTargets(rows, { provider: "zai", status: "healthy" })).toHaveLength(0);
  });

  it("searches model, provider and last reason only", () => {
    expect(filterTargets(rows, { search: "glm" })).toHaveLength(1);
    expect(filterTargets(rows, { search: "GROQ" })).toHaveLength(2);
    expect(filterTargets(rows, { search: "nothing-matches" })).toHaveLength(0);
    // An unset search is not a filter.
    expect(filterTargets(rows, { search: "" })).toHaveLength(3);
  });

  it("does not search the key index", () => {
    // The key index identifies a credential; it is not lookup data.
    expect(filterTargets(rows, { search: "key-1" })).toHaveLength(0);
  });

  it("lists providers in a stable sorted order", () => {
    expect(providerOptions(rows)).toEqual(["groq", "zai"]);
    expect(providerOptions([])).toEqual([]);
  });

  it("sorts a normalized column and puts missing values last", () => {
    const sorted = sortRows(rows, { latency: (row) => row.latencyMs }, { key: "latency", direction: "asc" });

    // key-1 has no latency; it must not read as the fastest target.
    expect(sorted.map((row) => row.keyIndex)).toEqual([0, 0, 1]);
    expect(sorted.at(-1).latencyMs).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Filter controls
// ---------------------------------------------------------------------------

describe("filter control options", () => {
  const view = normalizeModelPayload(MODEL_PAYLOAD);

  it("prefers the vocabulary the endpoint advertises", () => {
    const choices = filterChoices(view);

    expect(choices.providers).toEqual(["groq", "zai"]);
    expect(choices.protocols).toEqual(["anthropic", "openai-chat"]);
    expect(choices.statuses).toEqual(["healthy", "cooldown", "failed", "unknown"]);
  });

  it("falls back to the rows when the response carries no filters block", () => {
    // An older gateway, or a truncated response: the controls must still offer
    // every value that is actually in the table.
    const choices = filterChoices({ rows: view.rows });

    expect(choices.providers).toEqual(["groq", "zai"]);
    expect(choices.protocols).toEqual(["anthropic", "openai-chat"]);
  });

  it("offers every health state even when none is currently present", () => {
    // Filtering *to* a state that is empty is legitimate, and must stay
    // selectable so the operator can see the empty result.
    expect(filterChoices({ rows: [] }).statuses)
      .toEqual(["healthy", "cooldown", "failed", "unknown"]);
  });

  it("never throws on an absent or malformed payload", () => {
    for (const input of [undefined, {}, { filters: null }, { filters: { providers: "groq" } }, { rows: null }]) {
      const choices = filterChoices(input);
      expect(Array.isArray(choices.providers)).toBe(true);
      expect(Array.isArray(choices.protocols)).toBe(true);
      expect(Array.isArray(choices.statuses)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Detail drawer
// ---------------------------------------------------------------------------

describe("detail drawer selection", () => {
  const rows = normalizeModelPayload(MODEL_PAYLOAD).rows;

  it("resolves the clicked row for either page", () => {
    for (const row of rows) {
      expect(findTarget(rows, row.id)).toBe(row);
    }
  });

  it("closes rather than rendering a half-populated drawer", () => {
    // A poll can land between opening and closing a drawer, so an id that is no
    // longer in the response is the normal case rather than an error.
    expect(findTarget(rows, "groq:gone:key-0")).toBeNull();
    expect(findTarget([], rows[0].id)).toBeNull();
    expect(findTarget(rows, null)).toBeNull();
    expect(findTarget(rows, "")).toBeNull();
    expect(findTarget(rows)).toBeNull();
    expect(findTarget()).toBeNull();
  });

  it("keeps ids stable across a poll so an open drawer survives a refresh", () => {
    const later = normalizeModelPayload({
      ...MODEL_PAYLOAD,
      generatedAt: "2026-01-01T12:05:00.000Z"
    }).rows;

    expect(later.map((row) => row.id)).toEqual(rows.map((row) => row.id));
    expect(findTarget(later, rows[0].id)).not.toBeNull();
  });

  it("keeps a drawer open when only the health of its row changed", () => {
    // The common live case: the same target, newly failed.
    const later = normalizeModelPayload({
      ...MODEL_PAYLOAD,
      models: MODEL_PAYLOAD.models.map((row) =>
        row.id === rows[0].id ? { ...row, status: "failed", lastReason: "429 rate limited" } : row)
    }).rows;

    const reopened = findTarget(later, rows[0].id);
    expect(reopened.status).toBe("failed");
    expect(reopened.lastReason).toBe("429 rate limited");
  });
});

// ---------------------------------------------------------------------------
// Endpoint/shape agreement
// ---------------------------------------------------------------------------

/**
 * The regression this file exists to prevent: the Providers page once read a
 * health rollup as if it were provider configuration. Each page below must
 * consume the shape its own endpoint actually sends.
 */
describe("each page reads the shape its endpoint sends", () => {
  it("Models renders the /api/models catalogue", () => {
    const view = normalizeModelPayload(MODEL_PAYLOAD);

    // `models`, carrying the usage columns only that projection has.
    expect(view.rows).toHaveLength(3);
    expect(view.rows[0].requests).toBe(40);
    expect(view.rows[0].successRate).toBeCloseTo(12 / 13);
  });

  it("Health Monitor renders the /api/health target list", () => {
    const view = normalizeHealthPayload(HEALTH_PAYLOAD);

    // `targets`, not the `providers` rollup — those are different shapes.
    expect(view.rows).toHaveLength(3);
    expect(view.providers).toHaveLength(1);
    // Usage is absent from this projection and must read as absent, not as 0.
    expect(view.rows[0].requests).toBeNull();
    expect(view.rows[0].successRate).toBeNull();
  });

  it("does not let a health rollup masquerade as a target row", () => {
    // The rollup calls its per-provider count `targets`; feeding that object to
    // the target normalizer must not yield a row.
    const view = normalizeHealthPayload({ targets: { provider: "groq", targets: 2 } });

    expect(view.rows).toEqual([]);
    expect(view.summary.total).toBe(0);
  });

  it("derives each page's filter vocabulary from its own response", () => {
    // /api/health carries no `filters` block, so its controls recount from rows.
    const health = normalizeHealthPayload(HEALTH_PAYLOAD);
    const choices = filterChoices({ rows: health.rows });

    expect(choices.providers).toEqual(["groq", "zai"]);
    expect(choices.protocols).toEqual(["anthropic", "openai-chat"]);
  });
});

// ---------------------------------------------------------------------------
// Routing pools
// ---------------------------------------------------------------------------

describe("pool separation in the view model", () => {
  it("defaults a row with no pool to text and preserves an explicit vision pool", () => {
    expect(normalizeTarget({ provider: "groq", model: "m" }).pool).toBe("text");
    expect(normalizeTarget({ provider: "groq", model: "m", pool: "vision" }).pool).toBe("vision");
    // An unknown pool value must not leak through to a badge.
    expect(normalizeTarget({ provider: "groq", model: "m", pool: "sideways" }).pool).toBe("text");
  });

  it("filters by pool without disturbing the other filters", () => {
    const rows = [
      normalizeTarget({ provider: "groq", model: "t", pool: "text", protocols: ["openai-chat"] }),
      normalizeTarget({ provider: "groq", model: "v", pool: "vision", protocols: ["openai-chat"] })
    ];
    expect(filterTargets(rows, { pool: "vision" }).map((row) => row.model)).toEqual(["v"]);
    expect(filterTargets(rows, { pool: "text" }).map((row) => row.model)).toEqual(["t"]);
    expect(filterTargets(rows)).toHaveLength(2);
  });

  it("offers both pools as choices even when a response omits them", () => {
    // Filtering to an empty pool is legitimate, so the option stays selectable.
    expect(filterChoices({ rows: [] }).pools).toEqual([...POOLS]);
    expect(filterChoices({ filters: { pools: ["vision"] }, rows: [] }).pools).toEqual(["vision"]);
  });
});
