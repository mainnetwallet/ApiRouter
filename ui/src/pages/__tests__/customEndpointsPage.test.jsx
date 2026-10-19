import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("../../hooks/useApi.js", () => ({ useApi: vi.fn() }));
vi.mock("../../context/ToastContext.jsx", () => ({ useToast: () => ({ success() {}, error() {} }) }));
vi.mock("../../context/ConnectionContext.jsx", () => ({ useConnection: () => ({ generation: 0 }) }));

import { useApi } from "../../hooks/useApi.js";
import CustomEndpointsPage from "../CustomEndpoints.jsx";
import { ROUTES, findRoute } from "../../routes.js";

describe("Custom Endpoints page", () => {
  beforeEach(() => {
    useApi.mockReset();
    useApi.mockReturnValue({ data: { endpoints: [], storage: { mode: "file", ready: true } }, error: null, loading: false, reload() {} });
  });

  it("is its own routed page under Configure", () => {
    const route = findRoute("/custom-endpoints");
    expect(route?.label).toBe("Custom Endpoints");
    expect(route?.group).toBe("Configure");
    expect(ROUTES.filter((entry) => entry.path === "/custom-endpoints")).toHaveLength(1);
  });

  it("shows one page title and the add button", () => {
    const markup = renderToStaticMarkup(<CustomEndpointsPage />);
    expect(markup).toContain("Custom endpoints");
    expect(markup.match(/<h1/g)).toHaveLength(1);
    expect(markup).toContain("Add custom endpoint");
    expect(markup).toContain("No custom endpoints yet");
    // The section heading is dropped on the page: the page header carries it.
    expect(markup).not.toContain("section__title");
  });
});
