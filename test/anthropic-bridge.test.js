import test from "node:test";
import assert from "node:assert/strict";
import {
  bridgeProtocol,
  selectBridgeTargets,
  toOpenAIChatRequest,
  toGeminiRequest,
  cleanSchemaForGemini,
  openAIJsonToAnthropic,
  geminiJsonToAnthropic,
  sseData,
  streamToAnthropic,
  estimateInputTokens,
  buildBridgeRequest
} from "../src/anthropic-bridge.js";
import { startMockUpstream } from "../test-helpers/mock-upstream.js";
import { startRouter, postJson } from "../test-helpers/router-harness.js";

const target = (provider, model, protocols) => ({ provider, model, protocols, keyIndex: 0, apiKey: "k", baseUrl: "http://x" });

async function collect(iter) {
  let out = "";
  for await (const part of iter) out += part;
  return out;
}

const parseSse = (text) =>
  text.split("\n\n").filter(Boolean).map((block) => {
    const event = block.match(/^event: (.+)$/m)[1];
    const data = JSON.parse(block.match(/^data: (.+)$/m)[1]);
    return { event, data };
  });

async function* lines(...items) { for (const item of items) yield item; }

// ------------------------------------------------------------ selection

test("bridgeProtocol prefers native anthropic, then openai-chat, then gemini", () => {
  assert.equal(bridgeProtocol(target("a", "m", ["anthropic", "openai-chat"])), "anthropic");
  assert.equal(bridgeProtocol(target("g", "m", ["openai-chat"])), "openai-chat");
  assert.equal(bridgeProtocol(target("x", "m", ["gemini"])), "gemini");
  assert.equal(bridgeProtocol(target("x", "m", [])), null);
});

test("selectBridgeTargets puts exact model matches first and keeps the rest as fallback", () => {
  const a = target("agentrouter", "claude-opus-5", ["anthropic"]);
  const b = target("groq", "llama", ["openai-chat"]);
  const c = target("gemini", "flash", ["gemini"]);
  const exact = selectBridgeTargets([b, a, c], "claude-opus-5");
  assert.equal(exact.modelMatched, true);
  assert.deepEqual(exact.selected, [a, b, c]);

  const widened = selectBridgeTargets([b, a, c], "claude-haiku-4-5");
  assert.equal(widened.modelMatched, false);
  assert.equal(widened.selected.length, 3);
});

// ------------------------------------------------------ request: OpenAI

test("toOpenAIChatRequest converts system, text, tools and tool results", () => {
  const out = toOpenAIChatRequest({
    model: "claude-opus-5",
    max_tokens: 64000,
    stream: true,
    temperature: 0.2,
    system: [{ type: "text", text: "Be brief." }, { type: "text", text: "Be kind." }],
    tools: [{ name: "read", description: "Read a file", input_schema: { type: "object", properties: { path: { type: "string" } } } }],
    tool_choice: { type: "any" },
    messages: [
      { role: "user", content: "open a.txt" },
      { role: "assistant", content: [{ type: "text", text: "ok" }, { type: "tool_use", id: "t1", name: "read", input: { path: "a.txt" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "hello" }, { type: "text", text: "now summarize" }] }
    ]
  }, "llama-x", {});

  assert.equal(out.model, "llama-x");
  assert.equal(out.stream, true);
  assert.equal(out.max_tokens, 8192, "max_tokens is capped");
  assert.equal(out.temperature, 0.2);
  assert.equal(out.tool_choice, "required");
  assert.deepEqual(out.messages[0], { role: "system", content: "Be brief.\nBe kind." });
  assert.deepEqual(out.messages[1], { role: "user", content: "open a.txt" });
  assert.equal(out.messages[2].tool_calls[0].function.arguments, '{"path":"a.txt"}');
  assert.deepEqual(out.messages[3], { role: "tool", tool_call_id: "t1", content: "hello" });
  assert.deepEqual(out.messages[4], { role: "user", content: "now summarize" });
  assert.equal(out.tools[0].function.name, "read");
  assert.equal(out.tools[0].function.parameters.type, "object");
});

test("toOpenAIChatRequest honours BRIDGE_MAX_TOKENS and maps images to image_url", () => {
  const out = toOpenAIChatRequest({
    max_tokens: 100,
    messages: [{ role: "user", content: [
      { type: "text", text: "see" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "AAA" } }
    ] }]
  }, "m", { BRIDGE_MAX_TOKENS: "50" });
  assert.equal(out.max_tokens, 50);
  assert.equal(out.messages[0].content[1].image_url.url, "data:image/png;base64,AAA");
});

