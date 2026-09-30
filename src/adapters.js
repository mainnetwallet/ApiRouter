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

export function buildUpstreamRequest(target, protocol, body, incomingHeaders = {}) {
  const headers = {
    "content-type": "application/json",
    accept: incomingHeaders.accept || "application/json"
  };

  if (incomingHeaders["user-agent"]) headers["user-agent"] = incomingHeaders["user-agent"];
  if (incomingHeaders.originator) headers.originator = incomingHeaders.originator;

  const base = String(target.baseUrl || "").replace(/\/+$/, "");
  let url;
  let payload = { ...(body || {}) };

  if (protocol === "anthropic") {
    // AgentRouter exposes Anthropic Messages at the root host (no /v1),
    // while its OpenAI-compatible API uses /v1. Keep a single configured
    // AgentRouter base URL and normalize it per protocol here.
    const anthropicBase = target.provider === "agentrouter"
      ? base.replace(/\/v1$/i, "")
      : base;
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
    url = joinUrl(
      base,
      "v1beta/models/" + encodeURIComponent(target.model) + ":generateContent"
    );
    headers["x-goog-api-key"] = target.apiKey;
  } else {
    throw new Error("Unsupported upstream protocol: " + protocol);
  }

  return {
    url,
    options: {
      method: "POST",
      headers,
      body: JSON.stringify(payload)
    }
  };
}

export function createSessionId() {
  return randomUUID();
}

export async function readJsonBody(req, maxBytes = 10 * 1024 * 1024) {
  const chunks = [];
  let size = 0;

  for await (const chunk of req) {
    size += chunk.length;

    if (size > maxBytes) {
      const error = new Error("Request body too large");
      error.status = 413;
      throw error;
    }

    chunks.push(chunk);
  }

  if (chunks.length === 0) return {};

  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    const error = new Error("Invalid JSON request body");
    error.status = 400;
    throw error;
  }
}

export function clientProtocol(pathname) {
  if (pathname === "/v1/messages") return "anthropic";
  if (pathname === "/v1/responses") return "openai-responses";
  if (pathname === "/v1/chat/completions") return "openai-chat";
  if (/^\/v1beta\/models\/[^/]+:generateContent$/.test(pathname)) return "gemini";
  return null;
}
