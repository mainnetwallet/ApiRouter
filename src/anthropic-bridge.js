import { randomUUID } from "node:crypto";
import { ensureThoughtSignatures } from "./gemini-signature.js";

/**
 * Anthropic Messages bridge.
 *
 * Claude Code speaks Anthropic's /v1/messages protocol. Most providers only
 * speak OpenAI chat-completions (or Gemini generateContent). This module
 * translates requests and responses (including streaming and tool calls) so a
 * Claude Code request can fall back to ANY configured provider.
 */

/** Which upstream protocol a target is called with for an Anthropic client. */
export function bridgeProtocol(target) {
  const protocols = Array.isArray(target?.protocols) ? target.protocols : [];
  if (protocols.includes("anthropic")) return "anthropic";
  if (protocols.includes("openai-chat")) return "openai-chat";
  if (protocols.includes("gemini")) return "gemini";
  return null;
}

/**
 * Target selection for Anthropic clients: every target is eligible (native or
 * translated). Exact model matches come first, everything else follows, so a
 * failing preferred model falls back to the rest instead of ending the request.
 */
export function selectBridgeTargets(targets, requestedModel) {
  const compatible = (Array.isArray(targets) ? targets : []).filter((t) => bridgeProtocol(t));
  const model = typeof requestedModel === "string" && requestedModel ? requestedModel : "";
  const exact = model ? compatible.filter((t) => t.model === model) : [];
  const rest = compatible.filter((t) => !exact.includes(t));
  return {
    protocol: "anthropic",
    requestedModel: model || null,
    modelMatched: exact.length > 0,
    compatible,
    exact,
    selected: exact.length > 0 ? [...exact, ...rest] : compatible
  };
}

// ---------------------------------------------------------------- helpers

function blocksOf(content) {
  if (typeof content === "string") return [{ type: "text", text: content }];
  return Array.isArray(content) ? content : [];
}

function textOfBlocks(content) {
  return blocksOf(content)
    .map((b) => (b?.type === "text" ? b.text ?? "" : b?.type === "image" ? "[image]" : ""))
    .join("\n");
}

function systemText(system) {
  if (!system) return "";
  if (typeof system === "string") return system;
  return textOfBlocks(system);
}

function safeParse(text) {
  try { return JSON.parse(text); } catch { return {}; }
}

/** Gemini rejects most JSON-Schema extras; keep only what it understands. */
export function cleanSchemaForGemini(schema) {
  if (Array.isArray(schema)) return schema.map(cleanSchemaForGemini);
  if (!schema || typeof schema !== "object") return schema;

  // Gemini has no anyOf/oneOf/allOf here: collapse to the first non-null
  // variant so the node keeps a usable type instead of becoming `{}`.
  const variants = schema.anyOf || schema.oneOf || schema.allOf;
  if (Array.isArray(variants) && variants.length) {
    const pick = variants.find((v) => v && v.type !== "null") || variants[0];
    const { anyOf, oneOf, allOf, ...rest } = schema;
    const merged = cleanSchemaForGemini({ ...pick, ...rest });
    if (variants.some((v) => v && v.type === "null")) merged.nullable = true;
    return merged;
  }

  const allowed = ["type", "description", "enum", "properties", "required", "items", "nullable"];
  const out = {};
  for (const key of allowed) {
    if (!(key in schema)) continue;
    if (key === "type" && Array.isArray(schema.type)) {
      const nonNull = schema.type.filter((t) => t !== "null");
      out.type = nonNull[0] || "string";
      if (schema.type.includes("null")) out.nullable = true;
    } else if (key === "properties") {
      out.properties = Object.fromEntries(
        Object.entries(schema.properties || {}).map(([k, v]) => [k, cleanSchemaForGemini(v)])
      );
    } else if (key === "items") {
      // Tuple-style `items: [...]` is not supported; use the first entry.
      const item = Array.isArray(schema.items) ? schema.items[0] : schema.items;
      out.items = cleanSchemaForGemini(item);
    } else {
      out[key] = schema[key];
    }
  }
  if (!out.type && out.properties) out.type = "object";
  if (!out.type && out.items) out.type = "array";
  // Gemini requires every array node (at any depth) to declare `items`, and
  // every node to declare a `type`.
  if (out.type === "array" && (!out.items || typeof out.items !== "object")) out.items = { type: "string" };
  if (!out.type) out.type = "string";
  return out;
}

