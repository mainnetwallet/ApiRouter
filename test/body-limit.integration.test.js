import test from "node:test";
import assert from "node:assert/strict";

import { startRouter, postJson } from "../test-helpers/router-harness.js";
import { startUpstream, chatJsonReply } from "../test-helpers/http-upstream.js";

async function rig(t, env = {}) {
  const upstream = await startUpstream((req, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end(chatJsonReply()); });
  const router = await startRouter({ GROQ_API_KEYS: "sk-groq-test-key-1", GROQ_MODELS: "m1", GROQ_BASE_URL: `${upstream.url}/v1`, ...env });
  t.after(async () => { await router.close(); await upstream.close(); });
  return { router, upstream };
}
const big = (bytes) => JSON.stringify({ messages: [{ role: "user", content: "x".repeat(bytes) }] });

test("with no limit configured, a large body is accepted exactly as before", async (t) => {
  const { router } = await rig(t);
  const res = await router.request("/v1/chat/completions", postJson(big(3 * 1024 * 1024)));
  assert.equal(res.status, 200);
});

test("MAX_REQUEST_BODY_BYTES: a declared content-length over the limit is refused with 413 before buffering", async (t) => {
  const { router, upstream } = await rig(t, { MAX_REQUEST_BODY_BYTES: "2048" });
  const res = await router.request("/v1/chat/completions", postJson(big(10_000)));
  assert.equal(res.status, 413);
  assert.equal((await res.json()).error.type, "request_too_large");
  assert.equal(upstream.calls.length, 0, "nothing reached a provider");
});

test("MAX_REQUEST_BODY_BYTES: a chunked body (no content-length) is cut off at the limit", async (t) => {
  const { router, upstream } = await rig(t, { MAX_REQUEST_BODY_BYTES: "2048" });
  const body = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      controller.enqueue(encoder.encode('{"messages":[{"role":"user","content":"'));
      for (let i = 0; i < 8; i += 1) controller.enqueue(encoder.encode("y".repeat(1024)));
      controller.enqueue(encoder.encode('"}]}'));
      controller.close();
    }
  });
  const res = await fetch(router.baseUrl + "/v1/chat/completions", { method: "POST", headers: { "content-type": "application/json" }, body, duplex: "half" });
  assert.equal(res.status, 413);
  assert.equal(upstream.calls.length, 0);
});

test("MAX_REQUEST_BODY_BYTES: a body under the limit passes, and the limit also guards count_tokens", async (t) => {
  const { router } = await rig(t, { MAX_REQUEST_BODY_BYTES: "4096" });
  assert.equal((await router.request("/v1/chat/completions", postJson(big(500)))).status, 200);
  const res = await router.request("/v1/messages/count_tokens", postJson({ messages: [{ role: "user", content: "z".repeat(9000) }] }));
  assert.equal(res.status, 413);
});
