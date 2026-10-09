import test from "node:test";
import assert from "node:assert/strict";

import {
  probeTargetHealth,
  nextPageOf,
  MAX_MODEL_LIST_BYTES,
  MAX_MODEL_LIST_PAGES
} from "../src/health-checks.js";
import { HealthRegistry, HEALTH_STATES, healthRegistry, refreshAllHealth } from "../src/health.js";

/**
 * The model-catalogue signal, end to end.
 *
 * Two independent facts must never be conflated:
 *   - what the MOST RECENT probe observed  (`modelListed`)
 *   - what was last CONFIRMED              (`modelListedConfirmed`)
 * and a catalogue that was not read to the end must never produce `false`.
 */

const target = (model = "wanted") => ({
  provider: "groq",
  model,
  baseUrl: "https://api.groq.com/openai/v1",
  apiKey: "k",
  protocols: ["openai-chat"],
  keyIndex: 0
});

/** A response whose body is a real stream, so the reader path is exercised. */
function streamed(text, { status = 200, contentLength, chunkSize = 64 } = {}) {
  const bytes = Buffer.from(text, "utf8");
  const state = { offset: 0, cancelled: false };
  const body = new ReadableStream({
    pull(controller) {
      if (state.offset >= bytes.length) { controller.close(); return; }
      const end = Math.min(state.offset + chunkSize, bytes.length);
      controller.enqueue(new Uint8Array(bytes.subarray(state.offset, end)));
      state.offset = end;
    },
    cancel() { state.cancelled = true; }
  });
  return {
    status,
    headers: { get: (name) => (String(name).toLowerCase() === "content-length" && contentLength !== undefined ? String(contentLength) : null) },
    body,
    text: async () => text,
    state
  };
}

/** A response with no readable stream, exercising the text() fallback. */
function plain(status, text) {
  return { status, headers: { get: () => null }, text: async () => text };
}

const json = (value) => JSON.stringify(value);

/** A fetch impl serving one scripted page per call, in order. */
function pages(...responses) {
  const calls = [];
  const impl = async (url, options) => {
    calls.push({ url, options });
    const next = responses[calls.length - 1];
    if (next === undefined) return plain(404, json({ error: "no such page" }));
    return typeof next === "function" ? next(url, options) : next;
  };
  impl.calls = calls;
  return impl;
}

const probe = (model, fetchImpl, extra = {}) =>
  probeTargetHealth(target(model), { fetchImpl, timeoutMs: 500, ...extra });

// =========================================================== pagination

test("a model on the first page is confirmed without further requests", async () => {
  const fetchImpl = pages(streamed(json({ data: [{ id: "wanted" }, { id: "other" }] })));
  const result = await probe("wanted", fetchImpl);
  assert.equal(result.modelListed, true);
  assert.equal(fetchImpl.calls.length, 1, "a hit on page one must not keep walking pages");
});

test("a model on a LATER page is found rather than reported missing", async () => {
  // The bug: only the first page was read, so a model past page 1 became `false`.
  // Gemini serves 50 models per page, so this is routine on a busy account.
  const fetchImpl = pages(
    streamed(json({ models: [{ name: "models/other" }], nextPageToken: "page-2" })),
    streamed(json({ models: [{ name: "models/wanted" }] }))
  );
  const result = await probe("wanted", fetchImpl);
  assert.equal(result.modelListed, true, "a model on page two must not be reported absent");
  assert.equal(fetchImpl.calls.length, 2);
  // The follow-up request carries the cursor as a query parameter.
  assert.match(fetchImpl.calls[1].url, /[?&]pageToken=page-2/);
});

test("a model genuinely absent from a complete catalogue is reported missing", async () => {
  const fetchImpl = pages(
    streamed(json({ models: [{ name: "models/a" }], nextPageToken: "p2" })),
    streamed(json({ models: [{ name: "models/b" }], nextPageToken: "p3" })),
    streamed(json({ models: [{ name: "models/c" }] })) // no token -> the end
  );
  const result = await probe("wanted", fetchImpl);
  assert.equal(result.modelListed, false);
  assert.equal(fetchImpl.calls.length, 3, "the whole catalogue must be read before claiming absence");
});

