/**
 * Vision-aware routing.
 *
 * Image requests use a pool of their own. Each provider can be given a separate
 * vision key, base URL and model list (GEMINI_VISION_API_KEYS,
 * GEMINI_VISION_BASE_URL, GEMINI_VISION_MODELS, ...). A request that carries an
 * image is routed ONLY to those vision targets, and a text request never
 * reaches them, so text-only models are not tried (or logged as failures) for
 * images and vision keys are not spent on plain text.
 *
 * While no vision target is configured, an image request fails with 503
 * `no_vision_route`; it is never sent to the normal text pool.
 */

/**
 * Is an inline/file media blob an image?
 *
 * Gemini's `FileData.mimeType` is optional (files uploaded through the File API
 * carry only a `fileUri`), and some clients send `application/octet-stream` for
 * a blob they know to be an image. Both are treated as images so the request is
 * routed to the vision pool rather than a text-only target — the pools must
 * never cross. A MIME the sender *did* declare as non-image (audio, video,
 * pdf, text) stays text, which is the existing behaviour.
 */
function mediaIsImage(data) {
  if (!data || typeof data !== "object") return false;
  if (Object.keys(data).length === 0) return false;
  const mime = data.mimeType ?? data.mime_type;
  if (mime === undefined || mime === null || String(mime).trim() === "") return true;
  const value = String(mime).toLowerCase().trim();
  if (value.startsWith("image/")) return true;
  return value === "application/octet-stream" || value === "binary/octet-stream";
}

/** Is this one content part (block / item / Gemini part) an image? */
function partIsImage(part) {
  if (!part || typeof part !== "object" || Array.isArray(part)) return false;
  // Anthropic Messages: {type:"image"}; chat completions: {type:"image_url"};
  // Responses API: {type:"input_image"}.
  if (part.type === "image" || part.type === "image_url" || part.type === "input_image") return true;
  // Gemini: {inlineData:{mimeType:"image/png"}} / {fileData:{mimeType:"image/..."}}
  // A MIME-less blob counts as an image: the vision pool is the safe side of
  // the isolation rule, and the file API does not always report a type.
  for (const key of ["inlineData", "inline_data", "fileData", "file_data"]) {
    if (mediaIsImage(part[key])) return true;
  }
  return false;
}

/**
 * Does a content-bearing position hold an image? Only places the supported
 * protocols define as content are looked at, and only as deep as those
 * protocols nest content:
 *
 *   - a content array / single part (message `content`, Responses item `content`)
 *   - a tool result's own content (`tool_result.content`, Responses
 *     `function_call_output.output`, Gemini `functionResponse.parts`)
 *
 * Arbitrary JSON is never walked. A tool call's arguments (`tool_use.input`,
 * `functionCall.args`, `functionResponse.response`) are the model's own data;
 * `{type:"image"}` appearing inside them is a value, not an image attachment.
 */
function contentHasImage(content) {
  if (!content || typeof content !== "object") return false;
  const parts = Array.isArray(content) ? content : [content];
  for (const part of parts) {
    if (!part || typeof part !== "object" || Array.isArray(part)) continue;
    if (partIsImage(part)) return true;
    // Nested tool-result content: images returned by a tool are real attachments.
    if (part.type === "tool_result" && contentHasImage(part.content)) return true;
    if (part.functionResponse && typeof part.functionResponse === "object" && contentHasImage(part.functionResponse.parts)) return true;
    if (part.function_response && typeof part.function_response === "object" && contentHasImage(part.function_response.parts)) return true;
  }
  return false;
}

/** One entry of `messages` / `input` / `contents`: a message, a Responses item, or a bare part. */
function entryHasImage(entry) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
  if (partIsImage(entry)) return true;            // Responses: a top-level {type:"input_image"} item
  return contentHasImage(entry.content)           // chat / Anthropic / Responses message content
    || contentHasImage(entry.output)              // Responses: function_call_output.output
    || contentHasImage(entry.parts);              // Gemini Content.parts
}

/** True when the request body carries at least one image, in any client protocol. */
export function requestHasImage(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return false;

  for (const field of ["messages", "input", "contents"]) {
    const value = body[field];
    if (Array.isArray(value)) {
      if (value.some(entryHasImage)) return true;
    } else if (entryHasImage(value)) {
      return true;                                // Gemini allows a single Content object
    }
  }
  // System prompts: a content array (Anthropic) or a Content object (Gemini).
  for (const field of ["system", "systemInstruction", "system_instruction"]) {
    if (contentHasImage(body[field]) || entryHasImage(body[field])) return true;
  }
  return false;
}

/**
 * Picks the candidate pool for a request.
 *   { pool: "vision", targets }   any request that carries an image
 *   { pool: "text",   targets }   every other request
 * An image request NEVER gets text targets. When no vision target is configured,
 * `targets` is empty and the caller answers 503 `no_vision_route`.
 */
export function selectPool(body, { textTargets = [], visionTargets = [] } = {}) {
  if (requestHasImage(body)) return { pool: "vision", targets: visionTargets };
  return { pool: "text", targets: textTargets };
}