// ------------------------------------------------- request -> OpenAI chat

export function toOpenAIChatRequest(body, model) {
  const messages = [];
  const sys = systemText(body.system);
  if (sys) messages.push({ role: "system", content: sys });

  for (const msg of body.messages || []) {
    const blocks = blocksOf(msg.content);

    if (msg.role === "assistant") {
      const text = blocks.filter((b) => b.type === "text").map((b) => b.text ?? "").join("");
      const toolCalls = blocks
        .filter((b) => b.type === "tool_use")
        .map((b) => ({
          id: b.id,
          type: "function",
          function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) }
        }));
      const out = { role: "assistant", content: text };
      if (toolCalls.length) out.tool_calls = toolCalls;
      if (text || toolCalls.length) messages.push(out);
      continue;
    }

    // user: tool results first (they must follow the assistant tool_calls),
    // then the remaining text/images.
    for (const b of blocks.filter((x) => x.type === "tool_result")) {
      const content = typeof b.content === "string" ? b.content : textOfBlocks(b.content);
      messages.push({
        role: "tool",
        tool_call_id: b.tool_use_id,
        content: b.is_error ? "Error: " + content : content
      });
    }
    const rest = blocks.filter((b) => b.type === "text" || b.type === "image");
    if (rest.length === 0) continue;
    const hasImage = rest.some((b) => b.type === "image");
    if (!hasImage) {
      messages.push({ role: "user", content: rest.map((b) => b.text ?? "").join("\n") });
    } else {
      messages.push({
        role: "user",
        content: rest.map((b) =>
          b.type === "image" && b.source?.type === "base64"
            ? { type: "image_url", image_url: { url: `data:${b.source.media_type};base64,${b.source.data}` } }
            : b.type === "image" && b.source?.url
              ? { type: "image_url", image_url: { url: b.source.url } }
              : { type: "text", text: b.text ?? "" })
      });
    }
  }

  const payload = { model, messages, stream: body.stream === true };
  // Ask an OpenAI-compatible upstream to report usage in its final stream chunk. This
  // request is built here and its stream is translated before the client sees it, so the
  // extra usage-only chunk never reaches the client as-is.
  if (payload.stream) payload.stream_options = { include_usage: true };
  // The client's own limit is forwarded as sent; when it sends none, none is added.
  if (body.max_tokens !== undefined && body.max_tokens !== null) payload.max_tokens = body.max_tokens;
  if (typeof body.temperature === "number") payload.temperature = body.temperature;
  if (typeof body.top_p === "number") payload.top_p = body.top_p;
  if (Array.isArray(body.stop_sequences) && body.stop_sequences.length) {
    payload.stop = body.stop_sequences.slice(0, 4);
  }
  if (Array.isArray(body.tools) && body.tools.length) {
    payload.tools = body.tools.map((t) => ({
      type: "function",
      function: {
        name: t.name,
        description: t.description || "",
        parameters: t.input_schema || { type: "object", properties: {} }
      }
    }));
    const tc = body.tool_choice;
    if (tc?.type === "any") payload.tool_choice = "required";
    else if (tc?.type === "none") payload.tool_choice = "none";
    else if (tc?.type === "tool" && tc.name) payload.tool_choice = { type: "function", function: { name: tc.name } };
    else if (tc?.type === "auto") payload.tool_choice = "auto";
  }
  return payload;
}

// ------------------------------------------------------ request -> Gemini

// Gemini 3 needs the thoughtSignature echoed back with a functionCall. The
// Anthropic protocol has no field for it, so keep it keyed by tool id.
const signatures = new Map();
const MAX_SIGNATURES = 2000;
export function rememberSignature(id, signature) {
  if (!signature) return;
  signatures.set(id, signature);
  while (signatures.size > MAX_SIGNATURES) signatures.delete(signatures.keys().next().value);
}

export function signatureFor(id) {
  return signatures.get(id);
}

