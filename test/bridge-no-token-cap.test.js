import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { toOpenAIChatRequest, toGeminiRequest } from "../src/anthropic-bridge.js";
import { startMockUpstream } from "../test-helpers/mock-upstream.js";
import { startRouter, postJson } from "../test-helpers/router-harness.js";

// The Anthropic bridge imposes no token limit of its own. A client's max_tokens
// is forwarded as sent (OpenAI `max_tokens`, Gemini `generationConfig.maxOutputTokens`);
// a client that sends none gets none added. Native Anthropic is passed through.

const messages = [{ role: "user", content: "hi" }];
const SENT = [100, 99999, 1, 64000, 1000000];

// ---------------------------------------------------------------- unit level

test("OpenAI bridge: the client's max_tokens is forwarded unchanged, whatever its size", () => {
  for (const value of SENT) {
    assert.equal(toOpenAIChatRequest({ max_tokens: value, messages }, "m").max_tokens, value, String(value));
  }
});

test("OpenAI bridge: no client max_tokens means no max_tokens is invented", () => {
  for (const body of [{ messages }, { max_tokens: null, messages }]) {
    const out = toOpenAIChatRequest(body, "m");
    assert.equal("max_tokens" in out, false, JSON.stringify(body));
  }
});

test("Gemini bridge: the client's max_tokens becomes generationConfig.maxOutputTokens unchanged", () => {
  for (const value of SENT) {
    assert.equal(toGeminiRequest({ max_tokens: value, messages }).generationConfig.maxOutputTokens, value, String(value));
  }
});

test("Gemini bridge: no client max_tokens means no maxOutputTokens is invented", () => {
  for (const body of [{ messages }, { max_tokens: null, messages }]) {
    assert.equal("maxOutputTokens" in toGeminiRequest(body).generationConfig, false, JSON.stringify(body));
  }
  // The other generation settings are unaffected.
  const out = toGeminiRequest({ temperature: 0.3, top_p: 0.9, stop_sequences: ["END"], messages });
  assert.deepEqual(out.generationConfig, { temperature: 0.3, topP: 0.9, stopSequences: ["END"] });
});

// ------------------------------------------------------------ through the router

const chatOk = { id: "c1", object: "chat.completion", created: 0, model: "u", choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } };
const geminiOk = { candidates: [{ content: { role: "model", parts: [{ text: "ok" }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 } };
const nativeOk = { id: "m1", type: "message", role: "assistant", model: "m", content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } };

async function rig(t, okBody, envFor, extraEnv = {}) {
  const upstream = await startMockUpstream(() => ({ status: 200, body: okBody }));
  const router = await startRouter({ ...envFor(upstream), ...extraEnv });
  t.after(async () => { await router.close(); await upstream.close(); });
  // One request per case; each case's upstream body is read back in order.
  const send = async (maxTokens) => {
    const body = { model: "m", messages };
    if (maxTokens !== undefined) body.max_tokens = maxTokens;
    const res = await router.request("/v1/messages", postJson(body));
    assert.equal(res.status, 200, `max_tokens=${maxTokens} -> ${res.status}`);
    return upstream.apiRequests.at(-1).body;
  };
  return { upstream, send };
}

const openaiEnv = (u) => ({ GROQ_API_KEYS: "k", GROQ_MODELS: "m", GROQ_BASE_URL: u.baseUrl });
const geminiEnv = (u) => ({ GEMINI_API_KEYS: "k", GEMINI_MODELS: "m", GEMINI_BASE_URL: u.baseUrl });
const nativeEnv = (u) => ({ AGENTROUTER_API_KEYS: "k", AGENTROUTER_MODELS: "m", AGENTROUTER_BASE_URL: u.baseUrl });

test("OpenAI upstream receives the client's max_tokens: 100, 99999 and 1 exactly", async (t) => {
  const { send } = await rig(t, chatOk, openaiEnv);
  for (const value of [100, 99999, 1]) assert.equal((await send(value)).max_tokens, value);
});

test("OpenAI upstream receives no max_tokens when the client sends none", async (t) => {
  const { send } = await rig(t, chatOk, openaiEnv);
  const body = await send(undefined);
  assert.equal("max_tokens" in body, false, JSON.stringify(body));
});

test("Gemini upstream receives the client's value as generationConfig.maxOutputTokens", async (t) => {
  const { send } = await rig(t, geminiOk, geminiEnv);
  for (const value of [100, 99999, 1]) assert.equal((await send(value)).generationConfig.maxOutputTokens, value);
});

test("Gemini upstream receives no maxOutputTokens when the client sends none", async (t) => {
  const { send } = await rig(t, geminiOk, geminiEnv);
  const body = await send(undefined);
  assert.equal("maxOutputTokens" in (body.generationConfig || {}), false, JSON.stringify(body));
});

test("native Anthropic passthrough is unchanged: value forwarded as sent, none added", async (t) => {
  const { send } = await rig(t, nativeOk, nativeEnv);
  for (const value of [100, 99999, 1]) assert.equal((await send(value)).max_tokens, value);
  const body = await send(undefined);
  assert.equal("max_tokens" in body, false, JSON.stringify(body));
});

test("the removed environment variable has no effect on either bridge", async (t) => {
  // Name built in pieces so this file is not itself a reference to it.
  const removed = ["BRIDGE", "MAX", "TOKENS"].join("_");
  for (const [okBody, envFor, pick] of [
    [chatOk, openaiEnv, (b) => b.max_tokens],
    [geminiOk, geminiEnv, (b) => b.generationConfig.maxOutputTokens]
  ]) {
    const { send } = await rig(t, okBody, envFor, { [removed]: "50" });
    assert.equal(pick(await send(100)), 100);
    assert.equal(pick(await send(99999)), 99999);
  }
});

// ------------------------------------------------- nothing left in the repository

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SKIP_DIRS = new Set(["node_modules", ".git"]);

function* repoFiles(dir) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const full = path.join(dir, name);
    const info = statSync(full);
    if (info.isDirectory()) yield* repoFiles(full);
    else if (info.size < 5 * 1024 * 1024) yield full;
  }
}

test("no reference to the removed cap remains anywhere in the repository", () => {
  // Built in pieces so this file does not contain what it searches for.
  const forbidden = [["BRIDGE", "MAX", "TOKENS"].join("_"), "DEFAULT_" + "MAX_TOKENS_CAP", "maxTokens" + "For"];
  const hits = [];
  for (const file of repoFiles(ROOT)) {
    const text = readFileSync(file, "utf8");
    for (const word of forbidden) if (text.includes(word)) hits.push(`${path.relative(ROOT, file)}: ${word}`);
  }
  assert.deepEqual(hits, []);
});

test("the Anthropic bridge source holds no hardcoded token ceiling", () => {
  const source = readFileSync(path.join(ROOT, "src", "anthropic-bridge.js"), "utf8");
  assert.ok(!/\b8192\b/.test(source), "the old 8192 cap must not reappear");
  assert.ok(!/Math\.min\([^)]*max_tokens|max_tokens[^;\n]*Math\.min/.test(source), "no min() clamp on max_tokens");
});
