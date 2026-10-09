import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startMockUpstream } from "../test-helpers/mock-upstream.js";
import { startRouter, postJson } from "../test-helpers/router-harness.js";

const ok = (model) => ({ status: 200, body: { id: "x", object: "chat.completion", model, choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" }] } });
const bearer = (record) => String(record.headers.authorization || "").replace(/^Bearer /, "");
const chat = (router, model = "anything") => router.request("/v1/chat/completions", postJson({ model, messages: [{ role: "user", content: "hello" }] }));

test("manual selection: the key/provider/model that last succeeded is tried first on the next request", async () => {
  // groq key g0 fails (500), key g1 works. mistral works. Manual order: groq/m1, mistral/m2.
  const groq = await startMockUpstream((record) => (bearer(record) === "g0" ? { status: 500, body: { error: "down" } } : ok("m1")));
  const mistral = await startMockUpstream(() => ok("m2"));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "manual-e2e-"));
  const router = await startRouter({
    GROQ_API_KEYS: "g0,g1",
    GROQ_MODELS: "m1",
    GROQ_BASE_URL: `${groq.baseUrl}/v1`,
    MISTRAL_API_KEYS: "s0",
    MISTRAL_MODELS: "m2",
    MISTRAL_BASE_URL: `${mistral.baseUrl}/v1`,
    MANUAL_SELECTION_FILE: path.join(dir, "manual.json")
  });
  try {
    const put = await router.request("/api/manual-selection", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pool: "text", models: [{ provider: "groq", model: "m1" }, { provider: "mistral", model: "m2" }] })
    });
    assert.equal(put.status, 200);

    const posts = (mock) => mock.requests.filter((r) => r.method === "POST").map(bearer);

    // Request 1: g0 fails, g1 answers.
    assert.equal((await chat(router)).status, 200);
    assert.deepEqual(posts(groq), ["g0", "g1"]);

    // Request 2 and 3: g1 (the last success) is used directly; g0 is not retried,
    // and mistral (later in the manual list) is never touched.
    assert.equal((await chat(router)).status, 200);
    assert.equal((await chat(router)).status, 200);
    assert.deepEqual(posts(groq), ["g0", "g1", "g1", "g1"]);
    assert.deepEqual(posts(mistral), []);
  } finally {
    await router.close();
    await groq.close();
    await mistral.close();
  }
});
