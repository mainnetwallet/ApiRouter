import test from "node:test";
import assert from "node:assert/strict";
import { ensureThoughtSignatures, isSignatureRejection, SKIP_THOUGHT_SIGNATURE } from "../src/gemini-signature.js";
import { toGeminiRequest, rememberSignature } from "../src/anthropic-bridge.js";
import { toGeminiFromChat } from "../src/chat-bridge.js";
import { toGeminiFromResponses } from "../src/codex-bridge.js";
import { buildUpstreamRequest } from "../src/adapters.js";

const calls = (payload) => payload.contents.flatMap((c) => c.parts).filter((p) => p.functionCall);

test("placeholder goes on the first functionCall of a model turn only", () => {
  const out = ensureThoughtSignatures([
    { role: "user", parts: [{ text: "hi" }] },
    { role: "model", parts: [{ functionCall: { name: "a", args: {} } }, { functionCall: { name: "b", args: {} } }] }
  ]);
  const [first, second] = out[1].parts;
  assert.equal(first.thoughtSignature, SKIP_THOUGHT_SIGNATURE);
  assert.equal(second.thoughtSignature, undefined);
});

test("a real signature is never replaced, and the input is not mutated", () => {
  const input = [{ role: "model", parts: [{ functionCall: { name: "a", args: {} }, thoughtSignature: "real" }] }];
  assert.equal(ensureThoughtSignatures(input)[0].parts[0].thoughtSignature, "real");

  const bare = [{ role: "model", parts: [{ functionCall: { name: "a", args: {} } }] }];
  ensureThoughtSignatures(bare);
  assert.equal(bare[0].parts[0].thoughtSignature, undefined);
});

test("Anthropic request: cache miss gets the placeholder, cache hit keeps the real signature", () => {
  rememberSignature("toolu_hit", "REAL_SIG");
  const body = (id) => ({
    messages: [
      { role: "user", content: "go" },
      { role: "assistant", content: [{ type: "tool_use", id, name: "t", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "ok" }] }
    ]
  });
  assert.equal(calls(toGeminiRequest(body("toolu_miss")))[0].thoughtSignature, SKIP_THOUGHT_SIGNATURE);
  assert.equal(calls(toGeminiRequest(body("toolu_hit")))[0].thoughtSignature, "REAL_SIG");
});

test("chat-completions request from another provider's history gets the placeholder", () => {
  const payload = toGeminiFromChat({
    messages: [
      { role: "user", content: "go" },
      { role: "assistant", content: null, tool_calls: [{ id: "call_x", type: "function", function: { name: "t", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "call_x", content: "ok" }
    ]
  });
  assert.equal(calls(payload)[0].thoughtSignature, SKIP_THOUGHT_SIGNATURE);
});

test("Responses request: parallel calls merge into one turn, only the first is signed", () => {
  const payload = toGeminiFromResponses({
    input: [
      { type: "message", role: "user", content: "go" },
      { type: "function_call", call_id: "c1", name: "a", arguments: "{}" },
      { type: "function_call", call_id: "c2", name: "b", arguments: "{}" },
      { type: "function_call_output", call_id: "c1", output: "1" },
      { type: "function_call_output", call_id: "c2", output: "2" }
    ]
  });
  const [a, b] = calls(payload);
  assert.equal(a.thoughtSignature, SKIP_THOUGHT_SIGNATURE);
  assert.equal(b.thoughtSignature, undefined);
});

test("native Gemini passthrough adds the placeholder without touching the client's body", () => {
  const body = { contents: [{ role: "model", parts: [{ functionCall: { name: "a", args: {} } }] }] };
  const target = { provider: "gemini", baseUrl: "https://generativelanguage.googleapis.com", apiKey: "k", model: "gemini-3.8-flash" };
  const { options } = buildUpstreamRequest(target, "gemini", body);
  assert.equal(JSON.parse(options.body).contents[0].parts[0].thoughtSignature, SKIP_THOUGHT_SIGNATURE);
  assert.equal(body.contents[0].parts[0].thoughtSignature, undefined);
});

test("signature rejections are recognised", () => {
  assert.ok(isSignatureRejection("Function call is missing a thought_signature in functionCall parts"));
  assert.ok(isSignatureRejection("Corrupted thought signature."));
  assert.ok(!isSignatureRejection("Invalid JSON payload received"));
});
