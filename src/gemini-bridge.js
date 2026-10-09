import { randomUUID } from "node:crypto";
import { cleanSchemaForGemini } from "./anthropic-bridge.js";
import { toolCallKey, geminiNativeMediaUnsupportedError } from "./bridge-utils.js";
import { openAiSuffixPath } from "./url-utils.js";

function id(prefix) {
  return prefix + "_" + randomUUID().replace(/-/g, "").slice(0, 24);
}

/** Tool arguments arrive as a JSON string. A malformed one must not crash. */
function parseArgs(value) {
  if (typeof value !== "string") return value && typeof value === "object" ? value : {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function textParts(parts = []) {
  return parts.filter((p) => typeof p?.text === "string").map((p) => p.text).join("");
}

function inlineToChat(part) {
  const data = part?.inlineData;
  if (!data?.data) return null;
  // The SDK-style snake_case spelling carries `mime_type`; honour both so the
  // data URL keeps the real media type instead of degrading to octet-stream.
  const mimeType = data.mimeType ?? data.mime_type ?? "application/octet-stream";
  return {
    type: "image_url",
    image_url: { url: "data:" + mimeType + ";base64," + data.data }
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

  // Gemini clients usually send no ids on functionCall/functionResponse, so a
  // response is paired with the unanswered call of the same name from the
  // latest model turn. Otherwise the tool message would carry the function name
  // while the call carries a generated id, which OpenAI-compatible providers reject.
  let pending = [];

  for (const content of Array.isArray(body?.contents) ? body.contents : []) {
    const role = content?.role === "model" ? "assistant" : "user";
    if (role === "assistant") pending = [];
    const text = [];
    const parts = [];
    const toolCalls = [];
    const toolResults = [];

    for (const part of Array.isArray(content?.parts) ? content.parts : []) {
      // Thinking summaries are not conversation text.
      if (part?.thought === true && typeof part.text === "string") continue;
      if (typeof part?.text === "string") {
        text.push(part.text);
        // A mixed turn must use the content-parts form, in which every entry
        // is an object. A bare string is not a valid OpenAI content part.
        parts.push({ type: "text", text: part.text });
      }
      // Both spellings are accepted: the REST API uses camelCase (`inlineData`),
      // the official SDKs use snake_case (`inline_data`). `vision.js` detects
      // both as images, so both must be carried here — dropping either would
      // send an image-bearing request to the text-only upstream as plain text.
      const inline = part?.inlineData ?? part?.inline_data;
      if (inline) {
        const image = inlineToChat({ inlineData: inline });
        // An inline part with no payload has nothing to forward. Refuse it
        // rather than drop it, so the client never gets an answer that pretends
        // the model saw bytes it never received.
        if (!image) throw geminiNativeMediaUnsupportedError("inlineData");
        parts.push(image);
      }
      // A Files API URI is private to the Gemini provider (it needs the Gemini
      // key to fetch), so an OpenAI-compatible provider cannot be given one.
      if (part?.fileData || part?.file_data) {
        throw geminiNativeMediaUnsupportedError("fileData");
      }
      if (part?.functionCall) {
        const callId = part.functionCall.id || id("call");
        pending.push({ id: callId, name: part.functionCall.name || "tool" });
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
        const responseName = part.functionResponse.name || "";
        let callId = part.functionResponse.id;
        let at = callId
          ? pending.findIndex((call) => call.id === callId)
          : pending.findIndex((call) => call.name === responseName);
        if (!callId && at === -1 && pending.length) at = 0;
        if (at !== -1) {
          if (!callId) callId = pending[at].id;
          pending.splice(at, 1);
        }
        toolResults.push({
          role: "tool",
          tool_call_id: callId || responseName || "tool",
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

    // Tool results must directly follow the assistant turn that made the calls,
    // so they go before any user text that shares the turn. A functionResponse
    // turn with no text emits no empty user message for the same reason.
    messages.push(...toolResults);
    if (parts.length > 0) {
      messages.push({ role, content: hasImage ? parts : text.join("") });
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
  // Without this an OpenAI-compatible upstream sends no usage in a stream.
  if (stream) { out.stream = true; out.stream_options = { include_usage: true }; }

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
  const path = openAiSuffixPath(base, "chat/completions");
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
        id: call.id,
        name: fn.name,
        args: parseArgs(fn.arguments)
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
  const keyState = { last: null };
  let held = null;
  let usageMetadata = null;

  const drainCalls = () => {
    const parts = order.map((key) => {
      const call = pending.get(key);
      return {
        functionCall: {
          id: call.id ?? undefined,
          name: call.name || "tool",
          args: parseArgs(call.arguments)
        }
      };
    });
    order.length = 0;
    pending.clear();
    return parts;
  };

  for await (const data of events) {
    if (data === "[DONE]") break;
    let parsed;
    try { parsed = JSON.parse(data); } catch { continue; }
    if (parsed?.error) {
      // An upstream error ends the stream: nothing after it is a valid continuation.
      yield sseData(parsed);
      return;
    }

    const u = parsed.usage;
    if (u && typeof u === "object") {
      usageMetadata = {
        promptTokenCount: Number(u.prompt_tokens) || 0,
        candidatesTokenCount: Number(u.completion_tokens) || 0,
        totalTokenCount: Number(u.total_tokens) || 0
      };
    }

    const choices = Array.isArray(parsed.choices) ? parsed.choices : [];
    for (const choice of choices) {
      const delta = choice?.delta || {};
      const parts = [];
      if (typeof delta.content === "string" && delta.content) parts.push({ text: delta.content });

      const fragments = Array.isArray(delta.tool_calls) ? delta.tool_calls : [];
      for (const call of fragments) {
        const key = toolCallKey(call, keyState);
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

      // A chunk that is not the last must not carry a finishReason: Gemini
      // clients read it as the end of the response.
      const candidate = { content: { role: "model", parts }, index: 0 };
      if (finishing) {
        candidate.finishReason = finishReason(choice.finish_reason, parts.some((part) => part.functionCall));
        // The upstream's usage chunk arrives after the finish chunk, so the
        // last chunk is held until the stream ends and the usage is known.
        held = { candidates: [candidate] };
      } else {
        yield sseData({ candidates: [candidate] });
      }
    }
  }

  // A stream cut off before any finish reason still owes the client its calls.
  const remaining = drainCalls();
  if (remaining.length) {
    if (held) {
      // Calls that arrived after the held finish chunk belong in it.
      held.candidates[0].content.parts.push(...remaining);
    } else {
      held = { candidates: [{ content: { role: "model", parts: remaining }, finishReason: "STOP", index: 0 }] };
    }
  }

  if (held) {
    if (usageMetadata) held.usageMetadata = usageMetadata;
    yield sseData(held);
  }
}
