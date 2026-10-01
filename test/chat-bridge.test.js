import test from "node:test";
import assert from "node:assert/strict";
import {
  chatProtocol,
  selectChatTargets,
  toGeminiFromChat,
  buildChatRequest,
  geminiJsonToChat,
  convertChatJson,
  streamToChat,
  estimateChatInputTokens
} from "../src/chat-bridge.js";
import { startMockUpstream } from "../test-helpers/mock-upstream.js";
import { startRouter, postJson } from "../test-helpers/router-harness.js";

const target = (provider, model, protocols) => ({ provider, model, protocols, keyIndex: 0, apiKey: "k", baseUrl: "http://x" });

async function collect(iter) {
  let out = "";
  for await (const part of iter) out += part;
  return out;
}

/** Splits a chat SSE body into parsed chunks, plus the [DONE] terminator. */
function parseChatSse(text) {
  return text
    .split("\n\n")
    .filter(Boolean)
    .map((block) => block.replace(/^data: /, ""))
    .filter(Boolean)
    .map((raw) => (raw === "[DONE]" ? { done: true } : { chunk: JSON.parse(raw) }));
}

const deltas = (parsed) =>
  parsed.filter((entry) => entry.chunk).flatMap((entry) => entry.chunk.choices ?? []).map((choice) => choice.delta?.content ?? "").join("");

async function* lines(...items) { for (const item of items) yield item; }

// ------------------------------------------------------------ selection

test("chatProtocol prefers native openai-chat, then gemini, and rejects anthropic-only", () => {
  assert.equal(chatProtocol(target("g", "m", ["openai-chat", "gemini"])), "openai-chat");
  assert.equal(chatProtocol(target("g", "m", ["gemini"])), "gemini");
  assert.equal(chatProtocol(target("a", "m", ["anthropic"])), null);
  assert.equal(chatProtocol(null), null);
});

test("selectChatTargets puts exact model matches first and keeps the rest as fallback", () => {
  const a = target("a", "m1", ["openai-chat"]);
  const b = target("b", "m2", ["gemini"]);
  const c = target("c", "m2", ["anthropic"]);

  const selection = selectChatTargets([a, b, c], "m2");
  assert.equal(selection.protocol, "openai-chat");
  assert.equal(selection.modelMatched, true);
  assert.deepEqual(selection.selected, [b, a]);

  assert.deepEqual(selectChatTargets([a], "unknown").selected, [a]);
  assert.equal(selectChatTargets([a], "unknown").modelMatched, false);
  // An Anthropic-only target is not reachable for a chat client.
  assert.deepEqual(selectChatTargets([c], "m2").compatible, []);
});

// ---------------------------------------------------- request -> Gemini

test("toGeminiFromChat converts system, roles, tools and tool results", () => {
  const body = {
    messages: [
      { role: "system", content: "be brief" },
      { role: "developer", content: "and polite" },
      { role: "user", content: "run ls" },
      { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "shell", arguments: "{\"cmd\":\"ls\"}" } }] },
      { role: "tool", tool_call_id: "c1", content: "a.txt" }
    ],
    tools: [{ type: "function", function: { name: "shell", description: "run", parameters: { type: "object", properties: { cmd: { type: "string" } } } } }],
    tool_choice: "required",
    max_tokens: 256,
    temperature: 0.2,
    top_p: 0.9,
    stop: "STOP"
  };
  const out = toGeminiFromChat(body);

  assert.equal(out.systemInstruction.parts[0].text, "be brief\n\nand polite");
  assert.equal(out.contents[0].role, "user");
  assert.deepEqual(out.contents[0].parts, [{ text: "run ls" }]);
  assert.equal(out.contents[1].role, "model");
  assert.deepEqual(out.contents[1].parts[0].functionCall, { name: "shell", args: { cmd: "ls" } });
  assert.equal(out.contents[2].role, "user");
  assert.equal(out.contents[2].parts[0].functionResponse.name, "shell");
  assert.equal(out.contents[2].parts[0].functionResponse.response.output, "a.txt");

  assert.equal(out.tools[0].functionDeclarations[0].name, "shell");
  assert.equal(out.toolConfig.functionCallingConfig.mode, "ANY");
  assert.equal(out.generationConfig.maxOutputTokens, 256);
  assert.equal(out.generationConfig.temperature, 0.2);
  assert.equal(out.generationConfig.topP, 0.9);
  assert.deepEqual(out.generationConfig.stopSequences, ["STOP"]);
});

