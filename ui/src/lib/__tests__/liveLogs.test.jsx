import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import {
  MAX_ROWS, STATE, buildAttemptRow, buildRequestRow, buildRows, filterRows, ingestEvent, ingestPayload,
  isLive, isNearBottom, mergeRows, readUsage, shortRequestId
} from "../liveLogs.js";
import { createSseParser } from "../../api/liveStream.js";
import { LiveLogList, LiveLogRow, describeOutcome, describeUsage, formatClock, formatRowsAsText } from "../../components/domain/LiveLogList.jsx";

const SECRET = "sk-super-secret-provider-key-1234567890";
const T0 = Date.UTC(2026, 9, 1, 14, 2, 11);

/**
 * An attempt event as the gateway sends it (`attempt` push, snapshot or
 * `/api/attempts`). `n` is the attempt's number: it makes the id, the order and
 * the start time, so a test reads in the order things happened.
 */
function attempt(n, overrides = {}) {
  return {
    attemptId: `att-test-${String(n).padStart(6, "0")}`,
    attemptSeq: n,
    requestId: "req-a1b2c3-000001",
    requestSeq: 1,
    sessionId: "default",
    pool: "text",
    protocol: "openai-chat",
    requestedModel: "model-b",
    phase: null,
    callIndex: 1,
    provider: "groq",
    model: "model-b",
    keyIndex: 0,
    state: "success",
    ok: true,
    status: 200,
    startedAt: T0 + n * 1000,
    completedAt: T0 + n * 1000 + 120,
    latencyMs: 120,
    errorMessage: null,
    ...overrides
  };
}

const failed = (n, status, overrides = {}) =>
  attempt(n, { state: "failed", ok: false, status, errorMessage: "boom", ...overrides });

const calling = (n, overrides = {}) =>
  attempt(n, { state: "calling", ok: false, status: null, completedAt: null, latencyMs: null, ...overrides });

