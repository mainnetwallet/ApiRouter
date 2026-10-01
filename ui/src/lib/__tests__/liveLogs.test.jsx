import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import {
  STATE, STEP, buildRow, filterRows, ingestEvent, ingestPayload, isLive, isNearBottom, mergeRows
} from "../liveLogs.js";
import { createSseParser } from "../../api/liveStream.js";
import { LiveLogList, LiveLogRow, describeOutcome, describeStepOutcome, formatClock } from "../../components/domain/LiveLogList.jsx";

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
const cards = (html) => (html.match(/livelog__card /g) ?? []).length;
const boxes = (html) => (html.match(/data-step-state=/g) ?? []).length;

describe("one full card per model tried", () => {
  it("a finished call with a fallback is two cards, each with its own box", () => {
    const row = buildRow(finished());
    expect(row.state).toBe(STATE.SUCCESS);
    const html = render([row]);
    expect(cards(html)).toBe(2);
    expect(boxes(html)).toBe(2);
  });

  it("every card has the same shape: a header (time, state, protocol, request id) above its box", () => {
    const html = render([buildRow(finished())]);
    const parts = html.split("livelog__card ").slice(1);
    expect(parts).toHaveLength(2);
    for (const part of parts) {
      expect(part).toContain("livelog__card-head");
      expect(part).toContain("abc12345");
      expect(part).toContain("gemini · gemini-3.7-flash");
      expect(part).toContain("data-step-state");
    }
    // The failed model's card carries its own state; the last card carries the call's.
    expect(parts[0]).toContain("FAILED");
    expect(parts[1]).toContain("SUCCESS");
    expect(parts[1]).toContain("200 · 1.82 s");
  });

  it("a single-model call is one card, same shape, no FALLBACK line", () => {
    const html = render([buildRow(finished({ attempts: [{ provider: "gemini", model: "m", keyIndex: 1, ok: true, status: 200, latencyMs: 90 }] }))]);
    expect(cards(html)).toBe(1);
    expect(html).not.toContain("FALLBACK");
  });

  it("the FALLBACK line sits between two cards, not inside one", () => {
    const html = render([buildRow(finished())]);
    const first = html.indexOf("livelog__card ");
    const second = html.indexOf("livelog__card ", first + 1);
    const fallback = html.indexOf("livelog__fallback");
    expect(first).toBeLessThan(fallback);
    expect(fallback).toBeLessThan(second);
  });

  it("each attempt is a box: the failed one first, then the one that answered", () => {
    const row = buildRow(finished());
    expect(row).toMatchObject({ provider: "gemini", keyIndex: 1, status: 200, durationMs: 1820 });
    expect(row.steps.map((step) => step.state)).toEqual([STEP.FAILED, STEP.SUCCESS]);
    expect(row.steps[0]).toMatchObject({ keyIndex: 0, status: 429, reason: "rate limited" });

    const html = render([row]);
    expect(html).toContain("Gemini · gemini-3.7-flash · key 0");
    expect(html).toContain("Gemini · gemini-3.7-flash · key 1");
    expect(html).toContain("429 · 410 ms");
    expect(html).toContain("200 · 612 ms");
    expect(html).toContain("200 · 1.82 s");
    expect(html).toContain("abc12345");
  });

  it("a FALLBACK line sits between a failed box and the next box, and only there", () => {
    const html = render([buildRow(finished())]);
    expect(html).toContain("FALLBACK · 429 · rate limited");
    expect((html.match(/FALLBACK/g) ?? [])).toHaveLength(1);
    expect(html.indexOf("data-step-state=\"FAILED\"")).toBeLessThan(html.indexOf("FALLBACK"));
    expect(html.indexOf("FALLBACK")).toBeLessThan(html.indexOf("data-step-state=\"SUCCESS\""));
  });

  it("a plain success is a single box and no fallback line", () => {
    const row = buildRow(finished({ attempts: [{ provider: "gemini", model: "m", keyIndex: 1, ok: true, status: 200, latencyMs: 90 }] }));
    expect(row.steps).toHaveLength(1);
    const html = render([row]);
    expect(html).not.toContain("FALLBACK");
    expect(boxes(html)).toBe(1);
  });

  it("different models each get their own box", () => {
    const row = buildRow(finished({
      attempts: [
        { provider: "groq", model: "model-a", keyIndex: 0, ok: false, status: 503, latencyMs: 80 },
        { provider: "cerebras", model: "model-b", keyIndex: 0, ok: true, status: 200, latencyMs: 120 }
      ]
    }));
    const html = render([row]);
    expect(html).toContain("model-a");
    expect(html).toContain("model-b");
    expect(boxes(html)).toBe(2);
  });

  it("a failed call shows every failed box and the reason", () => {
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
    expect(row.steps.map((step) => step.state)).toEqual([STEP.FAILED, STEP.FAILED]);
    const html = render([row]);
    expect(html).toContain("FAILED");
    expect(html).toContain("All routing targets failed");
    expect(html).toContain("502");
    expect(html).not.toContain("SUCCESS");
  });

  it("represents a request that never reached a provider", () => {
    const row = buildRow({ seq: 3, id: "r3", receivedAt: T0, httpStatus: 401, outcome: "failed", errorMessage: "client authentication failed", attempts: [] });
    expect(row).toMatchObject({ state: STATE.FAILED, status: 401, reason: "client authentication failed", key: 3 });
    expect(row.steps).toEqual([]);
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
    expect(row.steps.map((step) => step.state)).toEqual([STEP.ROUTING]);
  });

  it("RUNNING: the first attempt is on the wire", () => {
    const row = buildRow(running({ inflight: wire }));
    expect(row.state).toBe(STATE.RUNNING);
    expect(row.steps.map((step) => step.state)).toEqual([STEP.CALLING]);
    const html = render([row]);
    expect(html).toContain("CALLING");
    expect(html).toContain("Hugging Face · Qwen/Qwen2.5-Coder-32B-Instruct · key 0");
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
    expect(row.steps.map((step) => step.state)).toEqual([STEP.FAILED, STEP.CALLING]);
    expect(html).toContain("FALLBACK · 429 · rate limited");
    expect(html).toContain("Hugging Face · m · key 0");
    expect(html).toContain("Hugging Face · m · key 1");
  });

  it("after a failure with nothing on the wire yet, the next box is a ROUTING placeholder", () => {
    const row = buildRow(running({
      attempts: [{ provider: "groq", model: "m", keyIndex: 0, ok: false, status: 500, latencyMs: 40 }],
      attemptCount: 1
    }));
    expect(row.state).toBe(STATE.RETRYING);
    expect(row.steps.map((step) => step.state)).toEqual([STEP.FAILED, STEP.ROUTING]);
    expect(render([row])).toContain("Choosing next target");
  });

  it("a call whose last attempt succeeded but is still finishing is RUNNING, not RETRYING", () => {
    const row = buildRow(running({
      attempts: [{ provider: "groq", model: "m", keyIndex: 0, ok: true, status: 200, latencyMs: 40 }],
      attemptCount: 1
    }));
    expect(row.state).toBe(STATE.RUNNING);
    expect(row.steps.map((step) => step.state)).toEqual([STEP.SUCCESS]);
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

  it("a CALLING box ticks from its own start; finished boxes are fixed", () => {
    const [calling] = buildRow(running({ inflight: wire })).steps;
    expect(describeStepOutcome(calling, wire.startedAt + 1500)).toBe("1.50 s");
    const [failed] = buildRow(finished()).steps;
    expect(describeStepOutcome(failed, T0 + 99_000)).toBe("429 · 410 ms");
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
        steps: [{ state: STEP.FAILED, provider: "groq", keyIndex: 2, status: 500, detail: `x ${SECRET}`, reason: `y ${SECRET}` }]
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

describe("pushed events", () => {
  it("an event becomes a row; an old running call is not mistaken for a gateway restart", () => {
    const { rows, maxSeq } = ingestEvent({ event: "pending", data: running({ startSeq: 3, inflight: wire }) }, { maxSeq: 40 });
    expect(rows).toHaveLength(1);
    expect(rows[0].state).toBe(STATE.RUNNING);
    expect(maxSeq).toBe(40);
  });

  it("ignores malformed events and respects the cleared floor", () => {
    expect(ingestEvent({ event: "pending", data: null }).rows).toEqual([]);
    expect(ingestEvent({ event: "entry", data: finished({ startSeq: 2, seq: 3 }) }, { floor: 3 }).rows).toEqual([]);
  });

  it("each pushed step updates the same card: ROUTING -> CALLING -> fallback -> SUCCESS", () => {
    const events = [
      running({ startSeq: 7 }),
      running({ startSeq: 7, inflight: wire }),
      running({ startSeq: 7, attempts: [{ provider: "huggingface", model: "m", keyIndex: 0, ok: false, status: 429, latencyMs: 90 }], inflight: null }),
      running({ startSeq: 7, attempts: [{ provider: "huggingface", model: "m", keyIndex: 0, ok: false, status: 429, latencyMs: 90 }], inflight: { ...wire, keyIndex: 1 } })
    ];
    let current = [];
    const seen = [];
    for (const data of events) {
      current = mergeRows(current, ingestEvent({ event: "pending", data }).rows);
      seen.push(current[0].steps.map((step) => step.state).join(","));
    }
    current = mergeRows(current, ingestEvent({ event: "entry", data: finished({ startSeq: 7, seq: 9 }) }).rows);
    seen.push(current[0].steps.map((step) => step.state).join(","));

    expect(current).toHaveLength(1);
    expect(seen).toEqual([
      "ROUTING", "CALLING", "FAILED,ROUTING", "FAILED,CALLING", "FAILED,SUCCESS"
    ]);
  });

  it("a stale snapshot never turns a finished call back into a running one", () => {
    const done = buildRow(finished({ startSeq: 5, seq: 6 }));
    const stale = buildRow(running({ startSeq: 5, inflight: wire }));
    expect(mergeRows([done], [stale])[0].state).toBe(STATE.SUCCESS);
  });

  it("a stale snapshot never moves a running call backwards", () => {
    const calling = buildRow(running({ startSeq: 5, inflight: wire }));
    const older = buildRow(running({ startSeq: 5 }));
    expect(mergeRows([calling], [older])[0].state).toBe(STATE.RUNNING);

    const retrying = buildRow(running({ startSeq: 5, attempts: [{ provider: "g", model: "m", keyIndex: 0, ok: false, status: 500, latencyMs: 1 }], inflight: wire }));
    expect(mergeRows([retrying], [calling])[0].steps).toHaveLength(2);
  });
});

describe("SSE parser", () => {
  const collect = (chunks) => {
    const out = [];
    const parser = createSseParser((e) => out.push(e));
    for (const chunk of chunks) parser.feed(chunk);
    return out;
  };

  it("parses events split across chunks and ignores heartbeats", () => {
    const out = collect([
      ": ping\n\nevent: pending\nda", 'ta: {"a":1}\n', '\nevent: entry\ndata: {"b":2}\n\n'
    ]);
    expect(out).toEqual([{ event: "pending", data: { a: 1 } }, { event: "entry", data: { b: 2 } }]);
  });

  it("handles CRLF and skips malformed data without throwing", () => {
    const out = collect(['event: snapshot\r\ndata: {"ok":true}\r\n\r\n', "event: x\ndata: {oops\n\n", 'event: y\ndata: {"n":1}\n\n']);
    expect(out.map((e) => e.event)).toEqual(["snapshot", "y"]);
  });
});
