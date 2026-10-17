import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("../../hooks/useApi.js", () => ({ useApi: vi.fn() }));
vi.mock("../../context/ToastContext.jsx", () => ({ useToast: () => ({ success() {}, error() {} }) }));
vi.mock("../../context/ConnectionContext.jsx", () => ({ useConnection: () => ({ generation: 0 }) }));

import { useApi } from "../../hooks/useApi.js";
import OneProviderFallback, { parseCooldownSeconds } from "../OneProviderFallback.jsx";

const candidate = (provider, model, extra = {}) => ({
  provider, model, pools: ["text"], keyCount: 2, disabled: false, selected: false, rank: null, ...extra
});

const key = (keyIndex, extra = {}) => ({
  provider: "groq", model: "m1", rank: 1, pool: "text", keyIndex, keyId: `${extra.model ?? "m1"}::text:${keyIndex}`,
  ready: true, cooldownUntil: 0, cooldownMs: 0,
  status: "healthy", lastStatus: 200, successes: 3, failures: 1, latencyMs: 420, ...extra
});

function render(data) {
  useApi.mockReturnValue({ data, error: null, loading: false, reload() {}, refreshing: false, lastUpdatedAt: Date.now() });
  return renderToStaticMarkup(<OneProviderFallback />);
}

const base = {
  enabled: false, active: false, provider: null, models: [], switchedOff: false,
  maxWaitMs: 120_000,
  candidates: [candidate("groq", "m1"), candidate("groq", "m3"), candidate("mistral", "m2", { keyCount: 1 })],
  keys: []
};

const on = (keys, extra = {}) => render({
  ...base, enabled: true, active: true, provider: "groq", models: ["m1", "m3"],
  candidates: [
    candidate("groq", "m1", { selected: true, rank: 1 }), candidate("groq", "m3", { selected: true, rank: 2 }),
    candidate("mistral", "m2")
  ],
  keys, ...extra
});

describe("One Provider Fallback page", () => {
  beforeEach(() => useApi.mockReset());

  it("is off by default: offers Turn on, disabled until a provider and a model are chosen", () => {
    const markup = render(base);
    expect(markup).toContain("One Provider Fallback");
    expect(markup).not.toContain("One Model Fallback");
    expect(markup).toContain("Turn on");
    expect(markup).not.toContain("Turn off");
    expect(markup).toMatch(/<button[^>]*disabled[^>]*>Turn on<\/button>/);
    expect(markup).toContain("Normal fallback is in use");
    expect(markup).toContain("Choose a provider first");
  });

  it("offers every provider as a tappable card with its model and key counts", () => {
    const markup = render(base);
    expect(markup).toContain('role="radiogroup"');
    expect(markup).toContain('aria-label="Provider to use"');
    expect(markup.match(/role="radio"/g)).toHaveLength(2);
    expect(markup).toMatch(/2 models · 4 keys/);
    expect(markup).toMatch(/1 model · 1 key/);
    expect(markup).not.toContain("<select");
  });

  it("with a provider on: shows its models to tap and add, and the order built so far", () => {
    const markup = on([key(0)]);
    expect(markup).toContain('aria-label="Available models"');
    expect(markup).toContain('aria-label="Remove m1 from the list"');
    expect(markup).toContain('aria-label="Remove m3 from the list"');
    expect(markup).toContain("✓ Added");
    expect(markup).not.toContain("mistral");
    expect(markup).toContain("Add all");
    expect(markup).not.toContain('aria-label="Search models"');
  });

  it("offers a search box once a provider has many models", () => {
    const many = Array.from({ length: 8 }, (_, i) => candidate("groq", `model-${i}`));
    const markup = render({
      ...base, enabled: true, active: true, provider: "groq", models: ["model-0"], candidates: many, keys: [key(0)]
    });
    expect(markup).toContain('aria-label="Search models"');
    expect(markup).toContain('aria-label="Add model-5"');
  });

  it("when on: lists the models in order with move/remove controls, offers Turn off, and shows the key cooldowns", () => {
    const markup = on([
      key(0, { ready: false, cooldownUntil: Date.now() + 45_000 }), key(1),
      key(0, { model: "m3", rank: 2 })
    ]);
    expect(markup).toContain("Turn off");
    expect(markup).not.toContain(">Turn on<");
    expect(markup).toContain("No other provider is used as a fallback");
    expect(markup).toContain('aria-label="Models in order"');
    expect(markup.indexOf("m1")).toBeLessThan(markup.indexOf("m3"));
    expect(markup).toContain('aria-label="Move m3 up"');
    expect(markup).toContain('aria-label="Remove m1"');
    expect(markup).toMatch(/cooling/);
    expect(markup).toMatch(/ready/);
    expect(markup).toContain("#0");
    expect(markup).toContain("#1");
  });

  it("warns when every chosen model is switched off in the Control Panel", () => {
    const markup = on([key(0)], { switchedOff: true });
    expect(markup).toContain("switched off in the Control Panel");
  });

  it("explains the model order, the way back to model 1 and the per-key cooldown", () => {
    const markup = render(base);
    expect(markup).toContain("Models in order");
    expect(markup).toContain("Back to model 1");
    expect(markup).toContain("No cooldown by default");
    expect(markup).toContain("Cooldown per key");
    expect(markup).toMatch(/up to 120s/);
  });

  it("shows one cooldown input per key, naming its model, empty when none is set and in seconds when set", () => {
    const markup = on([key(0), key(1, { cooldownMs: 60_000 }), key(0, { model: "m3", rank: 2 })]);
    expect(markup).toContain('aria-label="Cooldown in seconds for m1 key 0 (empty for none)"');
    expect(markup).toContain('aria-label="Cooldown in seconds for m1 key 1 (empty for none)"');
    expect(markup).toContain('aria-label="Cooldown in seconds for m3 key 0 (empty for none)"');
    expect(markup).toContain('placeholder="none"');
    expect(markup).toMatch(/value="60"/);
    expect(markup).toContain("Apply to all");
  });

  it("offers no cooldown editing before the mode has models to edit", () => {
    const markup = render(base);
    expect(markup).not.toContain("Apply to all");
    expect(markup).not.toContain("Cooldown in seconds for");
  });
});

describe("parseCooldownSeconds", () => {
  it("maps empty and zero to no cooldown, whole seconds to milliseconds", () => {
    expect(parseCooldownSeconds("")).toBeNull();
    expect(parseCooldownSeconds("   ")).toBeNull();
    expect(parseCooldownSeconds("0")).toBeNull();
    expect(parseCooldownSeconds("60")).toBe(60_000);
    expect(parseCooldownSeconds(" 5 ")).toBe(5_000);
    expect(parseCooldownSeconds("86400")).toBe(86_400_000);
  });

  it("rejects anything that is not a whole number of seconds up to a day", () => {
    for (const bad of ["abc", "-5", "1.5", "1e3", "86401", "6 0"]) {
      expect(parseCooldownSeconds(bad)).toBeUndefined();
    }
  });
});
