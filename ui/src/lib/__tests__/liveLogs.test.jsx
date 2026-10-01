import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import {
  EVENT, buildEvents, compareEvents, filterEvents, ingestEntries, isNearBottom, mergeEvents
} from "../liveLogs.js";
import { LiveLogList, LiveLogRow, formatClock } from "../../components/domain/LiveLogList.jsx";

const SECRET = "sk-super-secret-provider-key-1234567890";
const T0 = Date.UTC(2026, 9, 1, 14, 2, 11);

/** key 0 -> 429, key 1 -> 200, same provider and model. */
function fallbackEntry(overrides = {}) {
  return {
    seq: 1,
    id: "abc123",
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

const render = (events) => renderToStaticMarkup(<LiveLogList events={events} />);
const types = (events) => events.map((event) => event.type);

describe("live log event derivation", () => {
  it("emits only the executed events, in order", () => {
    const events = buildEvents(fallbackEntry());

    expect(types(events)).toEqual([
      EVENT.START, EVENT.ATTEMPT, EVENT.FAILED, EVENT.FALLBACK, EVENT.SUCCESS, EVENT.COMPLETE
    ]);
  });

  it("keeps the same model on key 0 and key 1 as separate events", () => {
    const events = buildEvents(fallbackEntry());
    const failed = events.find((event) => event.type === EVENT.FAILED);
    const success = events.find((event) => event.type === EVENT.SUCCESS);

    expect(failed).toMatchObject({ model: "gemini-3.7-flash", keyIndex: 0, status: 429, outcome: "failed" });
    expect(success).toMatchObject({ model: "gemini-3.7-flash", keyIndex: 1, status: 200, outcome: "success" });
    expect(events.filter((event) => event.model === "gemini-3.7-flash" && event.keyIndex === 0).length).toBe(2);
  });

  it("never reports a fallback that was not actually attempted", () => {
    // Both attempts failed and nothing came after: no FALLBACK, no phantom target.
    const events = buildEvents(fallbackEntry({
      outcome: "failed",
      httpStatus: 502,
      attempts: [
        { provider: "gemini", model: "m", keyIndex: 0, ok: false, status: 429, startedAt: T0, latencyMs: 100 }
      ]
    }));

    expect(types(events)).toEqual([EVENT.START, EVENT.ATTEMPT, EVENT.FAILED, EVENT.COMPLETE]);
    expect(events.some((event) => event.type === EVENT.FALLBACK)).toBe(false);
  });

  it("derives timestamps from per-attempt start and latency", () => {
    const events = buildEvents(fallbackEntry());
    const failed = events.find((event) => event.type === EVENT.FAILED);
    const complete = events.find((event) => event.type === EVENT.COMPLETE);

    expect(failed.ts).toBe(T0 + 410);
    expect(complete.ts).toBe(T0 + 1820);
    expect(complete.durationMs).toBe(1820);
  });

  it("still orders attempts when startedAt was not recorded", () => {
    const entry = fallbackEntry();
    entry.attempts = entry.attempts.map(({ startedAt, ...rest }) => rest);
    const events = buildEvents(entry);

    expect(types(events)).toEqual([
      EVENT.START, EVENT.ATTEMPT, EVENT.FAILED, EVENT.FALLBACK, EVENT.SUCCESS, EVENT.COMPLETE
    ]);
    expect([...events].sort(compareEvents).map((event) => event.id)).toEqual(events.map((event) => event.id));
  });

  it("represents a request that never reached a provider", () => {
    const events = buildEvents({ seq: 3, id: "r3", receivedAt: T0, httpStatus: 401, outcome: "failed", errorMessage: "client authentication failed", attempts: [] });

    expect(types(events)).toEqual([EVENT.START, EVENT.COMPLETE]);
    expect(events[1]).toMatchObject({ outcome: "failed", status: 401, reason: "client authentication failed" });
  });
});

describe("live log rendering", () => {
  const events = buildEvents(fallbackEntry());

  it("renders the log", () => {
    const html = render(events);
    expect(html).toContain('role="log"');
    expect(html).toContain("REQUEST START");
    expect(html).toContain("COMPLETE");
    expect((html.match(/<li /g) ?? []).length).toBe(events.length);
  });

  it("renders an attempt event", () => {
    const html = renderToStaticMarkup(<LiveLogRow event={events.find((e) => e.type === EVENT.ATTEMPT)} />);
    expect(html).toContain("ATTEMPT");
    expect(html).toContain("Gemini · gemini-3.7-flash · key 0");
  });

  it("renders a failure event with status and reason", () => {
    const html = renderToStaticMarkup(<LiveLogRow event={events.find((e) => e.type === EVENT.FAILED)} />);
    expect(html).toContain("FAILED");
    expect(html).toContain("key 0");
    expect(html).toContain("429 · rate limited");
  });

  it("renders a fallback event pointing at the next executed target", () => {
    const html = renderToStaticMarkup(<LiveLogRow event={events.find((e) => e.type === EVENT.FALLBACK)} />);
    expect(html).toContain("FALLBACK");
    expect(html).toContain("→ Gemini · gemini-3.7-flash · key 1");
  });

  it("renders a success event with status and duration", () => {
    const html = renderToStaticMarkup(<LiveLogRow event={events.find((e) => e.type === EVENT.SUCCESS)} />);
    expect(html).toContain("SUCCESS");
    expect(html).toContain("key 1");
    expect(html).toContain("200 · 612 ms");
  });

  it("renders complete with the total duration and request id", () => {
    const html = renderToStaticMarkup(<LiveLogRow event={events.find((e) => e.type === EVENT.COMPLETE)} />);
    expect(html).toContain("COMPLETE");
    expect(html).toContain("1.82 s");
    expect(html).toContain("abc123");
  });

  it("shows key 0 FAILED and key 1 SUCCESS as two distinct rows", () => {
    const html = render(events);
    expect(html).toMatch(/livelog__type--danger">FAILED/);
    expect(html).toMatch(/livelog__type--ok">SUCCESS/);
    expect(html.match(/key 0/g).length).toBeGreaterThanOrEqual(2); // attempt + failure
    expect(html.match(/key 1/g).length).toBeGreaterThanOrEqual(2); // fallback + success
  });

  it("does not crash on sparse events", () => {
    const sparse = [
      {},
      { id: "x", type: EVENT.ATTEMPT },
      { id: "y", type: EVENT.FAILED, status: "oops", durationMs: "slow", keyIndex: "0" },
      ...buildEvents({ seq: 9, attempts: [null, {}, { ok: true }] }),
      ...buildEvents(null),
      ...buildEvents({})
    ];

    expect(() => render(sparse)).not.toThrow();
    expect(renderToStaticMarkup(<LiveLogRow event={null} />)).toBe("");
    expect(formatClock(undefined)).toBe("—");
  });

  it("never renders secrets or credential-bearing text", () => {
    const entry = fallbackEntry({
      errorMessage: `all failed: Authorization: Bearer ${SECRET}`,
      outcome: "failed",
      attempts: [
        {
          provider: "gemini", model: "gemini-3.7-flash", keyIndex: 0, ok: false, status: 401,
          startedAt: T0, latencyMs: 50,
          errorMessage: `invalid key ${SECRET} (x-goog-api-key rejected, api_key=${SECRET})`,
          // Fields that must never be read, even if something upstream leaked them.
          apiKey: SECRET, authorization: `Bearer ${SECRET}`, headers: { authorization: `Bearer ${SECRET}` }
        }
      ]
    });

    const html = render(buildEvents(entry));
    expect(html).not.toContain(SECRET);
    expect(html).not.toMatch(/Bearer/i);
    expect(html).not.toMatch(/authorization/i);
    expect(html).not.toMatch(/x-goog-api-key/i);
    expect(html).toContain("key 0");
  });

  it("scrubs secrets even when handed an unsanitized event directly", () => {
    const html = renderToStaticMarkup(
      <LiveLogRow event={{ id: "1:1", seq: 1, order: 1, type: EVENT.FAILED, detail: `boom ${SECRET}`, provider: "groq", keyIndex: 2 }} />
    );
    expect(html).not.toContain(SECRET);
    expect(html).toContain("key 2");
  });
});

describe("live log ingestion and filtering", () => {
  it("ingests each entry once and only entries newer than the high-water mark", () => {
    const first = ingestEntries([fallbackEntry({ seq: 2, id: "b" }), fallbackEntry({ seq: 1, id: "a" })], 0);
    expect(first.maxSeq).toBe(2);
    expect(first.events.length).toBe(12);

    const again = ingestEntries([fallbackEntry({ seq: 2, id: "b" }), fallbackEntry({ seq: 1, id: "a" })], first.maxSeq);
    expect(again.events).toEqual([]);

    const next = ingestEntries([fallbackEntry({ seq: 3, id: "c" })], first.maxSeq);
    expect(next.events.every((event) => event.requestId === "c")).toBe(true);
  });

  it("detects a gateway restart (sequence counter reset)", () => {
    const result = ingestEntries([fallbackEntry({ seq: 1, id: "fresh" })], 57);
    expect(result.restarted).toBe(true);
    expect(result.events.length).toBe(6);
  });

  it("merges chronologically with the newest last, de-duplicated and capped", () => {
    const early = buildEvents(fallbackEntry({ seq: 1, id: "a", receivedAt: T0 }));
    const late = buildEvents(fallbackEntry({ seq: 2, id: "b", receivedAt: T0 + 60_000 }));

    const merged = mergeEvents(late, early);
    expect(merged[0].requestId).toBe("a");
    expect(merged.at(-1).requestId).toBe("b");
    expect(mergeEvents(merged, early).length).toBe(merged.length);
    expect(mergeEvents(merged, late, { max: 4 }).length).toBe(4);
  });

  it("filters by provider, status, search and request id", () => {
    const all = [
      ...buildEvents(fallbackEntry({ seq: 1, id: "abc123" })),
      ...buildEvents(fallbackEntry({
        seq: 2, id: "zzz999", finalProvider: "groq",
        attempts: [{ provider: "groq", model: "model-a", keyIndex: 0, ok: true, status: 200, startedAt: T0, latencyMs: 90 }]
      }))
    ];

    expect(filterEvents(all, { provider: "groq" }).every((event) => event.provider === "groq")).toBe(true);
    expect(filterEvents(all, { status: "failed" }).map((event) => event.type)).toEqual([EVENT.FAILED]);
    expect(filterEvents(all, { requestId: "zzz" }).every((event) => event.requestId === "zzz999")).toBe(true);
    expect(filterEvents(all, { search: "rate limited" }).length).toBe(1);
    expect(filterEvents(all, { search: "KEY 1", requestId: "abc123" }).map((event) => event.type))
      .toEqual([EVENT.FALLBACK, EVENT.SUCCESS, EVENT.COMPLETE]);
    expect(filterEvents(all, {})).toHaveLength(all.length);
  });
});

describe("auto-scroll", () => {
  it("treats a container near the bottom as following the latest", () => {
    expect(isNearBottom({ scrollTop: 480, scrollHeight: 1000, clientHeight: 500 })).toBe(true);
    expect(isNearBottom({ scrollTop: 100, scrollHeight: 1000, clientHeight: 500 })).toBe(false);
    expect(isNearBottom({})).toBe(true);
  });
});
