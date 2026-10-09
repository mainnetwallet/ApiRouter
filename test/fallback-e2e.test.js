import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startMockUpstream } from "../test-helpers/mock-upstream.js";
import { startRouter, postJson } from "../test-helpers/router-harness.js";

const ok = (model) => ({
  status: 200,
  body: { id: "x", object: "chat.completion", model, choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" }] }
});
const down = { status: 500, body: { error: "down" } };
const bearer = (record) => String(record.headers.authorization || "").replace(/^Bearer /, "");
const chat = (router) => router.request("/v1/chat/completions", postJson({ model: "anything", messages: [{ role: "user", content: "hello" }] }));
const posts = (mock) => mock.requests.filter((record) => record.method === "POST").map(bearer);

const json = async (response) => {
  // Read the body ONCE: a Response body can only be consumed a single time, so
  // reading it for the failure message and then again for the value would throw
  // on every call that succeeded.
  const text = await response.text();
  assert.equal(response.status, 200, `expected 200, got ${response.status}: ${text}`);
  return JSON.parse(text);
};
const saveChain = (router, pool, entries, headers = {}) => router.request("/api/fallback", {
  method: "PUT", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ pool, entries })
});
const saveMode = (router, mode, headers = {}) => router.request("/api/fallback", {
  method: "PUT", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ mode })
});
const getFallback = (router) => router.request("/api/fallback").then(json);
const resetFallback = (router) => router.request("/api/fallback/reset", { method: "POST" }).then(json);

const tmpDir = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `fallback-${name}-`));

/** Two pooled providers: groq (two keys) and mistral (one key). */
async function startTwoProviderRouter({ dir, ...env } = {}) {
  const base = dir ?? tmpDir("chain");
  const groq = await startMockUpstream((record) => (bearer(record) === "g0" ? down : ok("m1")));
  const mistral = await startMockUpstream(() => ok("m2"));
  const router = await startRouter({
    GROQ_API_KEYS: "g0,g1",
    GROQ_MODELS: "m1",
    GROQ_BASE_URL: `${groq.baseUrl}/v1`,
    MISTRAL_API_KEYS: "s0",
    MISTRAL_MODELS: "m2",
    MISTRAL_BASE_URL: `${mistral.baseUrl}/v1`,
    // Pinned into `base`, so a test can assert on the persisted file.
    FALLBACK_CHAIN_FILE: path.join(base, "fallback-chain.json"),
    MANUAL_SELECTION_FILE: path.join(base, "manual-selection.json"),
    ...env
  });
  return { router, groq, mistral, base };
}

// ---------------------------------------------------------------------------
// The configured chain
// ---------------------------------------------------------------------------

test("the chain is walked in its saved order, and every key before the next model", async () => {
  const { router, groq, mistral } = await startTwoProviderRouter();
  try {
    assert.equal((await saveChain(router, "text", [
      { provider: "groq", model: "m1" },
      { provider: "mistral", model: "m2" }
    ])).status, 200);

    // groq's first key is down, so its second key answers; mistral is never reached.
    assert.equal((await chat(router)).status, 200);
    assert.deepEqual(posts(groq), ["g0", "g1"]);
    assert.deepEqual(posts(mistral), [], "a success must stop the walk");
  } finally {
    await router.close(); await groq.close(); await mistral.close();
  }
});

test("reordering the chain reorders the routing", async () => {
  const { router, groq, mistral } = await startTwoProviderRouter();
  try {
    assert.equal((await saveChain(router, "text", [
      { provider: "mistral", model: "m2" },
      { provider: "groq", model: "m1" }
    ])).status, 200);

    assert.equal((await chat(router)).status, 200);
    assert.deepEqual(posts(mistral), ["s0"], "the first entry serves");
    assert.deepEqual(posts(groq), [], "a later entry is not touched after a success");
  } finally {
    await router.close(); await groq.close(); await mistral.close();
  }
});

test("a key can be narrowed out of an entry, and is then never called", async () => {
  const { router, groq, mistral } = await startTwoProviderRouter();
  try {
    assert.equal((await saveChain(router, "text", [
      { provider: "groq", model: "m1", keys: [1] },
      { provider: "mistral", model: "m2" }
    ])).status, 200);

    assert.equal((await chat(router)).status, 200);
    assert.deepEqual(posts(groq), ["g1"], "the excluded key is never attempted");
    assert.deepEqual(posts(mistral), []);
  } finally {
    await router.close(); await groq.close(); await mistral.close();
  }
});