test("a single-page catalogue with no pagination metadata still reports absence", async () => {
  const fetchImpl = pages(streamed(json({ data: [{ id: "a" }, { id: "b" }] })));
  const result = await probe("wanted", fetchImpl);
  assert.equal(result.modelListed, false);
});

test("pagination metadata present but the next page unavailable is indeterminate, never false", async () => {
  const fetchImpl = pages(
    streamed(json({ data: [{ id: "a" }], nextPageToken: "p2" })),
    plain(500, json({ error: "upstream exploded" }))
  );
  const result = await probe("wanted", fetchImpl);
  assert.equal(result.modelListed, null, "an unreachable page must not prove absence");
});

test("a next-page request that throws is indeterminate", async () => {
  const fetchImpl = pages(
    streamed(json({ data: [{ id: "a" }], nextPageToken: "p2" })),
    async () => { throw new Error("socket reset"); }
  );
  assert.equal((await probe("wanted", fetchImpl)).modelListed, null);
});

test("an unknown response shape is indeterminate on the first page too", async () => {
  assert.equal((await probe("wanted", pages(plain(200, json({ result: [{ name: "wanted" }] }))))).modelListed, null);
  assert.equal((await probe("wanted", pages(plain(200, json({ models: "not an array" }))))).modelListed, null);
  assert.equal((await probe("wanted", pages(plain(200, "[]")))).modelListed, null);
});

test("an unknown shape on a later page stops the walk as indeterminate", async () => {
  const fetchImpl = pages(
    streamed(json({ data: [{ id: "a" }], nextPageToken: "p2" })),
    streamed(json({ unexpected: true }))
  );
  assert.equal((await probe("wanted", fetchImpl)).modelListed, null);
});

test("has_more without a followable cursor is indeterminate, not an absence claim", async () => {
  // The page says more models exist but gives nothing this router can request,
  // so absence is unproven.
  assert.equal((await probe("wanted", pages(plain(200, json({ data: [{ id: "a" }], has_more: true }))))).modelListed, null);
  // ... and has_more:false is a genuine end-of-catalogue.
  assert.equal((await probe("wanted", pages(plain(200, json({ data: [{ id: "a" }], has_more: false }))))).modelListed, false);
});

test("nextPageOf handles malformed pagination metadata without inventing a request", () => {
  assert.deepEqual(nextPageOf({ nextPageToken: "t" }), { token: "t", more: true });
  assert.deepEqual(nextPageOf({ next_page_token: "t" }), { token: "t", more: true });
  // An empty token is the documented end of a Google list, not a malformed one.
  assert.deepEqual(nextPageOf({ nextPageToken: "" }), { token: null, more: false });
  assert.deepEqual(nextPageOf({ nextPageToken: null }), { token: null, more: false });
  // Present but UNUSABLE still means the provider was signalling further pages.
  // Reading that as "no more pages" is what produced a false missing-model
  // result, so anything non-string must report `more`.
  assert.deepEqual(nextPageOf({ nextPageToken: 42 }), { token: null, more: true });
  assert.deepEqual(nextPageOf({ nextPageToken: {} }), { token: null, more: true });
  assert.deepEqual(nextPageOf({ nextPageToken: [] }), { token: null, more: true });
  assert.deepEqual(nextPageOf({ next_page_token: 7 }), { token: null, more: true });
  // A non-boolean has_more is as unusable as a malformed cursor.
  assert.deepEqual(nextPageOf({ has_more: "true" }), { token: null, more: true });
  assert.deepEqual(nextPageOf({ has_more: 1 }), { token: null, more: true });
  // Only an explicit false ends the catalogue.
  assert.deepEqual(nextPageOf({ has_more: false }), { token: null, more: false });
  assert.deepEqual(nextPageOf({ has_more: true }), { token: null, more: true });
  assert.deepEqual(nextPageOf({}), { token: null, more: false });
  assert.deepEqual(nextPageOf(null), { token: null, more: false });
  assert.deepEqual(nextPageOf("nonsense"), { token: null, more: false });
});

