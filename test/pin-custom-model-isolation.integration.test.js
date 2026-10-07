import test from "node:test";
import assert from "node:assert/strict";
import { startMockUpstream } from "../test-helpers/mock-upstream.js";
import { startRouter, postJson } from "../test-helpers/router-harness.js";

/**
 * A custom-model pin copies a configured target and only swaps the model.
 *
 * Vision targets carry an explicit health `id` (`vision:<provider>:<model>:key-N`);
 * the copy kept the ORIGINAL model's id, so the throw-away custom target shared
 * a health record with the real configured target. A Playground probe of a bad
 * model id then cooled the configured model for ordinary traffic for 20
 * minutes (and a lucky one cleared a genuine cooldown). The copy now gets the
 * id its own model deserves, exactly as a text-pool custom target always did.
 */

const reply = (text) => ({
  id: "c1", object: "chat.completion", created: 0, model: "u",
  choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
});
const imageBody = (model) => ({
  model,
  messages: [{
    role: "user",
    content: [
      { type: "text", text: "what is this?" },
      { type: "image_url", image_url: { url: "data:image/png;base64,iVBORw0KGgo=" } }
    ]
  }]
});
const textBody = (model) => ({ model, messages: [{ role: "user", content: "hi" }] });
const pinCustom = { "x-multi-ai-pin-provider": "groq", "x-multi-ai-pin-custom-model": "1" };
const healthOf = async (router) => (await router.request("/health")).json();
const isEligible = (health, pool, model) =>
  health.rankedTargets.some((row) => row.pool === pool && row.model === model);

async function setup(t) {
  const upstream = await startMockUpstream((request) =>
    request.body?.model === "brand-new-model"
      ? { status: 500, body: { error: { message: "boom" } } }
      : { status: 200, body: reply("served") });
  const router = await startRouter({
    GROQ_VISION_API_KEYS: "vk", GROQ_VISION_MODELS: "vm", GROQ_VISION_BASE_URL: upstream.baseUrl,
    GROQ_API_KEYS: "tk", GROQ_MODELS: "tm", GROQ_BASE_URL: upstream.baseUrl
  });
  t.after(async () => { await router.close(); await upstream.close(); });
  return { upstream, router };
}

test("a failing pinned custom VISION model does not cool the configured vision target", async (t) => {
  const { upstream, router } = await setup(t);

  const probe = await router.request("/v1/chat/completions", postJson(imageBody("brand-new-model"), pinCustom));
  assert.equal(probe.status, 502, "the custom model really failed upstream");
  assert.equal(upstream.apiRequests.at(-1).body.model, "brand-new-model", "the custom model was the one called");

  const health = await healthOf(router);
  assert.ok(isEligible(health, "vision", "vm"), "the configured vision model is still eligible");
  assert.ok(!health.coolingTargets.some((row) => row.model === "vm"), "and is not cooling");

  const normal = await router.request("/v1/chat/completions", postJson(imageBody("vm")));
  assert.equal(normal.status, 200, "ordinary vision traffic is unaffected by the failed probe");
  assert.equal(upstream.apiRequests.at(-1).body.model, "vm");
});

test("a succeeding pinned custom VISION model does not clear a real cooldown on the configured target", async (t) => {
  // The mirror image: a custom success must not heal a genuinely failing target.
  let failVm = true;
  const upstream = await startMockUpstream((request) =>
    request.body?.model === "vm" && failVm
      ? { status: 500, body: { error: { message: "down" } } }
      : { status: 200, body: reply("served") });
  const router = await startRouter({
    GROQ_VISION_API_KEYS: "vk", GROQ_VISION_MODELS: "vm", GROQ_VISION_BASE_URL: upstream.baseUrl
  });
  t.after(async () => { await router.close(); await upstream.close(); });

  const failed = await router.request("/v1/chat/completions", postJson(imageBody("vm")));
  assert.equal(failed.status, 502);
  assert.ok(!isEligible(await healthOf(router), "vision", "vm"), "the configured target is cooling");

  failVm = false;
  const custom = await router.request("/v1/chat/completions", postJson(imageBody("brand-new-model"), pinCustom));
  assert.equal(custom.status, 200);

  assert.ok(!isEligible(await healthOf(router), "vision", "vm"), "a custom success did not heal the configured target");
});

test("text-pool custom pins keep their own health record (unchanged behaviour)", async (t) => {
  const { upstream, router } = await setup(t);

  const probe = await router.request("/v1/chat/completions", postJson(textBody("brand-new-model"), pinCustom));
  assert.equal(probe.status, 502);

  const health = await healthOf(router);
  assert.ok(isEligible(health, "text", "tm"), "the configured text model is unaffected");
  const normal = await router.request("/v1/chat/completions", postJson(textBody("tm")));
  assert.equal(normal.status, 200);
  assert.equal(upstream.apiRequests.at(-1).body.model, "tm");
});

test("a pinned custom model is still sent with the pinned key and the vision target's own base URL", async (t) => {
  const { upstream, router } = await setup(t);

  const res = await router.request("/v1/chat/completions", postJson(imageBody("other-new-model"), pinCustom));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("x-multi-ai-model"), "other-new-model");
  assert.equal(upstream.apiRequests.at(-1).headers.authorization, "Bearer vk", "the vision key, never the text key");
});
