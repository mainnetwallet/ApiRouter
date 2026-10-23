import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { RoutingFlowPanel } from "../RoutingFlowPanel.jsx";

const text = (markup) => markup.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

const target = (provider, model, rank) => ({
  id: `${provider}/${model}/0`,
  provider,
  model,
  keyIndex: 0,
  protocols: ["openai-chat"],
  rank
});

describe("RoutingFlowPanel", () => {
  it("renders empty input without error", () => {
    const markup = renderToStaticMarkup(<RoutingFlowPanel ranked={[]} />);
    const plain = text(markup);

    expect(plain).toContain("Routing Flow");
    expect(plain).toContain("no ordered target");
    expect(plain).toContain("CAPABILITY-ROUTED");
  });

  it("renders one ranked target", () => {
    const markup = renderToStaticMarkup(<RoutingFlowPanel ranked={[target("groq", "m1", 1)]} />);
    const plain = text(markup);

    expect(plain).toContain("1 target");
    expect(plain).toContain("Groq");
    expect(plain).toContain("m1");
  });

  it("renders multiple ranked targets without separate Text/Vision lanes", () => {
    const markup = renderToStaticMarkup(
      <RoutingFlowPanel ranked={[target("groq", "m1", 1), target("mistral", "m2", 2)]} />
    );
    const plain = text(markup);

    expect(plain).toContain("2 targets");
    expect(plain).toContain("Groq");
    expect(plain).toContain("m1");
    // Only the top target is shown, not separate Text/Vision lanes.
    expect(markup.toLowerCase()).not.toContain("text pool");
    expect(markup.toLowerCase()).not.toContain("vision pool");
    expect(markup.toLowerCase()).not.toContain("text/vision");
    // No duplicate target cards or separate per-pool columns.
    expect(plain.match(/ordered/g)).toHaveLength(1);
  });

  it("does not label generic health ranking as request-specific eligibility", () => {
    const markup = renderToStaticMarkup(<RoutingFlowPanel ranked={[target("groq", "m1", 1)]} />);
    const plain = text(markup);

    // The panel explicitly states the first target is not proven eligible for every request.
    expect(plain).toContain("not automatically eligible");
    expect(plain).toContain("protocol");
    expect(plain).toContain("capabilities");
    expect(plain).toContain("cooldowns");
  });
});