test("a model left out of the chain is not routed to", async () => {
  const { router, groq, mistral } = await startTwoProviderRouter();
  try {
    assert.equal((await saveChain(router, "text", [{ provider: "mistral", model: "m2" }])).status, 200);
    assert.equal((await chat(router)).status, 200);
    assert.deepEqual(posts(groq), [], "the chain is the complete order for its pool");
    assert.deepEqual(posts(mistral), ["s0"]);
  } finally {
    await router.close(); await groq.close(); await mistral.close();
  }
});

// ---------------------------------------------------------------------------
// Fallback after failures
// ---------------------------------------------------------------------------

test("a chain that fails falls through to the next model, which retries its own keys", async () => {
  const groq = await startMockUpstream(() => down);
  const mistral = await startMockUpstream((record) => (bearer(record) === "s0" ? down : ok("m2")));
  const router = await startRouter({
    GROQ_API_KEYS: "g0,g1",
    GROQ_MODELS: "m1",
    GROQ_BASE_URL: `${groq.baseUrl}/v1`,
    MISTRAL_API_KEYS: "s0,s1",
    MISTRAL_MODELS: "m2",
    MISTRAL_BASE_URL: `${mistral.baseUrl}/v1`
  });
  try {
    await saveChain(router, "text", [
      { provider: "groq", model: "m1" },
      { provider: "mistral", model: "m2" }
    ]);

    assert.equal((await chat(router)).status, 200);
    assert.deepEqual(posts(groq), ["g0", "g1"], "both keys of the first model are tried");
    assert.deepEqual(posts(mistral), ["s0", "s1"], "then the next model starts at its own first key");
  } finally {
    await router.close(); await groq.close(); await mistral.close();
  }
});

// ---------------------------------------------------------------------------
// Operating modes and Reset
// ---------------------------------------------------------------------------

test("Fixed Order remembers nothing; Remember Last Successful does", async () => {
  // groq is down on BOTH keys, so the walk really does reach mistral.
  const groq = await startMockUpstream(() => down);
  const mistral = await startMockUpstream(() => ok("m2"));
  const router = await startRouter({
    GROQ_API_KEYS: "g0,g1", GROQ_MODELS: "m1", GROQ_BASE_URL: `${groq.baseUrl}/v1`,
    MISTRAL_API_KEYS: "s0", MISTRAL_MODELS: "m2", MISTRAL_BASE_URL: `${mistral.baseUrl}/v1`
  });
  try {
    await saveChain(router, "text", [
      { provider: "groq", model: "m1" },
      { provider: "mistral", model: "m2" }
    ]);

    // Fixed Order (the default): groq fails over to mistral, and nothing is remembered.
    assert.equal((await chat(router)).status, 200);
    assert.deepEqual(posts(mistral), ["s0"]);
    let state = await getFallback(router);
    assert.equal(state.mode, "fixed");
    assert.equal(state.remembersSuccess, false);
    assert.deepEqual(state.remembered.remembered.text, [], "Fixed Order must not remember a success");

    // Remember Last Successful: the same request now records the target that answered.
    assert.equal((await saveMode(router, "last-success")).status, 200);
    state = await getFallback(router);
    assert.equal(state.mode, "last-success");
    assert.equal(state.remembersSuccess, true);

    assert.equal((await chat(router)).status, 200);
    state = await getFallback(router);
    assert.equal(state.remembered.remembered.text.length, 1, "the success is remembered");
    assert.match(state.remembered.remembered.text[0].targetId, /^mistral:m2:key-0$/);
    assert.equal(state.remembered.remembered.text[0].pool, "text");
  } finally {
    await router.close(); await groq.close(); await mistral.close();
  }
});

