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

// ---------------------------------------------------------------------------
// A remembered target may not bypass a key restriction applied afterwards
// ---------------------------------------------------------------------------

test("a remembered key excluded by the current chain is not attempted", async () => {
  // groq key 0 is down, key 1 works; mistral always works.
  const { router, groq, mistral } = await startTwoProviderRouter();
  try {
    await saveMode(router, "last-success");
    // Start with only key 1 allowed, so key 1 answers and is remembered.
    assert.equal((await saveChain(router, "text", [
      { provider: "groq", model: "m1", keys: [1] },
      { provider: "mistral", model: "m2" }
    ])).status, 200);
    assert.equal((await chat(router)).status, 200);
    assert.deepEqual(posts(groq), ["g1"]);
    assert.equal((await getFallback(router)).remembered.remembered.text[0].targetId, "groq:m1:key-1");

    // The operator now allows ONLY key 0. The remembered key 1 must not be
    // tried: it is excluded by the configuration in force.
    assert.equal((await saveChain(router, "text", [
      { provider: "groq", model: "m1", keys: [0] },
      { provider: "mistral", model: "m2" }
    ])).status, 200);

    assert.equal((await chat(router)).status, 200);
    assert.deepEqual(posts(groq), ["g1", "g0"], "key 1 must not be attempted again");
    assert.deepEqual(posts(mistral), ["s0"], "the request falls through to the next configured model");
  } finally {
    await router.close(); await groq.close(); await mistral.close();
  }
});

test("a remembered model with a restricted subset uses only allowed keys", async () => {
  const groq = await startMockUpstream((record) => (bearer(record) === "g0" ? down : ok("m1")));
  const mistral = await startMockUpstream(() => ok("m2"));
  const router = await startRouter({
    GROQ_API_KEYS: "g0,g1,g2",
    GROQ_MODELS: "m1",
    GROQ_BASE_URL: `${groq.baseUrl}/v1`,
    MISTRAL_API_KEYS: "s0",
    MISTRAL_MODELS: "m2",
    MISTRAL_BASE_URL: `${mistral.baseUrl}/v1`
  });
  try {
    await saveMode(router, "last-success");
    // Every key is allowed at first, so key 2 answers and is remembered.
    assert.equal((await saveChain(router, "text", [
      { provider: "groq", model: "m1" },
      { provider: "mistral", model: "m2" }
    ])).status, 200);
    assert.equal((await chat(router)).status, 200);
    // g0 is down, so the walk reaches g1.
    assert.deepEqual(posts(groq), ["g0", "g1"]);
    assert.equal((await getFallback(router)).remembered.remembered.text[0].targetId, "groq:m1:key-1");

    // Restrict the entry to keys 0 and 2. The remembered key 1 is now excluded.
    assert.equal((await saveChain(router, "text", [
      { provider: "groq", model: "m1", keys: [0, 2] },
      { provider: "mistral", model: "m2" }
    ])).status, 200);

    assert.equal((await chat(router)).status, 200);
    const after = posts(groq).slice(2);
    assert.ok(!after.includes("g1"), `key 1 is excluded and must not be attempted (saw ${JSON.stringify(after)})`);
    assert.ok(after.includes("g2"), "the other allowed key is still reached");
  } finally {
    await router.close(); await groq.close(); await mistral.close();
  }
});

// ---------------------------------------------------------------------------
// A saved configuration takes effect without waiting for the order cache
// ---------------------------------------------------------------------------

test("a model added to the chain is used on the very next request in Automatic mode", async () => {
  const groq = await startMockUpstream(() => down);
  const mistral = await startMockUpstream(() => ok("m2"));
  const router = await startRouter({
    GROQ_API_KEYS: "g0,g1", GROQ_MODELS: "m1", GROQ_BASE_URL: `${groq.baseUrl}/v1`,
    MISTRAL_API_KEYS: "s0", MISTRAL_MODELS: "m2", MISTRAL_BASE_URL: `${mistral.baseUrl}/v1`
  });
  try {
    await saveMode(router, "auto");
    assert.equal((await saveChain(router, "text", [{ provider: "groq", model: "m1" }])).status, 200);
    // groq is entirely down and is the only configured model: nothing can serve.
    assert.equal((await chat(router)).status, 502);

    // Adding mistral must take effect at once, in the same 30-second bucket.
    assert.equal((await saveChain(router, "text", [
      { provider: "groq", model: "m1" },
      { provider: "mistral", model: "m2" }
    ])).status, 200);
    assert.equal((await chat(router)).status, 200, "the newly added model must be eligible immediately");
    assert.deepEqual(posts(mistral), ["s0"]);
  } finally {
    await router.close(); await groq.close(); await mistral.close();
  }
});

