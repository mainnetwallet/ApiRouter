import test from "node:test";
import assert from "node:assert/strict";
import { analyzeRequest, collectRequestMedia, requestOperation } from "../src/request-profile.js";

const chat = (body = {}, extra = {}) => analyzeRequest({
  protocol: "openai-chat",
  pathname: "/v1/chat/completions",
  body: { model: "m", messages: [{ role: "user", content: "hi" }], ...body },
  ...extra
});

test("a plain chat request needs text in and text out, and nothing else", () => {
  const profile = chat();
  assert.equal(profile.operation, "chat");
  assert.equal("pool" in profile, false, "there is no pool: a request is described by capabilities alone");
  assert.deepEqual(profile.required, ["text_input", "text_output"]);
  assert.deepEqual(profile.preferred, []);
  assert.equal(profile.stream, false);
});

test("streaming is required when the client asks for it in any spelling", () => {
  assert.ok(chat({ stream: true }).required.includes("streaming"));
  assert.ok(chat({}, { stream: true }).required.includes("streaming"));
  const gemini = analyzeRequest({
    protocol: "gemini",
    pathname: "/v1beta/models/gemini-2.0:streamGenerateContent",
    body: { contents: [{ role: "user", parts: [{ text: "hi" }] }] }
  });
  assert.ok(gemini.required.includes("streaming"));
  assert.deepEqual(gemini.required, ["text_input", "text_output", "streaming"]);
});

