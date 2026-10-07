import test from "node:test";
import assert from "node:assert/strict";

import { startRouter, postJson } from "../test-helpers/router-harness.js";
import { startUpstream, chatJsonReply, sseChunk } from "../test-helpers/http-upstream.js";

// groq is first in provider order (A); openrouter is the fallback (B).
async function rig(t, { a, b, env = {} }) {
  const A = await startUpstream(a);
  const B = await startUpstream(b);
  const router = await startRouter({
    REQUEST_TIMEOUT_MS: "2000",
    GROQ_API_KEYS: "sk-groq-test-key-1", GROQ_MODELS: "mA", GROQ_BASE_URL: `${A.url}/v1`,
    OPENROUTER_API_KEYS: "sk-or-test-key-1", OPENROUTER_MODELS: "mB", OPENROUTER_BASE_URL: `${B.url}/v1`,
    ...env
  });
  t.after(async () => { await router.close(); await A.close(); await B.close(); });
  return { router, A, B };
}

const okStream = (req, res) => {
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.write(sseChunk({ content: "ok" }));
  res.write(sseChunk({}, "stop"));
  res.end("data: [DONE]\n\n");
};
const brokenStream = (req, res) => {
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.write(sseChunk({ content: "par" }));
  setTimeout(() => res.socket.destroy(), 60);
};
const okJson = (req, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end(chatJsonReply("from-b")); };

async function drain(response) {
  let text = "";
  let error = null;
  try {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    for (;;) { const { done, value } = await reader.read(); if (done) break; text += decoder.decode(value); }
  } catch (e) { error = e.cause?.code || e.message; }
  return { text, error };
}
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function logEntry(router, id) {
  for (let i = 0; i < 40; i += 1) {
    const entry = (await (await router.request("/api/requests?limit=20")).json()).entries.find((e) => e.requestId === id);
    if (entry) return entry;
    await wait(50);
  }
  throw new Error("request was never recorded");
}
const healthOf = async (router, provider) => (await (await router.request("/api/health")).json()).targets.find((x) => x.provider === provider);
const chat = { model: "mA", stream: true, messages: [{ role: "user", content: "hi" }] };

test("a stream that completes cleanly is the success: request, attempt, health and sticky all agree", async (t) => {
  const { router, B } = await rig(t, { a: okStream, b: okJson });
  const res = await router.request("/v1/chat/completions", postJson(chat, { "x-multi-ai-session-id": "s-ok" }));
  const { text, error } = await drain(res);
  assert.equal(error, null);
  assert.match(text, /\[DONE\]/);
  const entry = await logEntry(router, res.headers.get("x-multi-ai-request-id"));
  assert.equal(entry.outcome, "success");
  assert.deepEqual(entry.attempts.map((a) => [a.provider, a.ok]), [["groq", true]]);
  const health = await healthOf(router, "groq");
  assert.equal(health.status, "healthy");
  assert.equal(health.successes, 1);
  // sticky: the next request of the session goes back to groq
  const again = await router.request("/v1/chat/completions", postJson(chat, { "x-multi-ai-session-id": "s-ok" }));
  await drain(again);
  assert.equal(again.headers.get("x-multi-ai-provider"), "groq");
  assert.equal(B.calls.length, 0);
});

