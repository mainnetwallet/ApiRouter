import test from "node:test";
import assert from "node:assert/strict";
import { startMockUpstream } from "../test-helpers/mock-upstream.js";
import { startRouter, postJson } from "../test-helpers/router-harness.js";

/**
 * End-to-end coverage for the Gemini *client* path (`/v1beta/models/...`).
 *
 * `test/gemini-bridge.test.js` only exercises the pure conversion helpers. The
 * bug this file exists to catch — a bridged request carrying the client's model
 * name upstream instead of the target's — is invisible at that level, because
 * a unit test supplies the model argument by hand.
 */

const chatOk = (content = "hello", extra = {}) => ({
  status: 200,
  body: {
    id: "chatcmpl-1",
    object: "chat.completion",
    created: 0,
    model: "upstream",
    choices: [{ index: 0, message: { role: "assistant", content, ...extra }, finish_reason: "stop" }],
    usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 }
  }
});

const geminiOk = (text = "native") => ({
  status: 200,
  body: {
    candidates: [{ content: { role: "model", parts: [{ text }] }, finishReason: "STOP", index: 0 }],
    usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 }
  }
});

/** Boot one mock + one router and always tear both down. */
async function withRig(t, script, envFor) {
  const upstream = await startMockUpstream(script);
  const router = await startRouter(envFor(upstream));
  t.after(async () => {
    await router.close();
    await upstream.close();
  });
  return { upstream, router };
}

const generate = (router, model, body) =>
  router.request(`/v1beta/models/${model}:generateContent`, postJson(body));

const stream = (router, model, body) =>
  router.request(`/v1beta/models/${model}:streamGenerateContent`, postJson(body));

const ask = { contents: [{ role: "user", parts: [{ text: "hi" }] }] };

// ---------------------------------------------------------------------------
// A. Native Gemini target
// ---------------------------------------------------------------------------

test("A: a native gemini target is used as-is", async (t) => {
  const { upstream, router } = await withRig(
    t,
    () => geminiOk("native-answer"),
    (u) => ({ GEMINI_API_KEYS: "gk", GEMINI_MODELS: "gemini-2.0-flash", GEMINI_BASE_URL: u.baseUrl })
  );

  const res = await generate(router, "gemini-2.0-flash", ask);

  assert.equal(res.status, 200);
  assert.equal(upstream.apiRequests.length, 1);
  assert.equal(upstream.apiRequests[0].url, "/v1beta/models/gemini-2.0-flash:generateContent");
  assert.equal(upstream.apiRequests[0].headers["x-goog-api-key"], "gk");
  assert.deepEqual(upstream.apiRequests[0].body, ask, "a native request is forwarded untouched");
  assert.equal((await res.json()).candidates[0].content.parts[0].text, "native-answer");
});

// ---------------------------------------------------------------------------
// B. Chat-only target
// ---------------------------------------------------------------------------

test("B: a gemini client reaches a chat-only provider through the bridge", async (t) => {
  const { upstream, router } = await withRig(
    t,
    () => chatOk("bridged"),
    (u) => ({ GROQ_API_KEYS: "groq-key", GROQ_MODELS: "llama-x", GROQ_BASE_URL: u.baseUrl })
  );

  const res = await generate(router, "gemini-2.0-flash", ask);

  assert.equal(res.status, 200, "a chat-only configuration must serve a Gemini client");
  assert.equal(upstream.apiRequests.length, 1);

  const sent = upstream.apiRequests[0];
  assert.equal(sent.url, "/v1/chat/completions");
  assert.equal(sent.headers.authorization, "Bearer groq-key");
  assert.equal(sent.body.messages.at(-1).content, "hi");
  // The upstream only knows the model its provider was configured with. Sending
  // the client's model name here makes every fallback a guaranteed 404.
  assert.equal(sent.body.model, "llama-x");
  assert.equal(sent.body.stream, undefined);

  const out = await res.json();
  assert.equal(out.candidates[0].content.parts[0].text, "bridged");
  assert.equal(out.candidates[0].finishReason, "STOP");
  assert.equal(out.usageMetadata.totalTokenCount, 7);
  assert.equal(res.headers.get("x-multi-ai-provider"), "groq");
});

// ---------------------------------------------------------------------------
// C. Fallback on a retryable failure
// ---------------------------------------------------------------------------

