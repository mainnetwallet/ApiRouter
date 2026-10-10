import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { FallbackChain } from "../FallbackChain.jsx";
import { OrderLatency } from "../OrderLatency.jsx";

const target = (model, phase, extra = {}) => ({
  id: `a:${model}:key-0`,
  provider: "a",
  model,
  keyIndex: 0,
  protocols: ["openai-chat"],
  status: "healthy",
  available: true,
  score: 80,
  phase,
  orderLatencyMs: 900,
  orderLatencySource: "request",
  latencyMs: 900,
  ...extra
});

const html = (targets) => renderToStaticMarkup(<FallbackChain targets={targets} mode="planned" />);
const text = (markup) => markup.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
const count = (haystack, needle) => haystack.split(needle).length - 1;

describe("FallbackChain wording by mode", () => {
  it("Fixed Order shows the latency as information and never says 'ordered by'", () => {
    const markup = html([target("m1", "chain"), target("m2", "chain", { orderLatencyMs: 40 })]);
    expect(count(text(markup), "latency")).toBeGreaterThanOrEqual(2);
    expect(markup.toLowerCase()).not.toContain("ordered by");
    expect(markup).toContain('data-latency-decides-order="false"');
    expect(markup).toContain("900 ms");
  });

  it("saved Manual Model Selection steps never claim latency; the health batch does", () => {
    const markup = html([
      target("selected-1", "manual-selection"),
      target("selected-2", "manual-selection", { orderLatencyMs: 5 }),
      target("other-1", "health-fallback", { orderLatencyMs: 40 }),
      target("other-2", "health-fallback", { orderLatencyMs: 700 }),
      target("selected-1", "manual-retry"),
      target("other-1", "health-retry", { orderLatencyMs: 40 })
    ]);
    // 3 latency-ordered steps (health-fallback x2, health-retry), 3 saved-order steps.
    expect(count(text(markup), "ordered by latency")).toBe(3);
    expect(count(markup, 'data-latency-decides-order="true"')).toBe(3);
    expect(count(markup, 'data-latency-decides-order="false"')).toBe(3);
    // Nothing says "ordered by <n> ms" any more.
    expect(markup).not.toMatch(/ordered by\s*(<[^>]+>\s*)*\d/);
  });

  it("Automatic claims latency for sorted steps, but not for the remembered lead", () => {
    const markup = html([
      target("remembered", "sticky", { orderLatencyMs: 2500 }),
      target("fast", "auto", { orderLatencyMs: 40 }),
      target("slow", "auto", { orderLatencyMs: 700 })
    ]);
    expect(count(text(markup), "ordered by latency")).toBe(2);
    expect(count(markup, 'data-latency-decides-order="false"')).toBe(1);
  });

  it("an unmeasured model shows no figure and makes no claim, and the 'last' observation is unaffected", () => {
    const markup = html([target("m1", "auto", { orderLatencyMs: null, orderLatencySource: null, latencyMs: 123 })]);
    expect(text(markup)).not.toContain("ordered by latency");
    expect(text(markup)).toContain("last");
    expect(text(markup)).toContain("123 ms");
  });

  it("a traced attempt list is unchanged: it carries no ordering latency at all", () => {
    const markup = renderToStaticMarkup(
      <FallbackChain mode="traced" targets={[{ provider: "a", model: "m", keyIndex: 0, ok: true }]} />
    );
    expect(markup.toLowerCase()).not.toContain("ordered by");
  });
});

describe("OrderLatency", () => {
  it("renders a consistent label and an explanatory title for each situation", () => {
    const decided = renderToStaticMarkup(<OrderLatency item={target("m", "auto")} />);
    expect(text(decided).trim()).toBe("ordered by latency 900 ms");
    expect(decided).toContain("Ordered by latency");

    const info = renderToStaticMarkup(<OrderLatency item={target("m", "chain")} />);
    expect(text(info).trim()).toBe("latency 900 ms");
    expect(info).toContain("not from latency");
  });

  it("omits an unmeasured model by default and shows the placeholder, with its reason, on request", () => {
    const none = { ...target("m", "auto"), orderLatencyMs: null, orderLatencySource: null };
    expect(renderToStaticMarkup(<OrderLatency item={none} />)).toBe("");
    const shown = renderToStaticMarkup(<OrderLatency item={none} showUnmeasured />);
    expect(shown).toContain("Not measured");
    expect(text(shown)).not.toContain("ordered by latency");
    expect(text(shown)).not.toMatch(/\b0 ms\b/);
  });
});
