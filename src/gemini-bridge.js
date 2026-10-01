import { randomUUID } from "node:crypto";
import { cleanSchemaForGemini } from "./anthropic-bridge.js";

function id(prefix) {
  return prefix + "_" + randomUUID().replace(/-/g, "").slice(0, 24);
}

function parseArgs(value) {
  if (typeof value !== "string") return value && typeof value === "object" ? value : {};
  try { return JSON.parse(value); } catch { return {}; }
}

function textParts(parts = []) {
  return parts.filter((p) => typeof p?.text === "string").map((p) => p.text).join("");
}

function inlineToChat(part) {
  const data = part?.inlineData;
  if (!data?.data) return null;
  return {
    type: "image_url",
    image_url: { url: "data:" + (data.mimeType || "application/octet-stream") + ";base64," + data.data }
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

/** Gemini generateContent request -> OpenAI chat request. */
export function toChatFromGemini(body, requestedModel) {
  const messages = [];
  const system = body?.systemInstruction?.parts
    ? textParts(body.systemInstruction.parts)
    : "";

  if (system) messages.push({ role: "system", content: system });

  for (const content of Array.isArray(body?.contents) ? body.contents : []) {
    const role = content?.role === "model" ? "assistant" : "user";
    const text = [];
    const toolCalls = [];
    const toolResults = [];

    for (const part of Array.isArray(content?.parts) ? content.parts : []) {
      if (typeof part?.text === "string") text.push(part.text);
      if (part?.inlineData) {
        const image = inlineToChat(part);
        if (image) text.push(image);
      }
      if (part?.functionCall) {
        const callId = part.functionCall.id || id("call");
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

    if (role === "assistant") {
      const message = { role, content: text.length ? text : null };
      if (toolCalls.length) message.tool_calls = toolCalls;
      messages.push(message);
    } else {
      const hasImage = text.some((p) => typeof p === "object");
      messages.push({ role, content: hasImage ? text : text.join("") });
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
  const out = {
    model: requestedModel,
    messages,
  };
  if (tools.length) out.tools = tools;

  const mode = body?.toolConfig?.functionCallingConfig;
  if (mode?.mode === "NONE") out.tool_choice = "none";
  else if (mode?.mode === "ANY") {
    const names = mode.allowedFunctionNames;
    out.tool_choice = Array.isArray(names) && names.length === 1
      ? { type: "function", function: { name: names[0] } }
      : "required";
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

export function buildGeminiBridgeRequest(target, body, requestedModel, incomingHeaders = {}) {
  const headers = {
    "content-type": "application/json",
    accept: body?.stream ? "text/event-stream" : "application/json",
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
      body: JSON.stringify(toChatFromGemini(body, requestedModel))
    }
  };
}

function finishReason(reason, toolCalls) {
  if (toolCalls) return "STOP";
  if (reason === "length") return "MAX_TOKENS";
  if (reason === "content_filter") return "SAFETY";
  return "STOP";
}

export function chatJsonToGemini(json, model) {
  const choice = json?.choices?.[0] || {};
  const message = choice.message || {};
  const parts = [];

  if (typeof message.content === "string" && message.content) {
    parts.push({ text: message.content });
  } else if (Array.isArray(message.content)) {
    for (const part of message.content) if (typeof part?.text === "string") parts.push({ text: part.text });
  }

  for (const call of message.tool_calls || []) {
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
      finishReason: finishReason(choice.finish_reason, (message.tool_calls || []).length > 0),
      index: 0
    }]
  };
  if (usageMetadata) result.usageMetadata = usageMetadata;
  return result;
}

function parseSseEvent(buffer) {
  const lines = buffer.split("\n");
  const data = lines.filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("\n");
  return data || null;
}

export async function* streamToGemini(events, model) {
  for await (const data of events) {
    if (data === "[DONE]") break;
    let parsed;
    try { parsed = JSON.parse(data); } catch { continue; }
    if (parsed?.error) {
      yield "data: " + JSON.stringify(parsed) + "\n\n";
      continue;
    }

    const choices = Array.isArray(parsed.choices) ? parsed.choices : [];
    for (const choice of choices) {
      const delta = choice?.delta || {};
      const parts = [];
      if (typeof delta.content === "string" && delta.content) parts.push({ text: delta.content });
      for (const call of delta.tool_calls || []) {
        const fn = call?.function;
        if (fn?.name || fn?.arguments) {
          const args = parseArgs(fn.arguments);
          parts.push({
            functionCall: {
              id: call.id,
              name: fn.name || "tool",
              args
            }
          });
        }
      }
      if (!parts.length && !choice?.finish_reason) continue;
      yield "data: " + JSON.stringify({
        candidates: [{
          content: { role: "model", parts },
          finishReason: finishReason(choice.finish_reason, choice.finish_reason === "tool_calls"),
          index: 0
        }]
      }) + "\n\n";
    }
  }
}
