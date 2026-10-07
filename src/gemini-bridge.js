import { createHash, randomUUID } from "node:crypto";
import { cleanSchemaForGemini } from "./anthropic-bridge.js";
import { BridgeRequestError, MalformedUpstreamArgumentsError, UnsupportedMediaError, parseToolArguments } from "./bridge-errors.js";
import { isHttpUrl } from "./media.js";

function id(prefix) {
  return prefix + "_" + randomUUID().replace(/-/g, "").slice(0, 24);
}

/** Tool arguments from the upstream arrive as a JSON string; a malformed one is an upstream fault. */
function parseArgs(value, name) {
  return parseToolArguments(value, name, MalformedUpstreamArgumentsError);
}

function textParts(parts = []) {
  return parts.filter((p) => typeof p?.text === "string").map((p) => p.text).join("");
}

// ------------------------------------------------ request normalisation
//
// Gemini's REST API accepts both camelCase and snake_case field names. The
// router's own routing (vision detection) already recognises both, so the
// translation has to read both too — otherwise a request is routed as
// multimodal and then loses the very part that made it so.

const pick = (object, ...names) => {
  for (const name of names) if (object && object[name] !== undefined) return object[name];
  return undefined;
};

function normalizePart(part) {
  if (!part || typeof part !== "object") return part;
  const out = { ...part };
  const inline = pick(part, "inlineData", "inline_data");
  if (inline && typeof inline === "object") {
    out.inlineData = { mimeType: pick(inline, "mimeType", "mime_type"), data: inline.data };
  }
  const file = pick(part, "fileData", "file_data");
  if (file && typeof file === "object") {
    out.fileData = { mimeType: pick(file, "mimeType", "mime_type"), fileUri: pick(file, "fileUri", "file_uri") };
  }
  const call = pick(part, "functionCall", "function_call");
  if (call && typeof call === "object") out.functionCall = call;
  const response = pick(part, "functionResponse", "function_response");
  if (response && typeof response === "object") {
    out.functionResponse = { ...response, parts: Array.isArray(response.parts) ? response.parts.map(normalizePart) : response.parts };
  }
  for (const key of ["inline_data", "file_data", "function_call", "function_response"]) delete out[key];
  return out;
}

function normalizeContent(content) {
  if (typeof content === "string") return { role: "user", parts: [{ text: content }] };
  if (!content || typeof content !== "object") return content;
  return { ...content, parts: Array.isArray(content.parts) ? content.parts.map(normalizePart) : [] };
}

/** The camelCase view of a Gemini request body. Unknown fields are passed through untouched. */
export function normalizeGeminiBody(body) {
  const source = body && typeof body === "object" ? body : {};
  const contentsRaw = pick(source, "contents");
  const list = Array.isArray(contentsRaw) ? contentsRaw : contentsRaw ? [contentsRaw] : [];
  const systemRaw = pick(source, "systemInstruction", "system_instruction");
  const configRaw = pick(source, "generationConfig", "generation_config") || {};
  const toolConfigRaw = pick(source, "toolConfig", "tool_config") || {};
  const callingRaw = pick(toolConfigRaw, "functionCallingConfig", "function_calling_config");

  return {
    ...source,
    contents: list.map(normalizeContent),
    systemInstruction: systemRaw === undefined ? undefined : normalizeContent(systemRaw),
    generationConfig: {
      ...configRaw,
      maxOutputTokens: pick(configRaw, "maxOutputTokens", "max_output_tokens"),
      topP: pick(configRaw, "topP", "top_p"),
      stopSequences: pick(configRaw, "stopSequences", "stop_sequences"),
      responseMimeType: pick(configRaw, "responseMimeType", "response_mime_type"),
      responseSchema: pick(configRaw, "responseSchema", "response_schema")
    },
    toolConfig: callingRaw
      ? {
        functionCallingConfig: {
          mode: callingRaw.mode,
          allowedFunctionNames: pick(callingRaw, "allowedFunctionNames", "allowed_function_names")
        }
      }
      : undefined,
    tools: (Array.isArray(source.tools) ? source.tools : []).map((tool) => ({
      functionDeclarations: pick(tool, "functionDeclarations", "function_declarations")
    }))
  };
}