test("excessive pagination is bounded and ends indeterminate", async () => {
  // Every page advertises another one, forever.
  const endless = Array.from({ length: MAX_MODEL_LIST_PAGES + 5 }, (_v, i) =>
    () => streamed(json({ models: [{ name: `models/m${i}` }], nextPageToken: `p${i + 1}` }))
  );
  const fetchImpl = pages(...endless);
  const result = await probe("wanted", fetchImpl);
  assert.equal(result.modelListed, null, "an unfinished walk must not claim absence");
  assert.equal(fetchImpl.calls.length, MAX_MODEL_LIST_PAGES, "the page budget must bound the walk");
});

test("a page budget exhausted exactly at the last permitted page is still indeterminate", async () => {
  const atLimit = Array.from({ length: MAX_MODEL_LIST_PAGES }, (_v, i) =>
    streamed(json({ models: [{ name: `models/m${i}` }], nextPageToken: `p${i + 1}` }))
  );
  const fetchImpl = pages(...atLimit);
  assert.equal((await probe("wanted", fetchImpl)).modelListed, null);
  assert.equal(fetchImpl.calls.length, MAX_MODEL_LIST_PAGES);
});

test("a cursor the URL builder cannot apply leaves the result indeterminate", async () => {
  const fetchImpl = pages(streamed(json({ data: [{ id: "a" }], nextPageToken: "p2" })));
  // A scheme-less base URL yields a probe URL that cannot be extended into a
  // follow-up request, so the second page is unreachable and absence is unproven.
  const result = await probeTargetHealth(
    { ...target("wanted"), baseUrl: "api.example.com/v1" },
    { fetchImpl, timeoutMs: 500 }
  );
  assert.equal(result.modelListed, null);
  assert.equal(fetchImpl.calls.length, 1, "the unbuildable page must not be requested");
});

// =========================================================== byte limit

test("a catalogue below the limit is read normally", async () => {
  const body = json({ data: Array.from({ length: 10 }, (_v, i) => ({ id: `m${i}` })) });
  assert.ok(Buffer.byteLength(body) < MAX_MODEL_LIST_BYTES);
  const response = streamed(body);
  assert.equal((await probe("m5", pages(response))).modelListed, true);
  assert.equal(response.state.cancelled, false);
});

test("a body EXACTLY at the byte limit is still accepted", async () => {
  // Pad the JSON with a string of exactly the right length to land on the limit.
  const prefix = json({ data: [{ id: "wanted" }], pad: "" });
  const padLength = MAX_MODEL_LIST_BYTES - Buffer.byteLength(prefix);
  const body = json({ data: [{ id: "wanted" }], pad: "x".repeat(padLength) });
  assert.equal(Buffer.byteLength(body), MAX_MODEL_LIST_BYTES);
  const fetchImpl = pages(streamed(body));
  assert.equal((await probe("wanted", fetchImpl)).modelListed, true);
});

test("a body over the limit with NO Content-Length is stopped mid-read, not buffered", async () => {
  const body = json({ data: [{ id: "a" }], pad: "x".repeat(MAX_MODEL_LIST_BYTES * 2) });
  assert.ok(Buffer.byteLength(body) > MAX_MODEL_LIST_BYTES);
  const response = streamed(body); // no contentLength -> header absent
  const result = await probe("wanted", pages(response));
  assert.equal(result.modelListed, null);
  // The stream was abandoned near the limit rather than read to the end.
  assert.ok(response.state.offset < Buffer.byteLength(body), "the whole body was consumed");
  assert.ok(response.state.offset <= MAX_MODEL_LIST_BYTES + 128, `read ${response.state.offset} bytes`);
  assert.equal(response.state.cancelled, true, "the reader must cancel the body it abandoned");
});