test("tool errors are flagged and tool_choice variants map correctly", () => {
  const out = toOpenAIChatRequest({
    tools: [{ name: "x", input_schema: {} }],
    tool_choice: { type: "tool", name: "x" },
    messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: "boom", is_error: true }] }]
  }, "m", {});
  assert.equal(out.messages[0].content, "Error: boom");
  assert.deepEqual(out.tool_choice, { type: "function", function: { name: "x" } });
});

// -------------------------------------------------------- request: Gemini

test("toGeminiRequest converts roles, tools and function responses", () => {
  const out = toGeminiRequest({
    max_tokens: 100,
    system: "sys",
    stop_sequences: ["END"],
    tools: [{ name: "read", description: "d", input_schema: { type: "object", additionalProperties: false, $schema: "x", properties: { p: { type: ["string", "null"] } } } }],
    messages: [
      { role: "user", content: "hi" },
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "read", input: { p: "a" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "data" }] }
    ]
  }, {});

  assert.deepEqual(out.systemInstruction, { parts: [{ text: "sys" }] });
  assert.deepEqual(out.contents.map((c) => c.role), ["user", "model", "user"]);
  assert.deepEqual(out.contents[1].parts[0].functionCall, { name: "read", args: { p: "a" } });
  assert.deepEqual(out.contents[2].parts[0].functionResponse, { name: "read", response: { output: "data" } });
  assert.deepEqual(out.generationConfig.stopSequences, ["END"]);
  const params = out.tools[0].functionDeclarations[0].parameters;
  assert.equal(params.additionalProperties, undefined);
  assert.equal(params.$schema, undefined);
  assert.deepEqual(params.properties.p, { type: "string", nullable: true });
});

test("cleanSchemaForGemini keeps only supported keys", () => {
  assert.deepEqual(
    cleanSchemaForGemini({ type: "array", items: { type: "string", format: "uri" }, minItems: 1 }),
    { type: "array", items: { type: "string" } }
  );
});

test("cleanSchemaForGemini gives every array node an items field, at any depth", () => {
  // Mirrors the failing tool: query.where is an array whose items are arrays with no items of their own.
  const out = cleanSchemaForGemini({
    type: "object",
    properties: {
      query: {
        type: "object",
        properties: {
          where: { type: "array", items: { type: "array" } },
          bare: { type: "array" },
          tuple: { type: "array", items: [{ type: "number" }] },
          either: { anyOf: [{ type: "null" }, { type: "array", items: { type: "array" } }] }
        }
      }
    }
  });
  const q = out.query ?? out.properties.query;
  assert.deepEqual(q.properties.where, { type: "array", items: { type: "array", items: { type: "string" } } });
  assert.deepEqual(q.properties.bare, { type: "array", items: { type: "string" } });
  assert.deepEqual(q.properties.tuple, { type: "array", items: { type: "number" } });
  assert.deepEqual(q.properties.either, { type: "array", items: { type: "array", items: { type: "string" } }, nullable: true });
});

