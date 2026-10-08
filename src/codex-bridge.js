import { randomUUID } from "node:crypto";
import { cleanSchemaForGemini, rememberSignature, signatureFor } from "./anthropic-bridge.js";
import { invalidToolArguments, markStreamFailure } from "./bridge-errors.js";
import { splitInlineDataUrl, unsupportedContent, unsupportedImageSource } from "./image-source.js";
import { geminiModelsUrl, openAiChatUrl } from "./upstream-url.js";

/**
 * Codex (OpenAI Responses) bridge.
 *
 * Codex speaks the OpenAI Responses protocol (POST /v1/responses). Most
 * providers only speak OpenAI chat-completions (or Gemini generateContent).
 * This module translates requests and responses, including streaming and
 * function/custom tool calls, so a Codex request can fall back to ANY
 * configured provider. Targets that natively support Responses are passed
 * through untouched and are preferred.
 *
 * Not translated (dropped from the request): hosted/built-in tools such as
 * web_search, local_shell and image_generation, and reasoning items. They
 * have no chat-completions equivalent.
 */

/** Which upstream protocol a target is called with for a Codex client. */
export function codexProtocol(target) {
  const protocols = Array.isArray(target?.protocols) ? target.protocols : [];
  if (protocols.includes("openai-responses")) return "openai-responses";
  if (protocols.includes("openai-chat")) return "openai-chat";
  if (protocols.includes("gemini")) return "gemini";
  return null;
}

/**
 * Target selection for Codex: every target that can be reached natively or
 * through translation is eligible. Exact model matches come first, everything
 * else follows, so a failing preferred model falls back instead of ending the
 * request.
 */
export function selectCodexTargets(targets, requestedModel) {
  const compatible = (Array.isArray(targets) ? targets : []).filter((t) => codexProtocol(t));
  const model = typeof requestedModel === "string" && requestedModel ? requestedModel : "";
  const exact = model ? compatible.filter((t) => t.model === model) : [];
  const rest = compatible.filter((t) => !exact.includes(t));
  return {
    protocol: "openai-responses",
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

function safeParse(text) {
  try { return JSON.parse(text); } catch { return {}; }
}

/** Gemini `functionCall.args` must be a JSON object, so the raw string is parsed
 *  exactly (or the target is refused). Empty means "no arguments". */
function geminiToolArgs(raw) {
  const text = typeof raw === "string" ? raw : argsString(raw);
  if (text.trim() === "") return {};
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw invalidToolArguments("a tool call's arguments are not a JSON object");
    }
    return parsed;
  } catch (error) {
    if (error?.errorType) throw error;
    throw invalidToolArguments("a tool call's arguments are not valid JSON");
  }
}

function inputItems(body) {
  if (typeof body?.input === "string") {
    return [{ type: "message", role: "user", content: body.input }];
  }
  return Array.isArray(body?.input) ? body.input : [];
}

function itemKind(item) {
  return item?.type || (item?.role ? "message" : "");
}

/** Plain text of a Responses content value (string or content-part array). */
function textOf(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if (part?.type === "input_image") return "[image]";
      // Neither bridge target carries input_audio; refuse instead of returning "".
      if (part?.type === "input_audio") throw unsupportedContent("a Responses input_audio part");
      return typeof part?.text === "string" ? part.text : "";
    })
    .join("");
}

function outputText(output) {
  if (typeof output === "string") return output;
  if (Array.isArray(output)) {
    // An image or file inside a tool output cannot be carried as text by either
    // bridge target; refuse it rather than flattening it away.
    if (output.some((p) => p?.type === "input_image" || p?.type === "input_file")) {
      throw unsupportedImageSource("an image or file inside a tool output");
    }
    return textOf(output);
  }
  if (output && typeof output === "object") {
    if (typeof output.content === "string") return output.content;
    if (Array.isArray(output.content)) return textOf(output.content);
    return JSON.stringify(output);
  }
  return output == null ? "" : String(output);
}