test("C: a retryable failure falls back to another chat provider and still answers", async (t) => {
  const primary = await startMockUpstream(() => ({ status: 429, body: { error: { message: "slow down" } } }));
  const secondary = await startMockUpstream(() => chatOk("from-secondary"));
  const router = await startRouter({
    GROQ_API_KEYS: "k1",
    GROQ_MODELS: "primary-model",
    GROQ_BASE_URL: primary.baseUrl,
    OPENROUTER_API_KEYS: "k2",
    OPENROUTER_MODELS: "secondary-model",
    OPENROUTER_BASE_URL: secondary.baseUrl
  });
  t.after(async () => {
    await router.close();
    await primary.close();
    await secondary.close();
  });

  const res = await generate(router, "gemini-2.0-flash", ask);

  assert.equal(res.status, 200);
  assert.equal(primary.apiRequests.length, 1);
  assert.equal(secondary.apiRequests.length, 1);
  assert.equal(secondary.apiRequests[0].body.model, "secondary-model");
  assert.equal((await res.json()).candidates[0].content.parts[0].text, "from-secondary");
});

// ---------------------------------------------------------------------------
// D/E. Exact model preference
// ---------------------------------------------------------------------------

test("D: an exact model match on a bridged target is used before a different model", async (t) => {
  const exact = await startMockUpstream(() => chatOk("exact"));
  const other = await startMockUpstream(() => chatOk("other"));
  const router = await startRouter({
    GROQ_API_KEYS: "k1",
    GROQ_MODELS: "wanted-model",
    GROQ_BASE_URL: exact.baseUrl,
    OPENROUTER_API_KEYS: "k2",
    OPENROUTER_MODELS: "other-model",
    OPENROUTER_BASE_URL: other.baseUrl
  });
  t.after(async () => {
    await router.close();
    await exact.close();
    await other.close();
  });

  await generate(router, "wanted-model", ask);

  assert.equal(exact.apiRequests.length, 1);
  assert.equal(other.apiRequests.length, 0);
});

test("E: an unconfigured model widens to a compatible chat target", async (t) => {
  const { upstream, router } = await withRig(
    t,
    () => chatOk("widened"),
    (u) => ({ GROQ_API_KEYS: "k", GROQ_MODELS: "configured-model", GROQ_BASE_URL: u.baseUrl })
  );

  const res = await generate(router, "not-configured-anywhere", ask);

  assert.equal(res.status, 200);
  assert.equal(upstream.apiRequests[0].body.model, "configured-model");
});

// ---------------------------------------------------------------------------
// Request translation
// ---------------------------------------------------------------------------

test("text mixed with an inline image becomes valid chat content parts", async (t) => {
  const { upstream, router } = await withRig(
    t,
    () => chatOk(),
    (u) => ({ GROQ_API_KEYS: "k", GROQ_MODELS: "m", GROQ_BASE_URL: u.baseUrl })
  );

  await generate(router, "m", {
    contents: [{
      role: "user",
      parts: [{ text: "what is this" }, { inlineData: { mimeType: "image/png", data: "AAAA" } }]
    }]
  });

  const content = upstream.apiRequests[0].body.messages.at(-1).content;
  assert.ok(Array.isArray(content), "a mixed turn must use the content-parts form");
  for (const part of content) {
    assert.equal(typeof part, "object", "every content part must be an object, not a bare string");
    assert.ok(part.type === "text" || part.type === "image_url");
  }
  assert.equal(content[0].text, "what is this");
  assert.match(content[1].image_url.url, /^data:image\/png;base64,/);
});

test("tool results are not preceded by an empty user turn", async (t) => {
  const { upstream, router } = await withRig(
    t,
    () => chatOk(),
    (u) => ({ GROQ_API_KEYS: "k", GROQ_MODELS: "m", GROQ_BASE_URL: u.baseUrl })
  );

  await generate(router, "m", {
    contents: [
      { role: "user", parts: [{ text: "look it up" }] },
      { role: "model", parts: [{ functionCall: { id: "call-1", name: "lookup", args: { q: "x" } } }] },
      { role: "user", parts: [{ functionResponse: { id: "call-1", name: "lookup", response: { value: 1 } } }] }
    ]
  });

  const messages = upstream.apiRequests[0].body.messages;
  assert.deepEqual(messages.map((m) => m.role), ["user", "assistant", "tool"]);
  // A tool result must answer the assistant turn directly. An empty user
  // message in between is rejected by OpenAI-compatible providers.
  assert.equal(messages[1].tool_calls[0].id, "call-1");
  assert.equal(messages[2].tool_call_id, "call-1");
  assert.deepEqual(JSON.parse(messages[2].content), { value: 1 });
});