test("disabling an entry removes it from the effective order immediately", async () => {
  const groq = await startMockUpstream(() => down);
  const mistral = await startMockUpstream(() => ok("m2"));
  const router = await startRouter({
    GROQ_API_KEYS: "g0,g1", GROQ_MODELS: "m1", GROQ_BASE_URL: `${groq.baseUrl}/v1`,
    MISTRAL_API_KEYS: "s0", MISTRAL_MODELS: "m2", MISTRAL_BASE_URL: `${mistral.baseUrl}/v1`
  });
  try {
    await saveMode(router, "auto");
    await saveChain(router, "text", [
      { provider: "groq", model: "m1" },
      { provider: "mistral", model: "m2" }
    ]);
    assert.equal((await chat(router)).status, 200);
    assert.deepEqual(posts(mistral), ["s0"]);

    // Disabling mistral must remove it from the order at once. groq is already
    // cooling from the previous request, so nothing at all is eligible now:
    // that is the documented 503 ("no routing targets available"), not a 502.
    assert.equal((await saveChain(router, "text", [
      { provider: "groq", model: "m1" },
      { provider: "mistral", model: "m2", enabled: false }
    ])).status, 200);
    assert.equal((await chat(router)).status, 503, "a disabled entry must not serve");
    assert.deepEqual(posts(mistral), ["s0"], "and must never be called again");
  } finally {
    await router.close(); await groq.close(); await mistral.close();
  }
});

test("a mode change is reflected in the routing decision immediately", async () => {
  const { router, groq, mistral } = await startTwoProviderRouter();
  try {
    await saveChain(router, "text", [
      { provider: "groq", model: "m1" },
      { provider: "mistral", model: "m2" }
    ]);
    const preview = () => router.request("/api/router/preview?pool=text&protocol=openai-chat").then(json);

    assert.equal((await saveMode(router, "fixed")).status, 200);
    const fixed = await preview();
    assert.equal(fixed.mode, "fixed");
    assert.equal(fixed.orderSource, "chain");
    assert.equal(fixed.automatic, false);

    // No sleep: the switch must be live on the very next read.
    assert.equal((await saveMode(router, "auto")).status, 200);
    const auto = await preview();
    assert.equal(auto.mode, "auto");
    assert.equal(auto.orderSource, "auto");
    assert.equal(auto.automatic, true);
  } finally {
    await router.close(); await groq.close(); await mistral.close();
  }
});

test("saving a chain re-plans immediately, with no health change and no new bucket", async () => {
  // The preview path is read-only: it plans the order without observing any
  // health, so the health version and the 30-second bucket are both unchanged
  // between the two reads. Only the configuration differs, which is exactly the
  // case a cache keyed on health and time alone cannot notice.
  const { router, groq, mistral } = await startTwoProviderRouter();
  try {
    await saveMode(router, "auto");
    // fallbackOrder is per TARGET (one row per key), so read the distinct models.
    const order = async () => [...new Set(
      (await router.request("/api/router/preview?pool=text&protocol=openai-chat").then(json))
        .fallbackOrder.map((item) => item.model)
    )];

    assert.equal((await saveChain(router, "text", [{ provider: "groq", model: "m1" }])).status, 200);
    assert.deepEqual(await order(), ["m1"], "only the configured model is planned");

    assert.equal((await saveChain(router, "text", [
      { provider: "groq", model: "m1" },
      { provider: "mistral", model: "m2" }
    ])).status, 200);
    assert.ok((await order()).includes("m2"),
      "the model just added must be planned immediately, not after the next bucket");
  } finally {
    await router.close(); await groq.close(); await mistral.close();
  }
});

