import { randomUUID } from "node:crypto";
import { geminiModelUrl } from "./gemini-url.js";

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
    url = geminiModelUrl(base, target.model, { stream });
    headers["x-goog-api-key"] = target.apiKey;
  } else {
    throw new Error("Unsupported upstream protocol: " + protocol);
  }

  applyConfiguredClientHeaders(headers, target);
  return { url, options: { method: "POST", headers, body: JSON.stringify(payload) } };
}

export function createSessionId() { return randomUUID(); }

/** Reads the request body. `maxBytes` (optional) is the operator's ceiling; without it there is none. */
export async function readJsonBody(req, { maxBytes = null } = {}) {
  const tooLarge = () => {
    const error = new Error(`Request body is larger than the configured limit of ${maxBytes} bytes`);
    error.status = 413;
    error.errorType = "request_too_large";
    return error;
  };
  const declared = Number(req.headers?.["content-length"]);
  if (maxBytes && Number.isFinite(declared) && declared > maxBytes) {
    // Refused from the header alone: not a byte of the body is buffered.
    throw tooLarge();
  }
  const chunks = [];
  let size = 0;
  // Events rather than `for await`: breaking out of an async iterator destroys
  // the request, and with it the socket the 413 has to be written to.
  await new Promise((resolve, reject) => {
    let finished = false;
    const done = (error) => {
      if (finished) return;
      finished = true;
      if (error) reject(error); else resolve();
    };
    req.on("data", (chunk) => {
      if (finished) return;        // over the limit: keep draining, buffer nothing
      size += chunk.length;
      if (maxBytes && size > maxBytes) {
        chunks.length = 0;
        done(tooLarge());
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => done());
    req.on("error", (error) => done(error));
    req.on("aborted", () => done(Object.assign(new Error("Request body was not fully received"), { status: 400 })));
  });
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

/**
 * The one parser for a Gemini endpoint path. Routing, stream detection and model
 * extraction all use it, so they cannot disagree about what a path means.
 *
 * Exactly `/v1beta/models/<model>:generateContent` or `:streamGenerateContent`
 * (the casing Google defines). Anything else — another casing, a `:` inside the
 * model, a trailing slash, a malformed percent-escape — is not a Gemini endpoint.
 * Returns `{ model, stream }`, or null.
 */
export function parseGeminiPath(pathname) {
  const match = /^\/v1beta\/models\/([^/:]+):(generateContent|streamGenerateContent)$/.exec(String(pathname));
  if (!match) return null;
  let model;
  try { model = decodeURIComponent(match[1]); } catch { return null; }
  if (!model || /[/:\s]/.test(model)) return null;
  return { model, stream: match[2] === "streamGenerateContent" };
}

/** A path that is in Gemini's namespace but is not a supported endpoint (so it can be refused clearly). */
export function isGeminiNamespace(pathname) {
  return /^\/v1beta\/models(?:\/|$)/i.test(String(pathname));
}

export function clientProtocol(pathname) {
  if (pathname === "/v1/messages") return "anthropic";
  if (pathname === "/v1/responses") return "openai-responses";
  if (pathname === "/v1/chat/completions") return "openai-chat";
  // Gemini clients choose streaming with the method name, so both are routes.
  if (parseGeminiPath(pathname)) return "gemini";
  return null;
}

export function isGeminiStream(pathname) {
  return parseGeminiPath(pathname)?.stream === true;
}
