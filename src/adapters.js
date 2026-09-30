import { randomUUID } from "node:crypto";

const OPENAI_PROTOCOL_PROVIDERS = new Set(["groq","huggingface","mistral","openrouter","cerebras","sambanova","cohere","zai"]);

export function providerProtocol(provider) {
  if (provider === "agentrouter") return "anthropic";
  if (provider === "gemini") return "gemini";
  return OPENAI_PROTOCOL_PROVIDERS.has(provider) || provider === "cloudflare" ? "openai" : "openai";
}

function joinUrl(baseUrl, suffix) {
  const base = String(baseUrl || "").replace(/\/+$/, "");
  const path = String(suffix || "").replace(/^\/+/, "");
  return path ? base + "/" + path : base;
}

export function buildUpstreamRequest(target, protocol, body, incomingHeaders = {}) {
  const payload = { ...(body || {}), model: target.model };
  const headers = { "content-type": "application/json", accept: incomingHeaders.accept || "application/json" };
  const base = String(target.baseUrl || "").replace(/\/+$/, "");
  let url;

  if (protocol === "anthropic") {
    url = joinUrl(base, base.endsWith("/v1") ? "messages" : "v1/messages");
    headers.authorization = "Bearer " + target.apiKey;
    headers["anthropic-version"] = incomingHeaders["anthropic-version"] || "2023-06-01";
    if (incomingHeaders["anthropic-beta"]) headers["anthropic-beta"] = incomingHeaders["anthropic-beta"];
  } else if (protocol === "responses") {
    url = joinUrl(base, base.endsWith("/v1") ? "responses" : "v1/responses");
    headers.authorization = "Bearer " + target.apiKey;
  } else {
    url = joinUrl(base, base.endsWith("/v1") ? "chat/completions" : "v1/chat/completions");
    headers.authorization = "Bearer " + target.apiKey;
  }

  return { url, options: { method: "POST", headers, body: JSON.stringify(payload) } };
}

export function createSessionId() { return randomUUID(); }

export async function readJsonBody(req, maxBytes = 10 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) { const error = new Error("Request body too large"); error.status = 413; throw error; }
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export function clientProtocol(pathname) {
  if (pathname === "/v1/messages") return "anthropic";
  if (pathname === "/v1/responses") return "responses";
  if (pathname === "/v1/chat/completions") return "openai";
  return null;
}