import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ProviderDrawer } from "../ProviderDrawer.jsx";

const baseRecord = {
  id: "groq",
  configured: true,
  protocols: ["openai-chat"],
  models: ["m1", "m2"],
  modelCount: 2,
  keyCount: 3,
  targetCount: 6,
  envPrefix: "GROQ",
  baseUrl: "https://api.groq.com/openai/v1",
  missing: [],
  clientHeaderNames: [],
  health: {
    status: "healthy",
    successRate: 1,
    successes: 10,
    failures: 0,
    latencyMs: 420,
    lastUpdatedAt: Date.now()
  },
  targets: [
    { id: "groq/m1/0", provider: "groq", model: "m1", keyIndex: 0, status: "healthy", score: 80, latencyMs: 400, lastReason: null },
    { id: "groq/m1/1", provider: "groq", model: "m1", keyIndex: 1, status: "healthy", score: 80, latencyMs: 410, lastReason: null },
    { id: "groq/m2/0", provider: "groq", model: "m2", keyIndex: 0, status: "healthy", score: 70, latencyMs: 500, lastReason: null }
  ],
  custom: false,
  label: null
};

const html = (record) => renderToStaticMarkup(
  <DrawerTest record={record} />
);

function DrawerTest({ record }) {
  return <ProviderDrawer open={true} onClose={() => {}} id={record?.id} record={record} />;
}

describe("ProviderDrawer capability contract", () => {
  it("does not show a false 'none declared' when provider data lacks capabilities", () => {
    const record = { ...baseRecord };
    // Provider objects from /api/providers never include a capabilities field.
    expect("capabilities" in record).toBe(false);

    const markup = html(record);
    // No capability chips section should be rendered at all.
    expect(markup).not.toContain("none declared");
    expect(markup.toLowerCase()).not.toContain("capabilities");
  });

  it("still renders provider models, protocols, keys, health and targets", () => {
    const markup = html(baseRecord);

    expect(markup).toContain("groq");
    expect(markup).toContain("m1");
    expect(markup).toContain("m2");
    expect(markup).toContain("OpenAI Chat");
    expect(markup).toContain("3 key");
    expect(markup).toContain("healthy");
    expect(markup).toContain("Targets (3)");
  });
});
