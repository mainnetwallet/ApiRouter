import { apiStream } from "./client.js";
import { sanitizeText } from "../lib/sanitize.js";

/**
 * Playground transport.
 *
 * The playground talks to the gateway's *public* proxy endpoints — never to a
 * provider directly and never to an internal shortcut. That is deliberate:
 * "never bypass the backend router" means the playground exercises exactly the
 * path a real client would, including protocol detection, health ranking,
 * cooldown and fallback. With Auto Route on, nothing is pinned and the gateway
 * chooses. With it off, the chosen provider (and key, when one is picked) are
 * sent as pin headers and the gateway calls exactly that target.
 */

export const PROTOCOL_ENDPOINTS = Object.freeze({
  "openai-chat": "/v1/chat/completions",
  "openai-responses": "/v1/responses",
  anthropic: "/v1/messages",
  gemini: "/v1beta/models"
});

/**
 * Pin headers understood by the gateway. A pin needs a provider; a key index
 * is meaningless on its own, so it is only sent alongside one.
 */
export function buildPinHeaders({ autoRoute, provider, keyIndex, customModel } = {}) {
  if (autoRoute || !provider) return {};
  const headers = { "x-multi-ai-pin-provider": provider };
  if (Number.isInteger(keyIndex) && keyIndex >= 0) headers["x-multi-ai-pin-key-index"] = String(keyIndex);
  // A custom model is a model id typed in by hand, not one of the provider's
  // configured models. The gateway only accepts an unconfigured id when told to.
  if (customModel === true) headers["x-multi-ai-pin-custom-model"] = "1";
  return headers;
}

export function endpointFor(protocol, model) {
  if (protocol === "gemini") {
    return `/v1beta/models/${encodeURIComponent(model || "model")}:generateContent`;
  }
  return PROTOCOL_ENDPOINTS[protocol] ?? PROTOCOL_ENDPOINTS["openai-chat"];
}

/**
 * Build a request body in the client protocol's native shape.
 *
 * Auto Route omits `model`, which is what makes the gateway widen to every
 * protocol-compatible target instead of pinning one.
 */
/** Parse the Max tokens field: blank, zero or garbage all mean "no limit". */
export function parseMaxTokens(value) {
  const text = String(value ?? "").trim();
  if (text === "") return null;
  const number = Number(text);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : null;
}

export function buildRequestBody({
  protocol,
  model,
  autoRoute,
  prompt,
  system,
  temperature,
  maxTokens,
  images = [],
  stream = true
}) {
  const text = String(prompt ?? "");
  const pictures = Array.isArray(images) ? images.filter((image) => image?.data && image?.mimeType) : [];
  const includeModel = !autoRoute && Boolean(model);
  // Blank means "no limit": the field is simply not sent, so the provider's own
  // default applies. (`Number("")` is 0, which must never reach the wire.)
  const limited = Number.isFinite(maxTokens) && maxTokens > 0;

  if (protocol === "anthropic") {
    return {
      ...(includeModel ? { model } : {}),
      ...(limited ? { max_tokens: maxTokens } : {}),
      ...(system ? { system } : {}),
      ...(Number.isFinite(temperature) ? { temperature } : {}),
      messages: [{
        role: "user",
        content: pictures.length === 0
          ? text
          : [
            ...pictures.map((image) => ({
              type: "image",
              source: { type: "base64", media_type: image.mimeType, data: image.data }
            })),
            ...(text ? [{ type: "text", text }] : [])
          ]
      }],
      stream
    };
  }

  if (protocol === "openai-responses") {
    return {
      ...(includeModel ? { model } : {}),
      input: pictures.length === 0
        ? text
        : [{
          role: "user",
          content: [
            ...(text ? [{ type: "input_text", text }] : []),
            ...pictures.map((image) => ({
              type: "input_image",
              image_url: `data:${image.mimeType};base64,${image.data}`
            }))
          ]
        }],
      ...(system ? { instructions: system } : {}),
      ...(Number.isFinite(temperature) ? { temperature } : {}),
      ...(limited ? { max_output_tokens: maxTokens } : {}),
      stream
    };
  }

  if (protocol === "gemini") {
    const generationConfig = {};
    if (Number.isFinite(temperature)) generationConfig.temperature = temperature;
    if (limited) generationConfig.maxOutputTokens = maxTokens;

    return {
      contents: [{
        role: "user",
        parts: [
          ...(text || pictures.length === 0 ? [{ text }] : []),
          ...pictures.map((image) => ({ inlineData: { mimeType: image.mimeType, data: image.data } }))
        ]
      }],
      ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
      ...(Object.keys(generationConfig).length ? { generationConfig } : {})
    };
  }

  return {
    ...(includeModel ? { model } : {}),
    messages: [
      ...(system ? [{ role: "system", content: system }] : []),
      {
        role: "user",
        content: pictures.length === 0
          ? text
          : [
            ...(text ? [{ type: "text", text }] : []),
            ...pictures.map((image) => ({
              type: "image_url",
              image_url: { url: `data:${image.mimeType};base64,${image.data}` }
            }))
          ]
      }
    ],
    ...(Number.isFinite(temperature) ? { temperature } : {}),
    ...(limited ? { max_tokens: maxTokens } : {}),
    stream
  };
}

