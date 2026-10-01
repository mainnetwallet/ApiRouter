import { describe, expect, it } from "vitest";

import {
  EMPTY, formatBytes, formatCountdown, formatDuration, formatLatency, formatNumber,
  formatPercent, formatRelativeTime, formatTokens, protocolLabel, providerLabel, toMs, truncate
} from "../format.js";
import { maskCredential, maskIdentifier, looksSecret } from "../mask.js";
import { containsCredentialShapedText, sanitizeText } from "../sanitize.js";
import {
  ApiError, CATEGORY, apiErrorFromResponse, classifyFailure, describeAttempt,
  describeStatus, failureLabel, isRetryableStatus
} from "../errors.js";
import {
  applyFilters, compareValues, matchesSearch, nextSort, paginate, sortAriaValue, sortRows
} from "../table.js";

const SECRET = "sk-super-secret-provider-key-1234567890";

// ---------------------------------------------------------------------------
// format
// ---------------------------------------------------------------------------

describe("format", () => {
  it("never renders NaN or a misleading zero for missing numbers", () => {
    for (const value of [null, undefined, NaN, "abc"]) {
      expect(formatNumber(value)).toBe(EMPTY);
      expect(formatLatency(value)).toBe(EMPTY);
      expect(formatPercent(value)).toBe(EMPTY);
      expect(formatDuration(value)).toBe(EMPTY);
      expect(formatBytes(value)).toBe(EMPTY);
    }
  });

  it("reports tokens as 'not reported' rather than zero", () => {
    // A provider that omits usage must not look like it used no tokens.
    expect(formatTokens(null)).toBe("not reported");
    expect(formatTokens(0)).toBe("0");
    expect(formatTokens(1500)).toBe("1.5k");
    expect(formatTokens(2_500_000)).toBe("2.50M");
  });

  it("scales latency into seconds and minutes", () => {
    expect(formatLatency(420)).toBe("420 ms");
    expect(formatLatency(2500)).toBe("2.50 s");
    expect(formatLatency(90_000)).toBe("1.5 min");
  });

  it("formats durations in the largest sensible unit", () => {
    expect(formatDuration(900)).toBe("900 ms");
    expect(formatDuration(45_000)).toBe("45s");
    expect(formatDuration(90_000)).toBe("1m 30s");
    expect(formatDuration(3_600_000 * 2)).toBe("2h 0m");
  });

  it("derives relative time from either ISO strings or epoch millis", () => {
    const now = Date.parse("2026-01-01T12:00:00.000Z");
    expect(formatRelativeTime("2026-01-01T11:59:30.000Z", now)).toBe("30s ago");
    expect(formatRelativeTime(now - 120_000, now)).toBe("2m ago");
    expect(formatRelativeTime(null)).toBe(EMPTY);
    expect(formatRelativeTime("nonsense")).toBe(EMPTY);
  });

  it("returns null for an elapsed countdown and a value for a live one", () => {
    const now = Date.now();
    expect(formatCountdown(now - 1, now)).toBeNull();
    expect(formatCountdown(now + 60_000, now)).toBe("1m 0s");
    expect(formatCountdown(null, now)).toBeNull();
  });

  it("labels protocols in the gateway's own vocabulary", () => {
    expect(protocolLabel("openai-chat")).toBe("OpenAI Chat");
    expect(protocolLabel("openai-responses")).toBe("OpenAI Responses");
    expect(protocolLabel("anthropic")).toBe("Anthropic Messages");
    expect(protocolLabel("gemini")).toBe("Gemini generateContent");
    expect(providerLabel("zai")).toBe("Z.ai");
    expect(providerLabel(null)).toBe(EMPTY);
  });

  it("parses timestamps defensively", () => {
    expect(toMs("")).toBeNull();
    expect(toMs(null)).toBeNull();
    expect(toMs(1000)).toBe(1000);
    expect(Number.isFinite(toMs("2026-01-01T00:00:00.000Z"))).toBe(true);
  });

  it("truncates with an ellipsis", () => {
    expect(truncate("abcdefghij", 5)).toBe("abcd…");
    expect(truncate("abc", 5)).toBe("abc");
  });
});

// ---------------------------------------------------------------------------
// sanitize / mask
// ---------------------------------------------------------------------------

describe("sanitize", () => {
  it("redacts every credential shape the gateway might echo", () => {
    const inputs = [
      `Bearer ${SECRET}`,
      `failed: ${SECRET}`,
      "the authorization header was rejected",
      "x-goog-api-key is invalid",
      "api_key=abcdef123456"
    ];

    for (const input of inputs) {
      const output = sanitizeText(input);
      expect(output).not.toContain(SECRET);
      expect(output.toLowerCase()).not.toContain("bearer ");
      expect(output.toLowerCase()).not.toContain("authorization");
      expect(output.toLowerCase()).not.toContain("x-goog-api-key");
    }
  });

  it("keeps the useful part of the message", () => {
    const output = sanitizeText(`HTTP 429 rate limited for ${SECRET}`);
    expect(output).toContain("429");
    expect(output).toContain("rate limited");
  });

  it("strips control characters and caps length", () => {
    const output = sanitizeText(`bad\u0000value\u001b[31m${"x".repeat(500)}`);
    expect(output).not.toContain("\u0000");
    expect(output).not.toContain("\u001b");
    expect(output.length).toBeLessThanOrEqual(301);
  });

  it("detects what it would redact", () => {
    expect(containsCredentialShapedText(`Bearer ${SECRET}`)).toBe(true);
    expect(containsCredentialShapedText("HTTP 503 provider unavailable")).toBe(false);
  });
});