test("a misleadingly small Content-Length does not defeat the limit", async () => {
  const body = json({ data: [{ id: "a" }], pad: "x".repeat(MAX_MODEL_LIST_BYTES * 2) });
  const response = streamed(body, { contentLength: 10 }); // lies
  const result = await probe("wanted", pages(response));
  assert.equal(result.modelListed, null);
  assert.equal(response.state.cancelled, true);
  assert.ok(response.state.offset < Buffer.byteLength(body));
});

test("an oversized Content-Length is refused before the body is touched", async () => {
  // Instrumented so the assertion is about consumption, not about how eagerly a
  // ReadableStream happens to pre-fill its queue.
  let readerCreated = false;
  let textCalled = false;
  const response = {
    status: 200,
    headers: { get: (name) => (String(name).toLowerCase() === "content-length" ? String(MAX_MODEL_LIST_BYTES + 1) : null) },
    body: {
      getReader() { readerCreated = true; return { read: async () => ({ done: true }), cancel: async () => {} }; },
      cancel: async () => {}
    },
    text: async () => { textCalled = true; return "[]"; }
  };
  const result = await probe("wanted", pages(response));
  assert.equal(result.modelListed, null);
  assert.equal(readerCreated, false, "a reader was opened despite the declared oversize");
  assert.equal(textCalled, false, "the body was read despite the declared oversize");
});

test("an oversized catalogue is indeterminate, and the provider is still healthy", async () => {
  const response = streamed(json({ data: [{ id: "a" }], pad: "x".repeat(MAX_MODEL_LIST_BYTES * 2) }));
  const result = await probe("wanted", pages(response));
  // Unreadable catalogue != failed provider: the endpoint answered 200.
  assert.equal(result.ok, true);
  assert.equal(result.status, 200);
  assert.equal(result.modelListed, null);
});

test("invalid JSON is indeterminate", async () => {
  const result = await probe("wanted", pages(plain(200, "{ this is not json")));
  assert.equal(result.ok, true);
  assert.equal(result.modelListed, null);
});

test("a stream that errors mid-read is indeterminate and does not fail the provider", async () => {
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"data":[{"id":"a"}'));
      controller.error(new Error("connection reset"));
    }
  });
  const response = { status: 200, headers: { get: () => null }, body, text: async () => "" };
  const result = await probe("wanted", pages(response));
  assert.equal(result.ok, true);
  assert.equal(result.modelListed, null);
});

test("a stalled body is bounded by the probe timeout and still reports the endpoint healthy", async () => {
  // Opens, yields a partial frame, never closes. The probe timer aborts the
  // request signal; the platform's response to that is to ERROR the in-flight
  // body, which is what unblocks the pending read.
  let controllerRef = null;
  const body = new ReadableStream({
    start(controller) {
      controllerRef = controller;
      controller.enqueue(new TextEncoder().encode('{"data":['));
    }
  });
  const response = { status: 200, headers: { get: () => null }, body, text: async () => "" };
  const fetchImpl = async (url, options) => {
    options.signal?.addEventListener("abort", () => {
      try { controllerRef.error(new DOMException("Aborted", "AbortError")); } catch { /* already settled */ }
    });
    return response;
  };

  const started = Date.now();
  const result = await probeTargetHealth(target("wanted"), { fetchImpl, timeoutMs: 60 });
  assert.ok(Date.now() - started < 3000, "the probe must not hang on a stalled body");
  assert.equal(result.modelListed, null);
  assert.equal(result.ok, true, "a stalled catalogue read is not a provider failure");
  assert.equal(result.status, 200);
});

test("a response with no body and no text() is indeterminate, not a crash", async () => {
  const result = await probe("wanted", pages({ status: 200 }));
  assert.equal(result.ok, true);
  assert.equal(result.modelListed, null);
});

test("a non-200 probe response is never inspected for a catalogue", async () => {
  assert.equal((await probe("wanted", pages(plain(404, json({ data: [] }))))).modelListed, null);
  assert.equal((await probe("wanted", pages(plain(401, json({ data: [] }))))).modelListed, null);
});

// =============================================== latest vs confirmed