const row = (event, ctx) => buildAttemptRow(event, ctx);
const rowsOf = (...events) => events.map((event) => row(event));
const render = (rows, now = T0 + 90_000) => renderToStaticMarkup(<LiveLogList rows={rows} now={now} />);
const cards = (html) => (html.match(/<li class="livelog__card /g) ?? []).length;
const attemptIds = (html) => [...html.matchAll(/data-attempt-id="([^"]+)"/g)].map((m) => m[1]);

/** A finished request entry as `/api/requests` lists it, attempts nested. */
function entry(overrides = {}) {
  return {
    seq: 5,
    startSeq: 1,
    requestId: "req-a1b2c3-000001",
    id: "default",
    protocol: "openai-chat",
    pool: "text",
    requestedModel: "model-b",
    receivedAt: T0,
    totalMs: 1820,
    outcome: "success",
    httpStatus: 200,
    finalProvider: "groq",
    finalModel: "model-b",
    finalKeyIndex: 0,
    attempts: [],
    ...overrides
  };
}

describe("one real upstream attempt is one card", () => {
  it("two calls to the very same target in one request are two cards (Call #3 and Call #4)", () => {
    const call3 = attempt(3, { callIndex: 3 });
    const call4 = attempt(4, { callIndex: 4 });

    const rows = mergeRows([], rowsOf(call3, call4));
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.callIndex)).toEqual([3, 4]);
    expect(rows[0].key).not.toBe(rows[1].key);

    const html = render(rows);
    expect(cards(html)).toBe(2);
    expect(attemptIds(html)).toEqual([call3.attemptId, call4.attemptId]);
    expect(html).toContain("Call #3");
    expect(html).toContain("Call #4");
  });

  it("the same target succeeding on two consecutive requests is two cards", () => {
    const first = attempt(1, { requestId: "req-a1b2c3-000001", requestSeq: 1 });
    const second = attempt(2, { requestId: "req-a1b2c3-000002", requestSeq: 2 });

    const rows = mergeRows([], rowsOf(first, second));
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.state === STATE.SUCCESS && r.provider === "groq" && r.keyIndex === 0)).toBe(true);
    expect(rows.map((r) => r.requestId)).toEqual(["req-a1b2c3-000001", "req-a1b2c3-000002"]);
    expect(cards(render(rows))).toBe(2);
  });

  it("the same target failing on two consecutive requests is two cards", () => {
    const rows = mergeRows([], rowsOf(
      failed(1, 429, { requestSeq: 1, requestId: "req-a1b2c3-000001" }),
      failed(2, 429, { requestSeq: 2, requestId: "req-a1b2c3-000002" })
    ));
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.state === STATE.FAILED && r.status === 429)).toBe(true);
  });

  it("a fallback chain is one card per attempt, in the order they were made", () => {
    const events = [
      failed(1, 429, { provider: "gemini", model: "model-a", keyIndex: 0, callIndex: 1 }),
      failed(2, 500, { provider: "gemini", model: "model-a", keyIndex: 1, callIndex: 2 }),
      attempt(3, { provider: "groq", model: "model-b", keyIndex: 0, callIndex: 3 })
    ];
    // Arrive out of order, as a snapshot and a push can.
    const rows = mergeRows([], rowsOf(events[2], events[0], events[1]));

    expect(rows.map((r) => r.attemptId)).toEqual(events.map((e) => e.attemptId));
    expect(rows.map((r) => [r.provider, r.keyIndex, r.status, r.state])).toEqual([
      ["gemini", 0, 429, STATE.FAILED], ["gemini", 1, 500, STATE.FAILED], ["groq", 0, 200, STATE.SUCCESS]
    ]);
    expect(new Set(rows.map((r) => r.requestId)).size).toBe(1);

    const html = render(rows);
    expect(cards(html)).toBe(3);
    // A FALLBACK line joins each failed attempt to the next, and only those.
    expect((html.match(/livelog__fallback/g) ?? []).length).toBe(2);
    expect(html).toContain("FALLBACK · 429");
    expect(html).toContain("FALLBACK · 500");
  });

  it("a card says only what its own attempt says", () => {
    const html = render(rowsOf(failed(1, 429), attempt(2, { callIndex: 2 })));
    const [firstCard, secondCard] = html.split('<li class="livelog__card ').filter((part) => part.includes("data-attempt-id"));
    expect(firstCard).toContain("429");
    expect(firstCard).toContain("FAILED");
    expect(firstCard).not.toContain("SUCCESS");
    expect(secondCard).toContain("SUCCESS");
    expect(secondCard).not.toContain("429");
  });

  it("the same provider/model/key shown again later never reuses an older card", () => {
    let rows = mergeRows([], rowsOf(attempt(1)));
    const held = rows[0];
    rows = mergeRows(rows, rowsOf(attempt(2, { requestSeq: 2, requestId: "req-a1b2c3-000002" })));
    rows = mergeRows(rows, rowsOf(attempt(3, { requestSeq: 3, requestId: "req-a1b2c3-000003" })));

    expect(rows).toHaveLength(3);
    expect(rows[0]).toBe(held);
  });

  it("an id is the only thing that makes a card: target, session and request never do", () => {
    // Identical in every respect except the attempt id.
    const a = attempt(1);
    const b = { ...a, attemptId: "att-test-OTHER", attemptSeq: 2 };
    expect(mergeRows([], rowsOf(a, b))).toHaveLength(2);
  });

  it("a skipped target is not an attempt and gets no card", () => {
    expect(buildAttemptRow({ skipped: true, provider: "groq", model: "m", keyIndex: 0, index: 1 }, { startSeq: 1 })).toBeNull();
    const rows = buildRows(entry({
      attempts: [
        { index: 1, skipped: true, skipReason: "cooldown", provider: "groq", model: "m", keyIndex: 0, ok: false },
        { ...attempt(1), index: 2 }
      ]
    }));
    expect(rows).toHaveLength(1);
    expect(rows[0].attemptId).toBe("att-test-000001");
  });
});

