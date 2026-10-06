import { randomUUID } from "node:crypto";
import { unsupportedImageSource } from "./image-source.js";
import { openAiChatUrl } from "./upstream-url.js";
import { cleanSchemaForGemini } from "./anthropic-bridge.js";
import { INVALID_TOOL_ARGUMENTS, markStreamFailure, parseToolArguments } from "./bridge-errors.js";

function id(prefix) {
  return prefix + "_" + randomUUID().replace(/-/g, "").slice(0, 24);
}

function textParts(parts = []) {
  return parts.filter((p) => typeof p?.text === "string").map((p) => p.text).join("");
}

function inlineToChat(part) {
  const data = part?.inlineData ?? part?.inline_data;
  if (!data?.data) return null;
  return {
    type: "image_url",
    image_url: {
      url: "data:" + (data.mimeType || data.mime_type || "application/octet-stream") + ";base64," + data.data
    }
  };
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
export function toChatFromGemini(body, model, { stream = false } = {}) {
  const messages = [];
  const system = body?.systemInstruction?.parts
    ? textParts(body.systemInstruction.parts)
    : "";

  if (system) messages.push({ role: "system", content: system });

  for (const content of Array.isArray(body?.contents) ? body.contents : []) {
    const role = content?.role === "model" ? "assistant" : "user";
    const text = [];
    const parts = [];
    const toolCalls = [];
    const toolResults = [];

    for (const part of Array.isArray(content?.parts) ? content.parts : []) {
      if (typeof part?.text === "string") {
        text.push(part.text);
        // A mixed turn must use the content-parts form, in which every entry
        // is an object. A bare string is not a valid OpenAI content part.
        parts.push({ type: "text", text: part.text });
      }
      if (part?.inlineData || part?.inline_data) {
        const image = inlineToChat(part);
        // An inlineData with no bytes cannot be replayed, so it is refused
        // rather than silently dropped from the translated request.
        if (!image) throw unsupportedImageSource("a Gemini inlineData part with no data");
        parts.push(image);
      }
      if (part?.fileData || part?.file_data) {
        // fileData references a URI only Gemini can resolve; the gateway will
        // not fetch it, so the request is refused explicitly.
        throw unsupportedImageSource("a Gemini fileData (fileUri) reference");
      }
      if (part?.functionCall) {
        // Gemini's classic functionCall has no id, so pair it with the answer by
        // the function name (the same fallback functionResponse uses). A random
        // id here would never match the tool_call_id the response carries.
        const callId = part.functionCall.id || part.functionCall.name || id("call");
        toolCalls.push({
          id: callId,
          type: "function",
          function: {
            name: part.functionCall.name || "tool",
            arguments: JSON.stringify(part.functionCall.args || {})
          }
        });
      }
      if (part?.functionResponse) {
        toolResults.push({
          role: "tool",
          tool_call_id: part.functionResponse.id || part.functionResponse.name || "tool",
          name: part.functionResponse.name || undefined,
          content: JSON.stringify(part.functionResponse.response ?? {})
        });
      }
    }

    const hasImage = parts.some((p) => p.type === "image_url");

    if (role === "assistant") {
      const message = { role, content: text.length ? text.join("") : null };
      if (toolCalls.length) message.tool_calls = toolCalls;
      messages.push(message);
      continue;
    }

    // A functionResponse turn carries no user text. Emitting an empty user
    // message there would separate the tool result from the assistant turn it
    // answers, which OpenAI-compatible providers reject outright.
    if (parts.length > 0) {
      // Tool results must sit immediately after the assistant message that
      // requested them, so they are appended before any trailing user text.
      messages.push(...toolResults);
      messages.push({ role, content: hasImage ? parts : text.join("") });
    } else {
      messages.push(...toolResults);
    }
  }

  const tools = [];
  for (const tool of Array.isArray(body?.tools) ? body.tools : []) {
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

  const generation = body?.generationConfig || {};
  const out = { model, messages };
  if (tools.length) out.tools = tools;
  if (stream) out.stream = true;

  const mode = body?.toolConfig?.functionCallingConfig;
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

/** Builds the upstream fetch request for a translated (chat-compatible) target. */
export function buildGeminiBridgeRequest(target, body, incomingHeaders = {}, { stream = false } = {}) {
  const headers = {
    "content-type": "application/json",
    accept: stream ? "text/event-stream" : "application/json",
    authorization: "Bearer " + target.apiKey
  };
  if (incomingHeaders["user-agent"]) headers["user-agent"] = incomingHeaders["user-agent"];

  const base = String(target.baseUrl || "").replace(/\/+$/, "");
  return {
    url: openAiChatUrl(base),
    options: {
      method: "POST",
      headers,
      body: JSON.stringify(toChatFromGemini(body, target.model, { stream }))
    }
  };
}

function finishReason(reason, hasToolCalls) {
  // A truncated response is truncated whether or not it also emitted tool calls.
  if (reason === "length") return "MAX_TOKENS";
  if (reason === "content_filter" || reason === "safety") return "SAFETY";
  if (reason === "recitation") return "RECITATION";
  if (hasToolCalls) return "STOP";
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
        id: call.id,
        name: fn.name,
        args: parseToolArguments(fn.arguments)
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
          // Same id fallback as the non-streaming path, so a client that echoes
          // the call back keeps a stable pairing.
          id: call.id || call.name || "tool",
          name: call.name || "tool",
          args: parseToolArguments(call.arguments)
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
        // The client keeps Gemini's error envelope, but an explicit provider
        // error inside a 200 body is a FAILED stream, not a success: the throw
        // (marked as an upstream failure, never a client abort) makes
        // `pipeline()` reject so the server records a truncated request, cools
        // the target and saves no sticky.
        yield sseData(parsed);
        const message = typeof parsed.error === "string" ? parsed.error : parsed.error?.message;
        throw markStreamFailure(new Error(message || "Upstream stream reported an error"));
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
        const candidate = { content: { role: "model", parts }, index: 0 };
        // `finishReason` is a terminal signal, so it may only appear on the
        // chunk that actually carries one: announcing `STOP` on an intermediate
        // chunk tells the client the answer is already over.
        if (finishing) candidate.finishReason = finishReason(choice.finish_reason, parts.some((part) => part.functionCall));
        yield sseData({ candidates: [candidate] });
      }
    }

    // A stream cut off before any finish reason still owes the client its calls,
    // but no finish reason is invented for it: Gemini leaves `finishReason`
    // unset until the model actually stopped, and the client stops at the end
    // of the stream.
    const remaining = drainCalls();
    if (remaining.length) {
      yield sseData({ candidates: [{ content: { role: "model", parts: remaining }, index: 0 }] });
    }
  } catch (error) {
    if (error?.errorType === INVALID_TOOL_ARGUMENTS) {
      // Gemini's own mid-stream error envelope (the same shape a native Gemini
      // upstream sends), then the stream fails: never a silent `{}` and never a
      // recorded success. Marked as a stream failure so the truncated request is
      // classified as a truncation rather than a client abort.
      yield sseData({
        error: { code: 400, status: "INVALID_ARGUMENT", message: String(error.message || "invalid_tool_arguments").slice(0, 500) }
      });
      throw markStreamFailure(error);
    }
    throw error;
  }
}
