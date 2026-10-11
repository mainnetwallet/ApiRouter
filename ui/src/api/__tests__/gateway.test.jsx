import { afterEach, describe, expect, it, vi } from "vitest";

import { resumeGateway, shutdownGateway } from "../gateway.js";

/** The panel's master switch must hit the two POST endpoints, nothing else. */
describe("gateway control api", () => {
  afterEach(() => vi.unstubAllGlobals());

  const stubFetch = (payload) => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "content-type": "application/json" }
    }));
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  };

  it("POSTs shutdown", async () => {
    const fetchMock = stubFetch({ ok: true, state: "paused", paused: true });
    const result = await shutdownGateway();
    const [url, options] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("/api/gateway/shutdown");
    expect(options.method).toBe("POST");
    expect(result.paused).toBe(true);
  });

  it("POSTs resume", async () => {
    const fetchMock = stubFetch({ ok: true, state: "running", paused: false });
    const result = await resumeGateway();
    const [url, options] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("/api/gateway/resume");
    expect(options.method).toBe("POST");
    expect(result.paused).toBe(false);
  });
});