test("buildBridgeRequest builds the right URLs and auth for each protocol", () => {
  const chat = buildBridgeRequest({ ...target("groq", "m", ["openai-chat"]), baseUrl: "https://api.groq.com/openai/v1" }, "openai-chat", { stream: true, messages: [] });
  assert.equal(chat.url, "https://api.groq.com/openai/v1/chat/completions");
  assert.equal(chat.options.headers.authorization, "Bearer k");

  const gem = buildBridgeRequest({ ...target("gemini", "g-flash", ["gemini"]), baseUrl: "https://g.example/" }, "gemini", { stream: true, messages: [] });
  assert.equal(gem.url, "https://g.example/v1beta/models/g-flash:streamGenerateContent?alt=sse");
  assert.equal(gem.options.headers["x-goog-api-key"], "k");

  const gemNo = buildBridgeRequest({ ...target("gemini", "g-flash", ["gemini"]), baseUrl: "https://g.example" }, "gemini", { messages: [] });
  assert.ok(gemNo.url.endsWith(":generateContent"));
});

// ------------------------------------------------------ response: JSON

test("openAIJsonToAnthropic maps text, tool calls and usage", () => {
  const text = openAIJsonToAnthropic({ id: "chatcmpl-1", choices: [{ message: { content: "hello" }, finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 2 } }, "claude-opus-5");
  assert.equal(text.type, "message");
  assert.equal(text.model, "claude-opus-5");
  assert.deepEqual(text.content, [{ type: "text", text: "hello" }]);
  assert.equal(text.stop_reason, "end_turn");
  assert.deepEqual(text.usage, { input_tokens: 3, output_tokens: 2 });

  const tool = openAIJsonToAnthropic({ choices: [{ message: { content: null, tool_calls: [{ id: "c1", function: { name: "read", arguments: '{"p":"a"}' } }] }, finish_reason: "tool_calls" }] }, "m");
  assert.deepEqual(tool.content[0], { type: "tool_use", id: "c1", name: "read", input: { p: "a" } });
  assert.equal(tool.stop_reason, "tool_use");

  const length = openAIJsonToAnthropic({ choices: [{ message: { content: "x" }, finish_reason: "length" }] }, "m");
  assert.equal(length.stop_reason, "max_tokens");
});

test("geminiJsonToAnthropic maps text, function calls, thoughts and usage", () => {
  const out = geminiJsonToAnthropic({
    candidates: [{ content: { parts: [{ text: "hmm", thought: true }, { text: "hi " }, { text: "there" }, { functionCall: { name: "read", args: { p: 1 } } }] }, finishReason: "STOP" }],
    usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 4 }
  }, "m");
  assert.equal(out.content[0].text, "hi there");
  assert.equal(out.content[1].type, "tool_use");
  assert.match(out.content[1].id, /^toolu_/);
  assert.deepEqual(out.content[1].input, { p: 1 });
  assert.equal(out.stop_reason, "tool_use");
  assert.deepEqual(out.usage, { input_tokens: 5, output_tokens: 4 });
});

// --------------------------------------------------------- streaming

test("sseData reassembles events split across chunks", async () => {
  const enc = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(enc.encode('data: {"a"'));
      controller.enqueue(enc.encode(':1}\n\ndata: [DONE]\n\n'));
      controller.close();
    }
  });
  const got = [];
  for await (const d of sseData(stream)) got.push(d);
  assert.deepEqual(got, ['{"a":1}', "[DONE]"]);
});

test("streamToAnthropic turns an OpenAI text stream into Anthropic events", async () => {
  const chunks = [
    JSON.stringify({ choices: [{ delta: { content: "Hel" } }] }),
    JSON.stringify({ choices: [{ delta: { content: "lo" } }] }),
    JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { completion_tokens: 7 } }),
    "[DONE]"
  ];
  const events = parseSse(await collect(streamToAnthropic("openai-chat", lines(...chunks), "claude-opus-5")));
  assert.deepEqual(events.map((e) => e.event), [
    "message_start", "content_block_start", "content_block_delta", "content_block_delta",
    "content_block_stop", "message_delta", "message_stop"
  ]);
  assert.equal(events[0].data.message.model, "claude-opus-5");
  assert.equal(events[2].data.delta.text, "Hel");
  assert.equal(events[5].data.delta.stop_reason, "end_turn");
  assert.equal(events[5].data.usage.output_tokens, 7);
});

