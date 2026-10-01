import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import {
  STATE, buildRow, filterRows, ingestPayload, isLive, isNearBottom, mergeRows
} from "../liveLogs.js";
import { LiveLogList, LiveLogRow, describeOutcome, formatClock } from "../../components/domain/LiveLogList.jsx";

const SECRET = "sk-super-secret-provider-key-1234567890";
const T0 = Date.UTC(2026, 9, 1, 14, 2, 11);

/** key 0 -> 429, key 1 -> 200, same provider and model. */
function finished(overrides = {}) {
  return {
    seq: 5,
    startSeq: 1,
    id: "abc12345-aaaa",
    protocol: "gemini",
    requestedModel: "gemini-3.7-flash",
    receivedAt: T0,
    totalMs: 1820,
    outcome: "success",
    httpStatus: 200,
    finalProvider: "gemini",
    finalModel: "gemini-3.7-flash",
    finalKeyIndex: 1,
    attempts: [
      { index: 1, provider: "gemini", model: "gemini-3.7-flash", keyIndex: 0, ok: false, status: 429, startedAt: T0, latencyMs: 410, errorMessage: "quota" },
      { index: 2, provider: "gemini", model: "gemini-3.7-flash", keyIndex: 1, ok: true, status: 200, startedAt: T0 + 1100, latencyMs: 612, errorMessage: null }
    ],
    ...overrides
  };
}

function running(overrides = {}) {
  return {
    startSeq: 2,
    id: "run00001-bbbb",
    protocol: "anthropic",
    requestedModel: "Qwen/Qwen2.5-Coder-32B-Instruct",
    receivedAt: T0,
    outcome: "pending",
    attempts: [],
    attemptCount: 0,
    fallbackCount: 0,
    inflight: null,
    ...overrides
  };
}

const wire = { provider: "huggingface", model: "Qwen/Qwen2.5-Coder-32B-Instruct", keyIndex: 0, startedAt: T0 + 5 };
const render = (rows, now = T0 + 2500) => renderToStaticMarkup(<LiveLogList rows={rows} now={now} />);
const li = (html) => (html.match(/<li /g) ?? []).length;

describe("one row per API call", () => {
  it("a finished call with a fallback is still a single row", () => {
    const row = buildRow(finished());
    expect(row.state).toBe(STATE.SUCCESS);
    expect(li(render([row]))).toBe(1);
  });

  it("the headline is the target that answered; the failed attempt rides along", () => {
    const row = buildRow(finished());
    expect(row).toMatchObject({ provider: "gemini", keyIndex: 1, status: 200, durationMs: 1820 });
    expect(row.chain).toHaveLength(1);
    expect(row.chain[0]).toMatchObject({ keyIndex: 0, status: 429, reason: "rate limited" });

    const html = render([row]);
    expect(html).toContain("Gemini · gemini-3.7-flash · key 1");
    expect(html).toContain("↳ Gemini · gemini-3.7-flash · key 0 · 429 · rate limited");
    expect(html).toContain("200 · 1.82 s");
    expect(html).toContain("abc12345");
  });

  it("a plain success has no fallback lines", () => {
    const row = buildRow(finished({ attempts: [{ provider: "gemini", model: "m", keyIndex: 1, ok: true, status: 200, latencyMs: 90 }] }));
    expect(row.chain).toEqual([]);
    expect(render([row])).not.toContain("↳");
  });

  it("a failed call shows every failed attempt and the reason", () => {
    const row = buildRow(finished({
      outcome: "failed",
      httpStatus: 502,
      errorMessage: "All routing targets failed",
      finalProvider: "gemini", finalModel: "m", finalKeyIndex: 1,
      attempts: [
        { provider: "gemini", model: "m", keyIndex: 0, ok: false, status: 429, latencyMs: 50 },
        { provider: "gemini", model: "m", keyIndex: 1, ok: false, status: 500, latencyMs: 60 }
      ]
    }));
    expect(row.state).toBe(STATE.FAILED);
    expect(row.chain).toHaveLength(2);
    const html = render([row]);
    expect(html).toContain("FAILED");
    expect(html).toContain("All routing targets failed");
    expect(html).toContain("502");
  });

  it("represents a request that never reached a provider", () => {
    const row = buildRow({ seq: 3, id: "r3", receivedAt: T0, httpStatus: 401, outcome: "failed", errorMessage: "client authentication failed", attempts: [] });
    expect(row).toMatchObject({ state: STATE.FAILED, status: 401, reason: "client authentication failed", key: 3 });
  });
});