describe("an attempt moves once, and only that attempt moves", () => {
  it("CALLING becomes SUCCESS or FAILED on the same card, not on a new one", () => {
    let rows = mergeRows([], rowsOf(calling(1)));
    expect(rows[0].state).toBe(STATE.CALLING);
    expect(isLive(rows[0])).toBe(true);

    rows = mergeRows(rows, rowsOf(attempt(1)));
    expect(rows).toHaveLength(1);
    expect(rows[0].state).toBe(STATE.SUCCESS);
    expect(rows[0].status).toBe(200);
    expect(isLive(rows[0])).toBe(false);

    let other = mergeRows([], rowsOf(calling(2)));
    other = mergeRows(other, rowsOf(failed(2, 500)));
    expect(other).toHaveLength(1);
    expect(other[0].state).toBe(STATE.FAILED);
  });

  it("a later attempt never changes an earlier attempt's card", () => {
    let rows = mergeRows([], rowsOf(failed(1, 429)));
    const first = rows[0];

    rows = mergeRows(rows, rowsOf(calling(2, { callIndex: 2 })));
    rows = mergeRows(rows, rowsOf(attempt(2, { callIndex: 2 })));

    expect(rows).toHaveLength(2);
    expect(rows[0]).toBe(first);
    expect(rows[0].state).toBe(STATE.FAILED);
    expect(rows[0].status).toBe(429);
  });

  it("a stale snapshot never turns a finished attempt back into CALLING", () => {
    let rows = mergeRows([], rowsOf(attempt(1)));
    rows = mergeRows(rows, rowsOf(calling(1)));
    expect(rows[0].state).toBe(STATE.SUCCESS);
  });

  it("a finished attempt is final: a conflicting report cannot rewrite it", () => {
    let rows = mergeRows([], rowsOf(failed(1, 429)));
    const held = rows[0];
    rows = mergeRows(rows, rowsOf(attempt(1)));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toBe(held);
    expect(rows[0].status).toBe(429);
  });

  it("a request with nothing on the wire yet is one ROUTING card that a real attempt replaces", () => {
    const routing = buildRows(entry({ outcome: "pending", attempts: [], inflight: null, totalMs: null, httpStatus: null }));
    expect(routing).toHaveLength(1);
    expect(routing[0]).toMatchObject({ kind: "request", state: STATE.ROUTING, key: "req:1" });

    let rows = mergeRows([], routing);
    expect(isLive(rows[0])).toBe(true);
    rows = mergeRows(rows, rowsOf(calling(1)));
    expect(rows.map((r) => r.kind)).toEqual(["attempt"]);
  });

  it("a request rejected before any provider was tried is a single request card", () => {
    const [card] = buildRows(entry({ outcome: "failed", httpStatus: 503, errorType: "no_route", errorMessage: "No route", attempts: [], finalProvider: null, finalModel: null, finalKeyIndex: null }));
    expect(card).toMatchObject({ kind: "request", state: STATE.FAILED, status: 503, reason: "No route" });
    const html = render([card]);
    expect(cards(html)).toBe(1);
    expect(html).not.toContain("data-step-state");
  });
});

