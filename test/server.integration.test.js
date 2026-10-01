import test from "node:test";
import assert from "node:assert/strict";
import { startMockUpstream } from "../test-helpers/mock-upstream.js";
import { startRouter, postJson } from "../test-helpers/router-harness.js";

/** Convenience: boot a mock + router pair and always tear both down. */
async function withRig(t, script, envFor) {
  const upstream = await startMockUpstream(script);
  const router = await startRouter(envFor(upstream));
  t.after(async () => {
    await router.close();
    await upstream.close();
  });
  return { upstream, router };
}

const ok = (body = { ok: true }) => ({ status: 200, body });
const fail = (status, message) => ({ status, body: { error: { message } } });

// ---------------------------------------------------------------------------
// Protocol routing
// ---------------------------------------------------------------------------

test("Gemini native generateContent request reaches the gemini target", async (t) => {
  const { upstream, router } = await withRig(
    t,
    () => ok({ candidates: [] }),
    (u) => ({
      GEMINI_API_KEYS: "gemini-key",
      GEMINI_MODELS: "gemini-2.0-flash",
      GEMINI_BASE_URL: u.baseUrl
    })
  );

  const res = await router.request(
    "/v1beta/models/gemini-2.0-flash:generateContent",
    postJson({ contents: [{ parts: [{ text: "hi" }] }] })
  );

  assert.equal(res.status, 200);
  assert.equal(upstream.apiRequests.length, 1);

  const sent = upstream.apiRequests[0];
  assert.equal(sent.url, "/v1beta/models/gemini-2.0-flash:generateContent");
  assert.equal(sent.headers["x-goog-api-key"], "gemini-key");
  // Native Gemini payload is passed through untouched.
  assert.deepEqual(sent.body, { contents: [{ parts: [{ text: "hi" }] }] });
  assert.equal(res.headers.get("x-multi-ai-provider"), "gemini");
});

test("Gemini path model selects the matching configured model", async (t) => {
  const { upstream, router } = await withRig(
    t,
    () => ok(),
    (u) => ({
      GEMINI_API_KEYS: "gemini-key",
      GEMINI_MODELS: "gemini-2.0-flash,gemini-2.5-pro",
      GEMINI_BASE_URL: u.baseUrl
    })
  );

  await router.request(
    "/v1beta/models/gemini-2.5-pro:generateContent",
    postJson({ contents: [] })
  );

  assert.equal(upstream.apiRequests.length, 1);
  assert.equal(upstream.apiRequests[0].url, "/v1beta/models/gemini-2.5-pro:generateContent");
});

test("an unknown gemini path model falls back to a compatible gemini target", async (t) => {
  const { upstream, router } = await withRig(
    t,
    () => ok(),
    (u) => ({
      GEMINI_API_KEYS: "gemini-key",
      GEMINI_MODELS: "gemini-2.0-flash",
      GEMINI_BASE_URL: u.baseUrl
    })
  );

  const res = await router.request(
    "/v1beta/models/does-not-exist:generateContent",
    postJson({ contents: [] })
  );

  assert.equal(res.status, 200);
  assert.equal(upstream.apiRequests.length, 1);
  assert.equal(upstream.apiRequests[0].url, "/v1beta/models/gemini-2.0-flash:generateContent");
});

test("a chat-only provider is reached by a Responses request through the Codex bridge", async (t) => {
  const { upstream, router } = await withRig(
    t,
    () => ok(),
    (u) => ({
      GROQ_API_KEYS: "groq-key",
      GROQ_MODELS: "llama-x",
      GROQ_BASE_URL: u.baseUrl
    })
  );

  const res = await router.request("/v1/responses", postJson({ model: "llama-x", input: "hi" }));

  assert.equal(res.status, 200);
  assert.equal(upstream.apiRequests.length, 1);
  assert.equal(upstream.apiRequests[0].url, "/v1/chat/completions");
});