describe("a row moves through the call", () => {
  it("ROUTING: received, nothing on the wire yet", () => {
    const row = buildRow(running());
    expect(row.state).toBe(STATE.ROUTING);
    expect(isLive(row)).toBe(true);
    const html = render([row]);
    expect(html).toContain("ROUTING");
    expect(html).toContain("livelog__type--live");
    expect(html).toContain("anthropic · Qwen/Qwen2.5-Coder-32B-Instruct");
  });

  it("RUNNING: the first attempt is on the wire", () => {
    const row = buildRow(running({ inflight: wire }));
    expect(row.state).toBe(STATE.RUNNING);
    expect(render([row])).toContain("Hugging Face · Qwen/Qwen2.5-Coder-32B-Instruct · key 0");
  });

  it("RETRYING: a failure happened and the next target is on the wire", () => {
    const row = buildRow(running({
      attempts: [{ provider: "huggingface", model: "m", keyIndex: 0, ok: false, status: 429, latencyMs: 300 }],
      attemptCount: 1,
      inflight: { provider: "huggingface", model: "m", keyIndex: 1, startedAt: T0 + 400 }
    }));
    expect(row.state).toBe(STATE.RETRYING);
    expect(row.keyIndex).toBe(1);
    const html = render([row]);
    expect(html).toContain("RETRYING");
    expect(html).toContain("key 1");
    expect(html).toContain("↳ Hugging Face · m · key 0 · 429 · rate limited");
  });

  it("the same call keeps one key from start to finish, so it updates in place", () => {
    const rows = [
      buildRow(running({ startSeq: 7 })),
      buildRow(running({ startSeq: 7, inflight: wire })),
      buildRow({ ...finished({ startSeq: 7, seq: 9 }) })
    ];
    expect(new Set(rows.map((row) => row.key))).toEqual(new Set([7]));

    let current = [];
    for (const row of rows) current = mergeRows(current, [row]);
    expect(current).toHaveLength(1);
    expect(current[0].state).toBe(STATE.SUCCESS);
  });

  it("the elapsed time of a running call follows the clock; a finished call is fixed", () => {
    const row = buildRow(running({ inflight: wire }));
    expect(describeOutcome(row, T0 + 1500)).toBe("1.50 s");
    expect(describeOutcome(row, T0 + 4200)).toBe("4.20 s");
    expect(describeOutcome(buildRow(finished()), T0 + 99_000)).toBe("200 · 1.82 s");
  });
});

describe("rendering safety", () => {
  it("does not crash on sparse rows", () => {
    const rows = [
      buildRow({}), buildRow(null), buildRow({ seq: 9, attempts: [null, {}, { ok: true }] }),
      buildRow({ startSeq: 4, outcome: "pending" })
    ].filter(Boolean);
    expect(() => render(rows)).not.toThrow();
    expect(renderToStaticMarkup(<LiveLogRow row={null} />)).toBe("");
    expect(formatClock(undefined)).toBe("—");
  });

  it("never renders secrets or credential-bearing text", () => {
    const row = buildRow(finished({
      errorMessage: `all failed: Authorization: Bearer ${SECRET}`,
      outcome: "failed",
      attempts: [{
        provider: "gemini", model: "gemini-3.7-flash", keyIndex: 0, ok: false, status: 401, latencyMs: 50,
        errorMessage: `invalid key ${SECRET} (x-goog-api-key rejected, api_key=${SECRET})`,
        apiKey: SECRET, authorization: `Bearer ${SECRET}`, headers: { authorization: `Bearer ${SECRET}` }
      }]
    }));

    const html = render([row]);
    expect(html).not.toContain(SECRET);
    expect(html).not.toMatch(/Bearer/i);
    expect(html).not.toMatch(/authorization/i);
    expect(html).not.toMatch(/x-goog-api-key/i);
    expect(html).toContain("key 0");
  });

  it("scrubs secrets even when handed an unsanitized row directly", () => {
    const html = renderToStaticMarkup(
      <LiveLogRow row={{
        key: 1, state: STATE.FAILED, provider: "groq", keyIndex: 2, reason: `boom ${SECRET}`,
        chain: [{ provider: "groq", keyIndex: 2, status: 500, detail: `x ${SECRET}`, reason: `y ${SECRET}` }]
      }} />
    );
    expect(html).not.toContain(SECRET);
    expect(html).toContain("key 2");
  });
});

