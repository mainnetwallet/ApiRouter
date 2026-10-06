import test from "node:test";
import assert from "node:assert/strict";
import { startMockUpstream } from "../test-helpers/mock-upstream.js";
import { startRouter, postJson } from "../test-helpers/router-harness.js";
import { requestHasImage, selectPool } from "../src/vision.js";

// Image detection looks only at content-bearing positions. A tool's arbitrary JSON
// (tool_use.input, functionCall.args, functionResponse.response) is data, not an attachment.

const TOOL_ARGS_WITH_IMAGE_SHAPE = { children: [{ type: "image", image: { external: { url: "https://x/y.png" } } }] };

test("tool_use input containing {type:'image'} is NOT an image (Anthropic)", () => {
  const body = { model: "m", messages: [
    { role: "user", content: "append an image block to the page" },
    { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "example", input: TOOL_ARGS_WITH_IMAGE_SHAPE }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] }
  ] };
  assert.equal(requestHasImage(body), false);
  assert.equal(selectPool(body, { textTargets: [{}], visionTargets: [{}] }).pool, "text");
});

test("arbitrary JSON in other protocols' tool data is NOT an image", () => {
  // OpenAI chat: tool call arguments are a JSON string, and a tool message's content is text.
  assert.equal(requestHasImage({ messages: [
    { role: "assistant", tool_calls: [{ id: "c", type: "function", function: { name: "f", arguments: JSON.stringify(TOOL_ARGS_WITH_IMAGE_SHAPE) } }] },
    { role: "tool", tool_call_id: "c", content: JSON.stringify(TOOL_ARGS_WITH_IMAGE_SHAPE) }
  ] }), false);
  // Responses: function_call arguments / function_call_output.output as strings.
  assert.equal(requestHasImage({ input: [
    { type: "function_call", call_id: "c", name: "f", arguments: JSON.stringify(TOOL_ARGS_WITH_IMAGE_SHAPE) },
    { type: "function_call_output", call_id: "c", output: "done" }
  ] }), false);
  // Gemini: functionCall.args and functionResponse.response are free-form objects.
  assert.equal(requestHasImage({ contents: [
    { role: "model", parts: [{ functionCall: { name: "f", args: TOOL_ARGS_WITH_IMAGE_SHAPE } }] },
    { role: "user", parts: [{ functionResponse: { name: "f", response: { inlineData: { mimeType: "image/png" }, ...TOOL_ARGS_WITH_IMAGE_SHAPE } } }] }
  ] }), false);
  // Free-form top-level fields are never scanned.
  assert.equal(requestHasImage({ messages: [{ role: "user", content: "hi" }], metadata: TOOL_ARGS_WITH_IMAGE_SHAPE, tools: [{ type: "image" }] }), false);
});

test("legitimate image content is still detected in every supported protocol", () => {
  const png = { type: "base64", media_type: "image/png", data: "AAAA" };
  // Anthropic: image block, and an image returned inside a tool_result.
  assert.equal(requestHasImage({ messages: [{ role: "user", content: [{ type: "text", text: "x" }, { type: "image", source: png }] }] }), true);
  assert.equal(requestHasImage({ messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: [{ type: "image", source: png }] }] }] }), true);
  // OpenAI chat: image_url part.
  assert.equal(requestHasImage({ messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }] }] }), true);
  // Responses: input_image inside a message, as a bare item, and in a function_call_output.
  assert.equal(requestHasImage({ input: [{ role: "user", content: [{ type: "input_image", image_url: "data:image/png;base64,AAAA" }] }] }), true);
  assert.equal(requestHasImage({ input: [{ type: "input_image", image_url: "https://x/y.png" }] }), true);
  assert.equal(requestHasImage({ input: [{ type: "function_call_output", call_id: "c", output: [{ type: "input_image", image_url: "https://x/y.png" }] }] }), true);
  // Gemini: inlineData / fileData with an image mime type, one Content object, and a multimodal functionResponse.
  assert.equal(requestHasImage({ contents: [{ role: "user", parts: [{ inlineData: { mimeType: "image/jpeg", data: "AAAA" } }] }] }), true);
  assert.equal(requestHasImage({ contents: { role: "user", parts: [{ fileData: { mimeType: "image/png", fileUri: "gs://b/o" } }] } }), true);
  assert.equal(requestHasImage({ contents: [{ role: "user", parts: [{ functionResponse: { name: "f", response: {}, parts: [{ inlineData: { mimeType: "image/png", data: "AAAA" } }] } }] }] }), true);
  // A non-image mime type is not an image.
  assert.equal(requestHasImage({ contents: [{ parts: [{ inlineData: { mimeType: "audio/wav", data: "AAAA" } }] }] }), false);
  // And the pool follows: an image request is vision-only.
  const real = { messages: [{ role: "user", content: [{ type: "image", source: png }] }] };
  assert.equal(selectPool(real, { textTargets: [{ t: 1 }], visionTargets: [{ v: 1 }] }).pool, "vision");
});

