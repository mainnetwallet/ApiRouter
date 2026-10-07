import test from "node:test";
import assert from "node:assert/strict";

import { startRouter, postJson } from "../test-helpers/router-harness.js";
import { startUpstream, chatJsonReply, PNG_BYTES } from "../test-helpers/http-upstream.js";

const geminiReply = (text = "seen") => JSON.stringify({ candidates: [{ content: { role: "model", parts: [{ text }] }, finishReason: "STOP", index: 0 }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 } });
const jsonReply = (body) => (req, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end(body); };
const imageServer = () => startUpstream((req, res) => {
  if (req.url.startsWith("/img/ok")) { res.writeHead(200, { "content-type": "image/png" }); return res.end(PNG_BYTES); }
  if (req.url.startsWith("/img/html")) { res.writeHead(200, { "content-type": "text/html" }); return res.end("<html>"); }
  res.writeHead(404); res.end();
});
const LOCAL_FETCH = { REMOTE_IMAGE_ALLOW_HTTP: "1", REMOTE_IMAGE_ALLOW_PRIVATE_NETWORK: "1" };

async function rig(t, { gemini, env = {}, baseSuffix = "" }) {
  const upstream = await startUpstream(gemini);
  const images = await imageServer();
  // Image requests are served by the vision pool, so Gemini is configured in both pools.
  const base = upstream.url + baseSuffix;
  const router = await startRouter({
    GEMINI_API_KEYS: "gk-test-key-1", GEMINI_MODELS: "gemini-2.0-flash", GEMINI_BASE_URL: base,
    GEMINI_VISION_API_KEYS: "gk-test-key-1", GEMINI_VISION_MODELS: "gemini-2.0-flash", GEMINI_VISION_BASE_URL: base,
    ...env
  });
  t.after(async () => { await router.close(); await upstream.close(); await images.close(); });
  return { router, upstream, images };
}

const BASES = ["", "/", "/v1", "/v1/", "/v1beta", "/v1beta/", "/v1alpha", "/v1alpha/"];

for (const suffix of BASES) {
  test(`Anthropic/Chat/Responses -> Gemini reach exactly /v1beta/models/... when GEMINI_BASE_URL ends in "${suffix}"`, async (t) => {
    const { router, upstream } = await rig(t, { gemini: jsonReply(geminiReply()), baseSuffix: suffix });
    const a = await router.request("/v1/messages", postJson({ model: "gemini-2.0-flash", max_tokens: 5, messages: [{ role: "user", content: "hi" }] }));
    const c = await router.request("/v1/chat/completions", postJson({ model: "gemini-2.0-flash", messages: [{ role: "user", content: "hi" }] }));
    const r = await router.request("/v1/responses", postJson({ model: "gemini-2.0-flash", input: "hi" }));
    const g = await router.request("/v1beta/models/gemini-2.0-flash:generateContent", postJson({ contents: [{ role: "user", parts: [{ text: "hi" }] }] }));
    assert.deepEqual([a.status, c.status, r.status, g.status], [200, 200, 200, 200]);
    assert.deepEqual(upstream.calls.map((call) => call.url), Array(4).fill("/v1beta/models/gemini-2.0-flash:generateContent"));
  });
}

test("a remote image URL from an Anthropic client reaches Gemini as inline data (downloaded once, SSRF-checked)", async (t) => {
  const { router, upstream, images } = await rig(t, { gemini: jsonReply(geminiReply()), env: LOCAL_FETCH });
  const res = await router.request("/v1/messages", postJson({ model: "gemini-2.0-flash", max_tokens: 5, messages: [{ role: "user", content: [
    { type: "text", text: "what is this?" },
    { type: "image", source: { type: "url", url: `${images.url}/img/ok` } }
  ] }] }));
  assert.equal(res.status, 200);
  const parts = upstream.calls.find((c) => c.method === "POST").body.contents[0].parts;
  assert.equal(parts[0].text, "what is this?");
  assert.deepEqual(parts[1], { inlineData: { mimeType: "image/png", data: PNG_BYTES.toString("base64") } });
  assert.equal(images.calls.length, 1);
});