describe("ingestion and filtering", () => {
  it("builds rows from both finished entries and running ones", () => {
    const { rows, maxSeq } = ingestPayload({ entries: [finished()], pending: [running({ startSeq: 8 })] });
    expect(rows.map((row) => row.state).sort()).toEqual([STATE.ROUTING, STATE.SUCCESS]);
    expect(maxSeq).toBe(8);
  });

  it("a running call becomes its finished row on the next poll", () => {
    const first = ingestPayload({ entries: [], pending: [running({ startSeq: 3, inflight: wire })] });
    const after = ingestPayload({ entries: [finished({ startSeq: 3, seq: 4 })], pending: [] }, { maxSeq: first.maxSeq });

    const merged = mergeRows(mergeRows([], first.rows), after.rows);
    expect(merged).toHaveLength(1);
    expect(merged[0].state).toBe(STATE.SUCCESS);
  });

  it("does not bring back rows that were cleared", () => {
    const { rows } = ingestPayload({ entries: [finished({ startSeq: 1, seq: 2 }), finished({ startSeq: 3, seq: 4, id: "later" })] }, { floor: 2, maxSeq: 4 });
    expect(rows.map((row) => row.requestId)).toEqual(["later"]);
  });

  it("detects a gateway restart (sequence counter reset)", () => {
    const result = ingestPayload({ entries: [finished({ startSeq: 1, seq: 2, id: "fresh" })] }, { floor: 50, maxSeq: 57 });
    expect(result.restarted).toBe(true);
    expect(result.rows.map((row) => row.requestId)).toEqual(["fresh"]);
  });

  it("merges chronologically with the newest last, de-duplicated and capped", () => {
    const early = buildRow(finished({ startSeq: 1, receivedAt: T0 }));
    const late = buildRow(finished({ startSeq: 2, receivedAt: T0 + 60_000, id: "late" }));

    const merged = mergeRows([late], [early]);
    expect(merged.map((row) => row.key)).toEqual([1, 2]);
    expect(mergeRows(merged, [early])).toHaveLength(2);
    expect(mergeRows(merged, [buildRow(finished({ startSeq: 3, receivedAt: T0 + 120_000 }))], { max: 2 })).toHaveLength(2);
  });

  it("filters by provider, status, search and request id", () => {
    const all = [
      buildRow(finished({ startSeq: 1, id: "abc123" })),
      buildRow(finished({ startSeq: 2, id: "zzz999", finalProvider: "groq", attempts: [{ provider: "groq", model: "model-a", keyIndex: 0, ok: true, status: 200, latencyMs: 90 }] })),
      buildRow(finished({ startSeq: 3, id: "bad", outcome: "failed", httpStatus: 502, errorMessage: "boom" })),
      buildRow(running({ startSeq: 4, id: "live1", inflight: wire }))
    ];

    expect(filterRows(all, { provider: "groq" }).map((row) => row.requestId)).toEqual(["zzz999"]);
    expect(filterRows(all, { status: "failed" }).map((row) => row.requestId)).toEqual(["bad"]);
    expect(filterRows(all, { status: "success" })).toHaveLength(2);
    expect(filterRows(all, { status: "running" }).map((row) => row.requestId)).toEqual(["live1"]);
    expect(filterRows(all, { requestId: "zzz" }).map((row) => row.requestId)).toEqual(["zzz999"]);
    expect(filterRows(all, { search: "rate limited" }).map((row) => row.requestId)).toContain("abc123");
    expect(filterRows(all, {})).toHaveLength(all.length);
  });
});

describe("auto-scroll", () => {
  it("treats a container near the bottom as following the latest", () => {
    expect(isNearBottom({ scrollTop: 480, scrollHeight: 1000, clientHeight: 500 })).toBe(true);
    expect(isNearBottom({ scrollTop: 100, scrollHeight: 1000, clientHeight: 500 })).toBe(false);
    expect(isNearBottom({})).toBe(true);
  });
});