describe("live and historical logs use the same attempt events", () => {
  it("an `attempt` push becomes a card; the same id later updates it, a new id is a new card", () => {
    const first = ingestEvent({ event: "attempt", data: calling(1) });
    expect(first.rows).toHaveLength(1);
    expect(first.rows[0].state).toBe(STATE.CALLING);

    let rows = mergeRows([], first.rows);
    rows = mergeRows(rows, ingestEvent({ event: "attempt", data: attempt(1) }).rows);
    expect(rows).toHaveLength(1);
    expect(rows[0].state).toBe(STATE.SUCCESS);

    // The same target once more: a new attempt id, a new card.
    rows = mergeRows(rows, ingestEvent({ event: "attempt", data: calling(2, { requestSeq: 2, requestId: "req-a1b2c3-000002" }) }).rows);
    rows = mergeRows(rows, ingestEvent({ event: "attempt", data: attempt(2, { requestSeq: 2, requestId: "req-a1b2c3-000002" }) }).rows);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.state)).toEqual([STATE.SUCCESS, STATE.SUCCESS]);
  });

  it("every real attempt pushed one after another is appended, never replaced", () => {
    let rows = [];
    for (const event of [calling(1), failed(1, 429), calling(2), failed(2, 500), calling(3), attempt(3)]) {
      rows = mergeRows(rows, ingestEvent({ event: "attempt", data: event }).rows);
    }
    expect(rows.map((r) => [r.callIndex ?? 1, r.status])).toEqual([[1, 429], [1, 500], [1, 200]]);
    expect(rows).toHaveLength(3);
  });

  it("a snapshot lists every attempt as its own card, including identical targets", () => {
    const payload = {
      entries: [entry({
        attempts: [
          { ...failed(1, 429, { provider: "gemini", model: "model-a" }), index: 1 },
          { ...attempt(2, { callIndex: 2 }), index: 2 },
          { ...attempt(3, { callIndex: 3 }), index: 3 }
        ]
      })],
      pending: [],
      attempts: [failed(1, 429, { provider: "gemini", model: "model-a" }), attempt(2, { callIndex: 2 }), attempt(3, { callIndex: 3 })]
    };
    const { rows } = ingestPayload(payload);
    const merged = mergeRows([], rows);

    // The listed events and the request's nested attempts are the same attempts: no duplicates.
    expect(merged).toHaveLength(3);
    expect(merged.map((r) => r.attemptId)).toEqual(["att-test-000001", "att-test-000002", "att-test-000003"]);
    expect(merged[1].provider).toBe(merged[2].provider);
    expect(merged[1].key).not.toBe(merged[2].key);
  });

  it("a history built from nested attempts alone (no event list) is the same cards", () => {
    const nested = entry({ attempts: [{ ...failed(1, 429), index: 1 }, { ...attempt(2, { callIndex: 2 }), index: 2 }] });
    const viaEntry = mergeRows([], ingestPayload({ entries: [nested], pending: [] }).rows);
    const viaEvents = mergeRows([], ingestPayload({ entries: [], pending: [], attempts: [failed(1, 429), attempt(2, { callIndex: 2 })] }).rows);
    expect(viaEntry.map((r) => [r.attemptId, r.state, r.status])).toEqual(viaEvents.map((r) => [r.attemptId, r.state, r.status]));
  });

  it("a running request's attempt on the wire is a CALLING card; its finished attempts keep theirs", () => {
    const pending = entry({
      outcome: "pending", totalMs: null, httpStatus: null,
      attempts: [{ ...failed(1, 429), index: 1 }],
      inflight: { attemptId: "att-test-000002", provider: "groq", model: "model-b", keyIndex: 1, protocol: "openai-chat", startedAt: T0 + 2000 }
    });
    const rows = mergeRows([], buildRows(pending));
    expect(rows.map((r) => [r.attemptId, r.state])).toEqual([["att-test-000001", STATE.FAILED], ["att-test-000002", STATE.CALLING]]);
  });

  it("an older gateway with no attempt ids still gets one card per attempt, never shared across requests", () => {
    const a = { index: 1, provider: "groq", model: "m", keyIndex: 0, ok: true, status: 200, startedAt: T0, latencyMs: 5 };
    const rows = mergeRows([], [
      ...buildRows(entry({ startSeq: 1, seq: 1, attempts: [a] })),
      ...buildRows(entry({ startSeq: 2, seq: 2, attempts: [a] }))
    ]);
    expect(rows).toHaveLength(2);
  });

  it("does not bring back cleared cards, and starts over when the gateway restarts", () => {
    const payload = { entries: [], pending: [], attempts: [attempt(1, { requestSeq: 3 })] };
    expect(ingestPayload(payload, { floor: 3 }).rows).toEqual([]);
    expect(ingestEvent({ event: "attempt", data: attempt(1, { requestSeq: 3 }) }, { floor: 3 }).rows).toEqual([]);
    expect(ingestPayload(payload, { floor: 2 }).rows).toHaveLength(1);

    const afterRestart = ingestPayload({ entries: [], pending: [], attempts: [attempt(1, { requestSeq: 1, attemptId: "att-new-000001" })] }, { maxSeq: 40 });
    expect(afterRestart.restarted).toBe(true);
    expect(afterRestart.rows).toHaveLength(1);
  });

  it("ignores malformed events and payloads", () => {
    expect(ingestEvent({ event: "attempt", data: null }).rows).toEqual([]);
    expect(ingestEvent({ event: "attempt", data: { provider: "groq" } }).rows).toEqual([]);
    expect(ingestEvent({ event: "pending", data: { nope: true } }).rows).toEqual([]);
    expect(ingestPayload({}).rows).toEqual([]);
    expect(buildRows(null)).toEqual([]);
    expect(buildRequestRow(null)).toBeNull();
  });
});

