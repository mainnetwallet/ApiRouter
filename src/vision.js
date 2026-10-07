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

/** Content-part types that carry binary or remote media in the supported protocols. */
const MEDIA_PART_TYPES = new Set([
  // Anthropic Messages
  "image", "document",
  // Chat Completions
  "image_url", "input_audio", "file", "video_url", "audio_url",
  // Responses
  "input_image", "input_file", "input_audio"
]);

/** Gemini data parts: inline bytes or a file reference. */
const GEMINI_DATA_KEYS = ["inlineData", "inline_data", "fileData", "file_data"];

const isTextMime = (value) => typeof value === "string" && value.toLowerCase().startsWith("text/");

/**
 * Is this one content part (block / item / Gemini part) multimodal media?
 *
 * "Media" is deliberately wider than "image": a PDF, an audio clip, a video, a
 * file reference or a Gemini `fileData` whose MIME type is missing are not text
 * either, and a text-only model cannot read any of them. Routing such a request
 * to the text pool would either fail upstream or, worse, answer as if the
 * attachment were not there, so every one of them selects the vision
 * (multimodal) pool.
 */
function partIsImage(part) {
  if (!part || typeof part !== "object" || Array.isArray(part)) return false;
  if (MEDIA_PART_TYPES.has(part.type)) return true;
  for (const key of GEMINI_DATA_KEYS) {
    const data = part[key];
    if (data && typeof data === "object" && !isTextMime(data.mimeType ?? data.mime_type)) return true;
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

/** True when the request body carries at least one image/media attachment, in any client protocol. */
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

/** Clearer name for what `requestHasImage` actually answers: any multimodal attachment. */
export const requestHasMedia = requestHasImage;

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
