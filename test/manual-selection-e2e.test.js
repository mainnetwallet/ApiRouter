import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startMockUpstream } from "../test-helpers/mock-upstream.js";
import { startRouter, postJson } from "../test-helpers/router-harness.js";

/**
 * Manual Model Selection, through the real server process.
 *
 * Four providers, one shared call log. The log records every upstream call in
 * the order it happened, across providers, which is the only way to see that
 * "groq A -> mistral B -> groq C -> openrouter D -> groq E" really was
 * interleaved on the wire.
 *
 *   selected    groq/A, mistral/B, groq/C, openrouter/D, groq/E
 *   unselected  groq/X (same provider as three selected models), mistral/Y, cerebras/Z
 *
 * Keys look like secrets on purpose, so a test can assert they never reach logs.
 */

const MIN = 60 * 1000;
const okBody = (model) => ({
  status: 200,
  body: { id: "x", object: "chat.completion", model, choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" }] }
});
const bearer = (record) => String(record.headers.authorization || "").replace(/^Bearer /, "");
const json = async (response) => {
  const text = await response.text();
  return text ? JSON.parse(text) : null;
};
const chat = (router, headers = {}) => router.request("/v1/chat/completions", postJson(
  { model: "anything", messages: [{ role: "user", content: "hello" }] }, headers));
const putFallback = (router, body) => router.request("/api/fallback", {
  method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body)
});
const entry = (provider, model, extra = {}) => ({ provider, model, ...extra });

const SELECTION = [
  entry("groq", "A"), entry("mistral", "B"), entry("groq", "C"), entry("openrouter", "D"), entry("groq", "E")
];
const P1 = [
  "groq/A#0", "groq/A#1",
  "mistral/B#0",
  "groq/C#0", "groq/C#1",
  "openrouter/D#0",
  "groq/E#0", "groq/E#1"
];

/**
 * `behavior({ id, provider, model, key, n })` -> a mock descriptor. `n` counts
 * calls to that exact provider/model/key, starting at 1.
 */
async function startFleet(behavior, extraEnv = {}) {
  const calls = [];
  const counts = new Map();
  const servers = [];
  const spec = {
    groq: { prefix: "GROQ", keys: ["SECRET-G0", "SECRET-G1"], models: "A,C,E,X" },
    mistral: { prefix: "MISTRAL", keys: ["SECRET-S0"], models: "B,Y" },
    openrouter: { prefix: "OPENROUTER", keys: ["SECRET-O0"], models: "D" },
    cerebras: { prefix: "CEREBRAS", keys: ["SECRET-C0"], models: "Z" }
  };
  const env = {};
  for (const [provider, config] of Object.entries(spec)) {
    const server = await startMockUpstream((record) => {
      const key = bearer(record);
      const id = `${provider}/${record.body?.model}#${key.slice(-1)}`;
      const n = (counts.get(id) ?? 0) + 1;
      counts.set(id, n);
      calls.push(id);
      return behavior({ id, provider, model: record.body?.model, key, n });
    });
    servers.push(server);
    env[`${config.prefix}_API_KEYS`] = config.keys.join(",");
    env[`${config.prefix}_MODELS`] = config.models;
    env[`${config.prefix}_BASE_URL`] = `${server.baseUrl}/v1`;
  }
  const router = await startRouter({ ...env, ...extraEnv });
  return {
    router, calls, counts,
    reset: () => { calls.length = 0; counts.clear(); },
    async close() {
      await router.close();
      for (const server of servers) await server.close();
    }
  };
}

const down = { status: 500, body: { error: "down" } };

async function manual(fleet, entries = SELECTION) {
  assert.equal((await putFallback(fleet.router, { pool: "text", entries })).status, 200);
  assert.equal((await putFallback(fleet.router, { mode: "manual" })).status, 200);
  // The startup health monitor has settled (the harness waits); start counting from zero.
  fleet.reset();
}

const sortedUniqueByModel = (ids) => [...new Set(ids.map((id) => id.split("#")[0]))];

