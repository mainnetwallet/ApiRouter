import test from "node:test";
import assert from "node:assert/strict";
import {
  codexProtocol,
  selectCodexTargets,
  customToolNames,
  toOpenAIChatFromResponses,
  toGeminiFromResponses,
  buildCodexRequest,
  openAIJsonToResponses,
  geminiJsonToResponses,
  convertCodexJson,
  streamToResponses,
  estimateResponsesInputTokens
} from "../src/codex-bridge.js";
import { startMockUpstream } from "../test-helpers/mock-upstream.js";
import { startRouter, postJson } from "../test-helpers/router-harness.js";

const target = (provider, model, protocols) => ({ provider, model, protocols, keyIndex: 0, apiKey: "k", baseUrl: "http://x" });

async function collect(iter) {
  let out = "";
  for await (const part of iter) out += part;
  return out;
}

/** Collects chunks until the iterable throws, returning both the text and the error. */
async function collectUntilError(iter) {
  let out = "";
  try {
    for await (const part of iter) out += part;
    return { out, error: null };
  } catch (error) {
    return { out, error };
  }
}

const parseSse = (text) =>
  text.split("\n\n").filter(Boolean).map((block) => {
    const event = block.match(/^event: (.+)$/m)[1];
    const data = JSON.parse(block.match(/^data: (.+)$/m)[1]);
    return { event, data };
  });

async function* lines(...items) { for (const item of items) yield item; }

// ------------------------------------------------------------ selection

test("codexProtocol prefers native responses, then openai-chat, then gemini", () => {
  assert.equal(codexProtocol(target("a", "m", ["openai-responses", "openai-chat"])), "openai-responses");
  assert.equal(codexProtocol(target("g", "m", ["openai-chat"])), "openai-chat");
  assert.equal(codexProtocol(target("x", "m", ["gemini"])), "gemini");
  assert.equal(codexProtocol(target("n", "m", ["anthropic"])), null);
  assert.equal(codexProtocol(null), null);
});

test("selectCodexTargets puts exact model matches first and keeps the rest as fallback", () => {
  const a = target("a", "m1", ["openai-chat"]);
  const b = target("b", "m2", ["gemini"]);
  const c = target("c", "m2", ["anthropic"]);
  const sel = selectCodexTargets([a, b, c], "m2");
  assert.equal(sel.protocol, "openai-responses");
  assert.equal(sel.modelMatched, true);
  assert.deepEqual(sel.selected, [b, a]);
  assert.deepEqual(selectCodexTargets([a, b], "unknown").selected, [a, b]);
  assert.equal(selectCodexTargets([a, b], "unknown").modelMatched, false);
});

// ------------------------------------------------------ request -> chat

test("toOpenAIChatFromResponses converts instructions, messages, tools and tool results", () => {
  const body = {
    instructions: "be brief",
    input: [
      { type: "message", role: "developer", content: [{ type: "input_text", text: "dev note" }] },
      { type: "message", role: "user", content: [{ type: "input_text", text: "run ls" }] },
      { type: "function_call", call_id: "c1", name: "shell", arguments: "{\"cmd\":\"ls\"}" },
      { type: "function_call_output", call_id: "c1", output: "a.txt" }
    ],
    tools: [{ type: "function", name: "shell", description: "run", parameters: { type: "object", properties: { cmd: { type: "string" } } } }],
    tool_choice: "auto",
    max_output_tokens: 256,
    stream: true
  };
  const out = toOpenAIChatFromResponses(body, "llama-x");
  assert.equal(out.model, "llama-x");
  assert.equal(out.stream, true);
  assert.equal(out.max_tokens, 256);
  assert.equal(out.messages[0].role, "system");
  assert.equal(out.messages[0].content, "be brief\n\ndev note");
  assert.deepEqual(out.messages[1], { role: "user", content: "run ls" });
  assert.equal(out.messages[2].role, "assistant");
  assert.equal(out.messages[2].tool_calls[0].id, "c1");
  assert.equal(out.messages[2].tool_calls[0].function.name, "shell");
  assert.equal(out.messages[3].role, "tool");
  assert.equal(out.messages[3].tool_call_id, "c1");
  assert.equal(out.messages[3].content, "a.txt");
  assert.equal(out.tools[0].function.name, "shell");
  assert.equal(out.tool_choice, "auto");
});