// ---------------------------------------------------------------------------
// Fail-closed routing
//
// A pool with no saved chain routes automatically. A pool whose saved chain
// cannot serve the request must NOT: widening to a model outside the chain, or
// to a key an entry excludes, is the silent fallback the chain exists to stop.
//
// The API only saves entries that name models configured AT THAT MOMENT, so the
// unusable-chain cases arise the way they do in production: a provider or model
// disappears from the environment while the chain that names it is persisted.
// ---------------------------------------------------------------------------

/** A chain file shared across two router starts, so a saved chain can outlive
 *  the providers it names. */
const chainEnv = (dir, env = {}) => ({
  FALLBACK_CHAIN_FILE: path.join(dir, "fallback-chain.json"),
  MANUAL_SELECTION_FILE: path.join(dir, "manual-selection.json"),
  ...env
});

test("a chain naming a provider that is no longer configured routes only through its usable entries", async () => {
  const dir = tmpDir("gone-provider");
  const groq = await startMockUpstream(() => ok("m1"));
  const mistral = await startMockUpstream(() => ok("m2"));
  const shared = { MISTRAL_API_KEYS: "s0", MISTRAL_MODELS: "m2", MISTRAL_BASE_URL: `${mistral.baseUrl}/v1` };

  const first = await startRouter(chainEnv(dir, {
    ...shared, GROQ_API_KEYS: "g0", GROQ_MODELS: "m1", GROQ_BASE_URL: `${groq.baseUrl}/v1`
  }));
  try {
    assert.equal((await saveChain(first, "text", [
      { provider: "groq", model: "m1" },
      { provider: "mistral", model: "m2" }
    ])).status, 200);
  } finally {
    await first.close();
  }

  // groq is removed from the environment; the persisted chain still names it.
  const second = await startRouter(chainEnv(dir, shared));
  try {
    assert.equal((await chat(second)).status, 200);
    assert.deepEqual(posts(mistral), ["s0"], "the entry that is still usable serves");
    assert.deepEqual(posts(groq), [], "the removed provider is never called");
  } finally {
    await second.close(); await groq.close(); await mistral.close();
  }
});

test("a chain whose only provider is gone fails closed with a 503 and routes nowhere", async () => {
  const dir = tmpDir("gone-only");
  const groq = await startMockUpstream(() => ok("m1"));
  const mistral = await startMockUpstream(() => ok("m2"));
  const mistralEnv = { MISTRAL_API_KEYS: "s0", MISTRAL_MODELS: "m2", MISTRAL_BASE_URL: `${mistral.baseUrl}/v1` };

  const first = await startRouter(chainEnv(dir, {
    ...mistralEnv, GROQ_API_KEYS: "g0", GROQ_MODELS: "m1", GROQ_BASE_URL: `${groq.baseUrl}/v1`
  }));
  try {
    assert.equal((await saveChain(first, "text", [{ provider: "groq", model: "m1" }])).status, 200);
  } finally {
    await first.close();
  }

  const second = await startRouter(chainEnv(dir, mistralEnv));
  try {
    const response = await chat(second);
    assert.equal(response.status, 503);
    const body = await response.json();
    assert.equal(body.error.type, "fallback_chain_unusable", "the error says why, not a generic outage");
    assert.match(body.error.message, /Fallback Chain/);
    assert.deepEqual(posts(mistral), [], "a configured model outside the chain must not be substituted");
  } finally {
    await second.close(); await groq.close(); await mistral.close();
  }
});

