import test from "node:test";
import assert from "node:assert/strict";
import { startMockUpstream } from "../test-helpers/mock-upstream.js";
import { startRouter, postJson } from "../test-helpers/router-harness.js";
import { validateRequestShape } from "../src/request-validation.js";

// A request that violates the API shape must fail locally with a 400 and must
// never reach routing: the mock upstream records every non-probe call, and the
// count must stay at zero.

const ok = () => ({
  status: 200,
  body: {
    id: "c1", object: "chat.completion", created: 0, model: "upstream",
    choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
  }
});

async function boot(t) {
  const upstream = await startMockUpstream(() => ok());
  const router = await startRouter({ GROQ_API_KEYS: "key-for-validation-1", GROQ_MODELS: "m", GROQ_BASE_URL: upstream.baseUrl });
  t.after(async () => { await router.close(); await upstream.close(); });
  // Health probes are GETs; only real proxied calls count.
  const upstreamCalls = () => upstream.requests.filter((r) => r.method === "POST").length;
  return { router, upstreamCalls };
}

const GEMINI = "/v1beta/models/m:generateContent";
const MALFORMED = [
  ["anthropic", "/v1/messages", { model: "m", max_tokens: 8, messages: 5 }],
  ["anthropic", "/v1/messages", { model: "m", max_tokens: 8, messages: null }],
  ["anthropic", "/v1/messages", { model: "m", max_tokens: 8, messages: "invalid" }],
  ["anthropic", "/v1/messages", { model: "m", max_tokens: 8, messages: [5] }],
  ["openai-chat", "/v1/chat/completions", { model: "m", messages: 5 }],
  ["openai-chat", "/v1/chat/completions", { model: "m", messages: null }],
  ["openai-chat", "/v1/chat/completions", { model: "m", messages: "invalid" }],
  ["openai-chat", "/v1/chat/completions", { model: "m", messages: { role: "user", content: "x" } }],
  ["openai-chat", "/v1/chat/completions", { model: "m", messages: [null] }],
  ["openai-responses", "/v1/responses", { model: "m", input: 5 }],
  ["openai-responses", "/v1/responses", { model: "m", input: null }],
  ["openai-responses", "/v1/responses", { model: "m", input: { type: "message" } }],
  ["openai-responses", "/v1/responses", { model: "m", input: ["text"] }],
  ["gemini", GEMINI, { contents: 5 }],
  ["gemini", GEMINI, { contents: "invalid" }],
  ["gemini", GEMINI, { contents: null }],
  ["gemini", GEMINI, { contents: [1] }],
  ["gemini", GEMINI, { contents: [{ role: "user", parts: "text" }] }],
  ["gemini", "/v1beta/models/m:streamGenerateContent", { contents: 5 }]
];

test("malformed request shapes return 400 and never reach an upstream", async (t) => {
  const { router, upstreamCalls } = await boot(t);

  for (const [protocol, path, body] of MALFORMED) {
    const label = `${protocol} ${JSON.stringify(body)}`;
    const res = await router.request(path, postJson(body));
    const json = await res.json();
    assert.equal(res.status, 400, `${label} -> ${res.status} ${JSON.stringify(json)}`);
    assert.equal(json.error.type, "invalid_request_error", label);
    assert.notEqual(json.error.type, "upstream_error", label);
    assert.ok(!/All routing targets failed/.test(json.error.message), label);
    assert.equal(upstreamCalls(), 0, `${label} reached the upstream`);
  }
});

test("count_tokens rejects a malformed messages field without routing", async (t) => {
  const { router, upstreamCalls } = await boot(t);
  for (const messages of [5, null, "invalid"]) {
    const res = await router.request("/v1/messages/count_tokens", postJson({ model: "m", messages }));
    assert.equal(res.status, 400, JSON.stringify(messages));
  }
  assert.equal(upstreamCalls(), 0);
});

test("a malformed request is logged as a local 400 with no upstream attempts", async (t) => {
  const { router } = await boot(t);
  await router.request("/v1/chat/completions", postJson({ model: "m", messages: 5 }));
  const log = await (await router.request("/api/requests")).json();
  const entry = log.entries[0];
  assert.equal(entry.httpStatus, 400);
  assert.equal(entry.outcome, "failed");
  assert.equal(entry.errorType, "invalid_request_error");
  assert.equal(entry.attemptCount, 0);
});

test("valid requests are unaffected (control cases)", async (t) => {
  const { router, upstreamCalls } = await boot(t);
  const cases = [
    ["/v1/chat/completions", { model: "m", messages: [{ role: "user", content: "hi" }] }],
    ["/v1/chat/completions", { model: "m", messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] }],
    ["/v1/chat/completions", { model: "m", messages: [{ role: "assistant", content: null, tool_calls: [{ id: "t", type: "function", function: { name: "f", arguments: "{}" } }] }, { role: "tool", tool_call_id: "t", content: "r" }, { role: "user", content: "go" }] }],
    ["/v1/messages", { model: "m", max_tokens: 8, messages: [{ role: "user", content: "hi" }] }],
    ["/v1/responses", { model: "m", input: "hi" }],
    ["/v1/responses", { model: "m", input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }] }],
    [GEMINI, { contents: [{ role: "user", parts: [{ text: "hi" }] }] }],
    [GEMINI, { contents: { role: "user", parts: [{ text: "hi" }] } }]
  ];
  for (const [path, body] of cases) {
    const res = await router.request(path, postJson(body));
    assert.equal(res.status, 200, `${path} ${JSON.stringify(body)} -> ${res.status} ${await res.text()}`);
  }
  assert.equal(upstreamCalls(), cases.length);

  // An empty object is an existing contract (see robustness tests) and still routes.
  const empty = await router.request("/v1/chat/completions", postJson({}));
  assert.notEqual(empty.status, 400);
});

test("validateRequestShape: unit coverage of accepted and rejected shapes", () => {
  assert.equal(validateRequestShape("openai-chat", { messages: [] }), null);
  assert.equal(validateRequestShape("openai-chat", {}), null);
  assert.equal(validateRequestShape("openai-responses", { input: "hi" }), null);
  assert.equal(validateRequestShape("gemini", { contents: [] }), null);
  assert.equal(validateRequestShape("gemini", { contents: { parts: [] } }), null);
  assert.match(validateRequestShape("anthropic", { messages: 5 }), /"messages" must be an array/);
  assert.match(validateRequestShape("openai-responses", { input: 5 }), /"input"/);
  assert.match(validateRequestShape("gemini", { contents: 5 }), /"contents"/);
  assert.ok(validateRequestShape("anthropic", null));
  // Messages never echo client-controlled values.
  assert.ok(!String(validateRequestShape("openai-chat", { messages: "secret-value-xyz" })).includes("secret-value-xyz"));
});