test("Reset Fallback clears what was remembered and leaves the configuration alone", async () => {
  const dir = tmpDir("reset");
  const groq = await startMockUpstream(() => down);
  const mistral = await startMockUpstream(() => ok("m2"));
  const router = await startRouter({
    GROQ_API_KEYS: "g0,g1", GROQ_MODELS: "m1", GROQ_BASE_URL: `${groq.baseUrl}/v1`,
    MISTRAL_API_KEYS: "s0", MISTRAL_MODELS: "m2", MISTRAL_BASE_URL: `${mistral.baseUrl}/v1`,
    FALLBACK_CHAIN_FILE: path.join(dir, "fallback-chain.json"),
    MANUAL_SELECTION_FILE: path.join(dir, "manual-selection.json")
  });
  try {
    const chain = [
      { provider: "groq", model: "m1" },
      { provider: "mistral", model: "m2", keys: [0] }
    ];
    await saveChain(router, "text", chain);
    await saveMode(router, "last-success");
    assert.equal((await chat(router)).status, 200);
    assert.equal((await getFallback(router)).remembered.remembered.text.length, 1);

    const before = await getFallback(router);
    const reset = await resetFallback(router);
    assert.equal(reset.ok, true);
    assert.ok(reset.reset.clearedSessions >= 1, "the remembered session is reported as cleared");
    assert.ok(reset.message.length > 0, "the operator gets feedback");

    const after = await getFallback(router);
    assert.deepEqual(after.remembered.remembered.text, [], "nothing is remembered after a reset");
    // Everything the router was TOLD survives untouched.
    assert.deepEqual(after.chain, before.chain, "the saved chain is not deleted");
    assert.equal(after.mode, "last-success", "the selected mode is not deleted");
    assert.deepEqual(after.catalogue.text.map((group) => group.id), before.catalogue.text.map((group) => group.id),
      "the configured models are not deleted");
    assert.ok(fs.existsSync(path.join(dir, "fallback-chain.json")), "the persisted chain file still exists");

    // A genuine cooldown is NOT a remembered preference and must survive too.
    const healthAfter = await router.request("/api/health").then(json);
    const cooled = healthAfter.targets.filter((target) => target.cooldownUntil > Date.now());
    assert.ok(cooled.length > 0, "the groq failure is still in cooldown after a reset");
  } finally {
    await router.close(); await groq.close(); await mistral.close();
  }
});

test("the chain and the mode survive a restart, while remembered state does not", async () => {
  const dir = tmpDir("restart");
  const groq = await startMockUpstream(() => down);
  const mistral = await startMockUpstream(() => ok("m2"));
  const env = {
    GROQ_API_KEYS: "g0,g1", GROQ_MODELS: "m1", GROQ_BASE_URL: `${groq.baseUrl}/v1`,
    MISTRAL_API_KEYS: "s0", MISTRAL_MODELS: "m2", MISTRAL_BASE_URL: `${mistral.baseUrl}/v1`,
    FALLBACK_CHAIN_FILE: path.join(dir, "fallback-chain.json"),
    MANUAL_SELECTION_FILE: path.join(dir, "manual-selection.json")
  };

  const first = await startRouter(env);
  try {
    assert.equal((await saveChain(first, "text", [
      { provider: "mistral", model: "m2" },
      { provider: "groq", model: "m1" }
    ])).status, 200);
    await saveMode(first, "last-success");
    assert.equal((await chat(first)).status, 200);
    assert.equal((await getFallback(first)).remembered.remembered.text.length, 1);
  } finally {
    await first.close();
  }

  const second = await startRouter(env);
  try {
    const state = await getFallback(second);
    assert.equal(state.mode, "last-success", "the mode survives a restart");
    assert.deepEqual(state.chain.text.map((entry) => `${entry.provider}/${entry.model}`), ["mistral/m2", "groq/m1"],
      "the chain survives a restart");
    // Remembered targets are in-memory routing state, not configuration: a
    // restart legitimately starts with nothing remembered.
    assert.deepEqual(state.remembered.remembered.text, []);
  } finally {
    await second.close(); await groq.close(); await mistral.close();
  }
});

// ---------------------------------------------------------------------------
// Text and vision
// ---------------------------------------------------------------------------

const image = [{ type: "text", text: "what is this?" }, { type: "image_url", image_url: { url: "data:image/png;base64,iVBORw0KGgo=" } }];
const chatImage = (router) => router.request("/v1/chat/completions", postJson({ model: "anything", messages: [{ role: "user", content: image }] }));