test("consecutive same-role messages merge into one Gemini content", () => {
  const out = toGeminiFromChat({
    messages: [
      { role: "user", content: "one" },
      { role: "user", content: "two" }
    ]
  });
  assert.equal(out.contents.length, 1);
  assert.deepEqual(out.contents[0].parts, [{ text: "one" }, { text: "two" }]);
});

test("image parts become inlineData only when they are data URLs", () => {
  const out = toGeminiFromChat({
    messages: [{
      role: "user",
      content: [
        { type: "text", text: "see" },
        { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
        { type: "image_url", image_url: { url: "https://example.test/cat.png" } }
      ]
    }]
  });
  assert.deepEqual(out.contents[0].parts[0], { text: "see" });
  assert.deepEqual(out.contents[0].parts[1], { inlineData: { mimeType: "image/png", data: "AAAA" } });
  // A remote URL has no generateContent equivalent; it is dropped, not guessed.
  assert.equal(out.contents[0].parts.length, 2);
});

test("tool_choice variants and json_schema output map to Gemini equivalents", () => {
  const tools = [{ type: "function", function: { name: "f", parameters: { type: "object", properties: {} } } }];

  assert.equal(toGeminiFromChat({ messages: [], tools, tool_choice: "none" }).toolConfig.functionCallingConfig.mode, "NONE");
  assert.equal(toGeminiFromChat({ messages: [], tools, tool_choice: "auto" }).toolConfig, undefined);
  assert.deepEqual(
    toGeminiFromChat({ messages: [], tools, tool_choice: { type: "function", function: { name: "f" } } }).toolConfig.functionCallingConfig,
    { mode: "ANY", allowedFunctionNames: ["f"] }
  );

  const out = toGeminiFromChat({
    messages: [],
    response_format: { type: "json_schema", json_schema: { name: "o", schema: { type: "object", properties: { a: { type: "string" } } } } }
  });
  assert.equal(out.generationConfig.responseMimeType, "application/json");
  assert.equal(out.generationConfig.responseSchema.type, "object");

  assert.equal(
    toGeminiFromChat({ messages: [], response_format: { type: "json_object" } }).generationConfig.responseMimeType,
    "application/json"
  );
});

// ------------------------------------------------------- build request

test("buildChatRequest builds the Gemini URL and auth, and rejects anything else", () => {
  const request = buildChatRequest(
    { ...target("gm", "gemini-flash", ["gemini"]), apiKey: "GK" },
    "gemini",
    { messages: [{ role: "user", content: "hi" }], stream: true },
    { "user-agent": "curl" }
  );
  assert.equal(request.url, "http://x/v1beta/models/gemini-flash:streamGenerateContent?alt=sse");
  assert.equal(request.options.headers["x-goog-api-key"], "GK");
  assert.equal(request.options.headers.authorization, undefined);
  assert.equal(request.options.headers["user-agent"], "curl");
  assert.equal(request.options.headers.accept, "text/event-stream");

  const trailingSlash = buildChatRequest({ ...target("gm", "m", ["gemini"]), baseUrl: "http://x/v1beta/" }, "gemini", { messages: [] });
  assert.equal(trailingSlash.url, "http://x/v1beta/v1beta/models/m:generateContent");

  assert.throws(() => buildChatRequest(target("a", "m", ["anthropic"]), "anthropic", {}), /Unsupported/);
  assert.throws(() => buildChatRequest(target("c", "m", ["openai-chat"]), "openai-chat", {}), /Unsupported/);
});

// ---------------------------------------------------- JSON -> chat.completion

test("geminiJsonToChat maps text, tool calls, finish reason and usage", () => {
  const json = {
    candidates: [{
      content: { parts: [{ thought: true, text: "hmm" }, { text: "hello" }, { functionCall: { name: "shell", args: { cmd: "ls" } } }] },
      finishReason: "STOP"
    }],
    usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 4 }
  };
  const out = geminiJsonToChat(json, "my-model");

  assert.equal(out.object, "chat.completion");
  assert.equal(out.model, "my-model");
  assert.equal(out.choices[0].message.role, "assistant");
  assert.equal(out.choices[0].message.content, "hello");
  // A tool call means the assistant produced no text content.
  const toolCall = out.choices[0].message.tool_calls[0];
  assert.equal(toolCall.type, "function");
  assert.equal(toolCall.function.name, "shell");
  assert.deepEqual(JSON.parse(toolCall.function.arguments), { cmd: "ls" });
  assert.equal(out.choices[0].finish_reason, "tool_calls");
  assert.deepEqual(out.usage, { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 });
});