test("listed, then unreadable: the latest observation is indeterminate and the confirmation is kept", () => {
  const registry = new HealthRegistry();
  const t = target();
  registry.recordHealthCheck(t, { ok: true, status: 200, modelListed: true }, 1000);
  registry.recordHealthCheck(t, { ok: true, status: 200, modelListed: null }, 2000);

  const state = registry.ensureTarget(t);
  assert.equal(state.modelListed, null, "the latest observation is 'could not tell'");
  assert.equal(state.modelListedAt, new Date(2000).toISOString());
  assert.equal(state.modelListedConfirmed, true, "the confirmation is retained, separately");
  assert.equal(state.modelListedConfirmedAt, new Date(1000).toISOString());
});

test("missing, then unreadable: a stale `false` is never presented as the latest result", () => {
  const registry = new HealthRegistry();
  const t = target();
  registry.recordHealthCheck(t, { ok: true, status: 200, modelListed: false }, 1000);
  registry.recordHealthCheck(t, { ok: true, status: 200, modelListed: null }, 2000);

  const state = registry.ensureTarget(t);
  // This is the bug: it used to stay `false`, so the panel showed an old absence
  // as though the newest probe had just confirmed it.
  assert.equal(state.modelListed, null);
  assert.equal(state.modelListedConfirmed, false);
  assert.equal(state.modelListedConfirmedAt, new Date(1000).toISOString());
});

test("unreadable on the FIRST probe leaves nothing confirmed", () => {
  const registry = new HealthRegistry();
  const t = target();
  registry.recordHealthCheck(t, { ok: true, status: 200, modelListed: null }, 1000);

  const state = registry.ensureTarget(t);
  assert.equal(state.modelListed, null);
  assert.equal(state.modelListedConfirmed, null);
  assert.equal(state.modelListedConfirmedAt, null);
  assert.equal(state.modelListedAt, new Date(1000).toISOString());
});

test("a confirmed missing model is reported as missing, with its confirmation", () => {
  const registry = new HealthRegistry();
  const t = target();
  registry.recordHealthCheck(t, { ok: true, status: 200, modelListed: false }, 1000);

  const state = registry.ensureTarget(t);
  assert.equal(state.modelListed, false);
  assert.equal(state.modelListedConfirmed, false);
  assert.equal(state.modelListedConfirmedAt, new Date(1000).toISOString());
});

test("a confirmed available model is reported as available, with its confirmation", () => {
  const registry = new HealthRegistry();
  const t = target();
  registry.recordHealthCheck(t, { ok: true, status: 200, modelListed: true }, 1000);

  const state = registry.ensureTarget(t);
  assert.equal(state.modelListed, true);
  assert.equal(state.modelListedConfirmed, true);
  assert.equal(state.modelListedConfirmedAt, new Date(1000).toISOString());
});

test("a definite observation refreshes the confirmation and its timestamp", () => {
  const registry = new HealthRegistry();
  const t = target();
  registry.recordHealthCheck(t, { ok: true, status: 200, modelListed: false }, 1000);
  registry.recordHealthCheck(t, { ok: true, status: 200, modelListed: null }, 2000);
  registry.recordHealthCheck(t, { ok: true, status: 200, modelListed: true }, 3000);

  const state = registry.ensureTarget(t);
  assert.equal(state.modelListed, true);
  assert.equal(state.modelListedConfirmed, true);
  assert.equal(state.modelListedConfirmedAt, new Date(3000).toISOString(), "the confirmation must move forward");
});

test("omitting the catalogue field is not an observation and changes nothing", () => {
  const registry = new HealthRegistry();
  const t = target();
  registry.recordHealthCheck(t, { ok: true, status: 200, modelListed: false }, 1000);
  registry.recordHealthCheck(t, { ok: true, status: 200 }, 2000);

  const state = registry.ensureTarget(t);
  assert.equal(state.modelListed, false, "a caller that said nothing must not clear the signal");
  assert.equal(state.modelListedAt, new Date(1000).toISOString());
});