test("a string input becomes a single user message", () => {
  const out = toOpenAIChatFromResponses({ input: "hello" }, "m");
  assert.deepEqual(out.messages, [{ role: "user", content: "hello" }]);
  assert.equal(out.stream, false);
});

test("freeform custom tools become a function taking one input string", () => {
  const body = {
    input: [
      { type: "message", role: "user", content: "patch it" },
      { type: "custom_tool_call", call_id: "p1", name: "apply_patch", input: "*** Begin Patch" },
      { type: "custom_tool_call_output", call_id: "p1", output: "done" }
    ],
    tools: [{ type: "custom", name: "apply_patch", description: "edit files" }]
  };
  assert.deepEqual([...customToolNames(body)], ["apply_patch"]);
  const out = toOpenAIChatFromResponses(body, "m");
  assert.equal(out.tools[0].function.parameters.required[0], "input");
  assert.equal(JSON.parse(out.messages[1].tool_calls[0].function.arguments).input, "*** Begin Patch");
  assert.equal(out.messages[2].role, "tool");
});

test("hosted tools and reasoning items are dropped rather than forwarded", () => {
  const body = {
    input: [
      { type: "reasoning", summary: [] },
      { type: "message", role: "user", content: "hi" }
    ],
    tools: [{ type: "web_search" }, { type: "function", name: "f", parameters: { type: "object", properties: {} } }]
  };
  const out = toOpenAIChatFromResponses(body, "m");
  assert.equal(out.messages.length, 1);
  assert.equal(out.tools.length, 1);
  assert.equal(out.tools[0].function.name, "f");
});

test("tool_choice variants and json_schema output map to chat equivalents", () => {
  const tools = [{ type: "function", name: "f", parameters: { type: "object", properties: {} } }];
  assert.equal(toOpenAIChatFromResponses({ input: "x", tools, tool_choice: "required" }, "m").tool_choice, "required");
  assert.deepEqual(
    toOpenAIChatFromResponses({ input: "x", tools, tool_choice: { type: "function", name: "f" } }, "m").tool_choice,
    { type: "function", function: { name: "f" } }
  );
  const out = toOpenAIChatFromResponses({ input: "x", text: { format: { type: "json_schema", name: "o", schema: { type: "object" }, strict: true } } }, "m");
  assert.equal(out.response_format.type, "json_schema");
  assert.equal(out.response_format.json_schema.name, "o");
});

test("input images map to image_url parts", () => {
  const out = toOpenAIChatFromResponses({
    input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "see" }, { type: "input_image", image_url: "data:image/png;base64,AAAA" }] }]
  }, "m");
  assert.equal(out.messages[0].content[0].type, "text");
  assert.equal(out.messages[0].content[1].image_url.url, "data:image/png;base64,AAAA");
});

// ---------------------------------------------------- request -> Gemini

test("toGeminiFromResponses converts roles, tools and function responses", () => {
  const body = {
    instructions: "sys",
    input: [
      { type: "message", role: "user", content: "run it" },
      { type: "function_call", call_id: "g1", name: "shell", arguments: "{\"cmd\":\"ls\"}" },
      { type: "function_call_output", call_id: "g1", output: "ok" }
    ],
    tools: [{ type: "function", name: "shell", description: "d", parameters: { type: "object", properties: { cmd: { type: "string" } } } }],
    tool_choice: "required",
    max_output_tokens: 100
  };
  const out = toGeminiFromResponses(body);
  assert.equal(out.systemInstruction.parts[0].text, "sys");
  assert.equal(out.contents[0].role, "user");
  assert.equal(out.contents[1].role, "model");
  assert.deepEqual(out.contents[1].parts[0].functionCall, { name: "shell", args: { cmd: "ls" } });
  assert.equal(out.contents[2].role, "user");
  assert.equal(out.contents[2].parts[0].functionResponse.name, "shell");
  assert.equal(out.contents[2].parts[0].functionResponse.response.output, "ok");
  assert.equal(out.tools[0].functionDeclarations[0].name, "shell");
  assert.equal(out.toolConfig.functionCallingConfig.mode, "ANY");
  assert.equal(out.generationConfig.maxOutputTokens, 100);
});