test("a gemini-only provider is reached by a chat request through the Chat bridge", async (t) => {
  const { upstream, router } = await withRig(
    t,
    () => ok({ candidates: [{ content: { parts: [{ text: "gem" }] }, finishReason: "STOP" }] }),
    (u) => ({
      GEMINI_API_KEYS: "gemini-key",
      GEMINI_MODELS: "gemini-2.0-flash",
      GEMINI_BASE_URL: u.baseUrl
    })
  );

  const chat = await router.request(
    "/v1/chat/completions",
    postJson({ model: "gemini-2.0-flash", messages: [{ role: "user", content: "hi" }] })
  );
  assert.equal(chat.status, 200);
  const chatBody = await chat.json();
  assert.equal(chatBody.object, "chat.completion");
  assert.equal(chatBody.choices[0].message.content, "gem");
  assert.equal(chatBody.choices[0].finish_reason, "stop");
  assert.equal(chat.headers.get("x-multi-ai-provider"), "gemini");

  assert.equal(upstream.apiRequests.length, 1);
  assert.equal(upstream.apiRequests[0].url, "/v1beta/models/gemini-2.0-flash:generateContent");
  assert.equal(upstream.apiRequests[0].headers["x-goog-api-key"], "gemini-key");

  // The same target still serves a Responses client through the Codex bridge.
  const responses = await router.request("/v1/responses", postJson({ model: "gemini-2.0-flash", input: "hi" }));
  assert.equal(responses.status, 200);
  assert.equal(upstream.apiRequests.length, 2);
  assert.equal(upstream.apiRequests[1].url, "/v1beta/models/gemini-2.0-flash:generateContent");
});

test("AgentRouter serves anthropic, chat and responses with correct upstream paths", async (t) => {
  const { upstream, router } = await withRig(
    t,
    () => ok(),
    (u) => ({
      AGENTROUTER_API_KEYS: "ar-key",
      AGENTROUTER_MODELS: "shared-model",
      AGENTROUTER_BASE_URL: u.baseUrl + "/"
    })
  );

  const cases = [
    ["/v1/messages", { model: "shared-model", messages: [] }, "/v1/messages"],
    ["/v1/chat/completions", { model: "shared-model", messages: [] }, "/v1/chat/completions"],
    ["/v1/responses", { model: "shared-model", input: "hi" }, "/v1/responses"]
  ];

  for (const [path, body, expectedUrl] of cases) {
    const res = await router.request(path, postJson(body));
    assert.equal(res.status, 200, `${path} should be routed`);
    assert.equal(upstream.apiRequests.at(-1).url, expectedUrl);
    assert.equal(upstream.apiRequests.at(-1).headers.authorization, "Bearer ar-key");
  }
});

test("requested model selects the matching target", async (t) => {
  const { upstream, router } = await withRig(
    t,
    () => ok(),
    (u) => ({
      GROQ_API_KEYS: "groq-key",
      GROQ_MODELS: "model-a,model-b",
      GROQ_BASE_URL: u.baseUrl
    })
  );

  await router.request("/v1/chat/completions", postJson({ model: "model-b", messages: [] }));

  assert.equal(upstream.apiRequests.length, 1);
  assert.equal(upstream.apiRequests[0].url, "/v1/chat/completions");
  assert.equal(upstream.apiRequests[0].body.model, "model-b");
});

// ---------------------------------------------------------------------------
// Fallback / retry
// ---------------------------------------------------------------------------

for (const status of [402, 408, 429, 500, 502, 503, 504]) {
  test(`HTTP ${status} falls back to the next target`, async (t) => {
    let n = 0;
    const { upstream, router } = await withRig(
      t,
      () => (++n === 1 ? fail(status, "boom") : ok({ recovered: true })),
      (u) => ({
        GROQ_API_KEYS: "key-0,key-1",
        GROQ_MODELS: "model-a",
        GROQ_BASE_URL: u.baseUrl
      })
    );

    const res = await router.request("/v1/chat/completions", postJson({ model: "model-a", messages: [] }));

    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { recovered: true });
    assert.equal(upstream.apiRequests.length, 2);
    assert.equal(upstream.apiRequests[0].headers.authorization, "Bearer key-0");
    assert.equal(upstream.apiRequests[1].headers.authorization, "Bearer key-1");
  });
}

for (const status of [400, 422]) {
  test(`HTTP ${status} is not retried and is returned to the client`, async (t) => {
    const { upstream, router } = await withRig(
      t,
      () => fail(status, "denied"),
      (u) => ({
        GROQ_API_KEYS: "key-0,key-1",
        GROQ_MODELS: "model-a",
        GROQ_BASE_URL: u.baseUrl
      })
    );

    const res = await router.request("/v1/chat/completions", postJson({ model: "model-a", messages: [] }));

    assert.equal(res.status, status);
    assert.equal(upstream.apiRequests.length, 1);
  });
}

test("custom RETRY_STATUS_CODES can make a status retryable", async (t) => {
  let n = 0;
  const { upstream, router } = await withRig(
    t,
    () => (++n === 1 ? fail(418, "teapot") : ok()),
    (u) => ({
      GROQ_API_KEYS: "k0,k1",
      GROQ_MODELS: "m",
      GROQ_BASE_URL: u.baseUrl,
      RETRY_STATUS_CODES: "418"
    })
  );

  const res = await router.request("/v1/chat/completions", postJson({ model: "m", messages: [] }));

  assert.equal(res.status, 200);
  assert.equal(upstream.apiRequests.length, 2);
});