export function toGeminiRequest(body) {
  const toolNames = new Map();
  for (const msg of body.messages || []) {
    for (const b of blocksOf(msg.content)) if (b.type === "tool_use") toolNames.set(b.id, b.name);
  }

  const contents = [];
  const push = (role, parts) => {
    if (!parts.length) return;
    const last = contents.at(-1);
    if (last && last.role === role) last.parts.push(...parts);
    else contents.push({ role, parts });
  };

  for (const msg of body.messages || []) {
    const blocks = blocksOf(msg.content);
    const parts = [];
    for (const b of blocks) {
      if (b.type === "text") {
        if (b.text) parts.push({ text: b.text });
      } else if (b.type === "image" && b.source?.type === "base64") {
        parts.push({ inlineData: { mimeType: b.source.media_type, data: b.source.data } });
      } else if (b.type === "tool_use") {
        const part = { functionCall: { name: b.name, args: b.input ?? {} } };
        const sig = signatures.get(b.id);
        if (sig) part.thoughtSignature = sig;
        parts.push(part);
      } else if (b.type === "tool_result") {
        const content = typeof b.content === "string" ? b.content : textOfBlocks(b.content);
        parts.push({
          functionResponse: {
            name: toolNames.get(b.tool_use_id) || "tool",
            response: b.is_error ? { error: content } : { output: content }
          }
        });
      }
    }
    push(msg.role === "assistant" ? "model" : "user", parts);
  }

  const payload = { contents: ensureThoughtSignatures(contents), generationConfig: {} };
  // The client's own limit is forwarded as sent; when it sends none, none is added.
  if (body.max_tokens !== undefined && body.max_tokens !== null) payload.generationConfig.maxOutputTokens = body.max_tokens;
  const sys = systemText(body.system);
  if (sys) payload.systemInstruction = { parts: [{ text: sys }] };
  if (typeof body.temperature === "number") payload.generationConfig.temperature = body.temperature;
  if (typeof body.top_p === "number") payload.generationConfig.topP = body.top_p;
  if (Array.isArray(body.stop_sequences) && body.stop_sequences.length) {
    payload.generationConfig.stopSequences = body.stop_sequences.slice(0, 5);
  }
  if (Array.isArray(body.tools) && body.tools.length) {
    payload.tools = [{
      functionDeclarations: body.tools.map((t) => ({
        name: t.name,
        description: t.description || "",
        parameters: cleanSchemaForGemini(t.input_schema || { type: "object", properties: {} })
      }))
    }];
    const tc = body.tool_choice;
    if (tc?.type === "any") payload.toolConfig = { functionCallingConfig: { mode: "ANY" } };
    else if (tc?.type === "none") payload.toolConfig = { functionCallingConfig: { mode: "NONE" } };
    else if (tc?.type === "tool" && tc.name) {
      payload.toolConfig = { functionCallingConfig: { mode: "ANY", allowedFunctionNames: [tc.name] } };
    }
  }
  return payload;
}

function joinUrl(baseUrl, suffix) {
  const base = String(baseUrl || "").replace(/\/+$/, "");
  return base + "/" + String(suffix || "").replace(/^\/+/, "");
}

/** Builds the upstream fetch request for a translated (non-Anthropic) target. */
export function buildBridgeRequest(target, upstreamProtocol, body, incomingHeaders = {}) {
  const headers = { "content-type": "application/json" };
  if (incomingHeaders["user-agent"]) headers["user-agent"] = incomingHeaders["user-agent"];
  const base = String(target.baseUrl || "").replace(/\/+$/, "");
  const stream = body.stream === true;

  if (upstreamProtocol === "openai-chat") {
    headers.accept = stream ? "text/event-stream" : "application/json";
    headers.authorization = "Bearer " + target.apiKey;
    const url = joinUrl(base, /\/v\d+$/i.test(base) ? "chat/completions" : "v1/chat/completions");
    return { url, options: { method: "POST", headers, body: JSON.stringify(toOpenAIChatRequest(body, target.model)) } };
  }
  if (upstreamProtocol === "gemini") {
    headers.accept = stream ? "text/event-stream" : "application/json";
    headers["x-goog-api-key"] = target.apiKey;
    const method = stream ? ":streamGenerateContent?alt=sse" : ":generateContent";
    const url = joinUrl(base, "v1beta/models/" + encodeURIComponent(target.model) + method);
    return { url, options: { method: "POST", headers, body: JSON.stringify(toGeminiRequest(body)) } };
  }
  throw new Error("Unsupported bridge protocol: " + upstreamProtocol);
}

