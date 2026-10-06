import { randomUUID } from "node:crypto";
import { cleanSchemaForGemini, rememberSignature, signatureFor } from "./anthropic-bridge.js";
import { markStreamFailure, parseToolArguments } from "./bridge-errors.js";
import { splitInlineDataUrl, unsupportedImageSource } from "./image-source.js";
import { geminiModelsUrl } from "./upstream-url.js";

/**
 * OpenAI chat-completions bridge.
 *
 * Most clients (OpenCode, Qwen Code, Cursor, Cline, OpenAI SDKs, ...) speak the
 * OpenAI chat-completions protocol (POST /v1/chat/completions). Chat-capable
 * providers are called natively; Gemini-only providers are reached by
 * translating the request to `generateContent` and the response back to a
 * `chat.completion` (or `chat.completion.chunk` stream). Without this a
 * Gemini-only provider returned 503 no_route for every chat client.
 *
 * Native chat targets (openai-chat) are preferred and passed through untouched;
 * Gemini targets are the fallback. OpenAI chat and the Responses protocol are
 * separate capabilities, so this bridge does not make a Responses provider
 * reachable — see codex-bridge.js for that direction.
 */

/** Which upstream protocol a target is called with for a chat client. */
export function chatProtocol(target) {
  const protocols = Array.isArray(target?.protocols) ? target.protocols : [];
  if (protocols.includes("openai-chat")) return "openai-chat";
  if (protocols.includes("gemini")) return "gemini";
  return null;
}

/**
 * Target selection for chat clients: every target that can be reached natively
 * or through translation is eligible. Exact model matches come first, the
 * remaining compatible targets follow as fallback — the same rule the Codex and
 * Anthropic bridges use, so a failing preferred model falls back instead of
 * ending the request.
 */
export function selectChatTargets(targets, requestedModel) {
  const compatible = (Array.isArray(targets) ? targets : []).filter((t) => chatProtocol(t));
  const model = typeof requestedModel === "string" && requestedModel ? requestedModel : "";
  const exact = model ? compatible.filter((t) => t.model === model) : [];
  const rest = compatible.filter((t) => !exact.includes(t));
  return {
    protocol: "openai-chat",
    requestedModel: model || null,
    modelMatched: exact.length > 0,
    compatible,
    exact,
    selected: exact.length > 0 ? [...exact, ...rest] : compatible
  };
}

// ---------------------------------------------------------------- helpers

function newId(prefix) {
  return prefix + "_" + randomUUID().replace(/-/g, "").slice(0, 24);
}

function chatMessages(body) {
  return (Array.isArray(body?.messages) ? body.messages : []).filter(
    (message) => message && typeof message === "object"
  );
}

/** Plain text of a chat content value (string, or content-part array). */
function textOfContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if (part?.type === "image_url") return "[image]";
      return typeof part?.text === "string" ? part.text : "";
    })
    .join("");
}

function imageUrlOf(part) {
  const url = part?.image_url ?? part?.url;
  return typeof url === "string" ? url : url?.url || "";
}

/** Does a chat content value contain an image part? */
function contentHasImage(content) {
  if (!Array.isArray(content)) return false;
  return content.some((part) => part?.type === "image_url" || part?.type === "input_image");
}

function argsString(args) {
  if (typeof args === "string") return args || "{}";
  return JSON.stringify(args ?? {});
}