describe("text and vision attempts stay apart", () => {
  it("an identical target in each pool gives two independent cards, each tagged with its pool", () => {
    const text = attempt(1, { pool: "text", requestSeq: 1, requestId: "req-a1b2c3-000001" });
    const vision = attempt(2, { pool: "vision", requestSeq: 2, requestId: "req-a1b2c3-000002" });
    const rows = mergeRows([], rowsOf(text, vision));

    expect(rows.map((r) => r.pool)).toEqual(["text", "vision"]);
    expect(filterRows(rows, { pool: "vision" }).map((r) => r.attemptId)).toEqual([vision.attemptId]);
    expect(filterRows(rows, { pool: "text" }).map((r) => r.attemptId)).toEqual([text.attemptId]);
    expect(filterRows(rows, { search: "vision" })).toHaveLength(1);

    const html = render(rows);
    expect(cards(html)).toBe(2);
    expect(html).toContain("livelog__pool--text");
    expect(html).toContain("livelog__pool--vision");
  });

  it("defaults to text, and an unknown pool never becomes vision", () => {
    expect(row(attempt(1, { pool: undefined })).pool).toBe("text");
    expect(row(attempt(1, { pool: "sideways" })).pool).toBe("text");
    expect(row(attempt(1, { pool: "vision" })).pool).toBe("vision");
  });

  it("vision attempts keep their own independent fallback chain", () => {
    const rows = mergeRows([], rowsOf(
      failed(1, 429, { pool: "vision", provider: "openrouter", requestSeq: 1 }),
      attempt(2, { pool: "vision", provider: "mistral", callIndex: 2, requestSeq: 1 }),
      attempt(3, { pool: "text", requestSeq: 2, requestId: "req-a1b2c3-000002" })
    ));
    expect(rows.map((r) => r.pool)).toEqual(["vision", "vision", "text"]);
    expect((render(rows).match(/livelog__fallback/g) ?? []).length).toBe(1);
  });
});

describe("rendering safety", () => {
  it("does not crash on sparse rows", () => {
    const rows = [
      ...buildRows({}), ...buildRows(null),
      ...buildRows({ seq: 9, startSeq: 9, attempts: [null, {}, { ok: true }] }),
      ...buildRows({ startSeq: 4, outcome: "pending" })
    ];
    expect(() => render(rows)).not.toThrow();
    expect(renderToStaticMarkup(<LiveLogRow row={null} />)).toBe("");
    expect(formatClock(undefined)).toBe("—");
  });

  it("never renders secrets or credential-bearing text", () => {
    const rows = [row(failed(1, 401, {
      errorMessage: `invalid key ${SECRET} (x-goog-api-key rejected, api_key=${SECRET}) Authorization: Bearer ${SECRET}`,
      apiKey: SECRET, authorization: `Bearer ${SECRET}`, headers: { authorization: `Bearer ${SECRET}` }
    }))];
    const html = render(rows);
    expect(html).not.toContain(SECRET);
    expect(html).not.toMatch(/Bearer/i);
    expect(html).not.toMatch(/authorization/i);
    expect(html).not.toMatch(/x-goog-api-key/i);
    expect(html).toContain("key 0");
  });

  it("scrubs secrets even when handed an unsanitized row directly", () => {
    const html = renderToStaticMarkup(
      <LiveLogRow row={{
        key: "att-x", kind: "attempt", state: STATE.FAILED, provider: "groq", keyIndex: 2, status: 500,
        reason: `y ${SECRET}`, detail: `x ${SECRET}`
      }} />
    );
    expect(html).not.toContain(SECRET);
    expect(html).toContain("key 2");
  });
});