function argsString(args) {
  if (typeof args === "string") return args || "{}";
  return JSON.stringify(args ?? {});
}

function imageUrlOf(part) {
  const url = part?.image_url;
  return typeof url === "string" ? url : url?.url || "";
}

const CUSTOM_PARAMETERS = {
  type: "object",
  properties: { input: { type: "string", description: "The complete freeform input for this tool." } },
  required: ["input"]
};

/**
 * Function-calling view of the request's tools. `function` tools map directly;
 * freeform `custom` tools (e.g. apply_patch) become a function taking a single
 * `input` string and are mapped back on the way out.
 */
function toolList(body) {
  const out = [];
  for (const tool of Array.isArray(body?.tools) ? body.tools : []) {
    if (!tool || typeof tool.name !== "string" || !tool.name) continue;
    if (tool.type === "function") {
      out.push({
        name: tool.name,
        description: tool.description || "",
        parameters: tool.parameters || { type: "object", properties: {} },
        custom: false
      });
    } else if (tool.type === "custom") {
      out.push({
        name: tool.name,
        description: tool.description || "",
        parameters: CUSTOM_PARAMETERS,
        custom: true
      });
    }
  }
  return out;
}

/** Names of freeform custom tools, so responses can be mapped back. */
export function customToolNames(body) {
  return new Set(toolList(body).filter((t) => t.custom).map((t) => t.name));
}

/** Function-calling view of the request's tools (name + JSON schema), for response mapping. */
export function codexToolDefs(body) {
  return toolList(body);
}

/** Diagnostics: which tools Codex sent and which ones the bridge cannot forward. */
export function describeCodexTools(body) {
  const sent = (Array.isArray(body?.tools) ? body.tools : []).map((t) => ({ type: t?.type || "?", name: t?.name || null }));
  const forwarded = toolList(body).map((t) => t.name);
  const dropped = sent.filter((t) => !(t.name && forwarded.includes(t.name) && (t.type === "function" || t.type === "custom")));
  return { sent, forwarded, dropped };
}

// ------------------------------------------- text-encoded tool call fallback
//
// Some models do not return structured `tool_calls`. They write the call into
// the message text instead, e.g.
//   <|message_model|>exec<|content_invoke_tool_json|>{"name":"exec","args":{"command":"ls"}}<|end_message|>
// Codex would show that as plain chat text and never run it. These helpers
// recognise that format and turn it into a real function_call.

export const TEXT_CALL_START = "<|message_model|>";
const TEXT_CALL_RE = /<\|message_model\|>\s*([^<\s]*)\s*<\|content_invoke_tool_json\|>([\s\S]*?)<\|end_message\|>/g;
const SHELL_NAMES = new Set(["exec", "shell", "bash", "sh", "run", "run_command", "execute", "terminal", "local_shell", "shell_command", "exec_command"]);
const SHELL_TARGETS = ["exec_command", "shell", "shell_command", "local_shell", "container.exec"];

/** Drops a harmony-style `functions.` namespace: `functions.exec` -> `exec`. */
function bareToolName(name) {
  return String(name || "").trim().replace(/^functions\./i, "");
}

/** Arguments for a declared shell-like tool, shaped by that tool's own schema. */
function shellArgs(target, args) {
  const raw = args.command ?? args.cmd;
  const cmd = Array.isArray(raw) ? raw.join(" ") : typeof raw === "string" ? raw : "";
  if (!cmd) return null;
  const props = target.parameters?.properties || {};
  const mapped = {};
  if (props.cmd) mapped.cmd = cmd;
  else if (props.command?.type === "array") mapped.command = ["bash", "-lc", cmd];
  else mapped.command = cmd;
  if (props.workdir && typeof args.workdir === "string") mapped.workdir = args.workdir;
  return mapped;
}