test("text and vision keep separate chains, separate orders and separate memory", async () => {
  const groq = await startMockUpstream((record) => (["t0", "v0"].includes(bearer(record)) ? down : ok("m1")));
  const router = await startRouter({
    GROQ_API_KEYS: "t0,t1", GROQ_MODELS: "m1", GROQ_BASE_URL: `${groq.baseUrl}/v1`,
    GROQ_VISION_API_KEYS: "v0,v1", GROQ_VISION_MODELS: "vm1", GROQ_VISION_BASE_URL: `${groq.baseUrl}/v1`
  });
  try {
    await saveChain(router, "text", [{ provider: "groq", model: "m1" }]);
    await saveChain(router, "vision", [{ provider: "groq", model: "vm1" }]);
    await saveMode(router, "last-success");

    // Vision: its own keys, its own multi-key retry.
    assert.equal((await chatImage(router)).status, 200);
    assert.deepEqual(posts(groq), ["v0", "v1"], "vision tries every eligible key of its own chain");

    const state = await getFallback(router);
    assert.equal(state.chain.vision[0].model, "vm1");
    assert.equal(state.chain.text[0].model, "m1");
    assert.deepEqual(state.remembered.remembered.text, [], "a vision success must not become a text preference");
    assert.equal(state.remembered.remembered.vision.length, 1);
    assert.match(state.remembered.remembered.vision[0].targetId, /^vision:groq:vm1:key-1$/);

    // Text is untouched by the vision pool's state and starts from its own chain.
    assert.equal((await chat(router)).status, 200);
    assert.deepEqual(posts(groq).slice(2), ["t0", "t1"], "text starts at its own first key");
  } finally {
    await router.close(); await groq.close();
  }
});

test("a vision request never reaches a text-only model", async () => {
  const textOnly = await startMockUpstream(() => ok("m1"));
  const vision = await startMockUpstream(() => ok("vm1"));
  const router = await startRouter({
    GROQ_API_KEYS: "t0", GROQ_MODELS: "m1", GROQ_BASE_URL: `${textOnly.baseUrl}/v1`,
    MISTRAL_VISION_API_KEYS: "s0", MISTRAL_VISION_MODELS: "vm1", MISTRAL_VISION_BASE_URL: `${vision.baseUrl}/v1`
  });
  try {
    // Even with a text chain that names the text model, the vision request
    // cannot be routed to it: the pools are separate target lists.
    await saveChain(router, "text", [{ provider: "groq", model: "m1" }]);
    await saveChain(router, "vision", [{ provider: "mistral", model: "vm1" }]);

    assert.equal((await chatImage(router)).status, 200);
    assert.deepEqual(posts(textOnly), [], "a text-only provider must never receive a vision request");
    assert.deepEqual(posts(vision), ["s0"]);
  } finally {
    await router.close(); await textOnly.close(); await vision.close();
  }
});

// ---------------------------------------------------------------------------
// Legacy routing cannot override the chain
// ---------------------------------------------------------------------------

test("the legacy priority env vars and manual-selection file cannot override the chain", async () => {
  const dir = tmpDir("legacy");
  const manualFile = path.join(dir, "manual-selection.json");
  // A saved chain AND a legacy selection that names the OTHER provider first.
  fs.writeFileSync(manualFile, JSON.stringify({ text: [{ provider: "groq", model: "m1" }] }));
  fs.writeFileSync(path.join(dir, "fallback-chain.json"), JSON.stringify({
    version: 2,
    mode: "fixed",
    text: [{ provider: "mistral", model: "m2", keys: null, enabled: true }],
    vision: []
  }, null, 2));

  const { router, groq, mistral } = await startTwoProviderRouter({
    dir,
    MANUAL_SELECTION_FILE: manualFile,
    FALLBACK_CHAIN_FILE: path.join(dir, "fallback-chain.json"),
    TEXT_PRIORITY_MODELS: "groq/m1",
    VISION_PRIORITY_MODELS: "groq/m1"
  });
  try {
    assert.equal((await chat(router)).status, 200);
    assert.deepEqual(posts(mistral), ["s0"], "the saved chain decides, not the legacy sources");
    assert.deepEqual(posts(groq), [], "a legacy priority entry cannot pull the request elsewhere");
  } finally {
    await router.close(); await groq.close(); await mistral.close();
  }
});