test("custom RETRY_STATUS_CODES can make a status terminal", async (t) => {
  const { upstream, router } = await withRig(
    t,
    () => fail(429, "slow down"),
    (u) => ({
      GROQ_API_KEYS: "k0,k1",
      GROQ_MODELS: "m",
      GROQ_BASE_URL: u.baseUrl,
      RETRY_STATUS_CODES: "418"
    })
  );

  const res = await router.request("/v1/chat/completions", postJson({ model: "m", messages: [] }));

  assert.equal(res.status, 429);
  assert.equal(upstream.apiRequests.length, 1);
});

test("a retryable failure cools the target down for the next request", async (t) => {
  let n = 0;
  const { upstream, router } = await withRig(
    t,
    () => (++n === 1 ? fail(429, "slow down") : ok()),
    (u) => ({
      GROQ_API_KEYS: "key-0,key-1",
      GROQ_MODELS: "model-a",
      GROQ_BASE_URL: u.baseUrl
    })
  );

  await router.request("/v1/chat/completions", postJson({ model: "model-a", messages: [] }));
  assert.equal(upstream.apiRequests.length, 2);

  // Second request must skip the cooled-down key-0 entirely.
  await router.request("/v1/chat/completions", postJson({ model: "model-a", messages: [] }));

  const keysUsed = upstream.apiRequests.slice(2).map((r) => r.headers.authorization);
  assert.deepEqual(keysUsed, ["Bearer key-1"]);
});

test("all targets failing produces 502 with per-target failure detail", async (t) => {
  const { upstream, router } = await withRig(
    t,
    () => fail(503, "unavailable"),
    (u) => ({
      GROQ_API_KEYS: "k0,k1",
      GROQ_MODELS: "m",
      GROQ_BASE_URL: u.baseUrl
    })
  );

  const res = await router.request("/v1/chat/completions", postJson({ model: "m", messages: [] }));

  assert.equal(res.status, 502);
  const payload = await res.json();
  assert.equal(payload.error.failures.length, 2);
  assert.equal(upstream.apiRequests.length, 2);
});

test("upstream timeout is treated as a retryable 408 failure", async (t) => {
  const { upstream, router } = await withRig(
    t,
    () => ({ hang: true }),
    (u) => ({
      GROQ_API_KEYS: "k0,k1",
      GROQ_MODELS: "m",
      GROQ_BASE_URL: u.baseUrl,
      REQUEST_TIMEOUT_MS: "400"
    })
  );

  const res = await router.request("/v1/chat/completions", postJson({ model: "m", messages: [] }));

  assert.equal(res.status, 502);
  const payload = await res.json();
  assert.equal(payload.error.failures.length, 2);
  assert.equal(payload.error.failures[0].status, 408);
  assert.equal(payload.error.failures[0].message, "Upstream request timed out");
});

// ---------------------------------------------------------------------------
// Sticky sessions
// ---------------------------------------------------------------------------

test("a successful target becomes sticky for the session", async (t) => {
  let n = 0;
  const { upstream, router } = await withRig(
    t,
    () => (++n === 1 ? fail(429, "slow down") : ok()),
    (u) => ({
      GROQ_API_KEYS: "key-0,key-1",
      GROQ_MODELS: "m",
      GROQ_BASE_URL: u.baseUrl
    })
  );

  const first = await router.request(
    "/v1/chat/completions",
    postJson({ model: "m", messages: [] }, { "x-multi-ai-session-id": "session-abc" })
  );
  assert.equal(first.headers.get("x-multi-ai-session-id"), "session-abc");

  await router.request(
    "/v1/chat/completions",
    postJson({ model: "m", messages: [] }, { "x-multi-ai-session-id": "session-abc" })
  );

  // The sticky target (key-1) is reused with no further upstream attempt on key-0.
  const keysUsed = upstream.apiRequests.slice(2).map((r) => r.headers.authorization);
  assert.deepEqual(keysUsed, ["Bearer key-1"]);
});

test("the router issues a session id when the client omits one", async (t) => {
  const { router } = await withRig(
    t,
    () => ok(),
    (u) => ({
      GROQ_API_KEYS: "k",
      GROQ_MODELS: "m",
      GROQ_BASE_URL: u.baseUrl
    })
  );

  const res = await router.request("/v1/chat/completions", postJson({ model: "m", messages: [] }));
  const id = res.headers.get("x-multi-ai-session-id");
  assert.ok(id && id.length > 0);
});

