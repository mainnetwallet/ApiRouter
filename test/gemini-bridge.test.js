import test from "node:test";
import assert from "node:assert/strict";
import {
  geminiProtocol,
  selectGeminiTargets,
  toChatFromGemini,
  buildGeminiBridgeRequest,
  chatJsonToGemini,
  streamToGemini
} from "../src/gemini-bridge.js";

const target = (provider, model, protocols, baseUrl = "http://provider") => ({
  provider, model, protocols, baseUrl, apiKey: "key", keyIndex: 0
});

test("Gemini protocol selection prefers exact model and can reach chat targets", () => {
  const targets = [
    target("groq", "other", ["openai-chat"]),
    target("groq", "gemini-model", ["openai-chat"]),
    target("gemini", "gemini-model", ["gemini"])
  ];
  assert.equal(geminiProtocol(targets[0]), "openai-chat");
  const selected = selectGeminiTargets(targets, "gemini-model");
  assert.equal(selected.modelMatched, true);
  assert.deepEqual(selected.exact.map((t) => t.provider), ["groq", "gemini"]);
  assert.deepEqual(selected.selected.map((t) => t.model), ["gemini-model", "gemini-model", "other"]);
});

test("Gemini request converts system, text, images, tools and generation config", () => {
  const body = {
    systemInstruction: { parts: [{ text: "be concise" }] },
    contents: [
      { role: "user", parts: [
        { text: "look" },
        { inlineData: { mimeType: "image/png", data: "AAAA" } }
      ] },
      { role: "model", parts: [
        { functionCall: { id: "call-1", name: "lookup", args: { q: "x" } } }
      ]},
      { role: "user", parts: [
        { functionResponse: { id: "call-1", name: "lookup", response: { value: 1 } } }
      ]}
    ],
    tools: [{ functionDeclarations: [{
      name: "lookup",
      description: "lookup data",
      parameters: { type: "object", properties: { q: { type: "string" } } }
    }]}],
    toolConfig: { functionCallingConfig: { mode: "ANY", allowedFunctionNames: ["lookup"] } },
    generationConfig: {
      temperature: 0.2,
      topP: 0.8,
      maxOutputTokens: 100,
      stopSequences: ["END"],
      responseMimeType: "application/json",
      responseSchema: { type: "object", properties: { value: { type: "string" } } }
    }
  };
  const out = toChatFromGemini(body, "chat-model");
  assert.equal(out.model, "chat-model");
  assert.equal(out.messages[0].role, "system");
  assert.equal(out.messages[1].content[0].text, "look");
  assert.match(out.messages[1].content[1].image_url.url, /^data:image\/png;base64,/);
  assert.equal(out.messages[2].tool_calls[0].function.name, "lookup");
  assert.equal(out.messages[3].role, "tool");
  assert.equal(out.tools[0].function.name, "lookup");
  assert.equal(out.tool_choice.type, "function");
  assert.equal(out.temperature, 0.2);
  assert.equal(out.top_p, 0.8);
  assert.equal(out.max_tokens, 100);
  assert.deepEqual(out.stop, ["END"]);
  assert.equal(out.response_format.type, "json_schema");
});

test("Gemini bridge builds an OpenAI chat request", () => {
  const request = buildGeminiBridgeRequest(
    target("groq", "chat-model", ["openai-chat"], "http://provider/v1"),
    { contents: [{ role: "user", parts: [{ text: "hi" }] }] },
    { "user-agent": "gemini-client" }
  );
  assert.equal(request.url, "http://provider/v1/chat/completions");
  assert.equal(request.options.headers.authorization, "Bearer key");
  assert.equal(request.options.headers["user-agent"], "gemini-client");
  assert.equal(JSON.parse(request.options.body).messages[0].content, "hi");
});

test("Gemini bridge asks the upstream for a stream, and for the target's model", () => {
  const request = buildGeminiBridgeRequest(
    target("groq", "configured-model", ["openai-chat"], "http://provider/v1"),
    { contents: [{ role: "user", parts: [{ text: "hi" }] }] },
    {},
    { stream: true }
  );
  const payload = JSON.parse(request.options.body);
  assert.equal(payload.stream, true);
  assert.equal(payload.model, "configured-model");
  assert.equal(request.options.headers.accept, "text/event-stream");
});

test("Chat response converts back to Gemini generateContent shape", () => {
  const out = chatJsonToGemini({
    choices: [{
      message: {
        role: "assistant",
        content: "hello",
        tool_calls: [{
          id: "call-1",
          type: "function",
          function: { name: "lookup", arguments: "{\"q\":\"x\"}" }
        }]
      },
      finish_reason: "tool_calls"
    }],
    usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 }
  });
  assert.equal(out.candidates[0].content.role, "model");
  assert.equal(out.candidates[0].content.parts[0].text, "hello");
  assert.equal(out.candidates[0].content.parts[1].functionCall.name, "lookup");
  assert.deepEqual(out.candidates[0].content.parts[1].functionCall.args, { q: "x" });
  assert.equal(out.candidates[0].finishReason, "STOP");
  assert.equal(out.usageMetadata.totalTokenCount, 8);
});

