import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("../../hooks/useApi.js", () => ({ useApi: vi.fn() }));
vi.mock("../../context/HealthContext.jsx", () => ({ useHealth: vi.fn() }));
vi.mock("../../context/ConnectionContext.jsx", () => ({ useConnection: () => ({ generation: 0 }) }));

import { useApi } from "../../hooks/useApi.js";
import { useHealth } from "../../context/HealthContext.jsx";
import { getProviders } from "../../api/providers.js";
import Dashboard from "../Dashboard.jsx";

const text = (markup) => markup.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

function setupApiMocks(overrides = {}) {
  const defaultProviders = {
    data: {
      summary: { knownProviders: 3, configuredProviders: 3, disabledProviders: 0 },
      providers: [{ id: "groq" }, { id: "openai" }, { id: "anthropic" }]
    },
    error: null,
    loading: false,
    reload: vi.fn()
  };

  const defaultAnalytics = {
    data: {
      summary: {
        total: 150,
        successful: 140,
        failed: 10,
        successRate: 0.933,
        failureRate: 0.067,
        avgLatencyMs: 350,
        p95LatencyMs: 820
      },
      series: [{ total: 50 }, { total: 100 }],
      recentFailures: [
        { seq: 1, receivedAt: new Date().toISOString(), provider: "groq", model: "llama-3", category: "upstream_5xx" }
      ],
      recentFallbacks: [
        {
          seq: 2,
          receivedAt: new Date().toISOString(),
          finalProvider: "openai",
          finalModel: "gpt-4o",
          attempts: [{ ok: false, status: 503 }, { ok: true, status: 200 }],
          fallbackCount: 1,
          outcome: "success"
        }
      ]
    },
    error: null,
    loading: false,
    reload: vi.fn()
  };

  const defaultRecent = {
    data: {
      entries: [
        {
          seq: 10,
          receivedAt: new Date().toISOString(),
          finalProvider: "groq",
          finalModel: "llama-3",
          httpStatus: 200,
          outcome: "success",
          latencyMs: 180
        }
      ]
    },
    error: null,
    loading: false,
    reload: vi.fn()
  };

  useApi.mockImplementation((fn) => {
    if (fn === getProviders) {
      return overrides.providers ?? defaultProviders;
    }
    const fnStr = fn.toString();
    if (fnStr.includes("getAnalytics")) {
      return overrides.analytics ?? defaultAnalytics;
    }
    if (fnStr.includes("getRequests")) {
      return overrides.recent ?? defaultRecent;
    }
    return { data: null, error: null, loading: false, reload: vi.fn() };
  });
}

function setupHealthMock(overrides = {}) {
  useHealth.mockReturnValue({
    health: overrides.health !== undefined ? overrides.health : { ok: true },
    summary: overrides.summary !== undefined ? overrides.summary : null,
    ranked: overrides.ranked !== undefined ? overrides.ranked : [],
    error: overrides.error !== undefined ? overrides.error : null,
    loading: overrides.loading !== undefined ? overrides.loading : false,
    reload: vi.fn(),
    lastUpdatedAt: Date.now(),
    refreshing: false
  });
}