test("a tool call comes back to the client in Gemini shape", async (t) => {
  const { router } = await withRig(
    t,
    () => chatOk(null, {
      tool_calls: [{ id: "call-9", type: "function", function: { name: "lookup", arguments: "{\"q\":\"x\"}" } }]
    }),
    (u) => ({ GROQ_API_KEYS: "k", GROQ_MODELS: "m", GROQ_BASE_URL: u.baseUrl })
  );

  const res = await generate(router, "m", ask);
  const body = await res.json();
  const part = body.candidates[0].content.parts[0];

  assert.equal(part.functionCall.name, "lookup");
  assert.deepEqual(part.functionCall.args, { q: "x" });
  assert.equal(part.functionCall.id, "call-9");
  assert.equal(body.candidates[0].finishReason, "STOP");
});

// ---------------------------------------------------------------------------
// Streaming
// ---------------------------------------------------------------------------

test("a Gemini client can stream through a chat provider", async (t) => {
  const { upstream, router } = await withRig(
    t,
    () => ({
      status: 200,
      stream: [
        'data: {"choices":[{"delta":{"role":"assistant","content":"hel"},"finish_reason":null}]}\n\n',
        'data: {"choices":[{"delta":{"content":"lo"},"finish_reason":null}]}\n\n',
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
        "data: [DONE]\n\n"
      ]
    }),
    (u) => ({ GROQ_API_KEYS: "k", GROQ_MODELS: "m", GROQ_BASE_URL: u.baseUrl })
  );

  const res = await stream(router, "gemini-2.0-flash", { ...ask, stream: true });

  assert.equal(res.status, 200, "the Gemini streaming method must be routed, not 404");
  assert.match(res.headers.get("content-type") || "", /text\/event-stream/);
  assert.equal(upstream.apiRequests[0].body.stream, true, "the upstream must be asked to stream");

  const text = await res.text();
  const payloads = text.split("\n\n").filter((c) => c.startsWith("data:")).map((c) => JSON.parse(c.slice(5)));
  const chunks = payloads.flatMap((p) => p.candidates ?? []);

  assert.equal(chunks.map((c) => c.content.parts[0]?.text).join(""), "hello");
  assert.equal(chunks.at(-1).finishReason, "STOP");
});

test("a native gemini target streams its own SSE straight through", async (t) => {
  const { upstream, router } = await withRig(
    t,
    () => ({
      status: 200,
      headers: { "content-type": "text/event-stream" },
      stream: [
        'data: {"candidates":[{"content":{"role":"model","parts":[{"text":"na"}]}}]}\n\n',
        'data: {"candidates":[{"content":{"role":"model","parts":[{"text":"tive"}]},"finishReason":"STOP"}]}\n\n'
      ]
    }),
    (u) => ({ GEMINI_API_KEYS: "gk", GEMINI_MODELS: "gemini-2.0-flash", GEMINI_BASE_URL: u.baseUrl })
  );

  const res = await stream(router, "gemini-2.0-flash", ask);

  assert.equal(res.status, 200);
  assert.equal(
    upstream.apiRequests[0].url,
    "/v1beta/models/gemini-2.0-flash:streamGenerateContent?alt=sse"
  );
  assert.equal(upstream.apiRequests[0].headers["x-goog-api-key"], "gk");

  const text = await res.text();
  const chunks = text
    .split("\n\n")
    .filter((c) => c.startsWith("data:"))
    .map((c) => JSON.parse(c.slice(5)));
  assert.equal(chunks.length, 2);
  assert.equal(chunks.map((c) => c.candidates[0].content.parts[0].text).join(""), "native");
});