// ------------------------------------------------------- build request

test("buildCodexRequest builds the right URLs and auth for each protocol", () => {
  const chat = buildCodexRequest({ ...target("g", "llama-x", ["openai-chat"]), baseUrl: "http://x/openai/v1/", apiKey: "K" }, "openai-chat", { input: "hi" }, { "user-agent": "codex" });
  assert.equal(chat.url, "http://x/openai/v1/chat/completions");
  assert.equal(chat.options.headers.authorization, "Bearer K");
  assert.equal(chat.options.headers["user-agent"], "codex");
  assert.equal(JSON.parse(chat.options.body).model, "llama-x");

  const bare = buildCodexRequest({ ...target("g", "m", ["openai-chat"]), baseUrl: "http://x" }, "openai-chat", { input: "hi" });
  assert.equal(bare.url, "http://x/v1/chat/completions");

  const gem = buildCodexRequest({ ...target("gm", "gemini-flash", ["gemini"]), apiKey: "GK" }, "gemini", { input: "hi", stream: true });
  assert.equal(gem.url, "http://x/v1beta/models/gemini-flash:streamGenerateContent?alt=sse");
  assert.equal(gem.options.headers["x-goog-api-key"], "GK");
  assert.equal(gem.options.headers.authorization, undefined);

  assert.throws(() => buildCodexRequest(target("a", "m", ["anthropic"]), "anthropic", {}), /Unsupported/);
});

// --------------------------------------------------- JSON -> Responses

test("openAIJsonToResponses maps text, tool calls, custom tools and usage", () => {
  const res = openAIJsonToResponses({
    choices: [{
      message: {
        content: "hello",
        tool_calls: [
          { id: "t1", function: { name: "shell", arguments: "{\"cmd\":\"ls\"}" } },
          { id: "t2", function: { name: "apply_patch", arguments: "{\"input\":\"PATCH\"}" } }
        ]
      },
      finish_reason: "tool_calls"
    }],
    usage: { prompt_tokens: 10, completion_tokens: 4 }
  }, "my-model", { customTools: new Set(["apply_patch"]) });

  assert.equal(res.object, "response");
  assert.equal(res.status, "completed");
  assert.equal(res.model, "my-model");
  assert.equal(res.output[0].type, "message");
  assert.equal(res.output[0].content[0].text, "hello");
  assert.equal(res.output[1].type, "function_call");
  assert.equal(res.output[1].call_id, "t1");
  assert.equal(res.output[1].arguments, "{\"cmd\":\"ls\"}");
  assert.equal(res.output[2].type, "custom_tool_call");
  assert.equal(res.output[2].input, "PATCH");
  assert.equal(res.usage.input_tokens, 10);
  assert.equal(res.usage.output_tokens, 4);
  assert.equal(res.usage.total_tokens, 14);
});

test("a length finish becomes an incomplete response", () => {
  const res = openAIJsonToResponses({ choices: [{ message: { content: "cut" }, finish_reason: "length" }] }, "m");
  assert.equal(res.status, "incomplete");
  assert.equal(res.incomplete_details.reason, "max_output_tokens");
});

test("openAIJsonToResponses falls back to the input estimate when usage is missing", () => {
  const res = openAIJsonToResponses({ choices: [{ message: { content: "x" }, finish_reason: "stop" }] }, "m", { inputTokens: 42 });
  assert.equal(res.usage.input_tokens, 42);
});

test("geminiJsonToResponses maps text, function calls and skips thoughts", () => {
  const res = geminiJsonToResponses({
    candidates: [{
      content: { parts: [{ thought: true, text: "hmm" }, { text: "hi " }, { text: "there" }, { functionCall: { name: "shell", args: { cmd: "ls" } } }] },
      finishReason: "STOP"
    }],
    usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 3 }
  }, "gm");
  assert.equal(res.output[0].content[0].text, "hi there");
  assert.equal(res.output[1].type, "function_call");
  assert.equal(res.output[1].name, "shell");
  assert.deepEqual(JSON.parse(res.output[1].arguments), { cmd: "ls" });
  assert.equal(res.usage.input_tokens, 7);
  assert.equal(res.usage.output_tokens, 3);
});