test("the legacy manual selection seeds the chain once, then stops being read", async () => {
  const dir = tmpDir("migrate");
  const manualFile = path.join(dir, "manual-selection.json");
  fs.writeFileSync(manualFile, JSON.stringify({ text: [{ provider: "mistral", model: "m2" }], vision: [] }));

  const env = { MANUAL_SELECTION_FILE: manualFile, FALLBACK_CHAIN_FILE: path.join(dir, "fallback-chain.json") };
  const { router, groq, mistral } = await startTwoProviderRouter({ dir, ...env });
  try {
    const state = await getFallback(router);
    assert.deepEqual(state.chain.text.map((entry) => entry.model), ["m2"], "the legacy selection becomes the chain");
    assert.equal(state.mode, "last-success", "seeded in the mode the legacy behaviour actually used");

    // The operator replaces the chain; the legacy file must not come back.
    await saveChain(router, "text", [{ provider: "groq", model: "m1" }]);
    assert.equal((await chat(router)).status, 200);
    assert.deepEqual(posts(groq), ["g0", "g1"]);
    assert.deepEqual(posts(mistral), []);
  } finally {
    await router.close(); await groq.close(); await mistral.close();
  }

  const restarted = await startTwoProviderRouter({ dir, ...env });
  try {
    const state = await getFallback(restarted.router);
    assert.deepEqual(state.chain.text.map((entry) => entry.model), ["m1"],
      "the saved chain wins over the legacy file on the next start too");
  } finally {
    await restarted.router.close();
    await restarted.groq.close();
    await restarted.mistral.close();
  }
});

// ---------------------------------------------------------------------------
// Unchanged behaviour
// ---------------------------------------------------------------------------

test("the configuration API validates what it is given", async () => {
  const { router, groq, mistral } = await startTwoProviderRouter();
  try {
    const put = (body) => router.request("/api/fallback", {
      method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body)
    });

    assert.equal((await put({ pool: "video", entries: [] })).status, 400);
    assert.equal((await put({ pool: "text" })).status, 400, "entries must be an array");
    assert.equal((await put({ mode: "chaos" })).status, 400);
    assert.equal((await put({ pool: "text", entries: [{ provider: "groq", model: "not-configured" }] })).status, 400,
      "a model that is not configured for the pool is refused");
    assert.equal((await put({ pool: "vision", entries: [{ provider: "groq", model: "m1" }] })).status, 400,
      "a text model cannot be saved into the vision chain");
    assert.equal((await put({})).status, 400);

    // Nothing above was saved.
    const state = await getFallback(router);
    assert.deepEqual(state.chain.text, []);
    assert.equal(state.mode, "fixed");
  } finally {
    await router.close(); await groq.close(); await mistral.close();
  }
});

test("streaming, authentication and the request log are unaffected", async () => {
  const sse = [
    'data: {"id":"x","object":"chat.completion.chunk","model":"m1","choices":[{"index":0,"delta":{"content":"he"}}]}\n\n',
    'data: {"id":"x","object":"chat.completion.chunk","model":"m1","choices":[{"index":0,"delta":{"content":"llo"},"finish_reason":"stop"}]}\n\n',
    "data: [DONE]\n\n"
  ];
  const groq = await startMockUpstream(() => ({ status: 200, stream: sse }));
  const router = await startRouter({
    GROQ_API_KEYS: "g0", GROQ_MODELS: "m1", GROQ_BASE_URL: `${groq.baseUrl}/v1`,
    APIROUTER_API_KEYS: "client-token"
  });
  try {
    // Auth is still enforced on the proxy and on every /api route, the
    // configuration API included. The gateway reads a Bearer token only.
    assert.equal((await router.request("/v1/chat/completions", postJson({ model: "x", messages: [] }))).status, 401);
    assert.equal((await router.request("/api/fallback")).status, 401);
    assert.equal((await saveChain(router, "text", [{ provider: "groq", model: "m1" }])).status, 401);

    const headers = { authorization: "Bearer client-token" };
    assert.equal((await saveChain(router, "text", [{ provider: "groq", model: "m1" }], headers)).status, 200);

    const streamed = await router.request("/v1/chat/completions", postJson(
      { model: "x", messages: [{ role: "user", content: "hi" }], stream: true }, headers
    ));
    assert.equal(streamed.status, 200);
    const text = await streamed.text();
    assert.match(text, /data: /);
    assert.match(text, /\[DONE\]/);

    // The attempt is recorded under the new phase vocabulary.
    const log = await router.request("/api/requests?limit=5", { headers }).then(json);
    const attempts = log.attempts ?? [];
    assert.ok(attempts.length > 0, "the attempt is logged");
    assert.equal(attempts[0].phase, "chain");
  } finally {
    await router.close(); await groq.close();
  }
});
