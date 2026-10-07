import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { DEFAULT_MAX_BODY_BYTES, loadConfig } from "../src/config.js";
import { startMockUpstream } from "../test-helpers/mock-upstream.js";
import { startRouter, postJson } from "../test-helpers/router-harness.js";

// Numeric env settings must fail fast. An invalid value used to become NaN or
// 0 (REQUEST_TIMEOUT_MS=0 aborted every upstream call immediately).

test("valid numeric env values are parsed exactly as before", () => {
  const c = loadConfig({ REQUEST_TIMEOUT_MS: "30000", STREAM_CONNECT_TIMEOUT_MS: "500", PORT: "9000" });
  assert.equal(c.timeoutMs, 30000);
  assert.equal(c.connectTimeoutMs, 500);
  assert.equal(c.port, 9000);
});

test("unset or empty numeric env values keep their defaults", () => {
  for (const env of [{}, { REQUEST_TIMEOUT_MS: "", STREAM_CONNECT_TIMEOUT_MS: "", PORT: "" }]) {
    const c = loadConfig(env);
    assert.equal(c.timeoutMs, 120000);
    assert.equal(c.connectTimeoutMs, 30000);
    assert.equal(c.port, 999);
  }
});

test("REQUEST_TIMEOUT_MS rejects non-numeric, zero, negative and fractional values", () => {
  for (const bad of ["abc", "0", "-1", "1.5", "NaN", "Infinity", "12ms"]) {
    assert.throws(() => loadConfig({ REQUEST_TIMEOUT_MS: bad }), /Invalid REQUEST_TIMEOUT_MS: expected a positive integer/, bad);
  }
});

// The body ceiling is a gateway memory guard, not a provider limit. Its only
// spelling is MAX_REQUEST_BODY_BYTES; the historical MAX_REQUEST_BODY_MB was
// never read and stays ignored so an old .env cannot silently change behaviour.
test("MAX_REQUEST_BODY_BYTES is the ceiling; MAX_REQUEST_BODY_MB stays ignored", () => {
  assert.equal(loadConfig({}).maxBodyBytes, DEFAULT_MAX_BODY_BYTES);
  assert.equal(loadConfig({ MAX_REQUEST_BODY_BYTES: "1048576" }).maxBodyBytes, 1048576);
  // 0 disables the guard, which is a meaningful value rather than a bad one.
  assert.equal(loadConfig({ MAX_REQUEST_BODY_BYTES: "0" }).maxBodyBytes, 0);
  for (const bad of ["abc", "-1", "1.5", "12mb"]) {
    assert.throws(() => loadConfig({ MAX_REQUEST_BODY_BYTES: bad }), /Invalid MAX_REQUEST_BODY_BYTES/, bad);
  }

  for (const value of ["1", "abc", "0", "-3"]) {
    assert.equal(loadConfig({ MAX_REQUEST_BODY_MB: value }).maxBodyBytes, DEFAULT_MAX_BODY_BYTES, value);
  }
});

test("STREAM_IDLE_TIMEOUT_MS is validated; 0 disables the post-header bound", () => {
  assert.equal(loadConfig({}).streamIdleTimeoutMs, 120000);
  assert.equal(loadConfig({ STREAM_IDLE_TIMEOUT_MS: "0" }).streamIdleTimeoutMs, 0);
  assert.equal(loadConfig({ STREAM_IDLE_TIMEOUT_MS: "250" }).streamIdleTimeoutMs, 250);
  for (const bad of ["abc", "-1", "1.5"]) {
    assert.throws(() => loadConfig({ STREAM_IDLE_TIMEOUT_MS: bad }), /Invalid STREAM_IDLE_TIMEOUT_MS/, bad);
  }
});

test("STICKY_TTL_MS is validated and never silently falls back", () => {
  assert.equal(loadConfig({}).stickyTtlMs, 20 * 60 * 1000);
  assert.equal(loadConfig({ STICKY_TTL_MS: "60000" }).stickyTtlMs, 60000);
  for (const bad of ["abc", "0", "-1", "1.5", "NaN", "Infinity"]) {
    assert.throws(() => loadConfig({ STICKY_TTL_MS: bad }), /Invalid STICKY_TTL_MS: expected a positive integer/, bad);
  }
});

// A typo used to be filtered out silently: RETRY_STATUS_CODES=abc configured
// nothing and looked fine. Every entry is now a real HTTP status code.
test("RETRY_STATUS_CODES accepts a valid list and rejects anything that is not a status code", () => {
  const parsed = loadConfig({ RETRY_STATUS_CODES: " 429, 500 ,503" }).retryableStatus;
  assert.deepEqual([...parsed].sort((a, b) => a - b), [429, 500, 503]);
  // Unset or empty keeps the documented default set.
  assert.ok(loadConfig({}).retryableStatus.has(429));
  assert.ok(loadConfig({ RETRY_STATUS_CODES: "" }).retryableStatus.has(503));

  assert.throws(() => loadConfig({ RETRY_STATUS_CODES: "abc" }), /Invalid RETRY_STATUS_CODES/);
  assert.throws(() => loadConfig({ RETRY_STATUS_CODES: "0,99,600" }), /Invalid RETRY_STATUS_CODES/);
  // Blank entries are ignored, so a trailing comma is not an error.
  assert.deepEqual([...loadConfig({ RETRY_STATUS_CODES: "429,,500" }).retryableStatus], [429, 500]);
  assert.throws(() => loadConfig({ RETRY_STATUS_CODES: "429.5" }), /Invalid RETRY_STATUS_CODES/);
  assert.throws(() => loadConfig({ RETRY_STATUS_CODES: "," }), /Invalid RETRY_STATUS_CODES/);
});