test("an out-of-order catalogue observation does not overwrite a newer one", () => {
  const registry = new HealthRegistry();
  const t = target();
  registry.recordHealthCheck(t, { ok: true, status: 200, modelListed: true }, 5000);
  // A slow probe that started earlier finishes later.
  registry.recordHealthCheck(t, { ok: true, status: 200, modelListed: false }, 1000);

  const state = registry.ensureTarget(t);
  assert.equal(state.modelListed, true);
  assert.equal(state.modelListedAt, new Date(5000).toISOString());
});

test("describe() exposes both the latest and the confirmed catalogue facts", () => {
  const registry = new HealthRegistry();
  const t = target();
  registry.recordHealthCheck(t, { ok: true, status: 200, modelListed: false }, 1000);
  registry.recordHealthCheck(t, { ok: true, status: 200, modelListed: null }, 2000);

  const [row] = registry.describe([t], 2000);
  assert.equal(row.modelListed, null);
  assert.equal(row.modelListedAt, new Date(2000).toISOString());
  assert.equal(row.modelListedConfirmed, false);
  assert.equal(row.modelListedConfirmedAt, new Date(1000).toISOString());
});

// =============================================== cooldown independence

test("catalogue observations are recorded during an active cooldown without touching health", () => {
  const registry = new HealthRegistry();
  const t = target();
  registry.markFailure(t, 500, {}, 1000);
  const cooldownUntil = registry.ensureTarget(t).cooldownUntil;
  assert.ok(cooldownUntil > 1000, "precondition: the target is cooling down");

  registry.recordHealthCheck(t, { ok: true, status: 200, modelListed: false }, 1100);
  const state = registry.ensureTarget(t);
  assert.equal(state.status, HEALTH_STATES.FAILED, "the cooldown still freezes health");
  assert.equal(state.cooldownUntil, cooldownUntil, "the cooldown was not moved");
  assert.equal(state.modelListed, false, "but the catalogue fact is still recorded");

  // An indeterminate observation during cooldown also lands, and still does not
  // disturb health.
  registry.recordCatalogueObservation(t, null, 1200);
  assert.equal(registry.ensureTarget(t).modelListed, null);
  assert.equal(registry.ensureTarget(t).cooldownUntil, cooldownUntil);
  assert.equal(registry.ensureTarget(t).status, HEALTH_STATES.FAILED);
});

test("catalogue uncertainty never changes a score, a status or a cooldown", () => {
  const registry = new HealthRegistry();
  const t = target();
  registry.markSuccess(t, {}, 1000);
  const before = { ...registry.ensureTarget(t) };

  registry.recordCatalogueObservation(t, null, 2000);
  registry.recordCatalogueObservation(t, false, 3000);

  const after = registry.ensureTarget(t);
  assert.equal(after.status, before.status);
  assert.equal(after.score, before.score);
  assert.equal(after.cooldownUntil, before.cooldownUntil);
  assert.equal(after.successes, before.successes);
  assert.equal(after.failures, before.failures);
});

// =============================================== the refresh cycle

test("a probe that THROWS records an indeterminate catalogue observation, not a stale value", async () => {
  // `refreshAllHealth` writes to the module-level registry, so this test uses a
  // uniquely-named target to stay isolated from the rest of the file.
  const t = { ...target("throwing-probe-target"), provider: "groq", keyIndex: 77 };
  healthRegistry.recordCatalogueObservation(t, false, 1000);
  assert.equal(healthRegistry.ensureTarget(t).modelListed, false);

  await refreshAllHealth([t], async () => { throw new Error("probe blew up"); });

  const state = healthRegistry.ensureTarget(t);
  assert.equal(state.modelListed, null, "a failed probe must not leave an old `false` on screen");
  assert.equal(state.modelListedConfirmed, false, "the last real confirmation is still available");
  assert.equal(state.status, HEALTH_STATES.FAILED, "the probe failure itself is still recorded");
});