// ---------------------------------------------------------------------------

test("manual mode is selectable through the API and reported as such", async () => {
  const fleet = await startFleet(() => down);
  try {
    const rejected = await putFallback(fleet.router, { mode: "manuel" });
    assert.equal(rejected.status, 400, "a typo is still rejected");
    await manual(fleet);
    const state = await fleet.router.request("/api/fallback").then(json);
    assert.equal(state.mode, "manual");
    assert.equal(state.remembersSuccess, false);
    assert.ok(state.modes.some((mode) => mode.id === "manual" && mode.label === "Manual Model Selection"));
  } finally { await fleet.close(); }
});

const H = ["groq/X#0", "groq/X#1", "mistral/Y#0", "cerebras/Z#0"];

test("Manual and Health alternate over the real proxy: selection, every unselected model, selection again, health again", async () => {
  const fleet = await startFleet(() => down);
  try {
    await manual(fleet);
    const response = await chat(fleet.router);
    assert.equal(response.status, 502);

    const batch1 = fleet.calls.slice(0, P1.length);
    assert.deepEqual(batch1, P1, "exact saved order, providers interleaved, every key before the next model");
    assert.deepEqual(sortedUniqueByModel(batch1), ["groq/A", "mistral/B", "groq/C", "openrouter/D", "groq/E"]);

    const health1 = fleet.calls.slice(P1.length, P1.length + H.length);
    assert.deepEqual(new Set(health1), new Set(H),
      "every unselected model, including groq/X from a provider that is in the selection");
    assert.equal(health1.length, 4, "each fallback key is tried exactly once per batch");
    assert.equal(health1.indexOf("groq/X#1") - health1.indexOf("groq/X#0"), 1, "a fallback model's keys are adjacent");

    const rest = fleet.calls.slice(P1.length + H.length);
    assert.deepEqual(rest.slice(0, P1.length), P1, "second Manual batch: same order");
    assert.deepEqual(rest.slice(P1.length), health1, "second Health batch: the same order as the first, stable within the request");

    assert.equal(fleet.calls.length, (P1.length + H.length) * 2, "bounded: no loop, no accidental duplicates");
    for (const id of [...P1, ...H]) assert.equal(fleet.counts.get(id), 2, `${id}: first attempt + one permitted retry`);
  } finally { await fleet.close(); }
});

test("later batches are never reached once a fallback model answers", async () => {
  const fleet = await startFleet(({ id }) => (id === "cerebras/Z#0" ? okBody("Z") : down));
  try {
    await manual(fleet);
    const response = await chat(fleet.router);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-multi-ai-provider"), "cerebras");
    assert.equal(response.headers.get("x-multi-ai-model"), "Z");
    assert.deepEqual(fleet.calls.slice(0, P1.length), P1);
    for (const id of P1) assert.equal(fleet.counts.get(id), 1, `${id} must not be retried when the first Health batch succeeded`);
  } finally { await fleet.close(); }
});

test("a later Manual batch recovers a target that failed transiently, after Health has also failed", async () => {
  const fleet = await startFleet(({ id, n }) => (id === "groq/E#1" && n === 2 ? okBody("E") : down));
  try {
    await manual(fleet);
    const response = await chat(fleet.router);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-multi-ai-model"), "E");
    assert.equal(response.headers.get("x-multi-ai-key-index"), "1");
    assert.equal(fleet.counts.get("groq/E#1"), 2);
    assert.deepEqual(fleet.calls.slice(0, P1.length + H.length), [...P1, ...fleet.calls.slice(P1.length, P1.length + H.length)]);
    assert.deepEqual(fleet.calls.slice(P1.length + H.length), P1, "second Manual batch walked in saved order up to the success");
  } finally { await fleet.close(); }
});