test("streamToAnthropic assembles streamed OpenAI tool calls", async () => {
  const chunks = [
    JSON.stringify({ choices: [{ delta: { content: "Let me look." } }] }),
    JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "read", arguments: '{"pa' } }] } }] }),
    JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'th":"a"}' } }] } }] }),
    JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })
  ];
  const events = parseSse(await collect(streamToAnthropic("openai-chat", lines(...chunks), "m")));
  const names = events.map((e) => e.event);
  // text block must be closed before the tool block opens
  assert.ok(names.indexOf("content_block_stop") < names.lastIndexOf("content_block_start"));
  const start = events.find((e) => e.data.content_block?.type === "tool_use");
  assert.equal(start.data.content_block.id, "c1");
  assert.equal(start.data.content_block.name, "read");
  const json = events.filter((e) => e.data.delta?.type === "input_json_delta").map((e) => e.data.delta.partial_json).join("");
  assert.deepEqual(JSON.parse(json), { path: "a" });
  assert.equal(events.at(-2).data.delta.stop_reason, "tool_use", "finish_reason=stop with tool calls still ends as tool_use");
});

test("streamToAnthropic handles Gemini SSE text and function calls", async () => {
  const chunks = [
    JSON.stringify({ candidates: [{ content: { parts: [{ text: "Hi" }] } }] }),
    JSON.stringify({ candidates: [{ content: { parts: [{ functionCall: { name: "read", args: { p: "a" } } }] }, finishReason: "STOP" }], usageMetadata: { candidatesTokenCount: 9 } })
  ];
  const events = parseSse(await collect(streamToAnthropic("gemini", lines(...chunks), "m")));
  assert.ok(events.some((e) => e.data.delta?.text === "Hi"));
  const json = events.find((e) => e.data.delta?.type === "input_json_delta");
  assert.deepEqual(JSON.parse(json.data.delta.partial_json), { p: "a" });
  assert.equal(events.at(-2).data.delta.stop_reason, "tool_use");
  assert.equal(events.at(-2).data.usage.output_tokens, 9);
});

test("streamToAnthropic skips unparsable chunks instead of crashing", async () => {
  const events = parseSse(await collect(streamToAnthropic("openai-chat", lines("not json", JSON.stringify({ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] })), "m")));
  assert.ok(events.some((e) => e.data.delta?.text === "ok"));
});

test("estimateInputTokens returns a positive integer", () => {
  const n = estimateInputTokens({ system: "x".repeat(400), messages: [] });
  assert.ok(Number.isInteger(n) && n >= 100);
});

// -------------------------------------------------------- integration

async function withRig(t, script, envFor) {
  const upstream = await startMockUpstream(script);
  const router = await startRouter(envFor(upstream));
  t.after(async () => { await router.close(); await upstream.close(); });
  return { upstream, router };
}

const anthropicBody = (extra = {}) => ({
  model: "claude-opus-5",
  max_tokens: 1000,
  messages: [{ role: "user", content: "hi" }],
  ...extra
});

test("Claude Code request reaches an OpenAI-chat-only provider and gets an Anthropic reply", async (t) => {
  const { upstream, router } = await withRig(
    t,
    () => ({ status: 200, body: { id: "c1", choices: [{ message: { content: "pong" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } } }),
    (u) => ({ GROQ_API_KEYS: "g-key", GROQ_MODELS: "llama-x", GROQ_BASE_URL: u.baseUrl + "/openai/v1" })
  );

  const res = await router.request("/v1/messages", postJson(anthropicBody()));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.type, "message");
  assert.equal(body.model, "claude-opus-5");
  assert.equal(body.content[0].text, "pong");
  assert.equal(res.headers.get("x-multi-ai-provider"), "groq");

  const sent = upstream.apiRequests[0];
  assert.equal(sent.url, "/openai/v1/chat/completions");
  assert.equal(sent.headers.authorization, "Bearer g-key");
  assert.equal(sent.body.model, "llama-x");
  assert.equal(sent.body.messages[0].content, "hi");
});

test("streaming Claude Code request is translated to Anthropic SSE", async (t) => {
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

  const res = await router.request("/v1/messages", postJson(anthropicBody({ stream: true })));
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /text\/event-stream/);
  const events = parseSse(await res.text());
  assert.equal(events[0].event, "message_start");
  assert.equal(events.filter((e) => e.data.delta?.type === "text_delta").map((e) => e.data.delta.text).join(""), "pong");
  assert.equal(events.at(-1).event, "message_stop");
  assert.equal(upstream.apiRequests[0].body.stream, true);
});