test("convertCodexJson dispatches on the upstream protocol", () => {
  const gem = convertCodexJson("gemini", { candidates: [{ content: { parts: [{ text: "g" }] }, finishReason: "STOP" }] }, "m");
  assert.equal(gem.output[0].content[0].text, "g");
  const chat = convertCodexJson("openai-chat", { choices: [{ message: { content: "c" }, finish_reason: "stop" }] }, "m");
  assert.equal(chat.output[0].content[0].text, "c");
});

// ------------------------------------------------------------ streaming

test("streamToResponses turns an OpenAI text stream into Responses events", async () => {
  const events = parseSse(await collect(streamToResponses("openai-chat", lines(
    JSON.stringify({ choices: [{ delta: { content: "po" } }] }),
    JSON.stringify({ choices: [{ delta: { content: "ng" } }] }),
    JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 2 } }),
    "[DONE]"
  ), "m")));

  const types = events.map((e) => e.event);
  assert.equal(types[0], "response.created");
  assert.equal(types[1], "response.in_progress");
  assert.ok(types.includes("response.output_item.added"));
  assert.ok(types.includes("response.content_part.added"));
  assert.equal(events.filter((e) => e.event === "response.output_text.delta").map((e) => e.data.delta).join(""), "pong");
  assert.equal(events.find((e) => e.event === "response.output_text.done").data.text, "pong");
  assert.equal(types.at(-1), "response.completed");

  const final = events.at(-1).data.response;
  assert.equal(final.status, "completed");
  assert.equal(final.output[0].content[0].text, "pong");
  assert.equal(final.usage.input_tokens, 5);
  assert.equal(final.usage.output_tokens, 2);

  const seqs = events.map((e) => e.data.sequence_number);
  assert.deepEqual(seqs, seqs.map((_, i) => i), "sequence numbers are contiguous from 0");
});

test("streamToResponses assembles streamed OpenAI tool calls", async () => {
  const events = parseSse(await collect(streamToResponses("openai-chat", lines(
    JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "shell", arguments: "{\"cmd\"" } }] } }] }),
    JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: ":\"ls\"}" } }] } }] }),
    JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }),
    "[DONE]"
  ), "m")));

  const deltas = events.filter((e) => e.event === "response.function_call_arguments.delta").map((e) => e.data.delta).join("");
  assert.equal(deltas, "{\"cmd\":\"ls\"}");
  assert.equal(events.find((e) => e.event === "response.function_call_arguments.done").data.arguments, "{\"cmd\":\"ls\"}");
  const final = events.at(-1).data.response;
  assert.equal(final.output[0].type, "function_call");
  assert.equal(final.output[0].call_id, "c1");
  assert.equal(final.output[0].name, "shell");
  assert.equal(final.output[0].arguments, "{\"cmd\":\"ls\"}");
});

test("streamToResponses emits custom tool calls without argument deltas", async () => {
  const events = parseSse(await collect(streamToResponses("openai-chat", lines(
    JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "p1", function: { name: "apply_patch", arguments: "{\"input\":\"PATCH\"}" } }] } }] }),
    JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }),
    "[DONE]"
  ), "m", { customTools: new Set(["apply_patch"]) })));

  assert.equal(events.filter((e) => e.event === "response.function_call_arguments.delta").length, 0);
  const item = events.at(-1).data.response.output[0];
  assert.equal(item.type, "custom_tool_call");
  assert.equal(item.input, "PATCH");
});