test("a manual success never moves ahead of an earlier selection, and nothing is remembered", async () => {
  const fleet = await startFleet(({ id }) => (id === "openrouter/D#0" ? okBody("D") : down));
  try {
    await manual(fleet);
    assert.equal((await chat(fleet.router)).status, 200);
    fleet.reset();
    // The second request starts at the top of the selection again — D answered last time, but the order is the order.
    // (A, B, C are in cooldown now, so the walk skips them and reaches D without a call to them.)
    assert.equal((await chat(fleet.router)).status, 200);
    assert.deepEqual(fleet.calls, ["openrouter/D#0"]);
  } finally { await fleet.close(); }
});

test("transient failures are retried in a later batch; request/credential failures are not", async () => {
  const fleet = await startFleet(({ id }) => {
    if (id === "mistral/B#0") return { status: 404, body: { error: "gone" } };
    if (id === "openrouter/D#0") return { status: 429, body: { error: "slow down" } };
    return down;
  });
  try {
    await manual(fleet);
    await chat(fleet.router);
    assert.equal(fleet.counts.get("mistral/B#0"), 1, "a withdrawn model is not worth a second try");
    assert.equal(fleet.counts.get("openrouter/D#0"), 2, "a rate limit is");
  } finally { await fleet.close(); }
});

test("credential failures are never retried indefinitely, in either batch, and a transient Health failure gets exactly one retry", async () => {
  const fleet = await startFleet(({ id }) => {
    if (id === "groq/A#0") return { status: 401, body: { error: "bad key" } }; // cools only groq/A on key 0
    if (id === "mistral/Y#0") return { status: 403, body: { error: "forbidden" } };
    return down;
  });
  try {
    await manual(fleet);
    assert.equal((await chat(fleet.router)).status, 502);
    assert.equal(fleet.counts.get("groq/A#0"), 1, "a rejected credential is called once per request");
    assert.equal(fleet.counts.get("mistral/Y#0"), 1, "same in the Health batch");
    for (const id of ["groq/C#0", "groq/E#0", "groq/X#0"]) {
      assert.ok((fleet.counts.get(id) ?? 0) >= 1, `${id} shares key 0 but is a separate target and is still tried`);
    }
    assert.equal(fleet.counts.get("cerebras/Z#0"), 2, "a transient Health failure is retried once, in the second Health batch");
    for (const [id, n] of fleet.counts) assert.ok(n <= 2, `${id} was called ${n} times`);
  } finally { await fleet.close(); }
});

test("a success in the second Health batch ends routing and the next request still honours cooldowns", async () => {
  let healed = false;
  const fleet = await startFleet(({ id, n }) => {
    if (id === "mistral/Y#0" && (healed || n === 2)) return okBody("Y");
    return down;
  });
  try {
    await manual(fleet);
    const response = await chat(fleet.router);
    healed = true;
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-multi-ai-model"), "Y");
    assert.equal(fleet.calls.at(-1), "mistral/Y#0", "routing stopped on the success");
    fleet.reset();
    // Nothing else cooled down is called by the next request; the recovered target is the only one available.
    assert.equal((await chat(fleet.router)).status, 200);
    assert.deepEqual(fleet.calls, ["mistral/Y#0"]);
  } finally { await fleet.close(); }
});

test("genuine cooldowns stand: the next request does not force anything through", async () => {
  const fleet = await startFleet(() => down);
  try {
    await manual(fleet);
    assert.equal((await chat(fleet.router)).status, 502);
    fleet.reset();

    const second = await chat(fleet.router);
    assert.equal(second.status, 503, "every target is cooling down: the existing 'nothing available' answer");
    assert.equal(fleet.calls.length, 0, "no upstream call may be forced through a genuine cooldown");
  } finally { await fleet.close(); }
});