describe("the card", () => {
  it("shows the time, state, pool, call number, request id, then the model and the key/status/time", () => {
    const html = render(rowsOf(attempt(1, { keyIndex: 3, callIndex: 2 })));
    // The clock is local wall-clock time, so the expected value is derived from
    // the attempt's own start rather than written as a literal: "14:02:12" is
    // T0 in UTC, and asserting it only passes on a machine running in UTC.
    const started = new Date(T0 + 1000);
    const pad = (value) => String(value).padStart(2, "0");
    expect(html).toContain(
      `${pad(started.getHours())}:${pad(started.getMinutes())}:${pad(started.getSeconds())}`
    );
    expect(html).toContain("SUCCESS");
    expect(html).toContain("TEXT");
    expect(html).toContain("Call #2");
    expect(html).toContain("req-1");
    expect(html).toContain("key 3 · 200 · 120 ms");
    expect(html).toContain("Groq · model-b");
  });

  it("the model box is just the model: no key, no status", () => {
    const html = render(rowsOf(attempt(1)));
    const box = /livelog__target mono" title="([^"]*)"/.exec(html)[1];
    expect(box).toBe("Groq · model-b");
  });

  it("a CALLING card ticks from its own start; a finished card is fixed", () => {
    const r = row(calling(1));
    expect(describeOutcome(r, r.ts + 1500)).toBe("1.50 s");
    expect(describeOutcome(r, r.ts + 4000)).toBe("4.00 s");
    const done = row(attempt(1));
    expect(describeOutcome(done, done.ts + 99_000)).toBe(describeOutcome(done, done.ts + 1));
  });

  it("a failed card says why", () => {
    const html = render(rowsOf(failed(1, 429, { errorMessage: "quota exhausted" })));
    expect(html).toContain("livelog__detail--failed");
    expect(html).toContain("quota exhausted");
  });

  it("marks the first card of each request, so requests read as groups", () => {
    const html = render(rowsOf(
      failed(1, 429), attempt(2, { callIndex: 2 }),
      attempt(3, { requestSeq: 2, requestId: "req-a1b2c3-000002" })
    ));
    expect((html.match(/livelog__card--first/g) ?? []).length).toBe(2);
  });
});

describe("filtering", () => {
  const rows = mergeRows([], rowsOf(
    failed(1, 429, { provider: "gemini", model: "model-a" }),
    calling(2, { callIndex: 2, provider: "groq" }),
    attempt(3, { callIndex: 3, provider: "groq" }),
    attempt(4, { requestId: "req-a1b2c3-000009", requestSeq: 9 })
  ));

  it("filters by provider, status, search and request id", () => {
    expect(filterRows(rows, { provider: "gemini" }).map((r) => r.attemptId)).toEqual(["att-test-000001"]);
    expect(filterRows(rows, { status: "failed" })).toHaveLength(1);
    expect(filterRows(rows, { status: "running" }).map((r) => r.attemptId)).toEqual(["att-test-000002"]);
    expect(filterRows(rows, { status: "success" })).toHaveLength(2);
    expect(filterRows(rows, { search: "429" })).toHaveLength(1);
    expect(filterRows(rows, { search: "call 3" })).toHaveLength(1);
    expect(filterRows(rows, { requestId: "000009" }).map((r) => r.attemptId)).toEqual(["att-test-000004"]);
    expect(filterRows(rows, {})).toHaveLength(4);
  });
});

describe("the request id is not the attempt id", () => {
  it("short ids keep what tells requests apart", () => {
    expect(shortRequestId("req-0996e6-000042")).toBe("req-42");
    expect(shortRequestId("req-0996e6-000001")).not.toBe(shortRequestId("req-0996e6-000002"));
    expect(shortRequestId("abc12345-aaaa")).toBe("abc12345");
    expect(shortRequestId(null)).toBeNull();
  });

  it("a card carries both: the request it belongs to and its own attempt", () => {
    const r = row(attempt(7, { requestId: "req-a1b2c3-000004" }));
    expect(r.requestId).toBe("req-a1b2c3-000004");
    expect(r.attemptId).toBe("att-test-000007");
    expect(r.key).toBe(r.attemptId);
  });
});

describe("auto-scroll", () => {
  it("treats a container near the bottom as following the latest", () => {
    expect(isNearBottom({ scrollTop: 480, scrollHeight: 1000, clientHeight: 500 })).toBe(true);
    expect(isNearBottom({ scrollTop: 100, scrollHeight: 1000, clientHeight: 500 })).toBe(false);
    expect(isNearBottom({})).toBe(true);
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
      ": ping\n\nevent: attempt\nda", 'ta: {"a":1}\n', '\nevent: entry\ndata: {"b":2}\n\n'
    ]);
    expect(out).toEqual([{ event: "attempt", data: { a: 1 } }, { event: "entry", data: { b: 2 } }]);
  });

  it("handles CRLF and skips malformed data without throwing", () => {
    const out = collect(['event: snapshot\r\ndata: {"ok":true}\r\n\r\n', "event: x\ndata: {oops\n\n", 'event: y\ndata: {"n":1}\n\n']);
    expect(out.map((e) => e.event)).toEqual(["snapshot", "y"]);
  });
});

