import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("../../hooks/useApi.js", () => ({ useApi: vi.fn() }));
vi.mock("../../context/ToastContext.jsx", () => ({ useToast: () => ({ success() {}, error() {} }) }));
vi.mock("../../context/ConnectionContext.jsx", () => ({ useConnection: () => ({ generation: 0 }) }));

import { useApi } from "../../hooks/useApi.js";
import OneModelFallback, { parseCooldownSeconds } from "../OneModelFallback.jsx";

const candidate = (provider, model, extra = {}) => ({
  provider, model, pools: ["text"], keyCount: 2, disabled: false, selected: false, ...extra
});

const key = (keyIndex, extra = {}) => ({
  provider: "groq", model: "m1", pool: "text", keyIndex, ready: true, cooldownUntil: 0, cooldownMs: 0,
  status: "healthy", lastStatus: 200, successes: 3, failures: 1, latencyMs: 420, ...extra
});

function render(data) {
  useApi.mockReturnValue({ data, error: null, loading: false, reload() {}, refreshing: false, lastUpdatedAt: Date.now() });
  return renderToStaticMarkup(<OneModelFallback />);
}

const base = {
  enabled: false, active: false, provider: null, model: null, switchedOff: false,
  maxWaitMs: 120_000,
  candidates: [candidate("groq", "m1"), candidate("mistral", "m2", { keyCount: 1 })],
  keys: []
};

describe("One Model Fallback page", () => {
  beforeEach(() => useApi.mockReset());

  it("is off by default: offers Turn on, disabled until a model is chosen", () => {
    const markup = render(base);
    expect(markup).toContain("One Model Fallback");
    expect(markup).toContain("Turn on");
    expect(markup).not.toContain("Turn off");
    expect(markup).toMatch(/<button[^>]*disabled[^>]*>Turn on<\/button>/);
    expect(markup).toContain("Normal fallback is in use");
  });

  it("lists every configured model with its key count and pool", () => {
    const markup = render(base);
    expect(markup).toContain("m1");
    expect(markup).toContain("m2");
    expect(markup).toMatch(/2 keys/);
    expect(markup).toMatch(/1 key /);
  });

  it("when on: says only that model is used, offers Turn off, and shows the key cooldowns", () => {
    const markup = render({
      ...base, enabled: true, active: true, provider: "groq", model: "m1",
      candidates: [candidate("groq", "m1", { selected: true }), candidate("mistral", "m2")],
      keys: [key(0, { ready: false, cooldownUntil: Date.now() + 45_000 }), key(1)]
    });
    expect(markup).toContain("Turn off");
    expect(markup).not.toContain(">Turn on<");
    expect(markup).toContain("No other provider or model is used as a fallback");
    expect(markup).toMatch(/cooling/);
    expect(markup).toMatch(/ready/);
    expect(markup).toContain("#0");
    expect(markup).toContain("#1");
  });

  it("warns when the chosen model is switched off in the Control Panel", () => {
    const markup = render({
      ...base, enabled: true, active: true, provider: "groq", model: "m1", switchedOff: true,
      candidates: [candidate("groq", "m1", { selected: true, disabled: true })], keys: [key(0)]
    });
    expect(markup).toContain("switched off in the Control Panel");
  });

  it("explains that there is no cooldown or waiting unless one is set per key", () => {
    const markup = render(base);
    expect(markup).toContain("No cooldown by default");
    expect(markup).toContain("Cooldown per key");
    expect(markup).toMatch(/up to 120s/);
  });

  const on = (keys) => render({
    ...base, enabled: true, active: true, provider: "groq", model: "m1",
    candidates: [candidate("groq", "m1", { selected: true }), candidate("mistral", "m2")], keys
  });

  it("shows one cooldown input per key, empty when none is set and in seconds when set", () => {
    const markup = on([key(0), key(1, { cooldownMs: 60_000 })]);
    expect(markup).toContain('aria-label="Cooldown in seconds for key 0 (empty for none)"');
    expect(markup).toContain('aria-label="Cooldown in seconds for key 1 (empty for none)"');
    expect(markup).toContain('placeholder="none"');
    expect(markup).toMatch(/value="60"/);
    expect(markup).toContain("Apply to all");
  });

  it("offers no cooldown editing before the mode has a model to edit", () => {
    const markup = render(base);
    expect(markup).not.toContain("Apply to all");
    expect(markup).not.toContain("Cooldown in seconds for key");
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