/** Stable id for a function call the client sent without one: same history, same id, every request. */
function stableCallId(contentIndex, partIndex, name, args) {
  const hash = createHash("sha1").update(`${contentIndex}:${partIndex}:${name}:${JSON.stringify(args ?? {})}`).digest("hex");
  return `call_${hash.slice(0, 24)}`;
}

const isImageMime = (mime) => typeof mime === "string" && mime.toLowerCase().startsWith("image/");

/** Chat `image_url` part for a Gemini data part, or an error when chat cannot carry it. */
function chatImageForPart(part) {
  if (part.inlineData) {
    const { mimeType, data } = part.inlineData;
    if (!data) throw new UnsupportedMediaError("inlineData has no data", "invalid_inline_data");
    if (!isImageMime(mimeType)) {
      throw new UnsupportedMediaError(`inlineData of type "${mimeType || "unknown"}" cannot be forwarded to the selected provider`, "unsupported_media_type");
    }
    return { type: "image_url", image_url: { url: `data:${mimeType};base64,${data}` } };
  }
  if (part.fileData) {
    const { mimeType, fileUri } = part.fileData;
    // A file reference is only forwardable when the provider can fetch it itself.
    if (isHttpUrl(fileUri) && (mimeType === undefined || mimeType === null || isImageMime(mimeType))) {
      return { type: "image_url", image_url: { url: fileUri } };
    }
    throw new UnsupportedMediaError("This fileData reference cannot be forwarded to the selected provider", "unsupported_file_reference");
  }
  return null;
}

export function geminiProtocol(target) {
  const protocols = Array.isArray(target?.protocols) ? target.protocols : [];
  if (protocols.includes("gemini")) return "gemini";
  if (protocols.includes("openai-chat")) return "openai-chat";
  return null;
}

export function selectGeminiTargets(targets, requestedModel) {
  const compatible = (Array.isArray(targets) ? targets : []).filter((t) => geminiProtocol(t));
  const model = typeof requestedModel === "string" && requestedModel ? requestedModel : "";
  const exact = model ? compatible.filter((t) => t.model === model) : [];
  const rest = compatible.filter((t) => !exact.includes(t));
  return {
    protocol: "gemini",
    requestedModel: model || null,
    modelMatched: exact.length > 0,
    compatible,
    exact,
    selected: exact.length ? [...exact, ...rest] : compatible
  };
}

/**
 * Gemini generateContent request -> OpenAI chat request.
 *
 * `model` is the *target's* model, never the model the client asked for: the
 * provider is chosen by the router, and it only serves the model names it was
 * configured with. Forwarding the client's name turns every fallback into a
 * model-not-found error.
 */