test("a probe result with no catalogue field at all records an indeterminate observation", async () => {
  // What a provider with no probe plan returns. The refresh plumbing coerces the
  // absent field to "indeterminate", so an earlier `false` cannot survive it.
  const t = { ...target("no-probe-plan-target"), provider: "groq", keyIndex: 78 };
  healthRegistry.recordCatalogueObservation(t, false, 1000);

  await refreshAllHealth([t], async () => ({ ok: null, status: null, reason: "no safe health probe" }));

  const state = healthRegistry.ensureTarget(t);
  assert.equal(state.modelListed, null);
  assert.equal(state.modelListedConfirmed, false, "the earlier confirmation is still available");
});

// ============================================ follow-up page authentication

/**
 * Regression: the follow-up request was built with `page.headers` — the RESPONSE
 * headers — instead of the request headers. The credential therefore never
 * reached any page after the first, so a paginated catalogue always ended
 * "unauthorized" and the walk could never confirm anything.
 */

const geminiTarget = (model = "wanted") => ({
  provider: "gemini",
  model,
  baseUrl: "https://generativelanguage.googleapis.com/v1beta",
  apiKey: "secret-gemini-key",
  protocols: ["gemini"],
  keyIndex: 0
});

test("a follow-up page request carries the REQUEST headers, including the credential", async () => {
  const seen = [];
  const fetchImpl = async (url, options) => {
    seen.push({ url, options });
    const first = seen.length === 1;
    return {
      status: 200,
      // Deliberately response-shaped headers, to prove they are not recycled.
      headers: { get: (name) => (String(name).toLowerCase() === "content-type" ? "application/json" : null) },
      text: async () => (first
        ? json({ models: [{ name: "models/other" }], nextPageToken: "page-2" })
        : json({ models: [{ name: "models/wanted" }] })),
      body: { cancel: async () => {} }
    };
  };

  const result = await probeTargetHealth(geminiTarget(), { fetchImpl, timeoutMs: 500 });
  assert.equal(result.modelListed, true, "the page-2 model must be reachable");
  assert.equal(seen.length, 2);

  // The probe's own request headers, verbatim, on BOTH pages.
  assert.equal(seen[1].options.headers["x-goog-api-key"], "secret-gemini-key", "the follow-up page was sent unauthenticated");
  assert.equal(seen[1].options.headers, seen[0].options.headers, "the follow-up did not reuse the probe's request headers");
  assert.equal(seen[1].options.method, "GET");
  assert.equal(seen[1].options.signal, seen[0].options.signal, "the follow-up must share the probe signal so the timeout bounds it");
});

test("the follow-up URL carries the cursor and keeps the original path", async () => {
  const seen = [];
  const fetchImpl = async (url) => {
    seen.push(url);
    const first = seen.length === 1;
    return {
      status: 200,
      headers: { get: () => null },
      text: async () => (first ? json({ models: [{ name: "models/a" }], nextPageToken: "tok/with+chars" }) : json({ models: [{ name: "models/wanted" }] })),
      body: { cancel: async () => {} }
    };
  };
  await probeTargetHealth(geminiTarget(), { fetchImpl, timeoutMs: 500 });
  const followUp = new URL(seen[1]);
  assert.equal(followUp.pathname, "/v1beta/models", "the endpoint path must survive pagination");
  assert.equal(followUp.searchParams.get("pageToken"), "tok/with+chars", "the cursor must be encoded as a query parameter");
});

test("a follow-up that the provider rejects as unauthorized is indeterminate, never a false absence", async () => {
  // This is exactly what the bug produced: an unauthenticated second page.
  const fetchImpl = pages(
    streamed(json({ models: [{ name: "models/a" }], nextPageToken: "p2" })),
    plain(401, json({ error: { message: "API key not valid" } }))
  );
  assert.equal((await probe("wanted", fetchImpl)).modelListed, null);
});

// ============================================ malformed pagination metadata