test("a streamed tool call survives partial argument fragments", async (t) => {
  const { router } = await withRig(
    t,
    () => ({
      status: 200,
      stream: [
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-7","function":{"name":"lookup","arguments":"{\\"q\\":"}}]},"finish_reason":null}]}\n\n',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"x\\"}"}}]},"finish_reason":null}]}\n\n',
        'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n',
        "data: [DONE]\n\n"
      ]
    }),
    (u) => ({ GROQ_API_KEYS: "k", GROQ_MODELS: "m", GROQ_BASE_URL: u.baseUrl })
  );

  const res = await stream(router, "gemini-2.0-flash", { ...ask, stream: true });
  const text = await res.text();
  const parts = text
    .split("\n\n")
    .filter((c) => c.startsWith("data:"))
    .flatMap((c) => JSON.parse(c.slice(5)).candidates ?? [])
    .flatMap((c) => c.content.parts ?? []);

  const calls = parts.filter((p) => p.functionCall);
  assert.equal(calls.length, 1, "fragments must be coalesced into one function call");
  assert.equal(calls[0].functionCall.id, "call-7");
  assert.equal(calls[0].functionCall.name, "lookup");
  assert.deepEqual(calls[0].functionCall.args, { q: "x" });
});

// ---------------------------------------------------------------------------
// Routing preview
// ---------------------------------------------------------------------------

test("the routing preview serves gemini when only a chat target is configured", async (t) => {
  const { router } = await withRig(
    t,
    () => chatOk(),
    (u) => ({ GROQ_API_KEYS: "k", GROQ_MODELS: "m", GROQ_BASE_URL: u.baseUrl })
  );

  const res = await router.request("/api/router/preview?protocol=gemini&model=m");
  assert.equal(res.status, 200);
  const body = await res.json();

  assert.ok(body.protocols.includes("gemini"));
  assert.equal(body.counts.compatible, 1);
  assert.ok(body.selected, "the preview must show the target the proxy would really use");
  assert.equal(body.selected.provider, "groq");
});

// ---------------------------------------------------------------------------
// Exact-model-first ordering, over HTTP
//
// `selectGeminiTargets` puts the requested model first, but the ordering is
// only real if the proxy keeps it: health ranking and the session's sticky
// target both used to be able to promote a *different* model ahead of an exact
// match that was available. These two tests drive the live HTTP path.
// ---------------------------------------------------------------------------

test("an exact model match is served before the session's sticky fallback", async (t) => {
  const exact = await startMockUpstream(() => chatOk("from-exact"));
  const other = await startMockUpstream(() => chatOk("from-other"));
  const router = await startRouter({
    GROQ_API_KEYS: "k1",
    GROQ_MODELS: "wanted-model",
    GROQ_BASE_URL: exact.baseUrl,
    OPENROUTER_API_KEYS: "k2",
    OPENROUTER_MODELS: "other-model",
    OPENROUTER_BASE_URL: other.baseUrl
  });
  t.after(async () => {
    await router.close();
    await exact.close();
    await other.close();
  });

  const session = { "x-multi-ai-session-id": "sticky-session" };

  // 1. Ask for a model only the fallback serves, so the session's sticky
  //    target becomes the other-model provider.
  const first = await router.request("/v1beta/models/other-model:generateContent", postJson(ask, session));
  assert.equal(first.status, 200);
  assert.equal(other.apiRequests.length, 1);

  // 2. Now ask for the exact model. The sticky target is still the fallback,
  //    but an available exact match outranks it.
  const second = await router.request("/v1beta/models/wanted-model:generateContent", postJson(ask, session));

  assert.equal(second.status, 200);
  assert.equal((await second.json()).candidates[0].content.parts[0].text, "from-exact");
  assert.equal(exact.apiRequests.length, 1, "the exact model must be tried");
  assert.equal(other.apiRequests.length, 1, "the sticky fallback must not be reached while an exact match is available");
});

test("a failing exact target is followed by the different-model fallback tier", async (t) => {
  const exact = await startMockUpstream(() => ({ status: 500, body: { error: { message: "boom" } } }));
  const fallback = await startMockUpstream(() => chatOk("from-fallback"));
  const router = await startRouter({
    GROQ_API_KEYS: "k1",
    GROQ_MODELS: "wanted-model",
    GROQ_BASE_URL: exact.baseUrl,
    OPENROUTER_API_KEYS: "k2",
    OPENROUTER_MODELS: "other-model",
    OPENROUTER_BASE_URL: fallback.baseUrl
  });
  t.after(async () => {
    await router.close();
    await exact.close();
    await fallback.close();
  });

  const res = await router.request("/v1beta/models/wanted-model:generateContent", postJson(ask));

  assert.equal(res.status, 200);
  assert.equal((await res.json()).candidates[0].content.parts[0].text, "from-fallback");
  // The exact target went first and was exhausted; only then was the
  // different model reached.
  assert.equal(exact.apiRequests.length, 1);
  assert.equal(fallback.apiRequests.length, 1);
  assert.equal(fallback.apiRequests[0].body.model, "other-model");
});