export function toChatFromGemini(rawBody, model, { stream = false } = {}) {
  const body = normalizeGeminiBody(rawBody);
  const messages = [];
  const system = body.systemInstruction?.parts ? textParts(body.systemInstruction.parts) : "";
  if (body.systemInstruction?.parts?.some((p) => p?.inlineData || p?.fileData)) {
    throw new UnsupportedMediaError("Media in systemInstruction cannot be forwarded to the selected provider", "unsupported_system_media");
  }
  if (system) messages.push({ role: "system", content: system });

  // Gemini pairs a functionResponse with its functionCall by name and order, not
  // by id. Chat pairs by id, so every call gets one — the client's own when it
  // sent one, otherwise a stable id derived from the call's position and
  // content — and each response takes the oldest unanswered call of its name.
  const unanswered = new Map();   // name -> [call id, ...]
  const claim = (name, explicitId) => {
    const queue = unanswered.get(name) || [];
    if (explicitId) {
      const at = queue.indexOf(explicitId);
      if (at >= 0) queue.splice(at, 1);
      return explicitId;
    }
    const next = queue.shift();
    if (next === undefined) {
      throw new BridgeRequestError(`functionResponse for "${String(name || "tool").slice(0, 80)}" has no matching earlier functionCall`, { code: "orphan_function_response" });
    }
    return next;
  };

  body.contents.forEach((content, contentIndex) => {
    const role = content?.role === "model" ? "assistant" : "user";
    const text = [];
    const parts = [];
    const toolCalls = [];
    const toolResults = [];
    const toolMedia = [];

    (Array.isArray(content?.parts) ? content.parts : []).forEach((part, partIndex) => {
      if (typeof part?.text === "string") {
        text.push(part.text);
        // A mixed turn must use the content-parts form, in which every entry
        // is an object. A bare string is not a valid OpenAI content part.
        parts.push({ type: "text", text: part.text });
      }
      if (part?.inlineData || part?.fileData) {
        if (role === "assistant") {
          throw new UnsupportedMediaError("Media in a model turn cannot be forwarded to the selected provider", "unsupported_assistant_media");
        }
        parts.push(chatImageForPart(part));
      }
      if (part?.functionCall) {
        const name = part.functionCall.name || "tool";
        const args = part.functionCall.args ?? {};
        const callId = part.functionCall.id || stableCallId(contentIndex, partIndex, name, args);
        const queue = unanswered.get(name) || [];
        queue.push(callId);
        unanswered.set(name, queue);
        toolCalls.push({ id: callId, type: "function", function: { name, arguments: JSON.stringify(args) } });
      }
      if (part?.functionResponse) {
        const name = part.functionResponse.name || "tool";
        for (const attachment of part.functionResponse.parts || []) {
          const image = chatImageForPart(attachment);
          if (image) toolMedia.push(image);
        }
        toolResults.push({
          role: "tool",
          tool_call_id: claim(name, part.functionResponse.id),
          name: part.functionResponse.name || undefined,
          content: JSON.stringify(part.functionResponse.response ?? {})
        });
      }
    });

    const hasImage = parts.some((p) => p.type === "image_url");

    if (role === "assistant") {
      const message = { role, content: text.length ? text.join("") : null };
      if (toolCalls.length) message.tool_calls = toolCalls;
      messages.push(message);
      return;
    }

    // Tool results go first: OpenAI-compatible providers require them to follow
    // the assistant turn that made the calls with nothing in between, so text
    // the client sent in the same turn comes after them, never before.
    messages.push(...toolResults);
    if (toolMedia.length) {
      messages.push({ role: "user", content: [{ type: "text", text: "Image output of the tool call(s) above:" }, ...toolMedia] });
    }
    if (parts.length > 0) {
      messages.push({ role, content: hasImage ? parts : text.join("") });
    }
  });

  const tools = [];
  for (const tool of Array.isArray(body.tools) ? body.tools : []) {
    for (const fn of Array.isArray(tool?.functionDeclarations) ? tool.functionDeclarations : []) {
      if (!fn?.name) continue;
      tools.push({
        type: "function",
        function: {
          name: fn.name,
          description: fn.description || "",
          parameters: cleanSchemaForGemini(fn.parameters || { type: "object", properties: {} })
        }
      });
    }
  }

  const generation = body.generationConfig || {};
  const out = { model, messages };
  if (tools.length) out.tools = tools;
  if (stream) out.stream = true;

  const mode = body.toolConfig?.functionCallingConfig;
  const declaredNames = new Set(tools.map((tool) => tool.function.name));

  if (mode?.mode === "NONE") {
    out.tool_choice = "none";
  } else if (mode?.mode === "ANY") {
    const allowed = Array.isArray(mode.allowedFunctionNames)
      ? mode.allowedFunctionNames.filter((name) => typeof name === "string" && name)
      : [];

    if (allowed.length === 1 && declaredNames.has(allowed[0])) {
      // One named function is representable exactly, so send it as such. The
      // declaration is checked first: a `tool_choice` naming a function the
      // request never declares is rejected upstream, so an undeclared name
      // falls through to the controlled fallback below instead.
      out.tool_choice = { type: "function", function: { name: allowed[0] } };
    } else if (allowed.length > 1 && allowed.every((name) => declaredNames.has(name))) {
      // "Call one of these N" has no OpenAI-compatible tool_choice value.
      // `required` carries the "a call must happen" half; narrowing the
      // declarations to the allowed set carries the restriction half, because
      // the model then has nothing outside the allowed set to choose from. The
      // upstream sees a request whose meaning matches the original exactly.
      out.tools = tools.filter((tool) => allowed.includes(tool.function.name));
      out.tool_choice = "required";
    } else if (tools.length > 0) {
      // Empty allowedFunctionNames (Gemini reads it as "any tool"), a single
      // name with no matching functionDeclaration, or a mixed list of declared
      // and undeclared names: none of these can be represented. The controlled
      // fallback is `required` over every declared tool — the model is still
      // told it must call one, and only the name restriction is dropped. An
      // undeclared name is never invented or forwarded.
      out.tool_choice = "required";
    }
    // Otherwise nothing is callable at all: the request declares no tools, so
    // "a call must happen" cannot be honoured. `required` with an empty tool
    // list is a contradictory request providers reject, and any exact choice
    // would name an undeclared function, so the choice is left unset and the
    // request stays well-formed.
  } else if (mode?.mode === "AUTO" && Array.isArray(mode.allowedFunctionNames)) {
    // AUTO plus allowedFunctionNames means "may call one of these, or nothing".
    // The provider default already carries the "or nothing" half; narrowing the
    // declarations carries the restriction, so the model cannot call a
    // function the client excluded.
    const allowed = mode.allowedFunctionNames.filter((name) => declaredNames.has(name));
    if (allowed.length > 0 && allowed.length < tools.length) {
      out.tools = tools.filter((tool) => allowed.includes(tool.function.name));
    }
  }

  if (typeof generation.temperature === "number") out.temperature = generation.temperature;
  if (typeof generation.topP === "number") out.top_p = generation.topP;
  if (Number.isFinite(generation.maxOutputTokens)) out.max_tokens = generation.maxOutputTokens;
  if (Array.isArray(generation.stopSequences)) out.stop = generation.stopSequences;

  if (generation.responseMimeType === "application/json") {
    if (generation.responseSchema) {
      out.response_format = {
        type: "json_schema",
        json_schema: { name: "gemini_schema", schema: cleanSchemaForGemini(generation.responseSchema) }
      };
    } else {
      out.response_format = { type: "json_object" };
    }
  }

  return out;
}