// ---------------------------------------------------------------------------
// Authentication
// ---------------------------------------------------------------------------

test("gateway authentication is enforced when configured", async (t) => {
  const { upstream, router } = await withRig(
    t,
    () => ok(),
    (u) => ({
      GROQ_API_KEYS: "k",
      GROQ_MODELS: "m",
      GROQ_BASE_URL: u.baseUrl,
      MULTIAI_ROUTER_API_KEYS: "router-secret"
    })
  );

  const missing = await router.request("/v1/chat/completions", postJson({ model: "m", messages: [] }));
  assert.equal(missing.status, 401);

  const wrong = await router.request(
    "/v1/chat/completions",
    postJson({ model: "m", messages: [] }, { authorization: "Bearer nope" })
  );
  assert.equal(wrong.status, 401);

  const right = await router.request(
    "/v1/chat/completions",
    postJson({ model: "m", messages: [] }, { authorization: "Bearer router-secret" })
  );
  assert.equal(right.status, 200);

  assert.equal(upstream.apiRequests.length, 1);
});

test("gateway authentication is open when no router keys are configured", async (t) => {
  const { router } = await withRig(
    t,
    () => ok(),
    (u) => ({
      GROQ_API_KEYS: "k",
      GROQ_MODELS: "m",
      GROQ_BASE_URL: u.baseUrl
    })
  );

  const res = await router.request("/v1/chat/completions", postJson({ model: "m", messages: [] }));
  assert.equal(res.status, 200);
});

// ---------------------------------------------------------------------------
// Request validation / HTTP behaviour
// ---------------------------------------------------------------------------

test("malformed JSON is rejected with 400 and never reaches a provider", async (t) => {
  const { upstream, router } = await withRig(
    t,
    () => ok(),
    (u) => ({
      GROQ_API_KEYS: "k",
      GROQ_MODELS: "m",
      GROQ_BASE_URL: u.baseUrl
    })
  );

  const res = await router.request("/v1/chat/completions", postJson("{ not json"));
  assert.equal(res.status, 400);
  assert.equal(upstream.apiRequests.length, 0);
});

test("an empty body is accepted", async (t) => {
  const { upstream, router } = await withRig(
    t,
    () => ok(),
    (u) => ({
      GROQ_API_KEYS: "k",
      GROQ_MODELS: "m",
      GROQ_BASE_URL: u.baseUrl
    })
  );

  const res = await router.request("/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" }
  });
  assert.equal(res.status, 200);
  assert.equal(upstream.apiRequests.length, 1);
});

test("an oversized body is rejected with 413", async (t) => {
  const { upstream, router } = await withRig(
    t,
    () => ok(),
    (u) => ({
      GROQ_API_KEYS: "k",
      GROQ_MODELS: "m",
      GROQ_BASE_URL: u.baseUrl
    })
  );

  const res = await router.request(
    "/v1/chat/completions",
    postJson({ model: "m", messages: [{ role: "user", content: "x".repeat(11 * 1024 * 1024) }] })
  );

  assert.equal(res.status, 413);
  assert.equal(upstream.apiRequests.length, 0);
});

test("streamed upstream responses arrive intact", async (t) => {
  const chunks = [
    'data: {"delta":"Hel"}\n\n',
    'data: {"delta":"lo"}\n\n',
    "data: [DONE]\n\n"
  ];
  const { router } = await withRig(
    t,
    () => ({ status: 200, stream: chunks, headers: { "content-type": "text/event-stream" } }),
    (u) => ({
      GROQ_API_KEYS: "k",
      GROQ_MODELS: "m",
      GROQ_BASE_URL: u.baseUrl
    })
  );

  const res = await router.request("/v1/chat/completions", postJson({ model: "m", messages: [], stream: true }));

  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /text\/event-stream/);
  assert.equal(await res.text(), chunks.join(""));
});

test("a client disconnect mid-stream does not break the router", async (t) => {
  const chunks = Array.from({ length: 200 }, (_, i) => `data: ${i}\n\n`);
  const { router } = await withRig(
    t,
    (record) => record.body?.stream
      ? { status: 200, stream: chunks, delayMs: 10, headers: { "content-type": "text/event-stream" } }
      : ok(),
    (u) => ({
      GROQ_API_KEYS: "k",
      GROQ_MODELS: "m",
      GROQ_BASE_URL: u.baseUrl
    })
  );

  const controller = new AbortController();
  const res = await router.request(
    "/v1/chat/completions",
    { ...postJson({ model: "m", messages: [], stream: true }), signal: controller.signal }
  );

  const reader = res.body.getReader();
  await reader.read();      // consume one chunk...
  controller.abort();       // ...then the client goes away

  // The router must stay healthy and serve later requests.
  const after = await router.request("/v1/chat/completions", postJson({ model: "m", messages: [] }));
  assert.equal(after.status, 200);
  assert.equal((await after.json()).ok, true);
});