test("finish reasons map STOP -> stop and MAX_TOKENS -> length", () => {
  const stop = geminiJsonToChat({ candidates: [{ content: { parts: [{ text: "x" }] }, finishReason: "STOP" }] }, "m");
  assert.equal(stop.choices[0].finish_reason, "stop");

  const truncated = geminiJsonToChat({ candidates: [{ content: { parts: [{ text: "cut" }] }, finishReason: "MAX_TOKENS" }] }, "m");
  assert.equal(truncated.choices[0].finish_reason, "length");
});

test("an empty candidate still produces a well-formed completion", () => {
  const out = geminiJsonToChat({}, "m");
  assert.equal(out.choices[0].message.content, "");
  assert.equal(out.choices[0].finish_reason, "stop");
  assert.equal(out.usage.prompt_tokens, 0);
});

test("a missing usage block falls back to the input estimate", () => {
  const out = geminiJsonToChat({ candidates: [{ content: { parts: [{ text: "x" }] } }] }, "m", { inputTokens: 42 });
  assert.equal(out.usage.prompt_tokens, 42);
});

test("convertChatJson dispatches on the upstream protocol and rejects the rest", () => {
  const converted = convertChatJson("gemini", { candidates: [{ content: { parts: [{ text: "g" }] } }] }, "m");
  assert.equal(converted.choices[0].message.content, "g");
  assert.throws(() => convertChatJson("anthropic", {}, "m"), /Unsupported/);
});

test("a Gemini tool call's signature is echoed back on the next turn", () => {
  const first = geminiJsonToChat({
    candidates: [{ content: { parts: [{ functionCall: { name: "shell", args: { cmd: "ls" } }, thoughtSignature: "SIG" }] } }]
  }, "m");
  const callId = first.choices[0].message.tool_calls[0].id;

  const followUp = toGeminiFromChat({
    messages: [
      { role: "assistant", content: null, tool_calls: [{ id: callId, type: "function", function: { name: "shell", arguments: "{\"cmd\":\"ls\"}" } }] },
      { role: "tool", tool_call_id: callId, content: "a.txt" }
    ]
  });
  assert.equal(followUp.contents[0].parts[0].thoughtSignature, "SIG");
  assert.equal(followUp.contents[1].parts[0].functionResponse.name, "shell");
});

// ------------------------------------------------------------ streaming

