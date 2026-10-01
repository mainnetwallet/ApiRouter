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
    "chat-model",
    { "user-agent": "gemini-client" }
  );
  assert.equal(request.url, "http://provider/v1/chat/completions");
  assert.equal(request.options.headers.authorization, "Bearer key");
  assert.equal(request.options.headers["user-agent"], "gemini-client");
  assert.equal(JSON.parse(request.options.body).messages[0].content, "hi");
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
  }, "gemini-model");
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
  for await (const event of streamToGemini(events(), "gemini-model")) chunks.push(event);
  assert.equal(chunks.length, 3);
  assert.match(chunks[0], /"text":"hel"/);
  assert.match(chunks[1], /"text":"lo"/);
  assert.match(chunks[2], /"finishReason":"STOP"/);
});