test("provider API keys never appear in router responses", async (t) => {
  const providerKey = "sk-super-secret-provider-key";
  const { router } = await withRig(
    t,
    () => ok({ answer: 42 }),
    (u) => ({
      GROQ_API_KEYS: providerKey,
      GROQ_MODELS: "m",
      GROQ_BASE_URL: u.baseUrl
    })
  );

  const res = await router.request("/v1/chat/completions", postJson({ model: "m", messages: [] }));
  const bodyText = await res.text();
  const headerText = [...res.headers.entries()].flat().join(" ");

  assert.ok(!bodyText.includes(providerKey), "provider key leaked into response body");
  assert.ok(!headerText.includes(providerKey), "provider key leaked into response headers");
});

test("provider API keys never appear in fallback error responses", async (t) => {
  const providerKey = "sk-super-secret-provider-key";
  const { router } = await withRig(
    t,
    () => fail(503, "unavailable"),
    (u) => ({
      GROQ_API_KEYS: providerKey,
      GROQ_MODELS: "m",
      GROQ_BASE_URL: u.baseUrl
    })
  );

  const res = await router.request("/v1/chat/completions", postJson({ model: "m", messages: [] }));
  const text = await res.text();

  assert.equal(res.status, 502);
  assert.ok(!text.includes(providerKey), "provider key leaked into error response");
});

test("the client's own authorization header is not forwarded upstream", async (t) => {
  const { upstream, router } = await withRig(
    t,
    () => ok(),
    (u) => ({
      GROQ_API_KEYS: "provider-key",
      GROQ_MODELS: "m",
      GROQ_BASE_URL: u.baseUrl,
      MULTIAI_ROUTER_API_KEYS: "router-secret"
    })
  );

  await router.request(
    "/v1/chat/completions",
    postJson({ model: "m", messages: [] }, { authorization: "Bearer router-secret" })
  );

  assert.equal(upstream.apiRequests[0].headers.authorization, "Bearer provider-key");
});

test("GET /health and GET /v1/models report configured targets", async (t) => {
  const { router } = await withRig(
    t,
    () => ok(),
    (u) => ({
      GROQ_API_KEYS: "k0,k1",
      GROQ_MODELS: "m",
      GROQ_BASE_URL: u.baseUrl
    })
  );

  const health = await (await router.request("/health")).json();
  assert.equal(health.ok, true);
  assert.equal(health.configuredTargets, 2);
  assert.deepEqual(health.retryableStatus, [401, 402, 403, 404, 408, 409, 425, 429, 500, 501, 502, 503, 504, 520, 521, 522, 523, 524, 529]);

  const models = await (await router.request("/v1/models")).json();
  assert.equal(models.object, "list");
  assert.equal(models.data.length, 2);
  assert.equal(models.data[0].id, "m");
});

test("unknown routes return 404", async (t) => {
  const { router } = await withRig(t, () => ok(), () => ({}));

  const res = await router.request("/nope", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  assert.equal(res.status, 404);
});

test("starting with no configured providers serves health but no routes", async (t) => {
  const { router } = await withRig(t, () => ok(), () => ({}));

  const health = await (await router.request("/health")).json();
  assert.equal(health.ok, true);
  assert.equal(health.configuredTargets, 0);

  const res = await router.request("/v1/chat/completions", postJson({ messages: [] }));
  assert.equal(res.status, 503);
  assert.equal((await res.json()).error.type, "no_route");
});

test("an unreachable provider (no HTTP status) falls back to the next target", async (t) => {
  const upstream = await startMockUpstream(() => ok({ recovered: true }));
  const router = await startRouter({
    // Port 1 refuses connections, so fetch rejects without any HTTP status.
    GROQ_API_KEYS: "k0",
    GROQ_MODELS: "m",
    GROQ_BASE_URL: "http://127.0.0.1:1",
    CEREBRAS_API_KEYS: "k1",
    CEREBRAS_MODELS: "m2",
    CEREBRAS_BASE_URL: upstream.baseUrl
  });
  t.after(async () => {
    await router.close();
    await upstream.close();
  });

  const res = await router.request("/v1/chat/completions", postJson({ model: "m", messages: [] }));

  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { recovered: true });
  assert.equal(upstream.apiRequests.length, 1);
});
