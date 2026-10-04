import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { fileURLToPath } from "node:url";
import { startMockUpstream } from "../test-helpers/mock-upstream.js";
import { startRouter, postJson } from "../test-helpers/router-harness.js";

// Malformed client input must be answered with a 4xx by the SAME process, which then keeps serving.
// Every test proves survival the strong way: the child process has not exited, and a valid request
// sent afterwards succeeds.

const ok = () => ({
  status: 200,
  body: {
    id: "c1", object: "chat.completion", created: 0, model: "upstream",
    choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
  }
});
const validBody = { model: "m", max_tokens: 8, messages: [{ role: "user", content: "hi" }] };

async function boot(t, env = {}) {
  const upstream = await startMockUpstream(() => ok());
  const router = await startRouter({ GROQ_API_KEYS: "k1", GROQ_MODELS: "m", GROQ_BASE_URL: upstream.baseUrl, ...env });
  let exited = false;
  router.exited.then(() => { exited = true; });
  t.after(async () => { await router.close(); await upstream.close(); });
  return { router, upstream, isAlive: () => !exited };
}

/** Sends raw bytes (bypassing fetch's URL normalisation) and returns { status, body }. */
function rawRequest(port, text) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1");
    let data = "";
    socket.setTimeout(4000, () => { socket.destroy(); reject(new Error("raw request timed out")); });
    socket.on("data", (chunk) => { data += chunk; });
    socket.on("close", () => {
      const [head, ...rest] = data.split("\r\n\r\n");
      const status = Number(head.split(" ")[1]) || null;
      const bodyText = rest.join("\r\n\r\n");
      let body = null;
      try { body = JSON.parse(bodyText.replace(/^[0-9a-f]+\r\n/i, "").replace(/\r\n0\r\n\r\n$/, "")); } catch { /* not JSON */ }
      resolve({ status, body, raw: data });
    });
    socket.on("error", reject);
    socket.write(text);
  });
}

const rawGet = (port, target, headers = "") => rawRequest(port, `GET ${target} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n${headers}\r\n`);

async function assertStillServing(router, isAlive) {
  assert.equal(isAlive(), true, "router process is still running");
  const res = await router.request("/v1/chat/completions", postJson(validBody));
  assert.equal(res.status, 200, "a valid request still succeeds on the same server");
  const api = await router.request("/api/health");
  assert.equal(api.status, 200, "the admin API still answers");
}

// ---- Case B: JSON root must be an object ---------------------------------------------------------

test("a `null` JSON body is a controlled 400 and the process survives", async (t) => {
  const { router, upstream, isAlive } = await boot(t);
  const res = await router.request("/v1/chat/completions", { method: "POST", headers: { "content-type": "application/json" }, body: "null" });
  assert.equal(res.status, 400);
  const json = await res.json();
  assert.equal(json.error.type, "invalid_request_error");
  assert.equal(upstream.apiRequests.length, 0, "never reached a provider");
  await assertStillServing(router, isAlive);
});

for (const [label, raw] of [["array", "[]"], ["string", "\"hello\""], ["number", "123"], ["boolean", "true"]]) {
  test(`a ${label} JSON root is rejected with 400 on every proxy path`, async (t) => {
    const { router, isAlive } = await boot(t);
    for (const path of ["/v1/chat/completions", "/v1/messages", "/v1/responses", "/v1beta/models/m:generateContent", "/v1/messages/count_tokens"]) {
      const res = await router.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: raw });
      assert.equal(res.status, 400, `${path} with ${raw}`);
      assert.equal((await res.json()).error.type, "invalid_request_error");
    }
    await assertStillServing(router, isAlive);
  });
}

test("valid and empty bodies keep working (the object check is not stricter than the contract)", async (t) => {
  const { router, isAlive } = await boot(t);
  assert.equal((await router.request("/v1/chat/completions", postJson(validBody))).status, 200);
  // An empty body has always parsed to {} and is routed (auto-routed, no model).
  const empty = await router.request("/v1/chat/completions", { method: "POST" });
  assert.notEqual(empty.status, 400);
  assert.equal((await router.request("/v1/messages/count_tokens", postJson({ messages: [{ role: "user", content: "hi" }] }))).status, 200);
  assert.equal(isAlive(), true);
});

// ---- Case A: malformed request target -------------------------------------------------------------

test("a malformed request target is a controlled 400 and the process survives", async (t) => {
  const { router, isAlive } = await boot(t);
  const res = await rawGet(router.port, "http://[");
  assert.equal(res.status, 400);
  assert.equal(res.body?.error?.type, "invalid_request_error");
  await assertStillServing(router, isAlive);
});

test("a malformed request target is rejected before authentication, without crashing, when client auth is on", async (t) => {
  const { router, isAlive } = await boot(t, { MULTIAI_ROUTER_API_KEYS: "secret-router-key" });
  const res = await rawGet(router.port, "http://[");              // no Authorization header at all
  assert.equal(res.status, 400);
  assert.equal(isAlive(), true);
  const authed = await router.request("/v1/chat/completions", postJson(validBody, { authorization: "Bearer secret-router-key" }));
  assert.equal(authed.status, 200);
  assert.equal((await router.request("/v1/chat/completions", postJson(validBody))).status, 401, "auth is unchanged");
});

// ---- Case C: malformed percent-encoding -----------------------------------------------------------

test("malformed percent-encoding in /api/requests/<id> is a controlled 400 and the process survives", async (t) => {
  const { router, isAlive } = await boot(t);
  const res = await rawGet(router.port, "/api/requests/%E0%A4%A");
  assert.equal(res.status, 400);
  assert.equal(res.body?.error?.type, "invalid_request");
  assert.equal(isAlive(), true);
  // A well-formed id is unchanged: 404 for an unknown request, never 400.
  const unknown = await router.request("/api/requests/does-not-exist");
  assert.equal(unknown.status, 404);
  await assertStillServing(router, isAlive);
});

test("malformed percent-encoding in a static path does not crash either", async (t) => {
  const { router, isAlive } = await boot(t);
  const res = await rawGet(router.port, "/%E0%A4%A");
  assert.ok(res.status >= 200 && res.status < 500, `status ${res.status}`);
  await assertStillServing(router, isAlive);
});

// ---- the error boundary itself ---------------------------------------------------------------------

test("an unexpected server-side exception becomes a JSON 500, is logged without secrets, and the process survives", async (t) => {
  const preload = fileURLToPath(new URL("../test-helpers/fault-inject.mjs", import.meta.url));
  const { router, isAlive } = await boot(t, { NODE_OPTIONS: `--import ${preload}`, MULTIAI_TEST_FAULT: "session-id" });

  // No session header => the router mints one => the injected fault throws inside request handling.
  const res = await router.request("/v1/chat/completions", postJson(validBody));
  assert.equal(res.status, 500);
  const json = await res.json();
  assert.equal(json.error.type, "internal_error");
  assert.equal(JSON.stringify(json).includes("secretsecret"), false, "the fault message is not echoed to the client");
  assert.equal(isAlive(), true, "the process did not terminate");
  assert.match(router.stderr, /unhandled request error/);
  assert.equal(router.stderr.includes("secretsecret"), false, "credential-shaped text is scrubbed from the log");

  // The same server keeps serving requests that do not hit the fault.
  const withSession = await router.request("/v1/chat/completions", postJson(validBody, { "x-multi-ai-session-id": "survivor" }));
  assert.equal(withSession.status, 200);
  assert.equal((await router.request("/api/health")).status, 200);
});