function mapTextCall(rawName, rawArgs, tools) {
  if (!tools.length) return null;
  const name = bareToolName(rawName);
  const args = rawArgs && typeof rawArgs === "object" ? rawArgs : {};
  const shellLike = SHELL_NAMES.has(name.toLowerCase());
  const exact = tools.find((t) => t.name === name || t.name === rawName);
  if (exact) {
    if (shellLike) {
      const mapped = shellArgs(exact, args);
      if (mapped) return { name: exact.name, args: mapped };
    }
    return { name: exact.name, args: rawArgs ?? {} };
  }
  if (!shellLike) return null;
  const target = SHELL_TARGETS.map((n) => tools.find((t) => t.name === n)).find(Boolean);
  if (!target) return null;
  const mapped = shellArgs(target, args);
  return mapped ? { name: target.name, args: mapped } : null;
}

/** Undoes JSON string escapes by hand (the text is often not valid JSON). */
function looseUnescape(text) {
  return text.replace(/\\(["\\/bfnrt]|u[0-9a-fA-F]{4})/g, (_, e) => {
    if (e[0] === "u") return String.fromCharCode(parseInt(e.slice(1), 16));
    return { b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" }[e] ?? e;
  });
}

/**
 * Models often write this payload as NOT-quite-JSON: inner double quotes left
 * unescaped (`"command":"echo "hi""`) or a broken `{"name":"args":{...}}`. Try
 * strict JSON first, then pull the single string argument out by hand.
 */
function parseTextCallPayload(payload) {
  try {
    const parsed = JSON.parse(payload);
    if (parsed && typeof parsed === "object") {
      return { name: typeof parsed.name === "string" ? parsed.name : "", args: parsed.args ?? parsed.arguments ?? {} };
    }
  } catch { /* fall through to the lenient reader */ }
  const m = /"(command|cmd|input)"\s*:\s*"([\s\S]*)"\s*\}\s*\}?\s*$/.exec(payload);
  if (!m) return null;
  return { name: "", args: { [m[1]]: looseUnescape(m[2]) } };
}

/** Pulls text-encoded tool calls out of `text`. Returns { text, calls }. */
export function extractTextToolCalls(text, tools = []) {
  const calls = [];
  if (typeof text !== "string" || !text.includes(TEXT_CALL_START)) return { text, calls };
  const rest = text.replace(TEXT_CALL_RE, (whole, header, payload) => {
    const parsed = parseTextCallPayload(payload);
    if (!parsed) return whole;
    const name = bareToolName(header) || bareToolName(parsed.name);
    const mapped = mapTextCall(name, parsed.args, tools);
    if (!mapped) return whole;
    calls.push(mapped);
    return "";
  });
  return { text: calls.length ? rest.trim() : text, calls };
}

function callNames(items) {
  const names = new Map();
  for (const item of items) {
    const kind = itemKind(item);
    if (kind === "function_call" || kind === "custom_tool_call") {
      names.set(item.call_id || item.id, item.name);
    }
  }
  return names;
}