test("key restrictions and disabled models stay excluded in every phase", async () => {
  const fleet = await startFleet(() => down);
  try {
    await manual(fleet, [
      entry("groq", "A", { keys: [1] }),
      entry("mistral", "B"),
      entry("groq", "C"),
      entry("openrouter", "D"),
      entry("groq", "E", { enabled: false })
    ]);
    await chat(fleet.router);

    assert.ok(!fleet.calls.includes("groq/A#0"), "the excluded key is never used, not even as a fallback");
    assert.ok(!fleet.calls.some((id) => id.startsWith("groq/E")), "a parked model is not a fallback either");
    const phase1 = ["groq/A#1", "mistral/B#0", "groq/C#0", "groq/C#1", "openrouter/D#0"];
    assert.deepEqual(fleet.calls.slice(0, phase1.length), phase1);
    // Second Manual batch sits after the first Health batch, then Health repeats.
    assert.deepEqual(fleet.calls.slice(phase1.length + 4, phase1.length * 2 + 4), phase1);
    assert.equal(fleet.calls.length, (phase1.length + 4) * 2);
  } finally { await fleet.close(); }
});

test("a selection that cannot serve the request fails closed instead of using other models", async () => {
  // The API refuses to SAVE a selection it cannot honour, so this state is one a
  // hand-edited or stale file can still produce: a saved entry whose key subset
  // names a key the provider does not have. Seed it the way it would arise.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "manual-failclosed-"));
  const file = path.join(dir, "fallback-chain.json");
  fs.writeFileSync(file, JSON.stringify({
    mode: "manual",
    text: [{ provider: "groq", model: "A", keys: [9], enabled: true }],
    vision: []
  }));
  const fleet = await startFleet(() => okBody("anything"), { FALLBACK_CHAIN_FILE: file });
  try {
    const state = await fleet.router.request("/api/fallback").then(json);
    assert.equal(state.mode, "manual", "the seeded file was read");
    const response = await chat(fleet.router);
    assert.equal(response.status, 503);
    assert.equal((await response.json()).error.type, "fallback_chain_unusable");
    assert.equal(fleet.calls.length, 0, "phase 2 must not stand in for a selection that cannot be honoured");
  } finally { await fleet.close(); }
});

test("a pinned request stays strict under manual mode and does not touch session memory", async () => {
  const fleet = await startFleet(() => down);
  try {
    await manual(fleet);
    const response = await chat(fleet.router, { "x-multi-ai-pin-provider": "groq", "x-multi-ai-pin-key-index": "1" });
    assert.notEqual(response.status, 200);
    // groq key 1 only, every groq model that key can serve — never mistral/openrouter/cerebras, never a second pass.
    assert.ok(fleet.calls.every((id) => id.startsWith("groq/") && id.endsWith("#1")), `pin leaked: ${fleet.calls}`);
    for (const id of new Set(fleet.calls)) assert.equal(fleet.counts.get(id), 1, `${id} retried under a pin`);
    const state = await fleet.router.request("/api/fallback").then(json);
    assert.equal(state.remembered.remembered.text.length, 0, "a pin never writes the session's memory");
  } finally { await fleet.close(); }
});