test("a stream that breaks after the headers is a FAILURE everywhere, with no fallback and no sticky", async (t) => {
  const { router, B } = await rig(t, { a: brokenStream, b: okJson });
  const res = await router.request("/v1/chat/completions", postJson(chat, { "x-multi-ai-session-id": "s-broken" }));
  assert.equal(res.status, 200, "the status line was already sent");
  const { text } = await drain(res);
  assert.match(text, /par/);
  assert.doesNotMatch(text, /\[DONE\]/, "the client does not get a normal end");

  const entry = await logEntry(router, res.headers.get("x-multi-ai-request-id"));
  assert.equal(entry.outcome, "failed");
  assert.equal(entry.errorType, "stream_error");
  assert.deepEqual(entry.attempts.map((a) => [a.provider, a.ok]), [["groq", false]]);
  assert.match(entry.attempts[0].errorMessage, /stream ended before it completed/i);

  const health = await healthOf(router, "groq");
  assert.equal(health.successes, 0, "a broken stream is not a health success");
  assert.equal(health.status, "cooldown", "the target is cooling down briefly");
  assert.equal(B.calls.length, 0, "no retry after headers were sent");

  // sticky was not saved, and groq is cooling down: the next request goes to openrouter
  const next = await router.request("/v1/chat/completions", postJson({ ...chat, stream: false }, { "x-multi-ai-session-id": "s-broken" }));
  assert.equal(next.status, 200);
  assert.equal(next.headers.get("x-multi-ai-provider"), "openrouter");
});

test("a stream that broke clears the sticky target it was served from", async (t) => {
  let calls = 0;
  const { router } = await rig(t, { a: (req, res) => { calls += 1; return calls === 1 ? okStream(req, res) : brokenStream(req, res); }, b: okJson });
  const first = await router.request("/v1/chat/completions", postJson(chat, { "x-multi-ai-session-id": "s-clear" }));
  await drain(first);
  assert.equal(first.headers.get("x-multi-ai-provider"), "groq");
  const second = await router.request("/v1/chat/completions", postJson(chat, { "x-multi-ai-session-id": "s-clear" }));
  await drain(second);                              // sticky -> groq, which now breaks mid-stream
  await logEntry(router, second.headers.get("x-multi-ai-request-id"));
  await wait(100);
  const third = await router.request("/v1/chat/completions", postJson({ ...chat, stream: false }, { "x-multi-ai-session-id": "s-clear" }));
  assert.equal(third.headers.get("x-multi-ai-provider"), "openrouter", "no longer sticky to the target whose stream broke");
});

test("a translated stream (Anthropic client) that breaks reports an error event and a failed request", async (t) => {
  const { router, B } = await rig(t, { a: brokenStream, b: okJson });
  const res = await router.request("/v1/messages", postJson({ model: "mA", max_tokens: 20, stream: true, messages: [{ role: "user", content: "hi" }] }));
  const { text } = await drain(res);
  assert.match(text, /event: error/);
  assert.doesNotMatch(text, /message_stop/);
  const entry = await logEntry(router, res.headers.get("x-multi-ai-request-id"));
  assert.equal(entry.outcome, "failed");
  assert.equal(entry.errorType, "stream_error");
  assert.equal(B.calls.length, 0);
});

test("a Responses client (translated stream) whose upstream breaks is also booked as failed", async (t) => {
  // OpenAI Responses client -> chat upstream: the bridge emits response.failed, and the request is still booked failed.
  const { router } = await rig(t, { a: brokenStream, b: okJson });
  const res = await router.request("/v1/responses", postJson({ model: "mA", stream: true, input: "hi" }));
  const { text } = await drain(res);
  assert.match(text, /response\.failed|error/);
  const entry = await logEntry(router, res.headers.get("x-multi-ai-request-id"));
  assert.equal(entry.outcome, "failed");
});

test("a client that disconnects mid-stream is neither a success nor the provider's fault", async (t) => {
  const slow = (req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(sseChunk({ content: "a" }));
    const timer = setInterval(() => res.write(sseChunk({ content: "b" })), 30);
    res.on("close", () => clearInterval(timer));
  };
  const { router, B } = await rig(t, { a: slow, b: okJson });
  const controller = new AbortController();
  const res = await router.request("/v1/chat/completions", { ...postJson(chat, { "x-multi-ai-session-id": "s-abort" }), signal: controller.signal });
  const requestId = res.headers.get("x-multi-ai-request-id");
  const reader = res.body.getReader();
  await reader.read();
  controller.abort();
  await reader.read().catch(() => {});
  const entry = await logEntry(router, requestId);
  assert.equal(entry.outcome, "failed");
  assert.equal(entry.errorType, "client_aborted");
  const health = await healthOf(router, "groq");
  assert.equal(health.successes, 0);
  assert.equal(health.failures, 0, "the provider is not blamed");
  assert.equal(B.calls.length, 0);
});