function joinUrl(base, suffix) {
  const root = String(base || "").replace(/\/+$/, "");
  return root + "/" + String(suffix || "").replace(/^\/+/, "");
}

/** Builds the upstream fetch request for a translated (chat-compatible) target. */
export function buildGeminiBridgeRequest(target, body, incomingHeaders = {}, { stream = false } = {}) {
  const headers = {
    "content-type": "application/json",
    accept: stream ? "text/event-stream" : "application/json",
    authorization: "Bearer " + target.apiKey
  };
  if (incomingHeaders["user-agent"]) headers["user-agent"] = incomingHeaders["user-agent"];

  const base = String(target.baseUrl || "").replace(/\/+$/, "");
  const path = base.endsWith("/v1") ? "chat/completions" : "v1/chat/completions";
  return {
    url: joinUrl(base, path),
    options: {
      method: "POST",
      headers,
      body: JSON.stringify(toChatFromGemini(body, target.model, { stream }))
    }
  };
}

function finishReason(reason, hasToolCalls) {
  if (hasToolCalls) return "STOP";
  if (reason === "length") return "MAX_TOKENS";
  if (reason === "content_filter") return "SAFETY";
  return "STOP";
}

export function chatJsonToGemini(json) {
  const choice = json?.choices?.[0] || {};
  const message = choice.message || {};
  const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  const parts = [];

  if (typeof message.content === "string" && message.content) {
    parts.push({ text: message.content });
  } else if (Array.isArray(message.content)) {
    for (const part of message.content) if (typeof part?.text === "string") parts.push({ text: part.text });
  }

  for (const call of toolCalls) {
    const fn = call?.function;
    if (!fn?.name) continue;
    parts.push({
      functionCall: {
        id: call.id || id("call"),
        name: fn.name,
        args: parseArgs(fn.arguments, fn.name)
      }
    });
  }

  const usage = json?.usage;
  const usageMetadata = usage
    ? {
        promptTokenCount: Number(usage.prompt_tokens) || 0,
        candidatesTokenCount: Number(usage.completion_tokens) || 0,
        totalTokenCount: Number(usage.total_tokens) || 0
      }
    : undefined;

  const result = {
    candidates: [{
      content: { role: "model", parts },
      finishReason: finishReason(choice.finish_reason, toolCalls.length > 0),
      index: 0
    }]
  };
  if (usageMetadata) result.usageMetadata = usageMetadata;
  return result;
}