test("the existing modes are unchanged: they walk the chain once and never reach an unselected model", async () => {
  for (const mode of ["fixed", "last-success", "auto"]) {
    const fleet = await startFleet(() => down);
    try {
      assert.equal((await putFallback(fleet.router, { pool: "text", entries: SELECTION })).status, 200);
      assert.equal((await putFallback(fleet.router, { mode })).status, 200);
      fleet.reset();
      assert.equal((await chat(fleet.router)).status, 502, mode);
      assert.equal(fleet.calls.length, P1.length, `${mode}: every chain key exactly once`);
      assert.deepEqual(new Set(fleet.calls), new Set(P1), `${mode}: only chain targets`);
      assert.ok(!fleet.calls.some((id) => /\/[XYZ]#/.test(id)), `${mode}: no unselected model`);
      if (mode === "fixed") assert.deepEqual(fleet.calls, P1, "Fixed Order keeps the exact saved order");
    } finally { await fleet.close(); }
  }
});

test("Reset Fallback leaves manual mode and the selection alone", async () => {
  const fleet = await startFleet(() => down);
  try {
    await manual(fleet);
    const reset = await fleet.router.request("/api/fallback/reset", { method: "POST" });
    assert.equal(reset.status, 200);
    const state = await fleet.router.request("/api/fallback").then(json);
    assert.equal(state.mode, "manual");
    assert.deepEqual(
      state.chain.text.map((item) => `${item.provider}/${item.model}`),
      SELECTION.map((item) => `${item.provider}/${item.model}`),
      "the saved selection is untouched, in order"
    );
    await chat(fleet.router);
    assert.deepEqual(fleet.calls.slice(0, P1.length), P1);
  } finally { await fleet.close(); }
});

test("Live Logs label every batch, in order, and never expose a credential", async () => {
  const fleet = await startFleet(() => down);
  try {
    await manual(fleet);
    await chat(fleet.router);

    const raw = await fleet.router.request("/api/requests?limit=1&attemptLimit=100").then((response) => response.text());
    assert.ok(!raw.includes("SECRET"), "no API key may appear in the request log");
    const log = JSON.parse(raw);
    const attempts = (log.attempts ?? []).filter((attempt) => attempt.skipped !== true);
    assert.equal(attempts.length, (P1.length + H.length) * 2);

    const phases = attempts.map((attempt) => attempt.phase);
    const collapsed = phases.filter((phase, index) => phase !== phases[index - 1]);
    assert.deepEqual(collapsed, ["manual-selection", "health-fallback", "manual-retry", "health-retry"]);
    assert.equal(phases.filter((phase) => phase === "manual-selection").length, P1.length);
    assert.equal(phases.filter((phase) => phase === "health-fallback").length, 4);
    assert.equal(phases.filter((phase) => phase === "manual-retry").length, P1.length);
    assert.equal(phases.filter((phase) => phase === "health-retry").length, 4);

    // The recorded order is the real call order.
    assert.deepEqual(
      attempts.map((attempt) => `${attempt.provider}/${attempt.model}#${attempt.keyIndex}`),
      fleet.calls
    );
    // Live attempt events (what the Live Logs page streams) carry the same phase vocabulary.
    const events = await fleet.router.request("/api/attempts?limit=100").then(json);
    const eventPhases = new Set((events.attempts ?? events.events ?? []).map((event) => event.phase).filter(Boolean));
    for (const phase of eventPhases) assert.ok(["manual-selection", "health-fallback", "manual-retry", "health-retry"].includes(phase), phase);
  } finally { await fleet.close(); }
});

// ---------------------------------------------------------------------------
// Timing, observed on the running server
// ---------------------------------------------------------------------------

test("the running server reports a 12-minute health-check interval", async () => {
  const fleet = await startFleet(() => okBody("x"));
  try {
    const health = await fleet.router.request("/api/health").then(json);
    assert.equal(health.monitor.intervalMs, 12 * MIN);
    const system = await fleet.router.request("/api/system").then(json);
    assert.equal(JSON.stringify(system).includes(String(15 * MIN)), false, "no stale 15-minute interval is reported");
  } finally { await fleet.close(); }
});

test("a failed model cools down for 12 minutes by default; 400 for 8 and a 408 for 1", async () => {
  const cases = [[500, 12 * MIN], [400, 8 * MIN], [408, 1 * MIN]];
  for (const [status, expected] of cases) {
    const fleet = await startFleet(() => ({ status, body: { error: "x" } }));
    try {
      assert.equal((await putFallback(fleet.router, { pool: "text", entries: [entry("cerebras", "Z")] })).status, 200);
      const before = Date.now();
      await chat(fleet.router);
      const health = await fleet.router.request("/api/health").then(json);
      const target = health.targets.find((item) => item.provider === "cerebras" && item.model === "Z");
      const remaining = target.cooldownUntil - before;
      assert.ok(Math.abs(remaining - expected) < 10_000, `HTTP ${status}: expected ~${expected}ms of cooldown, got ${remaining}ms`);
    } finally { await fleet.close(); }
  }
});