test("the routing preview predicts the order the proxy walks under sticky pressure", async (t) => {
  const exact = await startMockUpstream(() => chatOk("from-exact"));
  const other = await startMockUpstream(() => chatOk("from-other"));
  const router = await startRouter({
    GROQ_API_KEYS: "k1",
    GROQ_MODELS: "wanted-model",
    GROQ_BASE_URL: exact.baseUrl,
    OPENROUTER_API_KEYS: "k2",
    OPENROUTER_MODELS: "other-model",
    OPENROUTER_BASE_URL: other.baseUrl
  });
  t.after(async () => {
    await router.close();
    await exact.close();
    await other.close();
  });

  // Make the other-model target the sticky one, exactly as a real session would.
  await router.request(
    "/v1beta/models/other-model:generateContent",
    postJson(ask, { "x-multi-ai-session-id": "preview-session" })
  );

  const res = await router.request(
    "/api/router/preview?protocol=gemini&model=wanted-model&session=openrouter:other-model:key-0"
  );
  assert.equal(res.status, 200);
  const body = await res.json();

  // What the preview shows ...
  assert.equal(body.selected.provider, "groq");
  assert.equal(body.fallbackOrder[0].provider, "groq", "the exact match must lead the previewed order");
  assert.equal(body.fallbackOrder.at(-1).provider, "openrouter");

  // ... is what the proxy does.
  const served = await router.request(
    "/v1beta/models/wanted-model:generateContent",
    postJson(ask, { "x-multi-ai-session-id": "preview-session" })
  );
  assert.equal(served.status, 200);
  assert.equal((await served.json()).candidates[0].content.parts[0].text, "from-exact");
  assert.equal(exact.apiRequests.length, 1);
  assert.equal(other.apiRequests.length, 1, "the sticky target must not receive a second request");
});

// ---------------------------------------------------------------------------
// Tool-config hardening, over HTTP
//
// The unit tests in test/gemini-bridge.test.js pin the conversion; these prove
// the contradictory request never leaves the router.
// ---------------------------------------------------------------------------

test("a tool choice that would need no tools is never sent upstream", async (t) => {
  const { upstream, router } = await withRig(
    t,
    () => chatOk(),
    (u) => ({ GROQ_API_KEYS: "k", GROQ_MODELS: "m", GROQ_BASE_URL: u.baseUrl })
  );

  await generate(router, "m", {
    contents: [{ role: "user", parts: [{ text: "hi" }] }],
    toolConfig: { functionCallingConfig: { mode: "ANY", allowedFunctionNames: ["lookup"] } }
  });

  const sent = upstream.apiRequests[0].body;
  assert.equal(sent.tools, undefined, "no declarations were supplied, so none are forwarded");
  assert.equal(sent.tool_choice, undefined, "`required` with no tools is a contradictory request");
});

test("an undeclared allowed function never becomes an exact tool choice upstream", async (t) => {
  const { upstream, router } = await withRig(
    t,
    () => chatOk(),
    (u) => ({ GROQ_API_KEYS: "k", GROQ_MODELS: "m", GROQ_BASE_URL: u.baseUrl })
  );

  await generate(router, "m", {
    contents: [{ role: "user", parts: [{ text: "hi" }] }],
    tools: [{ functionDeclarations: [{ name: "lookup", description: "l", parameters: { type: "object", properties: {} } }] }],
    toolConfig: { functionCallingConfig: { mode: "ANY", allowedFunctionNames: ["ghost"] } }
  });

  const sent = upstream.apiRequests[0].body;
  assert.equal(sent.tool_choice, "required");
  assert.deepEqual(sent.tools.map((tool) => tool.function.name), ["lookup"]);
  assert.ok(
    sent.tools.every((tool) => tool.function.name !== "ghost"),
    "the request must never mention a function it does not declare"
  );
});