describe("Dashboard regression tests", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    setupApiMocks();
  });

  it("renders without throwing when the health summary is null", () => {
    setupHealthMock({
      health: null,
      summary: null,
      error: new Error("Unauthorized (401)"),
      loading: false
    });

    let markup = "";
    expect(() => {
      markup = renderToStaticMarkup(<Dashboard />);
    }).not.toThrow();

    const plain = text(markup);
    expect(plain).toContain("Dashboard");
    expect(plain).toContain("System Health");
    expect(plain).toContain("Targets");
    expect(plain).toContain("n/a");
  });

  it("displays n/a when health summary is null", () => {
    setupHealthMock({ summary: null });
    const markup = renderToStaticMarkup(<Dashboard />);
    const plain = text(markup);

    expect(plain).toContain("Targets");
    expect(markup).toContain('<span class="tiny dim mono">n/a</span>');
    expect(markup).not.toContain("% healthy</span>");
  });

  it("displays n/a when healthPercent is null", () => {
    setupHealthMock({
      summary: {
        total: 4,
        healthy: 2,
        cooldown: 1,
        failed: 1,
        unknown: 0,
        healthPercent: null
      }
    });
    const markup = renderToStaticMarkup(<Dashboard />);
    const plain = text(markup);

    expect(plain).toContain("Targets");
    expect(markup).toContain('<span class="tiny dim mono">n/a</span>');
    expect(markup).not.toContain("% healthy</span>");
  });

  it("displays n/a when healthPercent is undefined", () => {
    setupHealthMock({
      summary: {
        total: 4,
        healthy: 2,
        cooldown: 1,
        failed: 1,
        unknown: 0
      }
    });
    const markup = renderToStaticMarkup(<Dashboard />);
    const plain = text(markup);

    expect(plain).toContain("Targets");
    expect(markup).toContain('<span class="tiny dim mono">n/a</span>');
    expect(markup).not.toContain("% healthy</span>");
  });

  it("formats a valid numeric health percentage correctly", () => {
    setupHealthMock({
      summary: {
        total: 10,
        healthy: 8,
        cooldown: 1,
        failed: 1,
        unknown: 0,
        healthPercent: 0.8
      }
    });
    const markup = renderToStaticMarkup(<Dashboard />);
    const plain = text(markup);

    expect(plain).toContain("Targets");
    expect(plain).toContain("80.0% healthy");
  });

  it("formats 100% health percentage correctly", () => {
    setupHealthMock({
      summary: {
        total: 5,
        healthy: 5,
        cooldown: 0,
        failed: 0,
        unknown: 0,
        healthPercent: 1.0
      }
    });
    const markup = renderToStaticMarkup(<Dashboard />);
    const plain = text(markup);

    expect(plain).toContain("100.0% healthy");
  });

  it("formats 0% health percentage correctly without showing n/a", () => {
    setupHealthMock({
      summary: {
        total: 5,
        healthy: 0,
        cooldown: 2,
        failed: 3,
        unknown: 0,
        healthPercent: 0
      }
    });
    const markup = renderToStaticMarkup(<Dashboard />);
    const plain = text(markup);

    expect(plain).toContain("0.0% healthy");
  });

  it("missing health data does not prevent unrelated Dashboard sections from rendering", () => {
    setupHealthMock({
      health: null,
      summary: null,
      ranked: null,
      error: new Error("Network error fetching health"),
      loading: false
    });

    const markup = renderToStaticMarkup(<Dashboard />);
    const plain = text(markup);

    // Header and error alert
    expect(plain).toContain("Dashboard");
    expect(plain).toContain("Live gateway health, traffic and routing activity");
    expect(plain).toContain("Network error fetching health");

    // Metrics cards
    expect(plain).toContain("Total Providers");
    expect(plain).toContain("3");
    expect(plain).toContain("Total Targets");
    expect(plain).toContain("Total Requests");
    expect(plain).toContain("150");
    expect(plain).toContain("Average Latency");
    expect(plain).toContain("350 ms");
    expect(plain).toContain("Success Rate");
    expect(plain).toContain("93.3%");
    expect(plain).toContain("Failed Requests");
    expect(plain).toContain("10");

    // Panels
    expect(plain).toContain("Routing Flow");
    expect(plain).toContain("Requests (24h)");
    expect(plain).toContain("Recent requests");
    expect(plain).toContain("Recent failures");
    expect(plain).toContain("Current fallback activity");

    // Recent requests data rendered
    expect(plain).toContain("llama-3");
    expect(plain).toContain("180 ms");

    // Recent failures data rendered
    expect(plain).toContain("upstream_5xx");

    // Fallback data rendered
    expect(plain).toContain("gpt-4o");
  });

  it("preserves routing functionality and links across Dashboard", () => {
    setupHealthMock({
      summary: null
    });

    const markup = renderToStaticMarkup(<Dashboard />);

    expect(markup).toContain('href="/playground"');
    expect(markup).toContain('href="/requests"');
    expect(markup).toContain('href="/analytics"');
    expect(markup).toContain('href="/fallback"');
    expect(markup).toContain('href="/configuration"');
  });

  it("renders loading skeleton only when health is loading and healthData is absent", () => {
    setupHealthMock({
      health: null,
      summary: null,
      loading: true
    });

    const markup = renderToStaticMarkup(<Dashboard />);
    expect(markup).toContain("skeleton");
    expect(markup).not.toContain("Global statistics");
  });
});