test("STREAM_CONNECT_TIMEOUT_MS and PORT are validated; 0 stays a meaningful value", () => {
  assert.equal(loadConfig({ STREAM_CONNECT_TIMEOUT_MS: "0" }).connectTimeoutMs, 0);
  assert.equal(loadConfig({ PORT: "0" }).port, 0);
  for (const bad of ["x", "-1", "1.5"]) {
    assert.throws(() => loadConfig({ STREAM_CONNECT_TIMEOUT_MS: bad }), /Invalid STREAM_CONNECT_TIMEOUT_MS/, bad);
  }
  for (const bad of ["abc", "-1", "65536", "80.5"]) {
    assert.throws(() => loadConfig({ PORT: bad }), /Invalid PORT/, bad);
  }
});

test("the error names the variable and carries no stack or file path", () => {
  try { loadConfig({ REQUEST_TIMEOUT_MS: "abc" }); assert.fail("should have thrown"); }
  catch (error) {
    assert.equal(error.message, 'Invalid REQUEST_TIMEOUT_MS: expected a positive integer, got "abc"');
  }
});

// ---- startup behavior: the real server process must refuse to start ---------

const SERVER_PATH = fileURLToPath(new URL("../src/server.js", import.meta.url));

function bootWith(env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SERVER_PATH], {
      cwd: path.dirname(SERVER_PATH),
      env: { ...process.env, PORT: "0", ...env },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => { stdout += c; });
    child.stderr.on("data", (c) => { stderr += c; });
    const timer = setTimeout(() => child.kill(), 4000);
    child.once("exit", (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

for (const [name, value] of [["REQUEST_TIMEOUT_MS", "abc"], ["REQUEST_TIMEOUT_MS", "0"], ["RETRY_STATUS_CODES", "abc"]]) {
  test(`startup with ${name}=${value} exits 1 with a clear message and never listens`, async () => {
    const { code, stdout, stderr } = await bootWith({ [name]: value });
    assert.equal(code, 1);
    assert.ok(!/listening/.test(stdout), "server must not start");
    assert.match(stderr, new RegExp(`Configuration error: Invalid ${name}:`));
    assert.ok(!/\bat \S+ \(|node_modules/.test(stderr), `no stack trace expected: ${stderr}`);
  });
}

test("valid REQUEST_TIMEOUT_MS=30000 starts normally and a large body is not rejected", async (t) => {
  const upstream = await startMockUpstream(() => ({ status: 200, body: {
    id: "c1", object: "chat.completion", created: 0, model: "u",
    choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
  } }));
  const router = await startRouter({
    GROQ_API_KEYS: "k1", GROQ_MODELS: "m", GROQ_BASE_URL: upstream.baseUrl,
    REQUEST_TIMEOUT_MS: "30000", MAX_REQUEST_BODY_MB: "1"
  });
  t.after(async () => { await router.close(); await upstream.close(); });

  const ok = await router.request("/v1/chat/completions", postJson({ model: "m", messages: [{ role: "user", content: "hi" }] }));
  assert.equal(ok.status, 200);

  const big = await router.request("/v1/chat/completions", postJson({ model: "m", messages: [{ role: "user", content: "x".repeat(2 * 1024 * 1024) }] }));
  assert.equal(big.status, 200);
});

test("MAX_REQUEST_BODY_BYTES caps the gateway's own buffer with a 413", async (t) => {
  const upstream = await startMockUpstream(() => ({ status: 200, body: {
    id: "c1", object: "chat.completion", created: 0, model: "u",
    choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
  } }));
  const router = await startRouter({
    GROQ_API_KEYS: "k1", GROQ_MODELS: "m", GROQ_BASE_URL: upstream.baseUrl,
    MAX_REQUEST_BODY_BYTES: "256"
  });
  t.after(async () => { await router.close(); await upstream.close(); });

  const small = await router.request("/v1/chat/completions", postJson({ model: "m", messages: [{ role: "user", content: "hi" }] }));
  assert.equal(small.status, 200, "a body under the ceiling is untouched");

  const big = await router.request("/v1/chat/completions", postJson({ model: "m", messages: [{ role: "user", content: "x".repeat(4096) }] }));
  assert.equal(big.status, 413);
  assert.equal((await big.json()).error.type, "request_too_large");
  assert.equal(upstream.apiRequests.length, 1, "the oversized body never reached the provider");
});