test("streamToResponses handles Gemini SSE text and function calls", async () => {
  const events = parseSse(await collect(streamToResponses("gemini", lines(
    JSON.stringify({ candidates: [{ content: { parts: [{ text: "hi" }] } }] }),
    JSON.stringify({ candidates: [{ content: { parts: [{ functionCall: { name: "shell", args: { cmd: "ls" } } }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 2 } })
  ), "gm")));

  const final = events.at(-1).data.response;
  assert.equal(events.at(-1).event, "response.completed");
  assert.equal(final.output[0].content[0].text, "hi");
  assert.equal(final.output[1].type, "function_call");
  assert.deepEqual(JSON.parse(final.output[1].arguments), { cmd: "ls" });
  assert.equal(final.usage.input_tokens, 3);
});

test("a truncated stream ends with response.incomplete", async () => {
  const events = parseSse(await collect(streamToResponses("openai-chat", lines(
    JSON.stringify({ choices: [{ delta: { content: "cut" }, finish_reason: "length" }] })
  ), "m")));
  assert.equal(events.at(-1).event, "response.incomplete");
  assert.equal(events.at(-1).data.response.incomplete_details.reason, "max_output_tokens");
});

test("streamToResponses turns upstream failure into response.failed, then re-throws it", async () => {
  const ok = parseSse(await collect(streamToResponses("openai-chat", lines("not json", JSON.stringify({ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] })), "m")));
  assert.ok(ok.some((e) => e.data.delta === "ok"));

  async function* broken() {
    yield JSON.stringify({ choices: [{ delta: { content: "partial" } }] });
    throw new Error("socket closed");
  }
  const { out, error } = await collectUntilError(streamToResponses("openai-chat", broken(), "m"));
  const failed = parseSse(out);
  assert.equal(failed.at(-1).event, "response.failed");
  assert.equal(failed.at(-1).data.response.status, "failed");
  assert.match(failed.at(-1).data.response.error.message, /socket closed/);
  // The terminal event is delivered, then the failure surfaces so the server
  // files it as truncated instead of a success.
  assert.match(error.message, /socket closed/);
  assert.equal(error.streamCause, "upstream");
  assert.equal(error.failedAfterHeaders, true);
});

test("estimateResponsesInputTokens returns a positive integer", () => {
  const n = estimateResponsesInputTokens({ instructions: "x".repeat(400), input: [] });
  assert.ok(Number.isInteger(n) && n >= 100);
});

// -------------------------------------------------------- integration

async function withRig(t, script, envFor) {
  const upstream = await startMockUpstream(script);
  const router = await startRouter(envFor(upstream));
  t.after(async () => { await router.close(); await upstream.close(); });
  return { upstream, router };
}

const responsesBody = (extra = {}) => ({ model: "gpt-5-codex", input: "hi", ...extra });

test("Codex request reaches an OpenAI-chat-only provider and gets a Responses reply", async (t) => {
  const { upstream, router } = await withRig(
    t,
    () => ({ status: 200, body: { id: "c1", choices: [{ message: { content: "pong" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } } }),
    (u) => ({ GROQ_API_KEYS: "g-key", GROQ_MODELS: "llama-x", GROQ_BASE_URL: u.baseUrl + "/openai/v1" })
  );

  const res = await router.request("/v1/responses", postJson(responsesBody()));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.object, "response");
  assert.equal(body.model, "gpt-5-codex");
  assert.equal(body.output[0].content[0].text, "pong");
  assert.equal(res.headers.get("x-multi-ai-provider"), "groq");

  const sent = upstream.apiRequests[0];
  assert.equal(sent.url, "/openai/v1/chat/completions");
  assert.equal(sent.headers.authorization, "Bearer g-key");
  assert.equal(sent.body.model, "llama-x");
  assert.equal(sent.body.messages[0].content, "hi");
});

test("streaming Codex request is translated to Responses SSE", async (t) => {
  const sseChunks = [
    `data: ${JSON.stringify({ choices: [{ delta: { content: "po" } }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ delta: { content: "ng" } }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`,
    "data: [DONE]\n\n"
  ];
  const { upstream, router } = await withRig(
    t,
    () => ({ status: 200, headers: { "content-type": "text/event-stream" }, stream: sseChunks }),
    (u) => ({ GROQ_API_KEYS: "g-key", GROQ_MODELS: "llama-x", GROQ_BASE_URL: u.baseUrl + "/v1" })
  );

  const res = await router.request("/v1/responses", postJson(responsesBody({ stream: true })));
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /text\/event-stream/);
  const events = parseSse(await res.text());
  assert.equal(events[0].event, "response.created");
  assert.equal(events.filter((e) => e.event === "response.output_text.delta").map((e) => e.data.delta).join(""), "pong");
  assert.equal(events.at(-1).event, "response.completed");
  assert.equal(upstream.apiRequests[0].body.stream, true);
});

test("Codex request reaches a Gemini target through generateContent", async (t) => {
  const { upstream, router } = await withRig(
    t,
    () => ({ status: 200, body: { candidates: [{ content: { parts: [{ text: "gem" }] }, finishReason: "STOP" }] } }),
    (u) => ({ GEMINI_API_KEYS: "gk", GEMINI_MODELS: "gemini-flash", GEMINI_BASE_URL: u.baseUrl })
  );

  const res = await router.request("/v1/responses", postJson(responsesBody()));
  assert.equal(res.status, 200);
  assert.equal((await res.json()).output[0].content[0].text, "gem");
  const sent = upstream.apiRequests[0];
  assert.equal(sent.url, "/v1beta/models/gemini-flash:generateContent");
  assert.equal(sent.headers["x-goog-api-key"], "gk");
  assert.equal(sent.body.contents[0].parts[0].text, "hi");
});

test("Codex tool calls round-trip through a chat-only provider", async (t) => {
  const { upstream, router } = await withRig(
    t,
    () => ({ status: 200, body: { choices: [{ message: { content: null, tool_calls: [{ id: "c9", function: { name: "shell", arguments: "{\"cmd\":\"ls\"}" } }] }, finish_reason: "tool_calls" }], usage: { prompt_tokens: 2, completion_tokens: 2 } } }),
    (u) => ({ GROQ_API_KEYS: "g-key", GROQ_MODELS: "llama-x", GROQ_BASE_URL: u.baseUrl + "/v1" })
  );

  const res = await router.request("/v1/responses", postJson(responsesBody({
    tools: [{ type: "function", name: "shell", parameters: { type: "object", properties: { cmd: { type: "string" } } } }]
  })));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.output[0].type, "function_call");
  assert.equal(body.output[0].call_id, "c9");
  assert.equal(body.output[0].arguments, "{\"cmd\":\"ls\"}");
  assert.equal(upstream.apiRequests[0].body.tools[0].function.name, "shell");
});

test("a Codex request falls back to a different provider type on failure", async (t) => {
  const gem = await startMockUpstream(() => ({ status: 429, body: { error: { message: "rate limited" } } }));
  const groq = await startMockUpstream(() => ({ status: 200, body: { choices: [{ message: { role: "assistant", content: "from groq" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } } }));
  const router = await startRouter({
    GEMINI_API_KEYS: "gk", GEMINI_MODELS: "gemini-flash", GEMINI_BASE_URL: gem.baseUrl,
    GROQ_API_KEYS: "g-key", GROQ_MODELS: "llama-x", GROQ_BASE_URL: groq.baseUrl + "/v1"
  });
  t.after(async () => { await router.close(); await gem.close(); await groq.close(); });

  const res = await router.request("/v1/responses", postJson(responsesBody()));
  assert.equal(res.status, 200);
  assert.equal((await res.json()).output[0].content[0].text, "from groq");
  assert.equal(res.headers.get("x-multi-ai-provider"), "groq");
  assert.equal(gem.apiRequests.length, 1);
  assert.equal(groq.apiRequests.length, 1);
});

test("a native openai-responses target is still passed through untranslated", async (t) => {
  const { upstream, router } = await withRig(
    t,
    () => ({ status: 200, body: { id: "resp_native", object: "response", output: [] } }),
    (u) => ({ AGENTROUTER_API_KEYS: "ar-key", AGENTROUTER_MODELS: "shared-model", AGENTROUTER_BASE_URL: u.baseUrl + "/" })
  );

  const res = await router.request("/v1/responses", postJson(responsesBody()));
  assert.equal(res.status, 200);
  assert.equal((await res.json()).id, "resp_native");
  assert.equal(upstream.apiRequests[0].url, "/v1/responses");
});

test("a Responses request with no usable provider returns 503 no_route", async (t) => {
  const { upstream, router } = await withRig(
    t,
    () => ({ status: 200, body: {} }),
    (u) => ({ ANTHROPIC_API_KEYS: "a-key", ANTHROPIC_MODELS: "claude-x", ANTHROPIC_BASE_URL: u.baseUrl })
  );

  const res = await router.request("/v1/responses", postJson(responsesBody()));
  assert.equal(res.status, 503);
  assert.equal((await res.json()).error.type, "no_route");
  assert.equal(upstream.apiRequests.length, 0);
});