test("HTTP: a text request whose tool call carries {type:'image'} stays in the text pool (no 503 no_vision_route)", async (t) => {
  const seen = [];
  const upstream = await startMockUpstream((req) => {
    seen.push(req.body?.model);
    return { status: 200, body: { id: "c", object: "chat.completion", created: 0, model: "u", choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }], usage: { total_tokens: 2 } } };
  });
  // Text pool only: NO vision provider configured, so a misclassified request would get 503 no_vision_route.
  const router = await startRouter({ GROQ_API_KEYS: "k1", GROQ_MODELS: "m", GROQ_BASE_URL: upstream.baseUrl });
  t.after(async () => { await router.close(); await upstream.close(); });

  const toolBody = { model: "m", max_tokens: 16, messages: [
    { role: "user", content: "add an image block" },
    { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "example", input: TOOL_ARGS_WITH_IMAGE_SHAPE }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] }
  ] };
  const res = await router.request("/v1/messages", postJson(toolBody));
  assert.equal(res.status, 200, await res.clone().text());
  assert.deepEqual(seen, ["m"], "served by the text pool");
  const entry = (await (await router.request("/api/requests")).json()).entries[0];
  assert.equal(entry.pool, "text");

  // A real image block still goes to the vision pool and, with none configured, is refused - never sent to text.
  seen.length = 0;
  const real = { model: "m", max_tokens: 16, messages: [{ role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } }] }] };
  const vision = await router.request("/v1/messages", postJson(real));
  assert.equal(vision.status, 503);
  assert.equal((await vision.json()).error.type, "no_vision_route");
  assert.deepEqual(seen, [], "the real image request never reached the text pool");
});

// A blob the client declared as an image, or one it declared nothing about,
// must reach the VISION pool. Gemini's File API payloads carry only a fileUri,
// and some clients send application/octet-stream for bytes they know are an
// image; treating either as text routed an image to a text-only target.
test("MIME-less and octet-stream blobs are images; a declared non-image stays text", () => {
  assert.equal(requestHasImage({ contents: [{ parts: [{ fileData: { fileUri: "gs://b/o" } }] }] }), true);
  assert.equal(requestHasImage({ contents: [{ parts: [{ file_data: { file_uri: "gs://b/o" } }] }] }), true);
  assert.equal(requestHasImage({ contents: [{ parts: [{ inlineData: { data: "AAAA" } }] }] }), true);
  assert.equal(requestHasImage({ contents: [{ parts: [{ inlineData: { mimeType: "", data: "AAAA" } }] }] }), true);
  assert.equal(requestHasImage({ contents: [{ parts: [{ inlineData: { mimeType: "application/octet-stream", data: "AAAA" } }] }] }), true);
  assert.equal(requestHasImage({ contents: [{ parts: [{ fileData: { mimeType: "binary/octet-stream", fileUri: "gs://b/o" } }] }] }), true);

  // The pool follows the detection: never the text pool.
  const body = { contents: [{ parts: [{ fileData: { fileUri: "gs://b/o" } }] }] };
  const selection = selectPool(body, { textTargets: [{ t: 1 }], visionTargets: [{ v: 1 }] });
  assert.equal(selection.pool, "vision");
  assert.deepEqual(selection.targets, [{ v: 1 }]);

  // A type the client did declare as non-image stays in the text pool.
  assert.equal(requestHasImage({ contents: [{ parts: [{ inlineData: { mimeType: "audio/wav", data: "AAAA" } }] }] }), false);
  assert.equal(requestHasImage({ contents: [{ parts: [{ fileData: { mimeType: "application/pdf", fileUri: "gs://b/o" } }] }] }), false);
  // An empty object is not a blob at all.
  assert.equal(requestHasImage({ contents: [{ parts: [{ inlineData: {} }] }] }), false);
});

test("HTTP: a MIME-less Gemini blob is refused as vision, never served by the text pool", async (t) => {
  const seen = [];
  const upstream = await startMockUpstream((req) => {
    seen.push(req.body?.model);
    return { status: 200, body: { id: "c", object: "chat.completion", created: 0, model: "u", choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }], usage: { total_tokens: 2 } } };
  });
  // Text pool only: a missclassification shows up as a 200 from the text target.
  const router = await startRouter({ GROQ_API_KEYS: "k1", GROQ_MODELS: "m", GROQ_BASE_URL: upstream.baseUrl });
  t.after(async () => { await router.close(); await upstream.close(); });

  const res = await router.request("/v1beta/models/m:generateContent", postJson({
    contents: [{ role: "user", parts: [{ text: "what is this?" }, { fileData: { fileUri: "gs://bucket/photo" } }] }]
  }));
  assert.equal(res.status, 503);
  assert.equal((await res.json()).error.type, "no_vision_route");
  assert.deepEqual(seen, [], "the MIME-less image never reached the text pool");
});
