import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("../../hooks/useApi.js", () => ({ useApi: vi.fn() }));
vi.mock("../../context/ToastContext.jsx", () => ({ useToast: () => ({ success() {}, error() {} }) }));
vi.mock("../../context/ConnectionContext.jsx", () => ({ useConnection: () => ({ generation: 0 }) }));

import { useApi } from "../../hooks/useApi.js";
import OneModelFallback from "../OneModelFallback.jsx";

const candidate = (provider, model, extra = {}) => ({
  provider, model, pools: ["text"], keyCount: 2, disabled: false, selected: false, ...extra
});

const key = (keyIndex, extra = {}) => ({
  provider: "groq", model: "m1", pool: "text", keyIndex, ready: true, cooldownUntil: 0,
  status: "healthy", lastStatus: 200, successes: 3, failures: 1, latencyMs: 420, ...extra
});

function render(data) {
  useApi.mockReturnValue({ data, error: null, loading: false, reload() {}, refreshing: false, lastUpdatedAt: Date.now() });
  return renderToStaticMarkup(<OneModelFallback />);
}

const base = {
  enabled: false, active: false, provider: null, model: null, switchedOff: false,
  cooldownMs: 60_000, maxWaitMs: 120_000,
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

  it("explains the cooldown rule using the gateway's own number", () => {
    expect(render({ ...base, cooldownMs: 60_000 })).toContain("1 minute");
    expect(render({ ...base, cooldownMs: 90_000 })).toContain("90 seconds");
  });
});