test("image content parts require image_input, in every client shape", () => {
  const openai = chat({
    messages: [{ role: "user", content: [
      { type: "text", text: "what is this" },
      { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }
    ] }]
  });
  assert.deepEqual(openai.required, ["text_input", "text_output", "image_input"]);

  const anthropic = analyzeRequest({
    protocol: "anthropic",
    pathname: "/v1/messages",
    body: {
      model: "m",
      max_tokens: 10,
      messages: [{ role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/jpeg", data: "x" } }] }]
    }
  });
  assert.deepEqual(anthropic.required, ["text_input", "text_output", "image_input"]);

  const gemini = analyzeRequest({
    protocol: "gemini",
    pathname: "/v1beta/models/m:generateContent",
    body: { contents: [{ role: "user", parts: [{ inlineData: { mimeType: "image/png", data: "x" } }] }] }
  });
  assert.deepEqual(gemini.required, ["text_input", "text_output", "image_input"]);
});

test("media-shaped values inside tool arguments are not uploads", () => {
  const body = {
    model: "m",
    messages: [{
      role: "assistant",
      content: null,
      tool_calls: [{
        id: "call_1",
        type: "function",
        function: { name: "render", arguments: JSON.stringify({ type: "image", url: "https://example.test/x.png" }) }
      }]
    }]
  };
  assert.deepEqual(collectRequestMedia(body), { image: false, audio: false, video: false, file: false });
  const profile = chat(body);
  assert.ok(!profile.required.includes("image_input"), "a value the model produced is not an image the client uploaded");
  assert.deepEqual(profile.required, ["text_input", "text_output"]);
});

test("audio, video and file inputs are ordinary requirements on top of text, never a separate route", () => {
  const audio = chat({
    messages: [{ role: "user", content: [{ type: "input_audio", input_audio: { format: "wav", data: "AAAA" } }] }]
  });
  assert.deepEqual(audio.required, ["text_input", "text_output", "audio_input"]);

  const file = chat({
    messages: [{ role: "user", content: [{ type: "file", file: { filename: "a.pdf", file_data: "data:application/pdf;base64,AA" } }] }]
  });
  assert.deepEqual(file.required, ["text_input", "text_output", "file_input"]);

  const video = analyzeRequest({
    protocol: "gemini",
    pathname: "/v1beta/models/m:generateContent",
    body: { contents: [{ role: "user", parts: [{ fileData: { mimeType: "video/mp4", fileUri: "https://example.test/v.mp4" } }] }] }
  });
  assert.deepEqual(video.required, ["text_input", "text_output", "video_input"]);
});

test("tools require tool calling; provider-side tools require their own capability", () => {
  const tools = chat({ tools: [{ type: "function", function: { name: "get_weather", parameters: {} } }] });
  assert.ok(tools.required.includes("tool_calling"));
  assert.ok(!tools.required.includes("web_search"));

  const serverTools = chat({ tools: [{ type: "web_search" }, { type: "code_interpreter" }] });
  assert.ok(serverTools.required.includes("tool_calling"));
  assert.ok(serverTools.required.includes("web_search"));
  assert.ok(serverTools.required.includes("code_execution"));

  const gemini = analyzeRequest({
    protocol: "gemini",
    pathname: "/v1beta/models/m:generateContent",
    body: { contents: [], tools: [{ googleSearch: {} }] }
  });
  assert.ok(gemini.required.includes("web_search"));
});

test("a structured response format requires structured output", () => {
  assert.ok(chat({ response_format: { type: "json_schema", json_schema: { name: "x", schema: { type: "object" } } } })
    .required.includes("structured_output"));
  assert.ok(chat({ response_format: { type: "json_object" } }).required.includes("structured_output"));
  assert.ok(!chat({ response_format: { type: "text" } }).required.includes("structured_output"));

  const responses = analyzeRequest({
    protocol: "openai-responses",
    pathname: "/v1/responses",
    body: { model: "m", input: "hi", text: { format: { type: "json_schema" } } }
  });
  assert.ok(responses.required.includes("structured_output"));

  const gemini = analyzeRequest({
    protocol: "gemini",
    pathname: "/v1beta/models/m:generateContent",
    body: { contents: [], generationConfig: { responseMimeType: "application/json" } }
  });
  assert.ok(gemini.required.includes("structured_output"));
});

test("an explicitly requested output modality is required", () => {
  assert.ok(chat({ modalities: ["text", "image"] }).required.includes("image_output"));
  assert.ok(chat({ modalities: ["audio"] }).required.includes("audio_output"));
  const gemini = analyzeRequest({
    protocol: "gemini",
    pathname: "/v1beta/models/m:generateContent",
    body: { contents: [], generationConfig: { responseModalities: ["video"] } }
  });
  assert.ok(gemini.required.includes("video_output"));
});

test("reasoning is a preference, never a requirement", () => {
  for (const body of [
    { reasoning_effort: "high" },
    { reasoning: { effort: "low" } },
    { thinking: { type: "enabled", budget_tokens: 100 } }
  ]) {
    const profile = chat(body);
    assert.deepEqual(profile.preferred, ["reasoning"]);
    assert.ok(!profile.required.includes("reasoning"));
  }
});

test("endpoint-only operations are classified even though no route serves them yet", () => {
  assert.equal(requestOperation("/v1/embeddings"), "embeddings");
  assert.equal(requestOperation("/v1/images/generations"), "image_generation");
  assert.equal(requestOperation("/v1/audio/speech"), "audio_generation");
  assert.equal(requestOperation("/v1/audio/transcriptions"), "audio_transcription");
  assert.equal(requestOperation("/v1/audio/translations"), "audio_translation");
  assert.equal(requestOperation("/v1/realtime"), "realtime_audio");
  assert.equal(requestOperation("/v1/rerank"), "reranking");
  assert.equal(requestOperation("/v1/moderations"), "moderation");
  assert.equal(requestOperation("/v1/videos"), "video_generation");
  assert.equal(requestOperation("/v1/chat/completions", "openai-chat"), "chat");

  assert.deepEqual(analyzeRequest({ pathname: "/v1/embeddings", body: {} }).required, ["embeddings"]);
  assert.deepEqual(analyzeRequest({ pathname: "/v1/images/generations", body: {} }).required, ["image_output"]);
  assert.deepEqual(analyzeRequest({ pathname: "/v1/audio/transcriptions", body: {} }).required, ["audio_transcription"]);
  assert.deepEqual(analyzeRequest({ pathname: "/v1/audio/translations", body: {} }).required, ["audio_translation"]);
  assert.deepEqual(analyzeRequest({ pathname: "/v1/realtime", body: {} }).required, ["realtime_audio"]);
  assert.deepEqual(analyzeRequest({ pathname: "/v1/rerank", body: {} }).required, ["reranking"]);
  assert.deepEqual(analyzeRequest({ pathname: "/v1/moderations", body: {} }).required, ["moderation"]);
});

test("server-side tools require their corresponding capabilities", () => {
  assert.ok(analyzeRequest({ body: { tools: [{ type: "file_search" }] } }).required.includes("file_search"));
  assert.ok(analyzeRequest({ body: { tools: [{ type: "computer_20241022", name: "computer" }] } }).required.includes("computer_use"));
  assert.ok(analyzeRequest({ body: { tools: [{ type: "web_fetch" }] } }).required.includes("web_fetch"));
  assert.ok(analyzeRequest({ body: { tools: [{ type: "url_context" }] } }).required.includes("url_context"));
  assert.ok(analyzeRequest({ body: { tools: [{ urlContext: {} }] } }).required.includes("url_context"));
  assert.ok(analyzeRequest({ body: { tools: [{ fileSearch: {} }] } }).required.includes("file_search"));
});