// ------------------------------------------------ response -> Anthropic

const STOP_REASONS = { stop: "end_turn", length: "max_tokens", tool_calls: "tool_use", function_call: "tool_use", content_filter: "end_turn" };

function newId(prefix) {
  return prefix + "_" + randomUUID().replace(/-/g, "").slice(0, 24);
}

export function openAIJsonToAnthropic(json, model) {
  const choice = json?.choices?.[0] ?? {};
  const message = choice.message ?? {};
  const content = [];
  if (typeof message.content === "string" && message.content) content.push({ type: "text", text: message.content });
  for (const call of message.tool_calls || []) {
    content.push({
      type: "tool_use",
      id: call.id || newId("toolu"),
      name: call.function?.name || "tool",
      input: safeParse(call.function?.arguments || "{}")
    });
  }
  if (content.length === 0) content.push({ type: "text", text: "" });
  const hasTools = content.some((b) => b.type === "tool_use");
  return {
    id: json?.id ? "msg_" + String(json.id).replace(/[^A-Za-z0-9]/g, "").slice(0, 24) : newId("msg"),
    type: "message",
    role: "assistant",
    model,
    content,
    stop_reason: hasTools ? "tool_use" : STOP_REASONS[choice.finish_reason] || "end_turn",
    stop_sequence: null,
    usage: {
      input_tokens: json?.usage?.prompt_tokens ?? 0,
      output_tokens: json?.usage?.completion_tokens ?? 0
    }
  };
}

export function geminiJsonToAnthropic(json, model) {
  const candidate = json?.candidates?.[0] ?? {};
  const content = [];
  for (const part of candidate.content?.parts || []) {
    if (part.thought) continue;
    if (typeof part.text === "string" && part.text) {
      const last = content.at(-1);
      if (last?.type === "text") last.text += part.text;
      else content.push({ type: "text", text: part.text });
    } else if (part.functionCall) {
      const id = newId("toolu");
      rememberSignature(id, part.thoughtSignature);
      content.push({ type: "tool_use", id, name: part.functionCall.name, input: part.functionCall.args ?? {} });
    }
  }
  if (content.length === 0) content.push({ type: "text", text: "" });
  const hasTools = content.some((b) => b.type === "tool_use");
  return {
    id: newId("msg"),
    type: "message",
    role: "assistant",
    model,
    content,
    stop_reason: hasTools ? "tool_use" : candidate.finishReason === "MAX_TOKENS" ? "max_tokens" : "end_turn",
    stop_sequence: null,
    usage: {
      input_tokens: json?.usageMetadata?.promptTokenCount ?? 0,
      output_tokens: json?.usageMetadata?.candidatesTokenCount ?? 0
    }
  };
}

export function convertJsonResponse(upstreamProtocol, json, model) {
  return upstreamProtocol === "gemini" ? geminiJsonToAnthropic(json, model) : openAIJsonToAnthropic(json, model);
}

// -------------------------------------------------------- streaming

/** Yields the `data:` payload of each SSE event from a web ReadableStream. */
export async function* sseData(webStream) {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of webStream) {
    buffer += decoder.decode(chunk, { stream: true });
    let idx;
    while ((idx = buffer.search(/\r?\n\r?\n/)) !== -1) {
      const raw = buffer.slice(0, idx);
      buffer = buffer.slice(idx).replace(/^\r?\n\r?\n/, "");
      const data = raw.split(/\r?\n/).filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trimStart()).join("\n");
      if (data) yield data;
    }
  }
  const tail = buffer.split(/\r?\n/).filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trimStart()).join("\n");
  if (tail) yield tail;
}

const sse = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

/**
 * Converts an upstream stream (OpenAI-chat or Gemini SSE) into Anthropic SSE.
 * `events` is an async iterable of raw `data:` strings.
 */