test("a client that disconnects BEFORE the answer stops the walk: the fallback provider is never called", async (t) => {
  const { router, A, B } = await rig(t, { a: () => { /* never answers */ }, b: okJson });
  const controller = new AbortController();
  const pending = router.request("/v1/chat/completions", { ...postJson({ ...chat, stream: false }), signal: controller.signal }).catch(() => "aborted");
  await wait(250);
  assert.equal(A.calls.length, 1, "the first provider was called");
  controller.abort();
  await pending;
  await wait(2600);                                   // longer than REQUEST_TIMEOUT_MS: the old walk would now try B
  assert.equal(B.calls.length, 0, "the next provider was never called for a client that left");
  const entries = (await (await router.request("/api/requests?limit=5")).json()).entries;
  assert.equal(entries[0].errorType, "client_aborted");
  const health = await healthOf(router, "groq");
  assert.equal(health.failures, 0, "an abandoned request does not cool the provider down");
});

test("a translated non-stream body that cannot be read still falls back, because it is read inside the attempt", async (t) => {
  const truncated = (req, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end("{\"choices\":[{\"message\":"); };
  const { router, B } = await rig(t, { a: truncated, b: okJson });
  const res = await router.request("/v1/messages", postJson({ model: "mA", max_tokens: 20, messages: [{ role: "user", content: "hi" }] }));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("x-multi-ai-provider"), "openrouter");
  assert.equal((await res.json()).content[0].text, "from-b");
  assert.equal(B.calls.length, 1);
  const entry = await logEntry(router, res.headers.get("x-multi-ai-request-id"));
  assert.deepEqual(entry.attempts.map((a) => [a.provider, a.ok]), [["groq", false], ["openrouter", true]]);
  const health = await healthOf(router, "groq");
  assert.equal(health.successes, 0, "no success was booked for the body that never arrived");
});

test("an unbuffered native non-stream body is also settled at its end", async (t) => {
  // content-length is absent (chunked), so it is streamed through rather than inspected.
  const chunkedJson = (req, res) => { res.writeHead(200, { "content-type": "application/json" }); res.write(chatJsonReply().slice(0, 20)); setTimeout(() => res.socket.destroy(), 40); };
  const { router } = await rig(t, { a: chunkedJson, b: okJson });
  const res = await router.request("/v1/chat/completions", postJson({ ...chat, stream: false }));
  await drain(res);
  const entry = await logEntry(router, res.headers.get("x-multi-ai-request-id"));
  assert.equal(entry.outcome, "failed");
  assert.equal((await healthOf(router, "groq")).successes, 0);
});

test("a provider redirect is not followed (and not trusted): it counts as a failure and the walk continues", async (t) => {
  const trap = await startUpstream((req, res) => { res.writeHead(200); res.end("{}"); });
  t.after(() => trap.close());
  const redirect = (req, res) => { res.writeHead(302, { location: `${trap.url}/steal` }); res.end(); };
  const { router, B } = await rig(t, { a: redirect, b: okJson });
  const res = await router.request("/v1/chat/completions", postJson({ ...chat, stream: false }));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("x-multi-ai-provider"), "openrouter");
  assert.equal(trap.calls.length, 0, "the redirect target was never contacted");
  assert.equal(B.calls.length, 1);
});

test("an upstream 200 that is a clean, complete stream after a slow start is still a success", async (t) => {
  const slowStart = (req, res) => { setTimeout(() => okStream(req, res), 150); };
  const { router } = await rig(t, { a: slowStart, b: okJson });
  const res = await router.request("/v1/chat/completions", postJson(chat));
  await drain(res);
  const entry = await logEntry(router, res.headers.get("x-multi-ai-request-id"));
  assert.equal(entry.outcome, "success");
  assert.ok(entry.attempts[0].latencyMs >= 100, "the attempt covers the whole stream");
});