test("Claude Code request reaches a Gemini target through generateContent", async (t) => {
  const { upstream, router } = await withRig(
    t,
    () => ({ status: 200, body: { candidates: [{ content: { parts: [{ text: "gem" }] }, finishReason: "STOP" }] } }),
    (u) => ({ GEMINI_API_KEYS: "gk", GEMINI_MODELS: "gemini-flash", GEMINI_BASE_URL: u.baseUrl })
  );

  const res = await router.request("/v1/messages", postJson(anthropicBody()));
  assert.equal(res.status, 200);
  assert.equal((await res.json()).content[0].text, "gem");
  const sent = upstream.apiRequests[0];
  assert.equal(sent.url, "/v1beta/models/gemini-flash:generateContent");
  assert.equal(sent.headers["x-goog-api-key"], "gk");
  assert.equal(sent.body.contents[0].parts[0].text, "hi");
});

test("a failing provider falls back to a different provider type", async (t) => {
  // Equal-score targets are tried alphabetically by provider, so gemini goes first and fails.
  const gem = await startMockUpstream(() => ({ status: 429, body: { error: { message: "rate limited" } } }));
  const groq = await startMockUpstream(() => ({ status: 200, body: { choices: [{ message: { role: "assistant", content: "from groq" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } } }));
  const router = await startRouter({
    GEMINI_API_KEYS: "k", GEMINI_MODELS: "flash", GEMINI_BASE_URL: gem.baseUrl,
    GROQ_API_KEYS: "g", GROQ_MODELS: "llama", GROQ_BASE_URL: groq.baseUrl + "/v1"
  });
  t.after(async () => { await router.close(); await groq.close(); await gem.close(); });

  const res = await router.request("/v1/messages", postJson(anthropicBody()));
  assert.equal(res.status, 200);
  assert.equal((await res.json()).content[0].text, "from groq");
  assert.equal(res.headers.get("x-multi-ai-provider"), "groq");
  assert.equal(gem.apiRequests.length, 1);
  assert.equal(groq.apiRequests.length, 1);
});

test("native Anthropic targets are still passed through untranslated", async (t) => {
  const { upstream, router } = await withRig(
    t,
    () => ({ status: 200, body: { type: "message", content: [{ type: "text", text: "native" }] } }),
    (u) => ({ AGENTROUTER_API_KEYS: "ar", AGENTROUTER_MODELS: "claude-opus-5", AGENTROUTER_BASE_URL: u.baseUrl })
  );
  const res = await router.request("/v1/messages", postJson(anthropicBody()));
  assert.equal((await res.json()).content[0].text, "native");
  assert.equal(upstream.apiRequests[0].url, "/v1/messages");
  assert.equal(upstream.apiRequests[0].body.max_tokens, 1000, "native body is not capped or rewritten");
});

test("count_tokens answers locally and respects client auth", async (t) => {
  const { upstream, router } = await withRig(
    t,
    () => ({ status: 200, body: {} }),
    (u) => ({ GROQ_API_KEYS: "g", GROQ_MODELS: "m", GROQ_BASE_URL: u.baseUrl + "/v1", MULTIAI_ROUTER_API_KEYS: "secret" })
  );
  const denied = await router.request("/v1/messages/count_tokens", postJson(anthropicBody()));
  assert.equal(denied.status, 401);

  const res = await router.request("/v1/messages/count_tokens", postJson(anthropicBody(), { authorization: "Bearer secret" }));
  assert.equal(res.status, 200);
  assert.ok((await res.json()).input_tokens > 0);
  assert.equal(upstream.apiRequests.length, 0, "no upstream call is made");
});