test("Chat SSE converts to Gemini SSE", async () => {
  async function* events() {
    yield JSON.stringify({ id: "x", choices: [{ delta: { role: "assistant", content: "hel" }, finish_reason: null }] });
    yield JSON.stringify({ id: "x", choices: [{ delta: { content: "lo" }, finish_reason: null }] });
    yield JSON.stringify({ id: "x", choices: [{ delta: {}, finish_reason: "stop" }] });
    yield "[DONE]";
  }
  const chunks = [];
  for await (const event of streamToGemini(events())) chunks.push(event);
  assert.equal(chunks.length, 3);
  assert.match(chunks[0], /"text":"hel"/);
  assert.match(chunks[1], /"text":"lo"/);
  assert.match(chunks[2], /"finishReason":"STOP"/);
});

test("malformed upstream SSE events are skipped, not fatal", async () => {
  async function* events() {
    yield "not json at all";
    yield JSON.stringify({ choices: [{ delta: { content: "ok" }, finish_reason: null }] });
    yield "{broken";
    yield JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] });
  }
  const chunks = [];
  for await (const event of streamToGemini(events())) chunks.push(event);
  assert.equal(chunks.length, 2);
  assert.match(chunks[0], /"text":"ok"/);
  assert.match(chunks[1], /"finishReason":"STOP"/);
});

test("an upstream error event reaches the client", async () => {
  async function* events() {
    yield JSON.stringify({ error: { message: "upstream exploded" } });
  }
  const chunks = [];
  for await (const event of streamToGemini(events())) chunks.push(event);
  assert.equal(chunks.length, 1);
  assert.match(chunks[0], /upstream exploded/);
});

test("tool calls still arrive when the upstream never sends a finish reason", async () => {
  async function* events() {
    yield JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "lookup", arguments: "{}" } }] }, finish_reason: null }] });
  }
  const chunks = [];
  for await (const event of streamToGemini(events())) chunks.push(event);
  const parts = chunks.flatMap((c) => JSON.parse(c.slice(5)).candidates[0].content.parts);
  assert.equal(parts.length, 1);
  assert.equal(parts[0].functionCall.name, "lookup");
});

// ---------------------------------------------------------------------------
// toolConfig.functionCallingConfig translation
//
// Gemini can say "call one of exactly these N functions". OpenAI-compatible
// APIs cannot express that in `tool_choice` alone, so the bridge preserves the
// restriction by narrowing the declarations it forwards and saying `required`.
// ---------------------------------------------------------------------------

const toolBody = (functionCallingConfig, names = ["lookup", "search", "delete"]) => ({
  contents: [{ role: "user", parts: [{ text: "hi" }] }],
  tools: [{
    functionDeclarations: names.map((name) => ({
      name,
      description: `${name} it`,
      parameters: { type: "object", properties: { q: { type: "string" } } }
    }))
  }],
  ...(functionCallingConfig ? { toolConfig: { functionCallingConfig } } : {})
});

test("mode NONE disables tool use", () => {
  const out = toChatFromGemini(toolBody({ mode: "NONE" }), "m");
  assert.equal(out.tool_choice, "none");
});

test("mode ANY with a single allowed function asks for that function by name", () => {
  const out = toChatFromGemini(toolBody({ mode: "ANY", allowedFunctionNames: ["lookup"] }), "m");
  assert.deepEqual(out.tool_choice, { type: "function", function: { name: "lookup" } });
  // The other declarations stay available; the choice alone carries the restriction.
  assert.equal(out.tools.length, 3);
});

test("mode ANY with several allowed functions is preserved, not degraded", () => {
  const out = toChatFromGemini(
    toolBody({ mode: "ANY", allowedFunctionNames: ["lookup", "search"] }),
    "m"
  );

  assert.equal(out.tool_choice, "required");
  // Only the allowed declarations are forwarded, so `required` can only select
  // among them: the upstream cannot emit a call to `delete`.
  assert.deepEqual(out.tools.map((tool) => tool.function.name), ["lookup", "search"]);
});

test("mode ANY with an empty allowed list falls back to required with every tool", () => {
  const out = toChatFromGemini(toolBody({ mode: "ANY", allowedFunctionNames: [] }), "m");
  assert.equal(out.tool_choice, "required");
  assert.deepEqual(out.tools.map((tool) => tool.function.name), ["lookup", "search", "delete"]);
});

test("mode ANY naming a function with no declaration falls back to required", () => {
  // The restriction cannot be represented when the name has no schema to send,
  // so the bridge keeps the "must call a tool" half and drops the name list.
  const out = toChatFromGemini(
    toolBody({ mode: "ANY", allowedFunctionNames: ["lookup", "not-declared"] }),
    "m"
  );
  assert.equal(out.tool_choice, "required");
  assert.deepEqual(out.tools.map((tool) => tool.function.name), ["lookup", "search", "delete"]);
});

test("mode ANY naming every declared function is equivalent to required", () => {
  const out = toChatFromGemini(
    toolBody({ mode: "ANY", allowedFunctionNames: ["lookup", "search", "delete"] }),
    "m"
  );
  assert.equal(out.tool_choice, "required");
  assert.deepEqual(out.tools.map((tool) => tool.function.name), ["lookup", "search", "delete"]);
});

test("mode AUTO with allowed names hides the excluded declarations", () => {
  const out = toChatFromGemini(toolBody({ mode: "AUTO", allowedFunctionNames: ["lookup"] }), "m");
  assert.equal(out.tool_choice, undefined);
  assert.deepEqual(out.tools.map((tool) => tool.function.name), ["lookup"]);
});

test("no toolConfig leaves the declarations and the choice untouched", () => {
  const out = toChatFromGemini(toolBody(null), "m");
  assert.equal(out.tool_choice, undefined);
  assert.deepEqual(out.tools.map((tool) => tool.function.name), ["lookup", "search", "delete"]);
});