test("an unusable chain is per-pool: vision keeps routing automatically", async () => {
  const dir = tmpDir("pool-isolation");
  const groq = await startMockUpstream(() => ok("m1"));
  const mistral = await startMockUpstream(() => ok("m2"));
  const vision = await startMockUpstream(() => ok("vm1"));
  // mistral is a TEXT provider that the chain does NOT name, so a router that
  // widened would happily serve the request through it.
  const afterEnv = {
    MISTRAL_API_KEYS: "s0", MISTRAL_MODELS: "m2", MISTRAL_BASE_URL: `${mistral.baseUrl}/v1`,
    GROQ_VISION_API_KEYS: "v0", GROQ_VISION_MODELS: "vm1", GROQ_VISION_BASE_URL: `${vision.baseUrl}/v1`
  };

  const first = await startRouter(chainEnv(dir, {
    ...afterEnv, GROQ_API_KEYS: "g0", GROQ_MODELS: "m1", GROQ_BASE_URL: `${groq.baseUrl}/v1`
  }));
  try {
    assert.equal((await saveChain(first, "text", [{ provider: "groq", model: "m1" }])).status, 200);
    // No vision chain is saved at all.
  } finally {
    await first.close();
  }

  const second = await startRouter(chainEnv(dir, afterEnv));
  try {
    assert.equal((await chat(second)).status, 503, "the text chain is unusable and must not widen to mistral");
    assert.deepEqual(posts(mistral), [], "an unnamed text model must not be substituted");
    assert.equal((await chatImage(second)).status, 200, "vision has no chain, so it still routes automatically");
    assert.deepEqual(posts(vision), ["v0"]);
  } finally {
    await second.close(); await groq.close(); await mistral.close(); await vision.close();
  }
});

test("a chain whose entries are all disabled fails closed, and clearing it restores automatic routing", async () => {
  const { router, groq, mistral } = await startTwoProviderRouter();
  try {
    assert.equal((await saveChain(router, "text", [
      { provider: "groq", model: "m1", enabled: false },
      { provider: "mistral", model: "m2", enabled: false }
    ])).status, 200);

    assert.equal((await chat(router)).status, 503, "saved entries that permit nothing must not widen");
    assert.deepEqual(posts(groq), []);
    assert.deepEqual(posts(mistral), []);

    // Clearing the chain is the way to ask for automatic routing.
    assert.equal((await saveChain(router, "text", [])).status, 200);
    assert.equal((await chat(router)).status, 200);
    assert.ok(posts(groq).length + posts(mistral).length > 0, "the automatic order takes over");
  } finally {
    await router.close(); await groq.close(); await mistral.close();
  }
});

test("the preview reports the fail-closed state instead of an automatic order", async () => {
  const dir = tmpDir("preview-failclosed");
  const groq = await startMockUpstream(() => ok("m1"));
  const mistral = await startMockUpstream(() => ok("m2"));
  const mistralEnv = { MISTRAL_API_KEYS: "s0", MISTRAL_MODELS: "m2", MISTRAL_BASE_URL: `${mistral.baseUrl}/v1` };

  const first = await startRouter(chainEnv(dir, {
    ...mistralEnv, GROQ_API_KEYS: "g0", GROQ_MODELS: "m1", GROQ_BASE_URL: `${groq.baseUrl}/v1`
  }));
  try {
    assert.equal((await saveChain(first, "text", [{ provider: "groq", model: "m1" }])).status, 200);
  } finally {
    await first.close();
  }

  const second = await startRouter(chainEnv(dir, mistralEnv));
  try {
    const preview = await second.request("/api/router/preview?pool=text&protocol=openai-chat").then(json);
    assert.equal(preview.chainFailClosed, true);
    assert.equal(preview.chainEntries, 1);
    assert.deepEqual(preview.fallbackOrder, [], "nothing is planned");
    const ranking = preview.stages.find((stage) => stage.key === "ranking");
    assert.equal(ranking.state, "error");
    assert.match(ranking.detail, /no target it names can serve this request/);

    // And it recovers the moment the chain is cleared.
    assert.equal((await saveChain(second, "text", [])).status, 200);
    const after = await second.request("/api/router/preview?pool=text&protocol=openai-chat").then(json);
    assert.equal(after.chainFailClosed, false);
    assert.ok(after.fallbackOrder.length > 0, "the automatic order is planned again");
  } finally {
    await second.close(); await groq.close(); await mistral.close();
  }
});

// ---------------------------------------------------------------------------
// Per-pool fail-closed diagnostics on /health
// ---------------------------------------------------------------------------

const healthPayload = (router) => router.request("/health").then(json);