function positiveInt(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

/** Function tools in the request's `tools` array, in chat-completions shape. */
function toolList(body) {
  const out = [];
  for (const tool of Array.isArray(body?.tools) ? body.tools : []) {
    const fn = tool?.type === "function" ? tool.function : null;
    if (!fn || typeof fn.name !== "string" || !fn.name) continue;
    out.push({
      name: fn.name,
      description: fn.description || "",
      parameters: fn.parameters || { type: "object", properties: {} }
    });
  }
  return out;
}

/** Stop sequences: `stop` may be a string or an array, `stop_sequences` a legacy alias. */
function stopSequences(body) {
  if (typeof body?.stop === "string" && body.stop) return [body.stop];
  if (Array.isArray(body?.stop)) return body.stop.filter((s) => typeof s === "string" && s);
  if (Array.isArray(body?.stop_sequences)) return body.stop_sequences.filter((s) => typeof s === "string" && s);
  return [];
}

// ---------------------------------------------------------- request -> Gemini

export function toGeminiFromChat(body, { sessionId = "" } = {}) {
  // Gemini's functionResponse must name the function; the chat protocol only
  // carries the call id, so map it from the assistant turns.
  const callNames = new Map();
  for (const message of chatMessages(body)) {
    for (const call of message.tool_calls || []) {
      if (call?.id) callNames.set(call.id, call.function?.name || "tool");
    }
  }

  const system = [];
  const contents = [];
  const push = (role, parts) => {
    if (!parts.length) return;
    const last = contents.at(-1);
    if (last && last.role === role) last.parts.push(...parts);
    else contents.push({ role, parts });
  };

  for (const message of chatMessages(body)) {
    const role = message.role;

    if (role === "system" || role === "developer") {
      const text = textOfContent(message.content);
      if (text) system.push(text);
      continue;
    }

    if (role === "assistant") {
      const parts = [];
      const text = textOfContent(message.content);
      if (text) parts.push({ text });
      for (const call of message.tool_calls || []) {
        if (!call || typeof call.function?.name !== "string" || !call.function.name) continue;
        const part = { functionCall: { name: call.function.name, args: parseToolArguments(call.function.arguments) } };
        // Echo the thoughtSignature a previous Gemini response returned with
        // this call, when the client sent the same tool-call id back.
        const signature = signatureFor(call.id, sessionId);
        if (signature) part.thoughtSignature = signature;
        parts.push(part);
      }
      push("model", parts);
      continue;
    }

    if (role === "tool" || role === "function") {
      const text = textOfContent(message.content);
      // A tool result carrying an image cannot be expressed as Gemini
      // functionResponse text, so it is refused rather than flattened to
      // "[image]" and answered 200.
      if (contentHasImage(message.content)) {
        throw unsupportedImageSource("an image inside a tool result");
      }
      push("user", [{
        functionResponse: {
          name: callNames.get(message.tool_call_id) || (typeof message.name === "string" && message.name) || "tool",
          response: { output: text }
        }
      }]);
      continue;
    }

    // user (and anything unrecognised, treated as user input)
    const parts = [];
    if (Array.isArray(message.content)) {
      for (const part of message.content) {
        if (part?.type === "image_url" || part?.type === "input_image") {
          const data = splitInlineDataUrl(imageUrlOf(part));
          if (!data) {
            // A remote URL has no generateContent equivalent and the gateway
            // will not fetch it, so the request is refused explicitly instead
            // of being answered 200 with the image silently removed.
            throw unsupportedImageSource("an image URL that is not a base64 data URL");
          }
          parts.push({ inlineData: data });
        } else {
          const text = textOfContent([part]);
          if (text) parts.push({ text });
        }
      }
    } else {
      const text = textOfContent(message.content);
      if (text) parts.push({ text });
    }
    push("user", parts);
  }

  const payload = { contents };
  if (system.length) payload.systemInstruction = { parts: [{ text: system.join("\n\n") }] };

  const generationConfig = {};
  const maxTokens = positiveInt(body?.max_tokens ?? body?.max_completion_tokens);
  if (maxTokens) generationConfig.maxOutputTokens = maxTokens;
  if (typeof body?.temperature === "number") generationConfig.temperature = body.temperature;
  if (typeof body?.top_p === "number") generationConfig.topP = body.top_p;
  const stop = stopSequences(body);
  if (stop.length) generationConfig.stopSequences = stop.slice(0, 5);

  const format = body?.response_format;
  const schema = format?.json_schema?.schema || format?.schema;
  if (format?.type === "json_schema" && schema) {
    generationConfig.responseMimeType = "application/json";
    generationConfig.responseSchema = cleanSchemaForGemini(schema);
  } else if (format?.type === "json_object") {
    generationConfig.responseMimeType = "application/json";
  }
  if (Object.keys(generationConfig).length) payload.generationConfig = generationConfig;

  const tools = toolList(body);
  if (tools.length) {
    payload.tools = [{
      functionDeclarations: tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: cleanSchemaForGemini(tool.parameters)
      }))
    }];
    const choice = body?.tool_choice;
    if (choice === "required") payload.toolConfig = { functionCallingConfig: { mode: "ANY" } };
    else if (choice === "none") payload.toolConfig = { functionCallingConfig: { mode: "NONE" } };
    else if (choice?.type === "function" && choice.function?.name) {
      payload.toolConfig = { functionCallingConfig: { mode: "ANY", allowedFunctionNames: [choice.function.name] } };
    }
    // "auto" is Gemini's default; no toolConfig needed.
  }
  return payload;
}

/** Builds the upstream fetch request for a translated (non-chat) target. */
export function buildChatRequest(target, upstreamProtocol, body, incomingHeaders = {}, { sessionId = "" } = {}) {
  const headers = { "content-type": "application/json" };
  if (incomingHeaders["user-agent"]) headers["user-agent"] = incomingHeaders["user-agent"];
  const base = String(target.baseUrl || "").replace(/\/+$/, "");
  const stream = body.stream === true;

  if (upstreamProtocol === "gemini") {
    headers.accept = stream ? "text/event-stream" : "application/json";
    headers["x-goog-api-key"] = target.apiKey;
    const url = geminiModelsUrl(base, target.model, { stream });
    return { url, options: { method: "POST", headers, body: JSON.stringify(toGeminiFromChat(body, { sessionId })) } };
  }
  throw new Error("Unsupported Chat bridge protocol: " + upstreamProtocol);
}

/** Cheap input-token estimate, used when the upstream reports no usage. */
export function estimateChatInputTokens(body) {
  const text = JSON.stringify({ messages: body?.messages, tools: body?.tools, response_format: body?.response_format }) || "";
  return Math.ceil(text.length / 4);
}

// ------------------------------------------------- JSON response -> chat

function finishReasonFor(reason, hasToolCalls) {
  if (hasToolCalls) return "tool_calls";
  return reason === "MAX_TOKENS" ? "length" : "stop";
}