test("an unusable cursor on the page yields null, not a missing-model result", async () => {
  // Present but non-string: the provider was pointing at further pages this
  // router cannot request. That is unverifiable, not proof of absence.
  for (const token of [42, {}, [], true]) {
    const fetchImpl = pages(plain(200, json({ models: [{ name: "models/a" }], nextPageToken: token })));
    const result = await probe("wanted", fetchImpl);
    assert.equal(result.modelListed, null, `nextPageToken=${JSON.stringify(token)} produced ${result.modelListed}`);
    assert.equal(result.ok, true, "an unreadable catalogue is not a provider failure");
    assert.equal(fetchImpl.calls.length, 1, "no request may be invented from a malformed cursor");
  }
});

test("a non-boolean has_more yields null, not a missing-model result", async () => {
  for (const hint of ["true", 1, "yes", {}]) {
    const fetchImpl = pages(plain(200, json({ data: [{ id: "a" }], has_more: hint })));
    assert.equal((await probe("wanted", fetchImpl)).modelListed, null, `has_more=${JSON.stringify(hint)}`);
  }
});

test("an explicitly false has_more with no cursor is a genuine end-of-catalogue", async () => {
  const fetchImpl = pages(plain(200, json({ data: [{ id: "a" }], has_more: false })));
  assert.equal((await probe("wanted", fetchImpl)).modelListed, false);
});

test("an empty cursor is a genuine end-of-catalogue, not malformed", async () => {
  // Google documents an empty nextPageToken as the end of the list.
  const fetchImpl = pages(plain(200, json({ models: [{ name: "models/a" }], nextPageToken: "" })));
  assert.equal((await probe("wanted", fetchImpl)).modelListed, false);
});

test("malformed metadata on a LATER page also yields null rather than false", async () => {
  const fetchImpl = pages(
    streamed(json({ models: [{ name: "models/a" }], nextPageToken: "p2" })),
    streamed(json({ models: [{ name: "models/b" }], nextPageToken: { nested: "nonsense" } }))
  );
  assert.equal((await probe("wanted", fetchImpl)).modelListed, null);
});

test("a malformed cursor never becomes a stale `confirmed` value either", async () => {
  const registry = new HealthRegistry();
  const t = target("wanted");
  // A malformed catalogue is an indeterminate observation, so it must not
  // refresh (or be recorded as) a confirmation.
  registry.recordHealthCheck(t, { ok: true, status: 200, modelListed: null }, 2000);
  const state = registry.ensureTarget(t);
  assert.equal(state.modelListed, null);
  assert.equal(state.modelListedConfirmed, null);
});

// ============================================ bounds stay correct across pages

test("a follow-up page that never answers is bounded by the probe timeout", async () => {
  let first = true;
  const fetchImpl = (url, options) => {
    if (first) {
      first = false;
      return Promise.resolve(streamed(json({ models: [{ name: "models/a" }], nextPageToken: "p2" })));
    }
    // Never answers, but honours the signal the way the platform does.
    return new Promise((_resolve, reject) => {
      options.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
    });
  };

  const started = Date.now();
  const result = await probeTargetHealth(geminiTarget(), { fetchImpl, timeoutMs: 80 });
  assert.ok(Date.now() - started < 3000, "a stalled follow-up page must not hang the probe");
  assert.equal(result.modelListed, null);
  assert.equal(result.ok, true, "the first page answered, so the endpoint is healthy");
});

test("the byte budget is TOTAL across pages: an oversized follow-up page is cancelled", async () => {
  const big = json({ models: [{ name: "models/b" }], pad: "x".repeat(MAX_MODEL_LIST_BYTES * 2) });
  const second = streamed(big);
  let call = 0;
  const fetchImpl = async () => (++call === 1
    ? streamed(json({ models: [{ name: "models/a" }], nextPageToken: "p2" }))
    : second);

  const result = await probeTargetHealth(geminiTarget(), { fetchImpl, timeoutMs: 500 });
  assert.equal(result.modelListed, null);
  assert.equal(second.state.cancelled, true, "the oversized follow-up body was not cancelled");
  assert.ok(second.state.offset < Buffer.byteLength(big), "the oversized follow-up body was buffered whole");
});