/** Incremental text from one SSE `data:` payload, per protocol shape. */
export function extractDelta(protocol, parsed) {
  if (!parsed || typeof parsed !== "object") return "";

  if (protocol === "anthropic") {
    if (parsed.type === "content_block_delta") return parsed.delta?.text ?? "";
    return "";
  }

  if (protocol === "openai-responses") {
    if (typeof parsed.delta === "string" && parsed.type?.includes("output_text")) return parsed.delta;
    return "";
  }

  // openai-chat
  const choice = parsed.choices?.[0];
  if (!choice) return "";
  const content = choice.delta?.content;
  if (typeof content === "string") return content;
  // Some providers emit the non-streaming shape even on the stream endpoint.
  if (typeof choice.message?.content === "string") return choice.message.content;
  return "";
}

/** Terminal metadata from a final chunk, when the provider reports it. */
export function extractStreamMeta(protocol, parsed) {
  if (!parsed || typeof parsed !== "object") return {};

  const meta = {};

  const usage = parsed.usage ?? parsed.usageMetadata ?? null;
  if (usage) {
    if (Number.isFinite(usage.total_tokens)) meta.tokens = usage.total_tokens;
    else if (Number.isFinite(usage.totalTokens)) meta.tokens = usage.totalTokens;
    else if (Number.isFinite(usage.input_tokens) || Number.isFinite(usage.output_tokens)) {
      meta.tokens = (Number(usage.input_tokens) || 0) + (Number(usage.output_tokens) || 0);
    }
  }

  const finish =
    parsed.choices?.[0]?.finish_reason ??
    parsed.stop_reason ??
    parsed.candidates?.[0]?.finishReason ??
    null;
  if (typeof finish === "string") meta.finishReason = finish;

  return meta;
}

/** Non-streaming body → text, for providers that answer with plain JSON. */
export function extractText(protocol, parsed) {
  if (!parsed || typeof parsed !== "object") return "";

  if (protocol === "anthropic") {
    return (parsed.content ?? [])
      .filter((block) => block?.type === "text")
      .map((block) => block.text)
      .join("");
  }

  if (protocol === "gemini") {
    return (parsed.candidates?.[0]?.content?.parts ?? [])
      .map((part) => part?.text ?? "")
      .join("");
  }

  if (protocol === "openai-responses") {
    if (typeof parsed.output_text === "string") return parsed.output_text;
    return (parsed.output ?? [])
      .flatMap((item) => item?.content ?? [])
      .map((part) => part?.text ?? "")
      .join("");
  }

  return parsed.choices?.[0]?.message?.content ?? "";
}

/**
 * Send a playground request, reporting text as it arrives.
 *
 * `onDelta` is called with each incremental chunk; `signal` cancels. Returns
 * the final metadata plus the routed target, which comes from the gateway's
 * own response headers rather than from any client-side guess.
 */
export async function sendPlaygroundRequest({
  protocol,
  model,
  body,
  headers,
  signal,
  onDelta,
  onMeta
}) {
  const response = await apiStream(endpointFor(protocol, model ?? body.model), { body, signal, headers });

  const routed = {
    provider: response.headers.get("x-multi-ai-provider"),
    model: response.headers.get("x-multi-ai-model"),
    keyIndex: Number(response.headers.get("x-multi-ai-key-index")),
    sessionId: response.headers.get("x-multi-ai-session-id"),
    status: response.status,
    contentType: response.headers.get("content-type") ?? ""
  };

  onMeta?.({ routed });

  const contentType = routed.contentType;
  let text = "";
  let meta = {};

  // Anthropic always streams when `stream: true`; Gemini generateContent does
  // not stream at all, so it takes the JSON path.
  const isStream = contentType.includes("text/event-stream");

  if (!isStream) {
    const raw = await response.text();
    let parsed = null;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = null;
    }

    text = parsed ? extractText(protocol, parsed) : sanitizeText(raw);
    meta = parsed ? extractStreamMeta(protocol, parsed) : {};
    if (text) onDelta?.(text);
    return { text, ...meta, routed };
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // SSE frames are separated by a blank line. Anything after the last
      // separator stays buffered until more bytes arrive.
      const frames = buffer.split(/\r?\n\r?\n/);
      buffer = frames.pop() ?? "";

      for (const frame of frames) {
        for (const line of frame.split(/\r?\n/)) {
          if (!line.startsWith("data:")) continue;
          const payload = line.slice(5).trim();
          if (!payload || payload === "[DONE]") continue;

          let parsed = null;
          try {
            parsed = JSON.parse(payload);
          } catch {
            continue;
          }

          const delta = extractDelta(protocol, parsed);
          if (delta) {
            text += delta;
            onDelta?.(delta);
          }

          const streamMeta = extractStreamMeta(protocol, parsed);
          if (Object.keys(streamMeta).length > 0) meta = { ...meta, ...streamMeta };
        }
      }
    }
  } finally {
    reader.releaseLock?.();
  }

  return { text, ...meta, routed };
}
