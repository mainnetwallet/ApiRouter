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

const MESSAGE_FIELDS = ["messages", "input", "contents", "system", "systemInstruction", "system_instruction"];

function isImageMime(value) {
  return typeof value === "string" && value.toLowerCase().startsWith("image/");
}

function nodeHasImage(node) {
  if (typeof node.type === "string") {
    // Anthropic Messages: {type:"image"}; chat completions: {type:"image_url"};
    // Responses API: {type:"input_image"}.
    if (node.type === "image" || node.type === "image_url" || node.type === "input_image") return true;
  }
  // Gemini: {inlineData:{mimeType:"image/png"}} / {fileData:{mimeType:"image/..."}}
  for (const key of ["inlineData", "inline_data", "fileData", "file_data"]) {
    const part = node[key];
    if (part && typeof part === "object" && isImageMime(part.mimeType ?? part.mime_type)) return true;
  }
  return false;
}

/** True when the request body carries at least one image, in any client protocol. */
export function requestHasImage(body) {
  if (!body || typeof body !== "object") return false;
  const stack = [];
  for (const field of MESSAGE_FIELDS) if (body[field] && typeof body[field] === "object") stack.push(body[field]);

  while (stack.length > 0) {
    const node = stack.pop();
    if (Array.isArray(node)) {
      for (const item of node) if (item && typeof item === "object") stack.push(item);
      continue;
    }
    if (nodeHasImage(node)) return true;
    for (const value of Object.values(node)) if (value && typeof value === "object") stack.push(value);
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