test("/health distinguishes an unusable chain from ordinary provider unavailability", async () => {
  const dir = tmpDir("health-status");
  const groq = await startMockUpstream(() => ok("m1"));
  const mistral = await startMockUpstream(() => ok("m2"));
  const mistralEnv = { MISTRAL_API_KEYS: "s0", MISTRAL_MODELS: "m2", MISTRAL_BASE_URL: `${mistral.baseUrl}/v1` };

  const first = await startRouter(chainEnv(dir, {
    ...mistralEnv, GROQ_API_KEYS: "g0", GROQ_MODELS: "m1", GROQ_BASE_URL: `${groq.baseUrl}/v1`
  }));
  try {
    assert.equal((await saveChain(first, "text", [{ provider: "groq", model: "m1" }])).status, 200);
  } finally {
    await first.close();
  }

  const second = await startRouter(chainEnv(dir, mistralEnv));
  try {
    const payload = await healthPayload(second);
    // The chain is saved and cannot be honoured: a configuration fault.
    assert.equal(payload.fallback.pools.text.failClosed, true);
    assert.equal(payload.fallback.pools.text.entries, 1);
    assert.equal(payload.fallback.pools.text.resolved, 0);
    // And it is reported per pool, not globally.
    assert.equal(payload.fallback.pools.vision.failClosed, false);
    assert.equal(payload.fallback.chains.text, 1);
  } finally {
    await second.close(); await groq.close(); await mistral.close();
  }
});

test("/health reports an empty chain as unconfigured, not as a fault", async () => {
  const { router, groq, mistral } = await startTwoProviderRouter();
  try {
    const payload = await healthPayload(router);
    for (const pool of ["text", "vision"]) {
      assert.equal(payload.fallback.pools[pool].failClosed, false, `${pool} is unconfigured, not broken`);
      assert.equal(payload.fallback.pools[pool].entries, 0);
    }
    assert.ok(payload.rankedTargets.length > 0, "an unconfigured router still routes");
  } finally {
    await router.close(); await groq.close(); await mistral.close();
  }
});

test("/health keeps failClosed false when a configured chain is merely unavailable", async () => {
  const { router, groq, mistral } = await startTwoProviderRouter();
  try {
    await saveChain(router, "text", [{ provider: "groq", model: "m1" }]);
    assert.equal((await chat(router)).status, 200);

    const payload = await healthPayload(router);
    assert.equal(payload.fallback.pools.text.failClosed, false,
      "a provider being unavailable is not a configuration fault");
    assert.equal(payload.fallback.pools.text.entries, 1);
    assert.equal(payload.fallback.pools.text.resolved, 1);
  } finally {
    await router.close(); await groq.close(); await mistral.close();
  }
});

// ---------------------------------------------------------------------------
// Key-index validation
// ---------------------------------------------------------------------------

test("PUT /api/fallback rejects key restrictions the provider cannot honour", async () => {
  const { router, groq, mistral } = await startTwoProviderRouter();
  try {
    const put = (entries) => router.request("/api/fallback", {
      method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ pool: "text", entries })
    });
    const entry = (keys) => [{ provider: "groq", model: "m1", keys }];
    const saved = async () => (await getFallback(router)).chain.text;

    // groq/m1 is configured with keys 0 and 1 only.
    const response = await put(entry([0, 5]));
    assert.equal(response.status, 400);
    const body = await response.json();
    assert.match(body.error.message, /key restrictions/);
    assert.deepEqual(body.error.details.keys, [
      { provider: "groq", model: "m1", reason: "keys_not_configured", keys: [5], available: [0, 1] }
    ]);
    assert.deepEqual(await saved(), [], "a rejected request must save nothing");

    // Everything that is not a real, configured index is refused rather than
    // normalized to null — which means EVERY key, and would silently widen the
    // restriction the operator was trying to state.
    const malformed = [
      [true], [false], ["1"], [""], [null], [1.5], [-1], [64], [{}], [[]], [0, "1"], [0, true],
      "1", 1, true, false, {}, 0, ""
    ];
    for (const keys of malformed) {
      const refused = await put(entry(keys));
      assert.equal(refused.status, 400, `keys ${JSON.stringify(keys)} must be refused`);
      const detail = (await refused.json()).error.details.keys[0];
      assert.ok(
        ["keys_not_an_array", "keys_not_configured"].includes(detail.reason),
        `keys ${JSON.stringify(keys)} reported reason ${detail.reason}`
      );
    }
    assert.deepEqual(await saved(), [], "no malformed restriction may be saved");

    // An explicitly empty array would also normalize to "every key", so it is
    // refused. Saying "every key" is done by omitting the field or sending null.
    const empty = await put(entry([]));
    assert.equal(empty.status, 400);
    assert.equal((await empty.json()).error.details.keys[0].reason, "keys_empty");

    // Omitted and explicit null keep their meaning: every key.
    for (const keys of [undefined, null]) {
      assert.equal((await put(entry(keys))).status, 200, `keys ${String(keys)} means every key`);
      assert.deepEqual(await saved(), [{ provider: "groq", model: "m1", keys: null, enabled: true }]);
    }

    // Real numeric indexes still work, whatever order they arrive in.
    assert.equal((await put(entry([1, 0]))).status, 200);
    assert.deepEqual(await saved(), [{ provider: "groq", model: "m1", keys: [0, 1], enabled: true }]);

    // And a request walks exactly the keys that were allowed.
    assert.equal((await chat(router)).status, 200);
    assert.deepEqual(posts(groq), ["g0", "g1"]);
  } finally {
    await router.close(); await groq.close(); await mistral.close();
  }
});

