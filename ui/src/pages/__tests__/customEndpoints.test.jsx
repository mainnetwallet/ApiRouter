import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("../../hooks/useApi.js", () => ({ useApi: vi.fn() }));
vi.mock("../../context/ToastContext.jsx", () => ({ useToast: () => ({ success() {}, error() {} }) }));
vi.mock("../../context/ConnectionContext.jsx", () => ({ useConnection: () => ({ generation: 0 }) }));

import { useApi } from "../../hooks/useApi.js";
import { CustomEndpoints } from "../../components/domain/CustomEndpoints.jsx";

const render = (endpoints, { loading = false, storage = { mode: "file", ready: true } } = {}) => {
  useApi.mockReturnValue({ data: { endpoints, storage }, error: null, loading, reload() {} });
  return renderToStaticMarkup(<CustomEndpoints />);
};

describe("Custom endpoints manager", () => {
  beforeEach(() => useApi.mockReset());

  it("explains the empty state and offers to add one", () => {
    const markup = render([]);
    expect(markup).toContain("No custom endpoints yet");
    expect(markup).toContain("Add custom endpoint");
  });

  it("lists each endpoint with its models and a key COUNT, never key text", () => {
    const markup = render([{ id: "custom-gw", name: "My gateway", baseUrl: "https://gw.example.com/v1", protocol: "openai-chat", models: ["m-a", "m-b"], keyCount: 3 }]);
    expect(markup).toContain("My gateway");
    expect(markup).toContain("custom-gw");
    expect(markup).toContain("2 models");
    expect(markup).toContain("3 keys");
    expect(markup).toContain("m-a, m-b");
    expect(markup).toContain(">Edit<");
    expect(markup).toContain(">Remove<");
  });

  it("warns when saved endpoints live only on a disk a redeploy can wipe", () => {
    expect(render([], { storage: { mode: "file", ready: true } })).toContain("CUSTOM_ENDPOINTS_GITHUB_REPO");
  });

  it("says so when they are stored encrypted in GitHub, and when GitHub is unreachable", () => {
    expect(render([], { storage: { mode: "github", ready: true } })).toContain("Saved encrypted in GitHub");
    const down = render([], { storage: { mode: "github", ready: false, error: "Could not reach GitHub" } });
    expect(down).toContain("GitHub storage is not reachable");
    expect(down).toContain("Could not reach GitHub");
  });
});
