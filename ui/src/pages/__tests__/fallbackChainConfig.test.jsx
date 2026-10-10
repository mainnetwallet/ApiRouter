import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("../../hooks/useApi.js", () => ({ useApi: vi.fn() }));
vi.mock("../../context/ToastContext.jsx", () => ({ useToast: () => ({ success() {}, error() {} }) }));

import { useApi } from "../../hooks/useApi.js";
import FallbackChainConfig from "../FallbackChainConfig.jsx";

const step = (model, phase, extra = {}) => ({
  id: `a:${model}:key-0`, provider: "a", model, keyIndex: 0, rank: 1, phase,
  orderLatencyMs: 900, orderLatencySource: "request", ...extra
});

const group = (model) => ({
  id: `text/a/${model}`, provider: "a", model, pool: "text", keyIndexes: [0], keyStates: [{ keyIndex: 0, status: "healthy", available: true }],
  available: true, status: "healthy", latencyMs: 900, latencySource: "request", measuredLatencyMs: 900, probeLatencyMs: null
});

/** The page calls useApi twice per render: the saved configuration, then the route preview. */
function render({ mode, fallbackOrder, chain = [] }) {
  const configuration = {
    data: {
      mode,
      modes: [{ id: mode, label: mode, summary: "" }],
      chain: { text: chain, vision: [] },
      catalogue: { text: [...new Set(fallbackOrder.map((item) => item.model))].map(group), vision: [] },
      remembered: null
    },
    error: null, loading: false, reload() {}
  };
  const preview = { data: { fallbackOrder }, error: null, loading: false, reload() {} };
  let call = 0;
  useApi.mockImplementation(() => (call++ % 2 === 0 ? configuration : preview));
  return renderToStaticMarkup(<FallbackChainConfig />);
}

/** Just the "Route order" panel, so the catalogue's own latency labels cannot satisfy an assertion. */
function routeOrder(markup) {
  const start = markup.indexOf('aria-label="Route order"');
  expect(start).toBeGreaterThan(-1);
  return markup.slice(start);
}
const text = (markup) => markup.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

describe("Fallback Chain page: Route order wording", () => {
  beforeEach(() => useApi.mockReset());

  it("Fixed Order never says the order came from latency", () => {
    const panel = routeOrder(render({
      mode: "fixed",
      chain: [{ provider: "a", model: "m1", keys: null, enabled: true }, { provider: "a", model: "m2", keys: null, enabled: true }],
      fallbackOrder: [step("m1", "chain"), step("m2", "chain", { orderLatencyMs: 40, rank: 2 })]
    }));
    expect(panel.toLowerCase()).not.toContain("ordered by");
    expect(text(panel)).toContain("latency 900 ms");
    expect(text(panel)).toContain("latency 40 ms");
  });

  it("Manual Model Selection: saved steps are information, the health batch is ordered by latency", () => {
    const panel = routeOrder(render({
      mode: "manual",
      chain: [{ provider: "a", model: "sel", keys: null, enabled: true }],
      fallbackOrder: [
        step("sel", "manual-selection"),
        step("fast", "health-fallback", { orderLatencyMs: 40, rank: 2 }),
        step("slow", "health-fallback", { orderLatencyMs: 700, rank: 3 })
      ]
    }));
    expect(text(panel).match(/ordered by latency/g)).toHaveLength(2);
    expect(panel).toContain('data-latency-decides-order="false"');
  });

  it("Automatic claims it for every sorted step", () => {
    const panel = routeOrder(render({
      mode: "auto",
      fallbackOrder: [step("fast", "auto", { orderLatencyMs: 40 }), step("slow", "auto", { orderLatencyMs: 700, rank: 2 })]
    }));
    expect(text(panel).match(/ordered by latency/g)).toHaveLength(2);
    expect(panel).not.toContain('data-latency-decides-order="false"');
  });

  it("an unmeasured model keeps a truthful tooltip in each mode", () => {
    const none = { orderLatencyMs: null, orderLatencySource: null };
    const auto = routeOrder(render({ mode: "auto", fallbackOrder: [step("m", "auto", none)] }));
    expect(auto).toContain("placed after measured models");
    const fixed = routeOrder(render({
      mode: "fixed", chain: [{ provider: "a", model: "m", keys: null, enabled: true }], fallbackOrder: [step("m", "chain", none)]
    }));
    expect(fixed).not.toContain("placed after");
    expect(fixed).toContain("Latency does not decide this position");
  });
});