test("the same remote image URL in Chat and Responses requests is also carried, and a tool-result image too", async (t) => {
  const { router, upstream, images } = await rig(t, { gemini: jsonReply(geminiReply()), env: LOCAL_FETCH });
  const url = `${images.url}/img/ok`;
  const chat = await router.request("/v1/chat/completions", postJson({ model: "gemini-2.0-flash", messages: [{ role: "user", content: [{ type: "image_url", image_url: { url } }] }] }));
  const responses = await router.request("/v1/responses", postJson({ model: "gemini-2.0-flash", input: [{ type: "message", role: "user", content: [{ type: "input_image", image_url: url }] }] }));
  const anthropicTool = await router.request("/v1/messages", postJson({ model: "gemini-2.0-flash", max_tokens: 5, messages: [
    { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "shot", input: {} }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: [{ type: "image", source: { type: "url", url } }] }] }
  ] }));
  assert.deepEqual([chat.status, responses.status, anthropicTool.status], [200, 200, 200]);
  const posts = upstream.calls.filter((c) => c.method === "POST");
  assert.equal(posts[0].body.contents[0].parts[0].inlineData.data, PNG_BYTES.toString("base64"));
  assert.equal(posts[1].body.contents[0].parts[0].inlineData.data, PNG_BYTES.toString("base64"));
  assert.ok(posts[2].body.contents[1].parts.some((p) => p.inlineData), "the tool's image reached Gemini");
  assert.ok(!JSON.stringify(posts).includes("[image]"));
});

test("an unreachable or non-image URL is a clear 400 and the request is NOT sent to Gemini without the image", async (t) => {
  const { router, upstream, images } = await rig(t, { gemini: jsonReply(geminiReply()), env: LOCAL_FETCH });
  for (const path of ["/img/html", "/img/missing"]) {
    const res = await router.request("/v1/messages", postJson({ model: "gemini-2.0-flash", max_tokens: 5, messages: [{ role: "user", content: [{ type: "image", source: { type: "url", url: `${images.url}${path}` } }] }] }));
    assert.equal(res.status, 400, path);
    assert.equal((await res.json()).error.type, "unsupported_media", path);
  }
  assert.equal(upstream.calls.filter((c) => c.method === "POST").length, 0);
});

test("by default the router refuses to fetch private/loopback addresses for a client (SSRF guard)", async (t) => {
  const { router, upstream, images } = await rig(t, { gemini: jsonReply(geminiReply()) });
  for (const url of [`${images.url}/img/ok`, "https://169.254.169.254/latest/meta-data/", "https://localhost/a.png", "http://example.com/a.png"]) {
    const res = await router.request("/v1/chat/completions", postJson({ model: "gemini-2.0-flash", messages: [{ role: "user", content: [{ type: "image_url", image_url: { url } }] }] }));
    assert.equal(res.status, 400, url);
  }
  assert.equal(images.calls.length, 0, "the local image server was never contacted");
  assert.equal(upstream.calls.filter((c) => c.method === "POST").length, 0);
});

test("a chat-compatible target takes the remote URL as is (no download), so a mixed pool still answers", async (t) => {
  const gemini = await startUpstream(jsonReply(geminiReply()));
  const chatUp = await startUpstream(jsonReply(chatJsonReply("from-chat")));
  const router = await startRouter({
    GEMINI_VISION_API_KEYS: "gk-test-key-1", GEMINI_VISION_MODELS: "gemini-2.0-flash", GEMINI_VISION_BASE_URL: gemini.url,
    MISTRAL_VISION_API_KEYS: "sk-mistral-test-1", MISTRAL_VISION_MODELS: "vision-model", MISTRAL_VISION_BASE_URL: `${chatUp.url}/v1`
  });
  t.after(async () => { await router.close(); await gemini.close(); await chatUp.close(); });
  const url = "https://example.test/cat.png";
  // Gemini is first in provider order; it refuses the (default-blocked) URL with a 4xx for that target, and the chat target takes the URL natively.
  const res = await router.request("/v1/chat/completions", postJson({ messages: [{ role: "user", content: [{ type: "image_url", image_url: { url } }] }] }));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("x-multi-ai-provider"), "mistral");
  assert.equal(chatUp.calls.find((c) => c.method === "POST").body.messages[0].content[0].image_url.url, url);
  assert.equal(gemini.calls.filter((c) => c.method === "POST").length, 0);
});
