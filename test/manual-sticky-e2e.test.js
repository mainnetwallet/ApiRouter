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

const image = [{ type: "text", text: "what is this?" }, { type: "image_url", image_url: { url: "data:image/png;base64,iVBORw0KGgo=" } }];
const chatImage = (router) => router.request("/v1/chat/completions", postJson({ model: "anything", messages: [{ role: "user", content: image }] }));

test("vision pool: same sticky, manual selection and cooldown rules apply, independent of text", async () => {
  // Same provider (groq) serves text with keys t0,t1 and vision with keys v0,v1.
  // Text key t0 and vision key v0 both fail; the second key of each pool works.
  const groq = await startMockUpstream((record) => (["t0", "v0"].includes(bearer(record)) ? { status: 500, body: { error: "down" } } : ok("m1")));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vision-e2e-"));
  const router = await startRouter({
    GROQ_API_KEYS: "t0,t1",
    GROQ_MODELS: "m1",
    GROQ_BASE_URL: `${groq.baseUrl}/v1`,
    GROQ_VISION_API_KEYS: "v0,v1",
    GROQ_VISION_MODELS: "vm1",
    GROQ_VISION_BASE_URL: `${groq.baseUrl}/v1`,
    MANUAL_SELECTION_FILE: path.join(dir, "manual.json")
  });
  try {
    const put = await router.request("/api/manual-selection", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pool: "vision", models: [{ provider: "groq", model: "vm1" }] })
    });
    assert.equal(put.status, 200);
    const posts = () => groq.requests.filter((r) => r.method === "POST").map(bearer);

    // Vision request 1: v0 fails (20 min cooldown), v1 answers.
    assert.equal((await chatImage(router)).status, 200);
    assert.deepEqual(posts(), ["v0", "v1"]);

    // Vision request 2: v1 directly, v0 not retried.
    assert.equal((await chatImage(router)).status, 200);
    assert.deepEqual(posts(), ["v0", "v1", "v1"]);

    // The vision failure did not cool down text: the text pool still starts at t0.
    assert.equal((await chat(router)).status, 200);
    assert.deepEqual(posts().slice(3), ["t0", "t1"]);
    assert.equal((await chat(router)).status, 200);
    assert.deepEqual(posts().slice(5), ["t1"]);
  } finally {
    await router.close();
    await groq.close();
  }
});
