import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { loadConfig } from "../src/config.js";
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
    assert.equal(c.port, 8788);
  }
});

test("REQUEST_TIMEOUT_MS rejects non-numeric, zero, negative and fractional values", () => {
  for (const bad of ["abc", "0", "-1", "1.5", "NaN", "Infinity", "12ms"]) {
    assert.throws(() => loadConfig({ REQUEST_TIMEOUT_MS: bad }), /Invalid REQUEST_TIMEOUT_MS: expected a positive integer/, bad);
  }
});

test("there is no request body size setting: MAX_REQUEST_BODY_MB is ignored", () => {
  for (const value of ["1", "abc", "0", "-3"]) {
    const c = loadConfig({ MAX_REQUEST_BODY_MB: value });
    assert.equal("maxBodyBytes" in c, false, value);
  }
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

for (const [name, value] of [["REQUEST_TIMEOUT_MS", "abc"], ["REQUEST_TIMEOUT_MS", "0"]]) {
  test(`startup with ${name}=${value} exits 1 with a clear message and never listens`, async () => {
    const { code, stdout, stderr } = await bootWith({ [name]: value });
    assert.equal(code, 1);
    assert.ok(!/listening/.test(stdout), "server must not start");
    assert.match(stderr, new RegExp(`Configuration error: Invalid ${name}: expected`));
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