test("a rejected save leaves the previous configuration untouched, mode included", async () => {
  const { router, groq, mistral } = await startTwoProviderRouter();
  try {
    await saveMode(router, "last-success");
    await saveChain(router, "text", [{ provider: "mistral", model: "m2" }]);
    const before = await getFallback(router);

    // One request carrying BOTH a valid mode and an invalid chain: the mode must
    // not be written on the way to the error.
    const response = await router.request("/api/fallback", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: "fixed", pool: "text", entries: [{ provider: "groq", model: "m1", keys: [9] }] })
    });
    assert.equal(response.status, 400);

    const after = await getFallback(router);
    assert.equal(after.mode, "last-success", "a rejected save must not persist the mode");
    assert.deepEqual(after.chain, before.chain, "nor the chain");
  } finally {
    await router.close(); await groq.close(); await mistral.close();
  }
});

// ---------------------------------------------------------------------------
// Pinned requests stay strict
// ---------------------------------------------------------------------------

/**
 * A pinned request. The model matters: `pinTargets` narrows by provider, by key
 * AND by the requested model, so naming a model the provider does not serve is
 * itself a 404 (that is the custom-model case, which needs its own header).
 */
const pinnedChat = (router, provider, model, keyIndex) => router.request("/v1/chat/completions", postJson(
  { model, messages: [{ role: "user", content: "hello" }] },
  { "x-multi-ai-pin-provider": provider, ...(keyIndex === undefined ? {} : { "x-multi-ai-pin-key-index": String(keyIndex) }) }
));

test("a pinned request is unaffected by an unusable chain", async () => {
  const dir = tmpDir("pinned");
  const groq = await startMockUpstream(() => ok("m1"));
  const mistral = await startMockUpstream(() => ok("m2"));
  const mistralEnv = { MISTRAL_API_KEYS: "s0", MISTRAL_MODELS: "m2", MISTRAL_BASE_URL: `${mistral.baseUrl}/v1` };

  const first = await startRouter(chainEnv(dir, {
    ...mistralEnv, GROQ_API_KEYS: "g0", GROQ_MODELS: "m1", GROQ_BASE_URL: `${groq.baseUrl}/v1`
  }));
  try {
    assert.equal((await saveChain(first, "text", [{ provider: "groq", model: "m1" }])).status, 200);
  } finally {
    await first.close();
  }

  const second = await startRouter(chainEnv(dir, mistralEnv));
  try {
    // The chain cannot be honoured at all...
    assert.equal((await chat(second)).status, 503);
    // ...but a pin names its target outright, so it still routes there. The
    // fail-closed chain neither blocks it nor substitutes a model for it.
    assert.equal((await pinnedChat(second, "mistral", "m2")).status, 200);
    assert.deepEqual(posts(mistral), ["s0"]);
    assert.deepEqual(posts(groq), [], "the pinned provider is the only one reached");
  } finally {
    await second.close(); await groq.close(); await mistral.close();
  }
});