describe("only the last 50 cards are kept", () => {
  const one = (n) => row(attempt(n, { requestSeq: n, requestId: `req-a1b2c3-${String(n).padStart(6, "0")}` }));

  it("keeps 50", () => {
    expect(MAX_ROWS).toBe(50);
  });

  it("drops the oldest card as soon as a newer one arrives past 50", () => {
    let rows = [];
    for (let n = 1; n <= 50; n += 1) rows = mergeRows(rows, [one(n)]);
    expect(rows).toHaveLength(50);
    expect(rows[0].attemptId).toBe("att-test-000001");

    rows = mergeRows(rows, [one(51)]);
    expect(rows).toHaveLength(50);
    expect(rows[0].attemptId).toBe("att-test-000002");
    expect(rows.at(-1).attemptId).toBe("att-test-000051");
  });

  it("a burst of new cards keeps only the newest 50, in order", () => {
    const rows = mergeRows([], Array.from({ length: 120 }, (_, i) => one(i + 1)));
    expect(rows).toHaveLength(50);
    expect(rows[0].attemptId).toBe("att-test-000071");
    expect(rows.at(-1).attemptId).toBe("att-test-000120");
  });

  it("settling an attempt already shown does not push another card out", () => {
    let rows = mergeRows([], Array.from({ length: 50 }, (_, i) => one(i + 1)));
    rows = mergeRows(rows, [row(calling(50, { requestSeq: 50 }))]);
    expect(rows).toHaveLength(50);
    expect(rows[0].attemptId).toBe("att-test-000001");
  });
});

describe("copy logs as text", () => {
  it("writes one block per attempt, with its call number, ids, target, key and failure reason", () => {
    const text = formatRowsAsText(rowsOf(failed(1, 429, { errorMessage: "quota" }), attempt(2, { callIndex: 2, keyIndex: 1 })));
    const [first, second] = text.split("\n\n");
    expect(first).toContain("FAILED");
    expect(first).toContain("call #1");
    expect(first).toContain("attempt att-test-000001");
    expect(first).toContain("key 0");
    expect(first).toContain("quota");
    expect(second).toContain("SUCCESS");
    expect(second).toContain("call #2");
    expect(second).toContain("attempt att-test-000002");
    expect(second).toContain("key 1");
  });

  it("prints the pool", () => {
    expect(formatRowsAsText(rowsOf(attempt(1, { pool: "vision" })))).toContain("VISION");
    expect(formatRowsAsText(rowsOf(attempt(1)))).toContain("TEXT");
  });

  it("never leaks a credential-shaped string", () => {
    expect(formatRowsAsText(rowsOf(failed(1, 500, { errorMessage: `bad key ${SECRET}` })))).not.toContain(SECRET);
  });

  it("is empty for no rows", () => {
    expect(formatRowsAsText([])).toBe("");
    expect(formatRowsAsText(null)).toBe("");
  });
});