describe("mask", () => {
  it("masks a credential while keeping it recognisable", () => {
    const masked = maskCredential(SECRET);
    expect(masked.startsWith("sk-")).toBe(true);
    expect(masked).toContain("*");
    expect(masked).not.toContain(SECRET);
    // The tail is preserved so an operator can tell two keys apart.
    expect(masked.endsWith(SECRET.slice(-4))).toBe(true);
  });

  it("fully masks a short value rather than revealing most of it", () => {
    expect(maskCredential("short")).toBe("•••••");
    expect(maskCredential("")).toBe("");
  });

  it("shortens long identifiers with a marker", () => {
    expect(maskIdentifier("abcdefghijklmnop", { head: 6, tail: 3 })).toBe("abcdef…nop");
    expect(maskIdentifier("abc", { head: 6 })).toBe("abc");
  });

  it("recognises secret-shaped input so it can be refused", () => {
    expect(looksSecret(SECRET)).toBe(true);
    expect(looksSecret("hello")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// errors
// ---------------------------------------------------------------------------

describe("error taxonomy", () => {
  it("distinguishes the statuses the brief calls out", () => {
    const cases = {
      401: CATEGORY.AUTH,
      403: CATEGORY.FORBIDDEN,
      408: CATEGORY.TIMEOUT,
      429: CATEGORY.RATE_LIMIT,
      500: CATEGORY.PROVIDER,
      502: CATEGORY.GATEWAY,
      503: CATEGORY.UNAVAILABLE,
      504: CATEGORY.TIMEOUT
    };

    for (const [status, category] of Object.entries(cases)) {
      expect(describeStatus(status).category).toBe(category);
      expect(describeStatus(status).hint).toBeTruthy();
    }
  });

  it("never labels everything the same way", () => {
    const labels = new Set();
    for (const status of [401, 403, 408, 429, 500, 502, 503, 504]) {
      labels.add(describeStatus(status).label);
    }
    expect(labels.size).toBeGreaterThan(5);
    expect([...labels]).not.toContain("Offline");
  });

  it("marks transient and provider-side failures retryable", () => {
    expect(isRetryableStatus(429)).toBe(true);
    expect(isRetryableStatus(503)).toBe(true);
    expect(isRetryableStatus(401)).toBe(true);
    expect(isRetryableStatus(402)).toBe(true);
    expect(isRetryableStatus(400)).toBe(false);
    expect(isRetryableStatus(200)).toBe(false);
  });

  it("prefers the gateway's error type over the status code", () => {
    // 503 + no_route is a configuration problem, not a provider outage.
    const error = apiErrorFromResponse(503, {
      error: { message: "No configured provider targets support this client protocol", type: "no_route" }
    });

    expect(error.category).toBe(CATEGORY.NO_ROUTE);
    expect(error.retryable).toBe(false);
    expect(error.label).toBe("No route available");
  });

  it("treats gateway auth failure distinctly from provider auth failure", () => {
    const error = apiErrorFromResponse(401, {
      error: { message: "Unauthorized", type: "authentication_error" }
    });

    expect(error.category).toBe(CATEGORY.AUTH);
    expect(error.label).toBe("Router authentication failed");
    expect(error.hint).toContain("token");
  });

  it("sanitizes messages as they are constructed", () => {
    const error = apiErrorFromResponse(502, {
      error: { message: `upstream said Bearer ${SECRET}`, type: "upstream_error" }
    });

    expect(error.message).not.toContain(SECRET);
    expect(error.message.toLowerCase()).not.toContain("bearer ");
  });

  it("carries per-target failures through for the fallback view", () => {
    const error = apiErrorFromResponse(502, {
      error: {
        message: "All routing targets failed",
        type: "upstream_error",
        failures: [{ provider: "groq", model: "m", keyIndex: 0, status: 503, message: "unavailable" }]
      }
    });

    expect(error.failures).toHaveLength(1);
    expect(error.failures[0].provider).toBe("groq");
  });

  it("describes a network failure without blaming the provider", () => {
    const error = new ApiError({ kind: "network" });
    expect(error.category).toBe(CATEGORY.NETWORK);
    expect(error.label).toBe("Cannot reach the router");
    expect(error.retryable).toBe(true);
  });

  it("classifies a single attempt for the fallback chain", () => {
    expect(describeAttempt({ ok: true, status: 200 }).tone).toBe("ok");
    expect(describeAttempt({ ok: false, status: 429 }).label).toBe("rate limited");
    expect(describeAttempt({ ok: false, status: 401 }).label).toBe("auth rejected");
    expect(describeAttempt({ ok: false, status: 402 }).label).toBe("quota exhausted");
    expect(describeAttempt({ ok: false, status: 504 }).label).toBe("timeout");
    expect(describeAttempt({ ok: false, status: 404 }).label).toBe("model unavailable");
    expect(describeAttempt({ ok: false, status: 500 }).tone).toBe("danger");
  });

  it("classifies request-log failures by the actionable category", () => {
    expect(classifyFailure({ httpStatus: 429 })).toBe("rate limited");
    expect(classifyFailure({ httpStatus: 402 })).toBe("quota exhausted");
    expect(classifyFailure({ httpStatus: 401 })).toBe("authentication");
    expect(classifyFailure({ httpStatus: 504 })).toBe("timeout");
    expect(classifyFailure({ errorType: "no_route", httpStatus: 503 })).toBe("no route");
    expect(failureLabel("authentication")).toBe("Authentication failure");
    expect(failureLabel("quota exhausted")).toBe("Quota exhaustion");
  });
});

// ---------------------------------------------------------------------------
// table helpers
// ---------------------------------------------------------------------------

describe("table helpers", () => {
  it("sorts empty values last in both directions", () => {
    // A target with no latency must not appear "fastest" when sorted ascending.
    expect(compareValues(null, 5)).toBeGreaterThan(0);
    expect(compareValues(5, null)).toBeLessThan(0);
    expect(compareValues(null, null)).toBe(0);
    expect(compareValues(undefined, 0)).toBeGreaterThan(0);
  });

  it("compares numbers numerically and strings naturally", () => {
    expect(compareValues(2, 10)).toBeLessThan(0);
    expect(compareValues("model-2", "model-10")).toBeLessThan(0);
  });

  it("sorts rows by a named column and stays stable", () => {
    const columns = { latency: (row) => row.latencyMs, name: (row) => row.name };
    const rows = [
      { name: "b", latencyMs: 100 },
      { name: "a", latencyMs: 100 },
      { name: "c", latencyMs: 50 }
    ];

    expect(sortRows(rows, columns, { key: "latency", direction: "asc" }).map((r) => r.name))
      .toEqual(["c", "b", "a"]);
    expect(sortRows(rows, columns, { key: "latency", direction: "desc" }).map((r) => r.name))
      .toEqual(["b", "a", "c"]);
    expect(sortRows(rows, columns, { key: null }).map((r) => r.name)).toEqual(["b", "a", "c"]);
  });

  it("matches search across the given fields only", () => {
    const row = { model: "llama-x", provider: "groq", secret: "hidden" };
    expect(matchesSearch(row, "llama", ["model"])).toBe(true);
    expect(matchesSearch(row, "GROQ", ["provider"])).toBe(true);
    expect(matchesSearch(row, "hidden", ["model"])).toBe(false);
    expect(matchesSearch(row, "", ["model"])).toBe(true);
  });

  it("treats empty filter values as no constraint", () => {
    const rows = [{ status: "healthy" }, { status: "failed" }];
    expect(applyFilters(rows, { status: "" })).toHaveLength(2);
    expect(applyFilters(rows, { status: "all" })).toHaveLength(2);
    expect(applyFilters(rows, { status: "failed" })).toHaveLength(1);
    expect(applyFilters(rows, {})).toHaveLength(2);
  });

  it("matches a filter against array fields", () => {
    const rows = [{ protocols: ["openai-chat"] }, { protocols: ["gemini"] }];
    expect(applyFilters(rows, { protocols: "gemini" })).toHaveLength(1);
  });

  it("paginates and clamps out-of-range pages", () => {
    const rows = Array.from({ length: 25 }, (_, index) => index);
    const first = paginate(rows, { page: 1, pageSize: 10 });
    expect(first.rows).toHaveLength(10);
    expect(first.pages).toBe(3);

    const last = paginate(rows, { page: 99, pageSize: 10 });
    expect(last.page).toBe(3);
    expect(last.rows).toHaveLength(5);
  });

  it("cycles sort direction and clears on the third click", () => {
    expect(nextSort(null, "model")).toEqual({ key: "model", direction: "asc" });
    expect(nextSort({ key: "model", direction: "asc" }, "model")).toEqual({ key: "model", direction: "desc" });
    expect(nextSort({ key: "model", direction: "desc" }, "model")).toEqual({ key: null, direction: "asc" });
    expect(nextSort({ key: "model", direction: "asc" }, "provider")).toEqual({ key: "provider", direction: "asc" });
  });

  it("reports aria-sort values for the active column only", () => {
    expect(sortAriaValue({ key: "a", direction: "asc" }, "a")).toBe("ascending");
    expect(sortAriaValue({ key: "a", direction: "desc" }, "a")).toBe("descending");
    expect(sortAriaValue({ key: "a", direction: "asc" }, "b")).toBe("none");
  });
});