test("a pinned request pins one key and ignores the configured key restrictions", async () => {
  // Both groq keys work, so a pin to key 0 is observable: without it the chain
  // restricts the request to key 1.
  const groq = await startMockUpstream(() => ok("m1"));
  const mistral = await startMockUpstream(() => ok("m2"));
  const router = await startRouter({
    GROQ_API_KEYS: "g0,g1", GROQ_MODELS: "m1", GROQ_BASE_URL: `${groq.baseUrl}/v1`,
    MISTRAL_API_KEYS: "s0", MISTRAL_MODELS: "m2", MISTRAL_BASE_URL: `${mistral.baseUrl}/v1`
  });
  try {
    // The chain allows only key 1 of groq/m1.
    await saveChain(router, "text", [{ provider: "groq", model: "m1", keys: [1] }]);

    // An ordinary request obeys the restriction.
    assert.equal((await chat(router)).status, 200);
    assert.deepEqual(posts(groq), ["g1"], "the configured subset is respected");

    // A pin to key 0 is a deliberate one-off override and must reach key 0.
    assert.equal((await pinnedChat(router, "groq", "m1", 0)).status, 200);
    assert.deepEqual(posts(groq), ["g1", "g0"], "the pinned key is used, not the key the chain allows");

    // And it is strict: no fallback to another model, and no target remembered.
    assert.deepEqual(posts(mistral), []);
    assert.deepEqual((await getFallback(router)).remembered.remembered.text, [],
      "a pinned request must not remember a target");
  } finally {
    await router.close(); await groq.close(); await mistral.close();
  }
});

test("a pin naming nothing configured is still a 404, whatever the chain says", async () => {
  const { router, groq, mistral } = await startTwoProviderRouter();
  try {
    await saveChain(router, "text", [{ provider: "mistral", model: "m2" }]);
    const response = await pinnedChat(router, "openai", "anything");
    assert.equal(response.status, 404);
    assert.deepEqual(posts(groq), []);
    assert.deepEqual(posts(mistral), []);
  } finally {
    await router.close(); await groq.close(); await mistral.close();
  }
});

// ---------------------------------------------------------------------------
// Atomic combined saves
// ---------------------------------------------------------------------------

test("a combined mode + pool save that cannot be persisted applies neither change", async () => {
  const dir = tmpDir("persist-fail");
  const groq = await startMockUpstream(() => ok("m1"));
  const router = await startRouter({
    GROQ_API_KEYS: "g0,g1", GROQ_MODELS: "m1", GROQ_BASE_URL: `${groq.baseUrl}/v1`,
    FALLBACK_CHAIN_FILE: path.join(dir, "chain.json"),
    MANUAL_SELECTION_FILE: path.join(dir, "manual.json")
  });
  try {
    const put = (body) => router.request("/api/fallback", {
      method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body)
    });

    // A good combined save first, so there is real state to protect.
    assert.equal((await put({
      mode: "last-success", pool: "text", entries: [{ provider: "groq", model: "m1" }]
    })).status, 200);
    const before = await getFallback(router);
    assert.equal(before.mode, "last-success");

    // Now break persistence: the configuration directory is replaced by a
    // regular file, so no write to it can succeed.
    fs.rmSync(dir, { recursive: true, force: true });
    fs.writeFileSync(dir, "not a directory");

    const failed = await put({
      mode: "auto", pool: "text", entries: [{ provider: "groq", model: "m1", keys: [0] }]
    });
    assert.equal(failed.status, 500, "a save that cannot be persisted must fail loudly");

    // Both halves must be untouched: a request that changes two things changes
    // both or neither.
    const after = await getFallback(router);
    assert.equal(after.mode, "last-success", "the mode must not be half-applied");
    assert.deepEqual(after.chain, before.chain, "nor the chain");
    assert.equal(after.chain.text[0].keys, null, "the previously saved chain is still the one in force");
  } finally {
    await router.close(); await groq.close();
  }
});
