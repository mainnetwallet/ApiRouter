/**
 * Vision-aware routing.
 *
 * Many models on the configured providers are text-only and answer HTTP 400 as
 * soon as a request carries an image. When the <PROVIDER>_VISION_MODELS
 * variables (GEMINI_VISION_MODELS, GROQ_VISION_MODELS, ...) list the models that
 * accept images, a request containing an image is only routed to those models,
 * so text-only models are never tried (and never logged as failed attempts).
 *
 * With no vision models configured nothing is filtered: behaviour is unchanged.
 */

const split = (value) => String(value || "").split(",").map((v) => v.trim()).filter(Boolean);

export function parseVisionModels(value) {
  return split(value);
}

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
 * A vision entry is "provider:model" ("cloudflare:@cf/qwen/qwen3.8-27b"), which
 * is what the per-provider variables produce, or a bare model id
 * ("gemini-3.7-flash") from the legacy global VISION_MODELS. Matching is
 * case-insensitive.
 */
export function isVisionTarget(target, visionModels) {
  const model = String(target?.model ?? "").toLowerCase();
  const provider = String(target?.provider ?? "").toLowerCase();
  return visionModels.some((entry) => {
    const e = entry.toLowerCase();
    return e === model || e === `${provider}:${model}`;
  });
}

/**
 * Narrows the candidate targets for a request.
 *   { filtered: false }                      nothing to do (no image / no vision models configured)
 *   { filtered: true, targets }              only vision-capable targets remain
 * `targets` may be empty: the caller reports that as a clear no_route error.
 */
export function filterTargetsForImages(targets, body, visionModels) {
  if (!Array.isArray(visionModels) || visionModels.length === 0) return { filtered: false, targets };
  if (!requestHasImage(body)) return { filtered: false, targets };
  return { filtered: true, targets: targets.filter((target) => isVisionTarget(target, visionModels)) };
}