function chatUsage(input, output) {
  return { prompt_tokens: input, completion_tokens: output, total_tokens: input + output };
}

export function geminiJsonToChat(json, model, ctx = {}) {
  const candidate = json?.candidates?.[0] ?? {};
  const toolCalls = [];
  let text = "";

  for (const part of candidate.content?.parts || []) {
    if (part.thought) continue;
    if (typeof part.text === "string" && part.text) {
      text += part.text;
    } else if (part.functionCall) {
      const id = newId("call");
      rememberSignature(id, part.thoughtSignature, ctx.sessionId);
      toolCalls.push({
        id,
        type: "function",
        function: { name: part.functionCall.name, arguments: argsString(part.functionCall.args) }
      });
    }
  }

  const input = json?.usageMetadata?.promptTokenCount ?? ctx.inputTokens ?? 0;
  const output = json?.usageMetadata?.candidatesTokenCount ?? 0;
  const message = { role: "assistant", content: text || (toolCalls.length ? null : "") };
  if (toolCalls.length) message.tool_calls = toolCalls;

  return {
    id: newId("chatcmpl"),
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{
      index: 0,
      message,
      finish_reason: finishReasonFor(candidate.finishReason, toolCalls.length > 0),
      logprobs: null
    }],
    usage: chatUsage(input, output)
  };
}

export function convertChatJson(upstreamProtocol, json, model, ctx = {}) {
  if (upstreamProtocol === "gemini") return geminiJsonToChat(json, model, ctx);
  throw new Error("Unsupported Chat bridge protocol: " + upstreamProtocol);
}

// ------------------------------------------------------------- streaming

const chunk = (id, created, model, choices, extra = {}) =>
  "data: " + JSON.stringify({ id, object: "chat.completion.chunk", created, model, choices, ...extra }) + "\n\n";

/**
 * Converts a Gemini SSE stream into `chat.completion.chunk` SSE, ending with
 * `data: [DONE]` (the terminator OpenAI-compatible clients wait for). `events`
 * is an async iterable of raw `data:` strings. An upstream failure after the
 * headers were sent still emits the error event followed by [DONE], then
 * re-throws so the caller can file the request as a failed (truncated) stream
 * instead of a success.
 */
export async function* streamToChat(upstreamProtocol, events, model, ctx = {}) {
  if (upstreamProtocol !== "gemini") throw new Error("Unsupported Chat bridge protocol: " + upstreamProtocol);

  const id = newId("chatcmpl");
  const created = Math.floor(Date.now() / 1000);
  const emit = (choices, extra) => chunk(id, created, model, choices, extra);

  yield emit([{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }]);

  let nextToolIndex = 0;
  let sawTool = false;
  let finish = null;
  let inputTokens = null;
  let outputTokens = 0;
  let outputChars = 0;

  try {
    for await (const data of events) {
      if (data === "[DONE]") break;
      let parsed;
      try { parsed = JSON.parse(data); } catch { continue; }

      const candidate = parsed.candidates?.[0];
      for (const part of candidate?.content?.parts || []) {
        if (part.thought) continue;
        if (typeof part.text === "string" && part.text) {
          outputChars += part.text.length;
          yield emit([{ index: 0, delta: { content: part.text }, finish_reason: null }]);
        } else if (part.functionCall) {
          const index = nextToolIndex++;
          sawTool = true;
          const callId = newId("call");
          rememberSignature(callId, part.thoughtSignature, ctx.sessionId);
          yield emit([{
            index: 0,
            delta: { tool_calls: [{ index, id: callId, type: "function", function: { name: part.functionCall.name, arguments: "" } }] },
            finish_reason: null
          }]);
          const args = argsString(part.functionCall.args);
          outputChars += args.length;
          yield emit([{ index: 0, delta: { tool_calls: [{ index, function: { arguments: args } }] }, finish_reason: null }]);
        }
      }
      if (candidate?.finishReason) finish = candidate.finishReason === "MAX_TOKENS" ? "length" : "stop";
      if (parsed.usageMetadata?.promptTokenCount) inputTokens = parsed.usageMetadata.promptTokenCount;
      if (parsed.usageMetadata?.candidatesTokenCount) outputTokens = parsed.usageMetadata.candidatesTokenCount;
    }
  } catch (error) {
    // Give the client the protocol's error event and terminator, then surface
    // the failure: `pipeline()` must reject so the request is recorded as
    // truncated, the target is not marked healthy, and no sticky is saved.
    yield "data: " + JSON.stringify({
      error: { message: String(error?.message || "Upstream stream failed").slice(0, 500), type: "upstream_error" }
    }) + "\n\n";
    yield "data: [DONE]\n\n";
    throw markStreamFailure(error);
  }

  yield emit([{ index: 0, delta: {}, finish_reason: sawTool ? "tool_calls" : finish || "stop" }]);

  if (ctx.includeUsage) {
    const input = inputTokens ?? ctx.inputTokens ?? 0;
    const output = outputTokens || Math.ceil(outputChars / 4);
    yield emit([], { usage: chatUsage(input, output) });
  }

  yield "data: [DONE]\n\n";
}
