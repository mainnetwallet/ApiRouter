/**
 * Minimal request-shape validation, run before any routing happens.
 *
 * This is deliberately NOT a schema. It rejects only shapes the router's own
 * adapters cannot interpret at all (`"messages": 5`), so a client mistake is a
 * local 400 instead of a pass through provider selection, an upstream call, a
 * fallback walk and a misleading 502. Anything an adapter already tolerates is
 * left alone, and the upstream stays the judge of finer detail.
 *
 * Returns `null` when the body is acceptable, otherwise a short client-safe
 * message. Messages only ever name the field, never echo client values.
 */

const isPlainObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const describe = (value) => (value === null ? "null" : Array.isArray(value) ? "an array" : typeof value);

function checkEntries(field, entries) {
  for (let index = 0; index < entries.length; index += 1) {
    if (!isPlainObject(entries[index])) return `"${field}[${index}]" must be an object`;
  }
  return null;
}

/**
 * Chat Completions and Anthropic Messages: `messages`, when sent, is an array of
 * objects. An absent `messages` (an empty `{}` body) is an existing, tested
 * contract and is left to the upstream; only a present-but-unusable value is
 * rejected here.
 */
function validateMessages(body) {
  if (body.messages === undefined) return null;
  if (!Array.isArray(body.messages)) {
    return `"messages" must be an array, got ${describe(body.messages)}`;
  }
  const entryError = checkEntries("messages", body.messages);
  if (entryError) return entryError;
  for (let index = 0; index < body.messages.length; index += 1) {
    const content = body.messages[index].content;
    // string, array of parts or null (assistant tool-call turns) are all real shapes.
    if (content !== undefined && content !== null && typeof content !== "string" && typeof content !== "object") {
      return `"messages[${index}].content" must be a string or an array`;
    }
  }
  return null;
}

/**
 * Anthropic Messages, on top of the generic `messages` check. The bridge reads
 * `.type` off every content block and `.name` off every tool, so a `null` (or
 * other non-object) entry there is a client mistake that would otherwise surface
 * as an internal TypeError and a 502. A string `content` and a non-array `tools`
 * stay accepted exactly as before; only array ENTRIES must be objects.
 */
function validateAnthropic(body) {
  const messageError = validateMessages(body);
  if (messageError) return messageError;
  if (Array.isArray(body.messages)) {
    for (let index = 0; index < body.messages.length; index += 1) {
      const { content } = body.messages[index];
      if (!Array.isArray(content)) continue;
      const blockError = checkEntries(`messages[${index}].content`, content);
      if (blockError) return blockError;
    }
  }
  if (Array.isArray(body.tools)) return checkEntries("tools", body.tools);
  return null;
}

/**
 * Responses API: `input` is a string or an array of items. An absent `input` is
 * left to the upstream (the Responses API allows requests without one).
 */
function validateResponsesInput(body) {
  if (body.input === undefined || typeof body.input === "string") return null;
  if (!Array.isArray(body.input)) return `"input" must be a string or an array, got ${describe(body.input)}`;
  return checkEntries("input", body.input);
}

/**
 * Gemini generateContent: `contents`, when sent, is an array of Content objects
 * or a single Content object (both are accepted by the adapter). `parts`, when
 * present, is an array. An absent `contents` is left to the upstream.
 */
function validateGeminiContents(body) {
  const { contents } = body;
  if (contents === undefined) return null;
  const list = Array.isArray(contents) ? contents : [contents];
  if (!Array.isArray(contents) && !isPlainObject(contents)) {
    return `"contents" must be an array or an object, got ${describe(contents)}`;
  }
  const entryError = checkEntries("contents", list);
  if (entryError) return entryError;
  for (let index = 0; index < list.length; index += 1) {
    const { parts } = list[index];
    if (parts === undefined) continue;
    if (!Array.isArray(parts)) return `"contents[${index}].parts" must be an array, got ${describe(parts)}`;
    const partError = checkEntries(`contents[${index}].parts`, parts);
    if (partError) return partError;
  }
  return null;
}

/** @param {string} protocol one of the router's client protocol ids */
export function validateRequestShape(protocol, body) {
  if (!isPlainObject(body)) return "Request body must be a JSON object";
  switch (protocol) {
    case "openai-chat":
      return validateMessages(body);
    case "anthropic":
      return validateAnthropic(body);
    case "openai-responses":
      return validateResponsesInput(body);
    case "gemini":
      return validateGeminiContents(body);
    default:
      return null;
  }
}