describe("token usage on a Live Logs card", () => {
  const usageOf = (row) => [row.inputTokens, row.outputTokens, row.totalTokens];
  const html = (row) => renderToStaticMarkup(<LiveLogRow row={row} now={T0} />);
  const text = (markup) => markup.replace(/<[^>]+>/g, "");

  it("shows Input, Output and Total inside the attempt's own card", () => {
    const row = buildAttemptRow(attempt(1, { inputTokens: 1245, outputTokens: 387, tokens: 1632 }));
    expect(usageOf(row)).toEqual([1245, 387, 1632]);
    expect(describeUsage(row)).toBe("Input: 1,245 · Output: 387 · Total: 1,632");

    const markup = html(row);
    expect(text(markup)).toContain("Input: 1,245 · Output: 387 · Total: 1,632");
    expect(markup).toContain('data-usage="reported"');
  });

  it("shows a dash, never a zero, for usage the provider did not report", () => {
    const row = buildAttemptRow(attempt(1));
    expect(usageOf(row)).toEqual([null, null, null]);
    expect(describeUsage(row)).toBe("Input: — · Output: — · Total: —");
    expect(html(row)).toContain('data-usage="unavailable"');
    expect(text(html(row))).not.toMatch(/Input: 0|Output: 0|Total: 0/);
  });

  it("keeps a reported zero, and shows a dash only for the missing figure", () => {
    const row = buildAttemptRow(attempt(1, { inputTokens: 12, outputTokens: null, tokens: null }));
    expect(describeUsage(row)).toBe("Input: 12 · Output: — · Total: —");
    expect(describeUsage(buildAttemptRow(attempt(2, { inputTokens: 0, outputTokens: 0, tokens: 0 }))))
      .toBe("Input: 0 · Output: 0 · Total: 0");
  });

  it("uses the provider's total, and derives one only when input and output are both known", () => {
    expect(readUsage({ inputTokens: 10, outputTokens: 5, tokens: 40 })).toEqual({ inputTokens: 10, outputTokens: 5, totalTokens: 40 });
    expect(readUsage({ inputTokens: 10, outputTokens: 5 })).toEqual({ inputTokens: 10, outputTokens: 5, totalTokens: 15 });
    expect(readUsage({ inputTokens: 10, outputTokens: null })).toEqual({ inputTokens: 10, outputTokens: null, totalTokens: null });
    expect(readUsage({ totalTokens: 9 })).toEqual({ inputTokens: null, outputTokens: null, totalTokens: 9 });
    expect(readUsage({ inputTokens: "10", outputTokens: -1, tokens: Number.NaN }))
      .toEqual({ inputTokens: null, outputTokens: null, totalTokens: null });
    expect(readUsage(undefined)).toEqual({ inputTokens: null, outputTokens: null, totalTokens: null });
  });

  it("a running attempt has no usage yet", () => {
    const row = buildAttemptRow(attempt(1, { state: "calling", ok: false, status: null, inputTokens: 5, outputTokens: 5, tokens: 10 }));
    expect(row.state).toBe(STATE.CALLING);
    expect(usageOf(row)).toEqual([null, null, null]);
  });

  it("fallback attempts each show their own figures and a failed one shows none", () => {
    const failed = attempt(1, { state: "failed", ok: false, status: 429, errorMessage: "rate limited" });
    const answered = attempt(2, { callIndex: 2, keyIndex: 1, inputTokens: 200, outputTokens: 80, tokens: 280 });
    const rows = mergeRows([], [failed, answered].map((event) => buildAttemptRow(event)));
    expect(rows.map(usageOf)).toEqual([[null, null, null], [200, 80, 280]]);

    const markup = renderToStaticMarkup(<LiveLogList rows={rows} now={T0} />);
    const lines = [...markup.matchAll(/class="livelog__usage[^"]*"[^>]*>([^<]*)</g)].map((m) => m[1]);
    expect(lines).toEqual(["Input: — · Output: — · Total: —", "Input: 200 · Output: 80 · Total: 280"]);
  });

  it("a settled card gains its usage when it arrives, once, and never loses it", () => {
    const settled = buildAttemptRow(attempt(1));
    const withUsage = buildAttemptRow(attempt(1, { inputTokens: 100, outputTokens: 50, tokens: 150 }));
    const other = buildAttemptRow(attempt(1, { inputTokens: 999, outputTokens: 999, tokens: 1998 }));

    let rows = mergeRows([], [settled]);
    expect(usageOf(rows[0])).toEqual([null, null, null]);

    rows = mergeRows(rows, [withUsage]);
    expect(rows).toHaveLength(1);
    expect(usageOf(rows[0])).toEqual([100, 50, 150]);

    // A stale snapshot without usage, or a repeated report, changes nothing.
    rows = mergeRows(rows, [settled]);
    expect(usageOf(rows[0])).toEqual([100, 50, 150]);
    rows = mergeRows(rows, [other]);
    expect(usageOf(rows[0])).toEqual([100, 50, 150]);
  });

  it("usage never turns a finished card back into a running one, or change its outcome", () => {
    const failed = buildAttemptRow(attempt(1, { state: "failed", ok: false, status: 500 }));
    const claimsSuccess = buildAttemptRow(attempt(1, { inputTokens: 1, outputTokens: 1, tokens: 2 }));
    const rows = mergeRows(mergeRows([], [failed]), [claimsSuccess]);
    expect(rows[0].state).toBe(STATE.FAILED);
    expect(usageOf(rows[0])).toEqual([null, null, null]);
  });

  it("usage arriving through a pushed attempt event or a payload reaches the card", () => {
    const event = { event: "attempt", data: attempt(1, { inputTokens: 7, outputTokens: 3, tokens: 10 }) };
    expect(usageOf(ingestEvent(event).rows[0])).toEqual([7, 3, 10]);

    const nested = { seq: 1, startSeq: 1, requestId: "req-a1b2c3-000001", outcome: "success", attempts: [
      { ...attempt(1), inputTokens: 7, outputTokens: 3, tokens: 10 }
    ] };
    expect(usageOf(ingestPayload({ entries: [nested] }).rows[0])).toEqual([7, 3, 10]);
  });

  it("the copied transcript carries each attempt's usage", () => {
    const rows = [
      buildAttemptRow(attempt(1, { inputTokens: 1245, outputTokens: 387, tokens: 1632 })),
      buildAttemptRow(attempt(2, { state: "failed", ok: false, status: 500 }))
    ];
    const copied = formatRowsAsText(rows);
    expect(copied).toContain("Input: 1,245 · Output: 387 · Total: 1,632");
    expect(copied).toContain("Input: — · Output: — · Total: —");
  });
});
