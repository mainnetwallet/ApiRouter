import { randomUUID } from "node:crypto";
import {
  anthropicMessagesUrl,
  geminiModelsUrl,
  openAiChatUrl,
  openAiResponsesUrl
} from "./upstream-url.js";

export function providerProtocols(provider) {
  if (provider === "agentrouter") return ["anthropic", "openai-chat", "openai-responses"];
  if (provider === "gemini") return ["gemini"];
  return ["openai-chat"];
}

function applyConfiguredClientHeaders(headers, target) {
  if (target?.provider !== "agentrouter") return;
  const configured = target.clientHeaders || {};
  if (configured.originator) headers.originator = configured.originator;
  if (configured.version) headers.version = configured.version;
  if (configured["user-agent"]) headers["user-agent"] = configured["user-agent"];
}

export function buildUpstreamRequest(target, protocol, body, incomingHeaders = {}, { stream = false } = {}) {
  const headers = {
    "content-type": "application/json",
    accept: incomingHeaders.accept || "application/json"
  };
  if (incomingHeaders["user-agent"]) headers["user-agent"] = incomingHeaders["user-agent"];
  if (incomingHeaders.originator) headers.originator = incomingHeaders.originator;

  const base = String(target.baseUrl || "").replace(/\/+$/, "");
  let url;
  const payload = { ...(body || {}) };

  if (protocol === "anthropic") {
    url = anthropicMessagesUrl(base, { agentrouter: target.provider === "agentrouter" });
    payload.model = target.model;
    headers.authorization = "Bearer " + target.apiKey;
    headers["anthropic-version"] = incomingHeaders["anthropic-version"] || "2023-06-01";
    if (incomingHeaders["anthropic-beta"]) headers["anthropic-beta"] = incomingHeaders["anthropic-beta"];
  } else if (protocol === "openai-responses") {
    url = openAiResponsesUrl(base);
    payload.model = target.model;
    headers.authorization = "Bearer " + target.apiKey;
  } else if (protocol === "openai-chat") {
    url = openAiChatUrl(base);
    payload.model = target.model;
    headers.authorization = "Bearer " + target.apiKey;
  } else if (protocol === "gemini") {
    // The client picks streaming by calling :streamGenerateContent, so the
    // method name — not a body field — decides which one to ask the provider for.
    // The shared builder strips a version already present on the base URL.
    url = geminiModelsUrl(base, target.model, { stream });
    headers["x-goog-api-key"] = target.apiKey;
  } else {
    throw new Error("Unsupported upstream protocol: " + protocol);
  }

  applyConfiguredClientHeaders(headers, target);
  return { url, options: { method: "POST", headers, body: JSON.stringify(payload) } };
}

export function createSessionId() { return randomUUID(); }

export async function readJsonBody(req, { maxBytes = 0 } = {}) {
  // The gateway does not size request bodies (providers do); it only guards its
  // own memory. Buffering stops at `maxBytes` while the rest of the upload is
  // still drained, so the caller can answer 413 instead of cutting the socket.
  const chunks = [];
  let total = 0;
  let exceeded = false;
  for await (const chunk of req) {
    total += chunk.length;
    if (maxBytes > 0 && total > maxBytes) {
      exceeded = true;
      continue;
    }
    chunks.push(chunk);
  }
  if (exceeded) {
    const error = new Error(`Request body exceeds the ${maxBytes} byte limit`);
    error.status = 413;
    error.errorType = "request_too_large";
    error.bytes = total;
    throw error;
  }
  if (chunks.length === 0) return {};
  let parsed;
  try { parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch {
    const error = new Error("Invalid JSON request body");
    error.status = 400;
    throw error;
  }
  // Every request body this gateway accepts is a JSON object. `null`, arrays and
  // scalars parse fine but would crash the first `body.model` read, so they are
  // rejected here, as a client error, before any routing code sees them.
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    const error = new Error("Request body must be a JSON object");
    error.status = 400;
    throw error;
  }
  return parsed;
}

const GEMINI_METHODS = new Map([
  ["generatecontent", "generateContent"],
  ["streamgeneratecontent", "streamGenerateContent"]
]);

/**
 * Parse a Gemini client path: `/v1beta/models/<model>:<method>`.
 *
 * One parser for detection, streaming detection and the model name, so the
 * three can never disagree. The method is matched case-insensitively (Google's
 * own clients use both `generateContent` and `GenerateContent` spellings) and
 * the model may contain `/` or percent-escapes, which the previous
 * `[^/]+:(?:stream)?[Gg]enerateContent` pattern rejected. Anything that is not
 * a recognised method — including `:countTokens` — parses to null.
 */
export function parseGeminiPath(pathname) {
  const match = /^\/v1beta\/models\/(.+):([A-Za-z]+)$/.exec(String(pathname ?? ""));
  if (!match) return null;
  const method = GEMINI_METHODS.get(match[2].toLowerCase());
  if (!method) return null;
  let model;
  try {
    model = decodeURIComponent(match[1]);
  } catch {
    return null;
  }
  if (!model) return null;
  return { model, method, stream: method === "streamGenerateContent" };
}

export function clientProtocol(pathname) {
  if (pathname === "/v1/messages") return "anthropic";
  if (pathname === "/v1/responses") return "openai-responses";
  if (pathname === "/v1/chat/completions") return "openai-chat";
  // Gemini clients choose streaming with the method name, so both are routes.
  if (parseGeminiPath(pathname)) return "gemini";
  return null;
}

/** True when a Gemini client asked for the streaming method. */
export function isGeminiStream(pathname) {
  return parseGeminiPath(pathname)?.stream === true;
}
