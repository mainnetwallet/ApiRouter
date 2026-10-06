import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { fetchUpstream, isRedirectStatus } from "../src/upstream-fetch.js";
import { startMockUpstream } from "../test-helpers/mock-upstream.js";
import { startRouter, postJson } from "../test-helpers/router-harness.js";

/**
 * The gateway contacts exactly the host the operator configured.
 *
 * `fetch` follows redirects by default, and a provider - or anyone who can
 * answer for it - could otherwise bounce the call to another host with the
 * credential headers still attached. undici strips `Authorization` on a
 * cross-origin hop but not provider-specific headers such as `x-goog-api-key`,
 * so a redirect is refused outright and surfaced to the caller as a non-2xx.
 */

test("isRedirectStatus covers exactly the 3xx range", () => {
  for (const code of [300, 301, 302, 303, 307, 308, 399]) assert.equal(isRedirectStatus(code), true, String(code));
  for (const code of [199, 200, 204, 400, 500, "302x", null, undefined, NaN]) assert.equal(isRedirectStatus(code), false, String(code));
});

test("fetchUpstream asks the resolved fetch for manual redirects", async () => {
  const calls = [];
  const fake = async (url, options) => {
    calls.push({ url, options });
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  };
  const res = await fetchUpstream("http://provider/v1/models", { method: "GET", headers: { authorization: "Bearer k" } }, fake);
  assert.equal(res.status, 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "http://provider/v1/models");
  assert.equal(calls[0].options.redirect, "manual");
  assert.equal(calls[0].options.method, "GET");
  assert.equal(calls[0].options.headers.authorization, "Bearer k");
});

test("a redirect is returned to the caller, never followed, and the credential never reaches the target", async (t) => {
  const reached = [];
  const target = http.createServer((req, res) => {
    reached.push(req.headers);
    res.writeHead(200, { "content-type": "application/json" });
    res.end('{"data":[]}');
  });
  await new Promise((resolve) => target.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => target.close(resolve)));

  const redirector = http.createServer((req, res) => {
    res.writeHead(302, { location: `http://127.0.0.1:${target.address().port}/steal` });
    res.end();
  });
  await new Promise((resolve) => redirector.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => redirector.close(resolve)));

  const res = await fetchUpstream(`http://127.0.0.1:${redirector.address().port}/v1beta/models`, {
    method: "GET",
    headers: { "x-goog-api-key": "SECRET", authorization: "Bearer SECRET" }
  });
  assert.equal(res.status, 302, "the redirect itself is the answer");
  assert.equal(isRedirectStatus(res.status), true);
  await res.body?.cancel();
  assert.equal(reached.length, 0, "the redirect target was never contacted");
});

test("a redirecting provider is skipped and the next target serves the request", async (t) => {
  const steal = await startMockUpstream(() => ({ status: 200, body: { stolen: true } }));
  const redirecting = await startMockUpstream(() => ({
    status: 302, headers: { location: "http://127.0.0.1:1/steal" }, body: ""
  }));
  const good = await startMockUpstream(() => ({
    status: 200,
    body: {
      id: "c1", object: "chat.completion", created: 0, model: "u",
      choices: [{ index: 0, message: { role: "assistant", content: "served" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
    }
  }));
  const router = await startRouter({
    GROQ_API_KEYS: "k1", GROQ_MODELS: "m", GROQ_BASE_URL: redirecting.baseUrl,
    OPENROUTER_API_KEYS: "o1", OPENROUTER_MODELS: "m", OPENROUTER_BASE_URL: good.baseUrl
  });
  t.after(async () => { await router.close(); await redirecting.close(); await good.close(); await steal.close(); });

  const res = await router.request("/v1/chat/completions", postJson({ model: "m", messages: [{ role: "user", content: "hi" }] }));
  assert.equal(res.status, 200);
  assert.equal((await res.json()).choices[0].message.content, "served");
  assert.equal(good.apiRequests.length, 1, "the redirecting provider fell through to the healthy one");
});