function positiveInt(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

// ---------------------------------------------------- request -> OpenAI chat

export function toOpenAIChatFromResponses(body, model) {
  const system = [];
  if (typeof body.instructions === "string" && body.instructions) system.push(body.instructions);

  const messages = [];
  const lastAssistant = () => {
    const last = messages.at(-1);
    return last && last.role === "assistant" ? last : null;
  };

  for (const item of inputItems(body)) {
    const kind = itemKind(item);

    if (kind === "message") {
      if (item.role === "system" || item.role === "developer") {
        const text = textOf(item.content);
        if (text) system.push(text);
        continue;
      }
      if (item.role === "assistant") {
        const text = textOf(item.content);
        if (text) messages.push({ role: "assistant", content: text });
        continue;
      }
      const parts = Array.isArray(item.content) ? item.content : [{ type: "input_text", text: textOf(item.content) }];
      for (const p of parts) {
        if (p?.type === "input_file") throw unsupportedImageSource("a Responses input_file / file_id");
        // An input_image with no url would previously degrade to an empty text
        // part; refuse it instead of silently dropping it.
        if (p?.type === "input_image" && !imageUrlOf(p)) throw unsupportedImageSource("an input_image with no url");
      }
      const hasImage = parts.some((p) => p?.type === "input_image");
      if (!hasImage) {
        const text = textOf(parts);
        if (text) messages.push({ role: "user", content: text });
      } else {
        messages.push({
          role: "user",
          content: parts
            .map((p) => p?.type === "input_image"
              ? (imageUrlOf(p) ? { type: "image_url", image_url: { url: imageUrlOf(p) } } : null)
              : { type: "text", text: textOf([p]) })
            .filter(Boolean)
        });
      }
    } else if (kind === "function_call" || kind === "custom_tool_call") {
      const args = kind === "custom_tool_call"
        ? JSON.stringify({ input: typeof item.input === "string" ? item.input : "" })
        : argsString(item.arguments);
      const call = {
        id: item.call_id || item.id,
        type: "function",
        function: { name: item.name, arguments: args }
      };
      const last = lastAssistant();
      if (last) (last.tool_calls ||= []).push(call);
      else messages.push({ role: "assistant", content: "", tool_calls: [call] });
    } else if (kind === "function_call_output" || kind === "custom_tool_call_output") {
      messages.push({ role: "tool", tool_call_id: item.call_id, content: outputText(item.output) });
    }
    // reasoning items and hosted-tool calls have no chat equivalent: dropped.
  }

  if (system.length) messages.unshift({ role: "system", content: system.join("\n\n") });

  const payload = { model, messages, stream: body.stream === true };
  const maxTokens = positiveInt(body.max_output_tokens);
  if (maxTokens) payload.max_tokens = maxTokens;
  if (typeof body.temperature === "number") payload.temperature = body.temperature;
  if (typeof body.top_p === "number") payload.top_p = body.top_p;

  const tools = toolList(body);
  if (tools.length) {
    payload.tools = tools.map((t) => ({
      type: "function",
      function: { name: t.name, description: t.description, parameters: t.parameters }
    }));
    const tc = body.tool_choice;
    if (tc === "required") payload.tool_choice = "required";
    else if (tc === "none") payload.tool_choice = "none";
    else if (tc === "auto") payload.tool_choice = "auto";
    else if (tc?.type === "function" && tc.name) payload.tool_choice = { type: "function", function: { name: tc.name } };
  }

  const format = body.text?.format;
  if (format?.type === "json_schema" && format.schema) {
    payload.response_format = {
      type: "json_schema",
      json_schema: { name: format.name || "output", schema: format.schema, strict: format.strict === true }
    };
  } else if (format?.type === "json_object") {
    payload.response_format = { type: "json_object" };
  }
  return payload;
}

// ---------------------------------------------------------- request -> Gemini

export function toGeminiFromResponses(body, { sessionId = "" } = {}) {
  const items = inputItems(body);
  const names = callNames(items);
  const system = [];
  if (typeof body.instructions === "string" && body.instructions) system.push(body.instructions);

  const contents = [];
  const push = (role, parts) => {
    if (!parts.length) return;
    const last = contents.at(-1);
    if (last && last.role === role) last.parts.push(...parts);
    else contents.push({ role, parts });
  };

  for (const item of items) {
    const kind = itemKind(item);

    if (kind === "message") {
      if (item.role === "system" || item.role === "developer") {
        const text = textOf(item.content);
        if (text) system.push(text);
        continue;
      }
      const parts = [];
      const content = Array.isArray(item.content) ? item.content : [{ type: "input_text", text: textOf(item.content) }];
      for (const p of content) {
        if (p?.type === "input_image") {
          const inline = splitInlineDataUrl(imageUrlOf(p));
          if (!inline) {
            // Gemini takes the image bytes; the gateway will not fetch a remote
            // URL, so the request is refused rather than answered 200 without
            // the image.
            throw unsupportedImageSource("an input_image that is not a base64 data URL");
          }
          parts.push({ inlineData: inline });
        } else if (p?.type === "input_file") {
          throw unsupportedImageSource("a Responses input_file / file_id");
        } else {
          const text = textOf([p]);
          if (text) parts.push({ text });
        }
      }
      push(item.role === "assistant" ? "model" : "user", parts);
    } else if (kind === "function_call" || kind === "custom_tool_call") {
      const callId = item.call_id || item.id;
      const args = kind === "custom_tool_call"
        ? { input: typeof item.input === "string" ? item.input : "" }
        : geminiToolArgs(item.arguments);
      const part = { functionCall: { name: item.name, args } };
      const sig = signatureFor(callId, sessionId);
      if (sig) part.thoughtSignature = sig;
      push("model", [part]);
    } else if (kind === "function_call_output" || kind === "custom_tool_call_output") {
      push("user", [{
        functionResponse: {
          name: names.get(item.call_id) || "tool",
          response: { output: outputText(item.output) }
        }
      }]);
    }
  }

  const payload = { contents };
  const generationConfig = {};
  const maxTokens = positiveInt(body.max_output_tokens);
  if (maxTokens) generationConfig.maxOutputTokens = maxTokens;
  if (typeof body.temperature === "number") generationConfig.temperature = body.temperature;
  if (typeof body.top_p === "number") generationConfig.topP = body.top_p;

  const format = body.text?.format;
  if (format?.type === "json_schema" && format.schema) {
    generationConfig.responseMimeType = "application/json";
    generationConfig.responseSchema = cleanSchemaForGemini(format.schema);
  } else if (format?.type === "json_object") {
    generationConfig.responseMimeType = "application/json";
  }
  if (Object.keys(generationConfig).length) payload.generationConfig = generationConfig;
  if (system.length) payload.systemInstruction = { parts: [{ text: system.join("\n\n") }] };

  const tools = toolList(body);
  if (tools.length) {
    payload.tools = [{
      functionDeclarations: tools.map((t) => ({
        name: t.name,
        description: t.description,
        parameters: cleanSchemaForGemini(t.parameters)
      }))
    }];
    const tc = body.tool_choice;
    if (tc === "required") payload.toolConfig = { functionCallingConfig: { mode: "ANY" } };
    else if (tc === "none") payload.toolConfig = { functionCallingConfig: { mode: "NONE" } };
    else if (tc?.type === "function" && tc.name) {
      payload.toolConfig = { functionCallingConfig: { mode: "ANY", allowedFunctionNames: [tc.name] } };
    }
  }
  return payload;
}

/** Builds the upstream fetch request for a translated (non-Responses) target. */
export function buildCodexRequest(target, upstreamProtocol, body, incomingHeaders = {}, { sessionId = "" } = {}) {
  const headers = { "content-type": "application/json" };
  if (incomingHeaders["user-agent"]) headers["user-agent"] = incomingHeaders["user-agent"];
  const base = String(target.baseUrl || "").replace(/\/+$/, "");
  const stream = body.stream === true;

  if (upstreamProtocol === "openai-chat") {
    headers.accept = stream ? "text/event-stream" : "application/json";
    headers.authorization = "Bearer " + target.apiKey;
    const url = openAiChatUrl(base);
    return { url, options: { method: "POST", headers, body: JSON.stringify(toOpenAIChatFromResponses(body, target.model)) } };
  }
  if (upstreamProtocol === "gemini") {
    headers.accept = stream ? "text/event-stream" : "application/json";
    headers["x-goog-api-key"] = target.apiKey;
    const url = geminiModelsUrl(base, target.model, { stream });
    return { url, options: { method: "POST", headers, body: JSON.stringify(toGeminiFromResponses(body, { sessionId })) } };
  }
  throw new Error("Unsupported Codex bridge protocol: " + upstreamProtocol);
}

/** Cheap input-token estimate, used when the upstream reports no usage. */
export function estimateResponsesInputTokens(body) {
  const text = JSON.stringify({ i: body?.instructions, input: body?.input, tools: body?.tools }) || "";
  return Math.ceil(text.length / 4);
}

// ------------------------------------------------------- response items

function messageItem(text, status = "completed") {
  return {
    id: newId("msg"),
    type: "message",
    status,
    role: "assistant",
    content: [{ type: "output_text", text, annotations: [] }]
  };
}

function customInput(args) {
  const parsed = typeof args === "string" ? safeParse(args) : args;
  if (parsed && typeof parsed.input === "string") return parsed.input;
  return typeof args === "string" ? args : JSON.stringify(args ?? {});
}

function toolCallItem(callId, name, args, custom) {
  if (custom) {
    return { id: newId("ctc"), type: "custom_tool_call", status: "completed", call_id: callId, name, input: customInput(args) };
  }
  return { id: newId("fc"), type: "function_call", status: "completed", call_id: callId, name, arguments: argsString(args) };
}

function usageOf(input, output) {
  return {
    input_tokens: input,
    input_tokens_details: { cached_tokens: 0 },
    output_tokens: output,
    output_tokens_details: { reasoning_tokens: 0 },
    total_tokens: input + output
  };
}

function responseObject({ id, model, createdAt, status, output = [], usage, incomplete, error }) {
  const response = { id, object: "response", created_at: createdAt, status, model, output };
  if (usage) response.usage = usage;
  if (incomplete) response.incomplete_details = { reason: incomplete };
  if (error) response.error = error;
  return response;
}

// ------------------------------------------------- JSON response -> Responses

export function openAIJsonToResponses(json, model, ctx = {}) {
  const custom = ctx.customTools || new Set();
  const choice = json?.choices?.[0] ?? {};
  const message = choice.message ?? {};
  const output = [];
  let content = typeof message.content === "string" ? message.content : "";
  const textCalls = [];
  if (content && !(message.tool_calls || []).length) {
    const extracted = extractTextToolCalls(content, ctx.tools || []);
    content = extracted.text;
    textCalls.push(...extracted.calls);
  }
  if (content) output.push(messageItem(content));
  for (const call of message.tool_calls || []) {
    const name = call.function?.name || "tool";
    output.push(toolCallItem(call.id || newId("call"), name, call.function?.arguments || "{}", custom.has(name)));
  }
  for (const call of textCalls) {
    output.push(toolCallItem(newId("call"), call.name, call.args, custom.has(call.name)));
  }
  const truncated = choice.finish_reason === "length";
  const input = json?.usage?.prompt_tokens ?? ctx.inputTokens ?? 0;
  const out = json?.usage?.completion_tokens ?? 0;
  return responseObject({
    id: newId("resp"),
    model,
    createdAt: Math.floor(Date.now() / 1000),
    status: truncated ? "incomplete" : "completed",
    output,
    usage: usageOf(input, out),
    incomplete: truncated ? "max_output_tokens" : null
  });
}

export function geminiJsonToResponses(json, model, ctx = {}) {
  const custom = ctx.customTools || new Set();
  const candidate = json?.candidates?.[0] ?? {};
  const output = [];
  let text = "";
  const flush = () => { if (text) output.push(messageItem(text)); text = ""; };
  for (const part of candidate.content?.parts || []) {
    if (part.thought) continue;
    if (typeof part.text === "string" && part.text) {
      text += part.text;
    } else if (part.functionCall) {
      flush();
      const callId = newId("call");
      rememberSignature(callId, part.thoughtSignature, ctx.sessionId);
      const name = part.functionCall.name;
      output.push(toolCallItem(callId, name, part.functionCall.args ?? {}, custom.has(name)));
    }
  }
  flush();
  const truncated = candidate.finishReason === "MAX_TOKENS";
  return responseObject({
    id: newId("resp"),
    model,
    createdAt: Math.floor(Date.now() / 1000),
    status: truncated ? "incomplete" : "completed",
    output,
    usage: usageOf(json?.usageMetadata?.promptTokenCount ?? ctx.inputTokens ?? 0, json?.usageMetadata?.candidatesTokenCount ?? 0),
    incomplete: truncated ? "max_output_tokens" : null
  });
}

export function convertCodexJson(upstreamProtocol, json, model, ctx = {}) {
  return upstreamProtocol === "gemini"
    ? geminiJsonToResponses(json, model, ctx)
    : openAIJsonToResponses(json, model, ctx);
}

// ------------------------------------------------------------- streaming

const sse = (type, data) => `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;

/**
 * Converts an upstream stream (OpenAI-chat or Gemini SSE) into Responses SSE.
 * `events` is an async iterable of raw `data:` strings. An upstream failure
 * after the headers were sent still emits a `response.failed` event, then
 * re-throws so the caller can file the request as a failed (truncated) stream
 * instead of a success.
 */
export async function* streamToResponses(upstreamProtocol, events, model, ctx = {}) {
  const customTools = ctx.customTools || new Set();
  const responseId = newId("resp");
  const createdAt = Math.floor(Date.now() / 1000);
  let seq = 0;
  const ev = (type, data) => sse(type, { type, sequence_number: seq++, ...data });
  const snapshot = (status, extra = {}) => responseObject({ id: responseId, model, createdAt, status, ...extra });

  yield ev("response.created", { response: snapshot("in_progress") });
  yield ev("response.in_progress", { response: snapshot("in_progress") });

  const output = [];
  let nextIndex = 0;
  let text = null;          // { index, id, buf }
  const tools = new Map();  // upstream key -> tool state
  let finish = null;
  let inputTokens = null;
  let outputTokens = 0;
  let outputChars = 0;

  const closeText = function* () {
    if (!text) return;
    const part = { type: "output_text", text: text.buf, annotations: [] };
    const item = { id: text.id, type: "message", status: "completed", role: "assistant", content: [part] };
    yield ev("response.output_text.done", { item_id: text.id, output_index: text.index, content_index: 0, text: text.buf });
    yield ev("response.content_part.done", { item_id: text.id, output_index: text.index, content_index: 0, part });
    yield ev("response.output_item.done", { output_index: text.index, item });
    output[text.index] = item;
    text = null;
  };

  const writeText = function* (delta) {
    if (!delta) return;
    if (!text) {
      text = { index: nextIndex++, id: newId("msg"), buf: "" };
      yield ev("response.output_item.added", {
        output_index: text.index,
        item: { id: text.id, type: "message", status: "in_progress", role: "assistant", content: [] }
      });
      yield ev("response.content_part.added", {
        item_id: text.id, output_index: text.index, content_index: 0,
        part: { type: "output_text", text: "", annotations: [] }
      });
    }
    text.buf += delta;
    outputChars += delta.length;
    yield ev("response.output_text.delta", { item_id: text.id, output_index: text.index, content_index: 0, delta });
  };

  const startTool = function* (key, callId, name) {
    yield* closeText();
    const custom = customTools.has(name);
    const tool = { index: nextIndex++, id: newId(custom ? "ctc" : "fc"), callId, name, custom, args: "", done: false };
    tools.set(key, tool);
    const item = custom
      ? { id: tool.id, type: "custom_tool_call", status: "in_progress", call_id: callId, name, input: "" }
      : { id: tool.id, type: "function_call", status: "in_progress", call_id: callId, name, arguments: "" };
    yield ev("response.output_item.added", { output_index: tool.index, item });
    return tool;
  };

  const toolArgs = function* (tool, fragment) {
    if (!fragment) return;
    tool.args += fragment;
    outputChars += fragment.length;
    if (!tool.custom) {
      yield ev("response.function_call_arguments.delta", { item_id: tool.id, output_index: tool.index, delta: fragment });
    }
  };

  // Leading text-encoded tool call: hold the text back until it is clear whether
  // it is the marker format (then it becomes a real tool call) or ordinary text.
  const toolDefs = ctx.tools || [];
  let lead = "undecided";   // undecided | capture | pass
  let held = "";
  const feedText = function* (delta) {
    if (lead === "pass") { yield* writeText(delta); return; }
    held += delta;
    const probe = held.trimStart();
    if (probe.startsWith(TEXT_CALL_START)) { lead = "capture"; return; }
    if (TEXT_CALL_START.startsWith(probe)) return;
    lead = "pass";
    const flush = held;
    held = "";
    yield* writeText(flush);
  };
  const resolveHeld = function* () {
    if (!held) return;
    const text = held;
    held = "";
    const extracted = lead === "capture" ? extractTextToolCalls(text, toolDefs) : { text, calls: [] };
    if (extracted.text) yield* writeText(extracted.text);
    for (const call of extracted.calls) {
      const tool = yield* startTool(`t${nextIndex}`, newId("call"), call.name);
      yield* toolArgs(tool, argsString(call.args));
      yield* finishTool(tool);
    }
  };

  const finishTool = function* (tool) {
    if (tool.done) return;
    tool.done = true;
    let item;
    if (tool.custom) {
      item = { id: tool.id, type: "custom_tool_call", status: "completed", call_id: tool.callId, name: tool.name, input: customInput(tool.args || "{}") };
    } else {
      const args = tool.args || "{}";
      yield ev("response.function_call_arguments.done", { item_id: tool.id, output_index: tool.index, arguments: args });
      item = { id: tool.id, type: "function_call", status: "completed", call_id: tool.callId, name: tool.name, arguments: args };
    }
    yield ev("response.output_item.done", { output_index: tool.index, item });
    output[tool.index] = item;
  };

  try {
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
            const callId = newId("call");
            rememberSignature(callId, part.thoughtSignature, ctx.sessionId);
            const tool = yield* startTool(`g${nextIndex}`, callId, part.functionCall.name);
            yield* toolArgs(tool, JSON.stringify(part.functionCall.args ?? {}));
            yield* finishTool(tool);
          }
        }
        if (candidate?.finishReason) finish = candidate.finishReason === "MAX_TOKENS" ? "length" : "stop";
        if (chunk.usageMetadata?.promptTokenCount) inputTokens = chunk.usageMetadata.promptTokenCount;
        if (chunk.usageMetadata?.candidatesTokenCount) outputTokens = chunk.usageMetadata.candidatesTokenCount;
        continue;
      }

      // OpenAI chat chunk
      if (chunk.usage?.prompt_tokens) inputTokens = chunk.usage.prompt_tokens;
      if (chunk.usage?.completion_tokens) outputTokens = chunk.usage.completion_tokens;
      const choice = chunk.choices?.[0];
      if (!choice) continue;
      const delta = choice.delta || {};
      if (typeof delta.content === "string" && delta.content) yield* feedText(delta.content);

      for (const call of delta.tool_calls || []) {
        const key = call.index ?? 0;
        let tool = tools.get(key);
        if (!tool) tool = yield* startTool(key, call.id || newId("call"), call.function?.name || "tool");
        yield* toolArgs(tool, call.function?.arguments);
      }
      if (choice.finish_reason) finish = choice.finish_reason === "length" ? "length" : "stop";
    }
  } catch (error) {
    // Deliver the terminal `response.failed` event, then surface the failure so
    // `pipeline()` rejects: the request is recorded as truncated, the target is
    // not marked healthy, and no sticky is saved.
    yield ev("response.failed", {
      response: snapshot("failed", {
        output: output.filter(Boolean),
        error: { code: "upstream_error", message: String(error?.message || "Upstream stream failed").slice(0, 500) }
      })
    });
    throw markStreamFailure(error);
  }

  yield* resolveHeld();
  yield* closeText();
  for (const tool of tools.values()) yield* finishTool(tool);

  const truncated = finish === "length";
  const input = inputTokens ?? ctx.inputTokens ?? 0;
  const out = outputTokens || Math.ceil(outputChars / 4);
  const response = snapshot(truncated ? "incomplete" : "completed", {
    output: output.filter(Boolean),
    usage: usageOf(input, out),
    incomplete: truncated ? "max_output_tokens" : null
  });
  yield ev(truncated ? "response.incomplete" : "response.completed", { response });
}