export async function* streamToAnthropic(upstreamProtocol, events, model) {
  yield sse("message_start", {
    type: "message_start",
    message: {
      id: newId("msg"), type: "message", role: "assistant", model, content: [],
      stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 }
    }
  });

  let nextIndex = 0;
  let textIndex = null;
  const toolBlocks = new Map(); // upstream tool index -> anthropic block index
  let sawTool = false;
  let finish = null;
  let outputTokens = 0;
  const open = [];

  const closeText = function* () {
    if (textIndex !== null) {
      yield sse("content_block_stop", { type: "content_block_stop", index: textIndex });
      open.splice(open.indexOf(textIndex), 1);
      textIndex = null;
    }
  };
  const writeText = function* (text) {
    if (!text) return;
    if (textIndex === null) {
      textIndex = nextIndex++;
      open.push(textIndex);
      yield sse("content_block_start", { type: "content_block_start", index: textIndex, content_block: { type: "text", text: "" } });
    }
    yield sse("content_block_delta", { type: "content_block_delta", index: textIndex, delta: { type: "text_delta", text } });
  };

  for await (const data of events) {
    if (data === "[DONE]") break;
    let chunk;
    try { chunk = JSON.parse(data); } catch { continue; }

    if (upstreamProtocol === "gemini") {
      const candidate = chunk.candidates?.[0];
      for (const part of candidate?.content?.parts || []) {
        if (part.thought) continue;
        if (typeof part.text === "string") {
          yield* writeText(part.text);
        } else if (part.functionCall) {
          yield* closeText();
          const index = nextIndex++;
          const id = newId("toolu");
          rememberSignature(id, part.thoughtSignature);
          sawTool = true;
          yield sse("content_block_start", { type: "content_block_start", index, content_block: { type: "tool_use", id, name: part.functionCall.name, input: {} } });
          yield sse("content_block_delta", { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(part.functionCall.args ?? {}) } });
          yield sse("content_block_stop", { type: "content_block_stop", index });
        }
      }
      if (candidate?.finishReason) finish = candidate.finishReason === "MAX_TOKENS" ? "max_tokens" : "end_turn";
      if (chunk.usageMetadata?.candidatesTokenCount) outputTokens = chunk.usageMetadata.candidatesTokenCount;
      continue;
    }

    // OpenAI chat chunk
    if (chunk.usage?.completion_tokens) outputTokens = chunk.usage.completion_tokens;
    const choice = chunk.choices?.[0];
    if (!choice) continue;
    const delta = choice.delta || {};
    if (typeof delta.content === "string" && delta.content) yield* writeText(delta.content);

    for (const call of delta.tool_calls || []) {
      const key = call.index ?? 0;
      if (!toolBlocks.has(key)) {
        yield* closeText();
        const index = nextIndex++;
        open.push(index);
        toolBlocks.set(key, index);
        sawTool = true;
        yield sse("content_block_start", {
          type: "content_block_start", index,
          content_block: { type: "tool_use", id: call.id || newId("toolu"), name: call.function?.name || "tool", input: {} }
        });
      }
      const args = call.function?.arguments;
      if (typeof args === "string" && args) {
        yield sse("content_block_delta", { type: "content_block_delta", index: toolBlocks.get(key), delta: { type: "input_json_delta", partial_json: args } });
      }
    }
    if (choice.finish_reason) finish = STOP_REASONS[choice.finish_reason] || "end_turn";
  }

  yield* closeText();
  for (const index of [...toolBlocks.values()]) {
    yield sse("content_block_stop", { type: "content_block_stop", index });
  }
  yield sse("message_delta", {
    type: "message_delta",
    delta: { stop_reason: sawTool ? "tool_use" : finish || "end_turn", stop_sequence: null },
    usage: { output_tokens: outputTokens }
  });
  yield sse("message_stop", { type: "message_stop" });
}

/** Cheap token estimate for /v1/messages/count_tokens. */
export function estimateInputTokens(body) {
  const text = JSON.stringify({ system: body.system, messages: body.messages, tools: body.tools }) || "";
  return Math.ceil(text.length / 4);
}