const sseData = (payload) => "data: " + JSON.stringify(payload) + "\n\n";

/**
 * Converts an OpenAI chat SSE stream into a Gemini SSE stream.
 *
 * Only ever called for a translated upstream: a native Gemini target streams
 * its own response straight through, so every event here is chat-shaped.
 *
 * Tool calls arrive as fragments — an id and name on the first delta, then the
 * arguments split across later ones, none of which parse as JSON on their own.
 * They are accumulated per index and emitted once, when the upstream reports a
 * finish reason (or the stream ends), so the client receives one complete
 * `functionCall` rather than a trail of empty ones.
 */
export async function* streamToGemini(events) {
  const pending = new Map();
  const order = [];

  const drainCalls = () => {
    const parts = order.map((key) => {
      const call = pending.get(key);
      return {
        functionCall: {
          id: call.id || id("call"),
          name: call.name || "tool",
          args: parseArgs(call.arguments, call.name)
        }
      };
    });
    order.length = 0;
    pending.clear();
    return parts;
  };

  try {
    for await (const data of events) {
      if (data === "[DONE]") break;
      let parsed;
      try { parsed = JSON.parse(data); } catch { continue; }
      if (parsed?.error) {
        yield sseData(parsed);
        continue;
      }

      const choices = Array.isArray(parsed.choices) ? parsed.choices : [];
      for (const choice of choices) {
        const delta = choice?.delta || {};
        const parts = [];
        if (typeof delta.content === "string" && delta.content) parts.push({ text: delta.content });

        const fragments = Array.isArray(delta.tool_calls) ? delta.tool_calls : [];
        for (const call of fragments) {
          const key = call.index ?? call.id ?? order.length;
          let entry = pending.get(key);
          if (!entry) {
            entry = { id: null, name: "", arguments: "" };
            pending.set(key, entry);
            order.push(key);
          }
          if (call.id) entry.id = call.id;
          if (call.function?.name) entry.name += call.function.name;
          if (typeof call.function?.arguments === "string") entry.arguments += call.function.arguments;
        }

        const finishing = Boolean(choice?.finish_reason);
        if (finishing) parts.push(...drainCalls());

        if (!parts.length && !finishing) continue;
        // Like Gemini itself, only the closing chunk carries a finishReason. A
        // client that treats a present finishReason as "this turn is over" would
        // otherwise stop reading at the first text delta.
        const candidate = { content: { role: "model", parts }, index: 0 };
        if (finishing) candidate.finishReason = finishReason(choice.finish_reason, parts.some((part) => part.functionCall));
        yield sseData({ candidates: [candidate] });
      }
    }

  } catch (error) {
    // Headers are already on the wire: report the truncation to the client as a
    // Gemini error object instead of ending as if the answer were complete.
    yield sseData({ error: { code: 502, status: "UNAVAILABLE", message: String(error?.message || "Upstream stream failed").slice(0, 300) } });
    return;
  }

  // A stream cut off before any finish reason still owes the client its calls.
  const remaining = drainCalls();
  if (remaining.length) {
    yield sseData({
      candidates: [{
        content: { role: "model", parts: remaining },
        finishReason: "STOP",
        index: 0
      }]
    });
  }
}
