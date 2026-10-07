import test from "node:test";
import assert from "node:assert/strict";

import {
  rememberSignature, signatureFor, clearSignatures, signatureStats, ensureCallSignatures,
  requiresThoughtSignature, runInSignatureScope, enterSignatureScope, MAX_SIGNATURES, SIGNATURE_TTL_MS, SKIP_THOUGHT_SIGNATURE
} from "../src/thought-signatures.js";
import { geminiJsonToAnthropic, toGeminiRequest } from "../src/anthropic-bridge.js";
import { streamToChat } from "../src/chat-bridge.js";
import { toGeminiFromChat } from "../src/chat-bridge.js";

test.beforeEach(() => clearSignatures());

test("signatures are scoped to a session: another session cannot read an id it did not create", () => {
  runInSignatureScope("session-a", () => rememberSignature("call_1", "SIG-A"));
  assert.equal(runInSignatureScope("session-a", () => signatureFor("call_1")), "SIG-A");
  assert.equal(runInSignatureScope("session-b", () => signatureFor("call_1")), undefined, "id reuse across sessions finds nothing");
  rememberSignature("call_1", "SIG-B", { scope: "session-b" });
  assert.equal(runInSignatureScope("session-a", () => signatureFor("call_1")), "SIG-A", "and writing does not clobber the other session");
});

test("the scope follows the async context, including a stream consumed later", async () => {
  const gemini = { candidates: [{ content: { parts: [{ functionCall: { name: "f", args: {} }, thoughtSignature: "STREAM-SIG" }] } }] };
  let id;
  await runInSignatureScope("s1", async () => {
    await new Promise((resolve) => setTimeout(resolve, 5));
    id = geminiJsonToAnthropic(gemini, "m").content[0].id;
  });
  assert.equal(runInSignatureScope("s1", () => signatureFor(id)), "STREAM-SIG");
  assert.equal(runInSignatureScope("s2", () => signatureFor(id)), undefined);

  async function* upstream() { yield JSON.stringify(gemini); }
  await runInSignatureScope("s3", async () => { for await (const _ of streamToChat("gemini", upstream(), "m")) { /* drain */ } });
  assert.equal(signatureStats().size, 2, "the streamed call stored its signature in the session that made it");
});

test("enterSignatureScope scopes everything after it in the same async chain", async () => {
  await Promise.resolve().then(async () => {
    enterSignatureScope("entered");
    rememberSignature("x", "S");
    await new Promise((resolve) => setTimeout(resolve, 1));
    assert.equal(signatureFor("x"), "S");
  });
  assert.equal(signatureFor("x"), undefined, "outside that chain the default scope sees nothing");
});

test("the store is bounded (LRU) and a read refreshes an entry", () => {
  for (let i = 0; i < MAX_SIGNATURES; i += 1) rememberSignature(`id-${i}`, `s${i}`);
  assert.equal(signatureFor("id-0"), "s0", "reading id-0 makes it the most recently used");
  rememberSignature("overflow", "s");
  assert.equal(signatureStats().size, MAX_SIGNATURES);
  assert.equal(signatureFor("id-0"), "s0", "the refreshed entry survived");
  assert.equal(signatureFor("id-1"), undefined, "the least recently used one was evicted");
});

test("an entry unused for the TTL expires", () => {
  rememberSignature("old", "S", { now: 1000 });
  assert.equal(signatureFor("old", { now: 1000 + SIGNATURE_TTL_MS - 1 }), "S");
  rememberSignature("older", "S", { now: 1000 });
  assert.equal(signatureFor("older", { now: 1000 + SIGNATURE_TTL_MS + 1 }), undefined);
});

test("only Gemini 3+ models require a signature", () => {
  assert.equal(requiresThoughtSignature("gemini-3-pro-preview"), true);
  assert.equal(requiresThoughtSignature("models/gemini-3.1-flash"), true);
  assert.equal(requiresThoughtSignature("gemini-2.5-pro"), false);
  assert.equal(requiresThoughtSignature("llama-3"), false);
});

test("a lost signature never produces a request Gemini 3 is certain to reject", () => {
  const history = { messages: [
    { role: "user", content: "go" },
    { role: "assistant", content: [{ type: "tool_use", id: "toolu_gone", name: "f", input: {} }, { type: "tool_use", id: "toolu_gone2", name: "g", input: {} }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_gone", content: "a" }, { type: "tool_result", tool_use_id: "toolu_gone2", content: "b" }] }
  ] };
  const g3 = toGeminiRequest(history, { model: "gemini-3-pro" }).contents[1].parts;
  assert.equal(g3[0].thoughtSignature, SKIP_THOUGHT_SIGNATURE, "the first call of the turn gets the documented placeholder");
  assert.equal(g3[1].thoughtSignature, undefined, "later parallel calls need none");
  const g25 = toGeminiRequest(history, { model: "gemini-2.5-pro" }).contents[1].parts;
  assert.equal(g25[0].thoughtSignature, undefined, "models that do not validate are left alone");
});

test("a real stored signature always wins over the placeholder, on every client protocol", () => {
  const gemini = { candidates: [{ content: { parts: [{ functionCall: { name: "f", args: { a: 1 } }, thoughtSignature: "REAL" }] } }] };
  const id = geminiJsonToAnthropic(gemini, "m").content[0].id;
  const anthropic = toGeminiRequest({ messages: [
    { role: "assistant", content: [{ type: "tool_use", id, name: "f", input: { a: 1 } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "r" }] }
  ] }, { model: "gemini-3-pro" });
  assert.equal(anthropic.contents[0].parts[0].thoughtSignature, "REAL");

  const chat = toGeminiFromChat({ messages: [
    { role: "assistant", content: null, tool_calls: [{ id, type: "function", function: { name: "f", arguments: "{\"a\":1}" } }] },
    { role: "tool", tool_call_id: id, content: "r" }
  ] }, { model: "gemini-3-pro" });
  assert.equal(chat.contents[0].parts[0].thoughtSignature, "REAL");
});

test("ensureCallSignatures only touches model turns that contain function calls", () => {
  const contents = [{ role: "user", parts: [{ text: "x" }] }, { role: "model", parts: [{ text: "y" }] }, { role: "model", parts: [{ functionCall: { name: "f", args: {} } }] }];
  ensureCallSignatures(contents, "gemini-3-flash");
  assert.equal(contents[1].parts[0].thoughtSignature, undefined);
  assert.equal(contents[2].parts[0].thoughtSignature, SKIP_THOUGHT_SIGNATURE);
});