test("streamToChat turns a Gemini stream into chat.completion.chunk ending in [DONE]", async () => {
  const parsed = parseChatSse(await collect(streamToChat("gemini", lines(
    JSON.stringify({ candidates: [{ content: { parts: [{ text: "po" }] } }] }),
    JSON.stringify({ candidates: [{ content: { parts: [{ text: "ng" }] } }] }),
    JSON.stringify({ candidates: [{ content: { parts: [] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2 } })
  ), "m")));

  const chunks = parsed.filter((entry) => entry.chunk).map((entry) => entry.chunk);
  assert.deepEqual(chunks[0].choices[0].delta, { role: "assistant", content: "" });
  assert.equal(chunks[0].object, "chat.completion.chunk");
  assert.equal(chunks[0].model, "m");
  assert.equal(deltas(parsed), "pong");
  assert.equal(chunks.at(-1).choices[0].finish_reason, "stop");
  assert.equal(chunks.at(-1).choices[0].delta.content, undefined);
  assert.equal(parsed.at(-1).done, true, "the stream terminates with [DONE]");
});

test("streamToChat assembles streamed Gemini tool calls with indexed deltas", async () => {
  const parsed = parseChatSse(await collect(streamToChat("gemini", lines(
    JSON.stringify({ candidates: [{ content: { parts: [{ functionCall: { name: "shell", args: { cmd: "ls" } } }] }, finishReason: "STOP" }] })
  ), "m")));

  const chunks = parsed.filter((entry) => entry.chunk).map((entry) => entry.chunk);
  const toolDeltas = chunks.flatMap((chunk) => chunk.choices[0]?.delta?.tool_calls ?? []);
  const start = toolDeltas.find((entry) => entry.id);
  assert.equal(start.index, 0);
  assert.equal(start.type, "function");
  assert.equal(start.function.name, "shell");
  const args = toolDeltas.map((entry) => entry.function?.arguments ?? "").join("");
  assert.deepEqual(JSON.parse(args), { cmd: "ls" });
  assert.equal(chunks.at(-1).choices[0].finish_reason, "tool_calls");
});

test("streamToChat emits a usage chunk only when the client asked for one", async () => {
  const events = () => lines(
    JSON.stringify({ candidates: [{ content: { parts: [{ text: "hi" }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 2 } })
  );

  const without = parseChatSse(await collect(streamToChat("gemini", events(), "m")));
  assert.equal(without.filter((entry) => entry.chunk?.usage).length, 0);

  const withUsage = parseChatSse(await collect(streamToChat("gemini", events(), "m", { includeUsage: true })));
  const usageChunk = withUsage.find((entry) => entry.chunk?.usage);
  assert.deepEqual(usageChunk.chunk.choices, []);
  assert.deepEqual(usageChunk.chunk.usage, { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 });
  assert.equal(withUsage.at(-1).done, true);
});

test("streamToChat skips unparsable chunks and reports an upstream failure as an error event", async () => {
  const ok = parseChatSse(await collect(streamToChat("gemini", lines(
    "not json",
    JSON.stringify({ candidates: [{ content: { parts: [{ text: "ok" }] }, finishReason: "STOP" }] })
  ), "m")));
  assert.equal(deltas(ok), "ok");

  async function* broken() {
    yield JSON.stringify({ candidates: [{ content: { parts: [{ text: "partial" }] } }] });
    throw new Error("socket closed");
  }
  const failed = parseChatSse(await collect(streamToChat("gemini", broken(), "m")));
  const errorChunk = failed.find((entry) => entry.chunk?.error);
  assert.match(errorChunk.chunk.error.message, /socket closed/);
  assert.equal(errorChunk.chunk.error.type, "upstream_error");
  assert.equal(failed.at(-1).done, true, "a failed stream still terminates with [DONE]");
});

test("streamToChat refuses a protocol it cannot translate", async () => {
  await assert.rejects(() => collect(streamToChat("openai-chat", lines(), "m")), /Unsupported/);
});

test("estimateChatInputTokens returns a positive integer", () => {
  const n = estimateChatInputTokens({ messages: [{ role: "user", content: "x".repeat(400) }] });
  assert.ok(Number.isInteger(n) && n >= 100);
});

// -------------------------------------------------------- integration

async function withRig(t, script, envFor) {
  const upstream = await startMockUpstream(script);
  const router = await startRouter(envFor(upstream));
  t.after(async () => { await router.close(); await upstream.close(); });
  return { upstream, router };
}

const chatBody = (extra = {}) => ({ model: "llama-x", messages: [{ role: "user", content: "hi" }], ...extra });

test("a chat request reaches a Gemini-only provider and gets a chat.completion reply", async (t) => {
  const { upstream, router } = await withRig(
    t,
    () => ({ status: 200, body: { candidates: [{ content: { parts: [{ text: "gem" }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 1 } } }),
    (u) => ({ GEMINI_API_KEYS: "gk", GEMINI_MODELS: "gemini-flash", GEMINI_BASE_URL: u.baseUrl })
  );

  const res = await router.request("/v1/chat/completions", postJson(chatBody()));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.object, "chat.completion");
  assert.equal(body.choices[0].message.content, "gem");
  assert.equal(body.choices[0].finish_reason, "stop");
  assert.equal(body.usage.total_tokens, 3);
  assert.equal(res.headers.get("x-multi-ai-provider"), "gemini");

  const sent = upstream.apiRequests[0];
  assert.equal(sent.url, "/v1beta/models/gemini-flash:generateContent");
  assert.equal(sent.headers["x-goog-api-key"], "gk");
  assert.equal(sent.body.contents[0].parts[0].text, "hi");
  // The client's model name is preserved on the way back, not the provider's.
  assert.equal(body.model, "llama-x");
});

test("a streaming chat request is translated to chat.completion.chunk SSE", async (t) => {
  const geminiSse = [
    `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: "po" }] } }] })}\n\n`,
    `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: "ng" }] } }] })}\n\n`,
    `data: ${JSON.stringify({ candidates: [{ content: { parts: [] }, finishReason: "STOP" }] })}\n\n`
  ];
  const { upstream, router } = await withRig(
    t,
    () => ({ status: 200, headers: { "content-type": "text/event-stream" }, stream: geminiSse }),
    (u) => ({ GEMINI_API_KEYS: "gk", GEMINI_MODELS: "gemini-flash", GEMINI_BASE_URL: u.baseUrl })
  );

  const res = await router.request("/v1/chat/completions", postJson(chatBody({ stream: true })));
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /text\/event-stream/);

  const raw = await res.text();
  const parsed = parseChatSse(raw);
  assert.equal(deltas(parsed), "pong");
  assert.ok(raw.trimEnd().endsWith("data: [DONE]"), "the body ends with the [DONE] terminator");
  assert.equal(upstream.apiRequests[0].url, "/v1beta/models/gemini-flash:streamGenerateContent?alt=sse");
  assert.match(upstream.apiRequests[0].headers.accept, /event-stream/);
});

test("a chat tool call round-trips through a Gemini provider", async (t) => {
  const { upstream, router } = await withRig(
    t,
    // The first turn asks for a tool call; the follow-up (which carries the
    // functionResponse) answers with text.
    (record) => (record.body?.contents?.some((content) => content.parts?.some((part) => part.functionResponse))
      ? { status: 200, body: { candidates: [{ content: { parts: [{ text: "done" }] }, finishReason: "STOP" }] } }
      : { status: 200, body: { candidates: [{ content: { parts: [{ functionCall: { name: "shell", args: { cmd: "ls" } }, thoughtSignature: "SIG" }] }, finishReason: "STOP" }] } }),
    (u) => ({ GEMINI_API_KEYS: "gk", GEMINI_MODELS: "gemini-flash", GEMINI_BASE_URL: u.baseUrl })
  );

  const tools = [{ type: "function", function: { name: "shell", description: "run", parameters: { type: "object", properties: { cmd: { type: "string" } } } } }];

  const first = await router.request("/v1/chat/completions", postJson(chatBody({ tools })));
  assert.equal(first.status, 200);
  const toolCall = (await first.json()).choices[0].message.tool_calls[0];
  assert.equal(toolCall.type, "function");
  assert.equal(toolCall.function.name, "shell");
  assert.deepEqual(JSON.parse(toolCall.function.arguments), { cmd: "ls" });
  assert.equal(upstream.apiRequests[0].body.tools[0].functionDeclarations[0].name, "shell");

  const second = await router.request("/v1/chat/completions", postJson({
    model: "llama-x",
    tools,
    messages: [
      { role: "user", content: "hi" },
      { role: "assistant", content: null, tool_calls: [toolCall] },
      { role: "tool", tool_call_id: toolCall.id, content: "a.txt" }
    ]
  }));
  assert.equal(second.status, 200);
  assert.equal((await second.json()).choices[0].message.content, "done");

  // The follow-up carries the call back to Gemini under the same name, with the
  // thoughtSignature preserved.
  const sent = upstream.apiRequests[1].body.contents;
  const modelTurn = sent.find((content) => content.parts?.some((part) => part.functionCall));
  assert.equal(modelTurn.parts[0].functionCall.name, "shell");
  assert.equal(modelTurn.parts[0].thoughtSignature, "SIG");
  const toolTurn = sent.find((content) => content.parts?.some((part) => part.functionResponse));
  assert.equal(toolTurn.parts[0].functionResponse.name, "shell");
  assert.equal(toolTurn.parts[0].functionResponse.response.output, "a.txt");
});

test("a chat request falls back from a chat provider to a Gemini provider", async (t) => {
  const groq = await startMockUpstream(() => ({ status: 429, body: { error: { message: "rate limited" } } }));
  const gemini = await startMockUpstream(() => ({ status: 200, body: { candidates: [{ content: { parts: [{ text: "from gemini" }] }, finishReason: "STOP" }] } }));
  const router = await startRouter({
    GROQ_API_KEYS: "g-key", GROQ_MODELS: "llama-x", GROQ_BASE_URL: groq.baseUrl + "/v1",
    GEMINI_API_KEYS: "gk", GEMINI_MODELS: "gemini-flash", GEMINI_BASE_URL: gemini.baseUrl
  });
  t.after(async () => { await router.close(); await groq.close(); await gemini.close(); });

  // The requested model matches the chat provider, so it is tried first.
  const res = await router.request("/v1/chat/completions", postJson(chatBody({ model: "llama-x" })));
  assert.equal(res.status, 200);
  assert.equal((await res.json()).choices[0].message.content, "from gemini");
  assert.equal(res.headers.get("x-multi-ai-provider"), "gemini");
  assert.equal(groq.apiRequests.length, 1);
  assert.equal(gemini.apiRequests.length, 1);
});

test("a native chat-completions target is still passed through untranslated", async (t) => {
  const { upstream, router } = await withRig(
    t,
    () => ({ status: 200, body: { id: "chatcmpl-native", object: "chat.completion", choices: [{ message: { role: "assistant", content: "native" } }] } }),
    (u) => ({ AGENTROUTER_API_KEYS: "ar-key", AGENTROUTER_MODELS: "shared-model", AGENTROUTER_BASE_URL: u.baseUrl + "/" })
  );

  const res = await router.request("/v1/chat/completions", postJson({ model: "shared-model", messages: [{ role: "user", content: "hi" }] }));
  assert.equal(res.status, 200);
  assert.equal((await res.json()).id, "chatcmpl-native");

  const sent = upstream.apiRequests[0];
  assert.equal(sent.url, "/v1/chat/completions");
  assert.equal(sent.headers.authorization, "Bearer ar-key");
  assert.equal(sent.body.model, "shared-model");
  // Untranslated: the client's message shape reaches the provider unchanged.
  assert.deepEqual(sent.body.messages, [{ role: "user", content: "hi" }]);
});

test("a chat request with no usable provider returns 503 no_route", async (t) => {
  const { router } = await withRig(t, () => ({ status: 200, body: {} }), () => ({}));

  const res = await router.request("/v1/chat/completions", postJson(chatBody()));
  assert.equal(res.status, 503);
  assert.equal((await res.json()).error.type, "no_route");
});

test("a chat request is not routed at all once every target is cooled down", async (t) => {
  const { upstream, router } = await withRig(
    t,
    () => ({ status: 429, body: { error: { message: "slow down" } } }),
    (u) => ({ GROQ_API_KEYS: "g-key", GROQ_MODELS: "llama-x", GROQ_BASE_URL: u.baseUrl + "/v1" })
  );

  // The first request retries, exhausts the only target and cools it down.
  const first = await router.request("/v1/chat/completions", postJson(chatBody()));
  assert.equal(first.status, 502);
  assert.equal(upstream.apiRequests.length, 1);

  // The second finds nothing available and fails before contacting anyone.
  const second = await router.request("/v1/chat/completions", postJson(chatBody()));
  assert.equal(second.status, 503);
  assert.equal(upstream.apiRequests.length, 1);
});
