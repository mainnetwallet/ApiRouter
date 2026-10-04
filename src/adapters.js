import { randomUUID } from "node:crypto";

export function providerProtocols(provider) {
  if (provider === "agentrouter") return ["anthropic", "openai-chat", "openai-responses"];
  if (provider === "gemini") return ["gemini"];
  return ["openai-chat"];
}

function joinUrl(baseUrl, suffix) {
  const base = String(baseUrl || "").replace(/\/+$/, "");
  const path = String(suffix || "").replace(/^\/+/, "");
  return path ? base + "/" + path : base;
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
    const anthropicBase = target.provider === "agentrouter" ? base.replace(/\/v1$/i, "") : base;
    url = joinUrl(anthropicBase, "v1/messages");
    payload.model = target.model;
    headers.authorization = "Bearer " + target.apiKey;
    headers["anthropic-version"] = incomingHeaders["anthropic-version"] || "2023-06-01";
    if (incomingHeaders["anthropic-beta"]) headers["anthropic-beta"] = incomingHeaders["anthropic-beta"];
  } else if (protocol === "openai-responses") {
    url = joinUrl(base, base.endsWith("/v1") ? "responses" : "v1/responses");
    payload.model = target.model;
    headers.authorization = "Bearer " + target.apiKey;
  } else if (protocol === "openai-chat") {
    url = joinUrl(base, base.endsWith("/v1") ? "chat/completions" : "v1/chat/completions");
    payload.model = target.model;
    headers.authorization = "Bearer " + target.apiKey;
  } else if (protocol === "gemini") {
    // The client picks streaming by calling :streamGenerateContent, so the
    // method name — not a body field — decides which one to ask the provider for.
    const method = stream ? ":streamGenerateContent?alt=sse" : ":generateContent";
    // A configured base URL may already carry the API version — `health-checks.js`
    // accepts either form — so it is stripped before the model path is appended.
    // Otherwise the request goes to `/v1beta/v1beta/models/...`.
    const root = base.replace(/\/v\d+(?:alpha|beta)?\d*$/i, "");
    url = joinUrl(root, "v1beta/models/" + encodeURIComponent(target.model) + method);
    headers["x-goog-api-key"] = target.apiKey;
  } else {
    throw new Error("Unsupported upstream protocol: " + protocol);
  }

  applyConfiguredClientHeaders(headers, target);
  return { url, options: { method: "POST", headers, body: JSON.stringify(payload) } };
}

export function createSessionId() { return randomUUID(); }

export async function readJsonBody(req) {
  // No size limit of our own: the whole body is read as sent.
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
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

export function clientProtocol(pathname) {
  if (pathname === "/v1/messages") return "anthropic";
  if (pathname === "/v1/responses") return "openai-responses";
  if (pathname === "/v1/chat/completions") return "openai-chat";
  // Gemini clients choose streaming with the method name, so both are routes.
  if (/^\/v1beta\/models\/[^/]+:(?:stream)?[Gg]enerateContent$/.test(pathname)) return "gemini";
  return null;
}

/** True when a Gemini client asked for the streaming method. */
export function isGeminiStream(pathname) {
  return /:streamGenerateContent$/.test(pathname);
}
