/**
 * Multimodal translation guard.
 *
 * A client can describe an image in more ways than every target protocol can
 * express. OpenAI-compatible targets accept a remote `image_url` (or a base64
 * data URL) unchanged, but Gemini `generateContent` takes the image *bytes*
 * (`inlineData`), so a remote URL, an Anthropic `url`/`file` source or a Gemini
 * `fileData` reference would have to be fetched by the gateway. The gateway
 * never fetches a client-supplied URL or a provider file reference — that is an
 * SSRF surface — so translation refuses those forms explicitly instead of
 * dropping them and answering `200`. Silently losing the image is never right.
 */

export const UNSUPPORTED_IMAGE_SOURCE = "unsupported_image_source";

/**
 * A `400` the client can act on, thrown when the request asks for an image form
 * the target protocol cannot carry.
 *
 * The error is `retryable` with `skipCooldown`: another configured target (an
 * OpenAI-compatible one) may well carry the same image unchanged, and a
 * request-shape mismatch is not provider ill health, so the target is skipped
 * without a cooldown rather than cooling a healthy provider.
 */
export function unsupportedImageSource(detail) {
  const error = new Error(
    `unsupported_image_source: this target cannot carry ${detail}. ` +
    "The router never fetches client-supplied image URLs or provider file references; " +
    "send the image as base64 inline data, or route the request to a target that accepts the source as-is."
  );
  error.status = 400;
  error.errorType = UNSUPPORTED_IMAGE_SOURCE;
  error.retryable = true;
  error.skipCooldown = true;
  return error;
}

const INLINE_DATA_URL = /^data:([^;,]*);base64,(.+)$/s;

/**
 * Split a base64 `data:` URL into `{ mimeType, data }`, or return null when the
 * value is not one. A missing MIME becomes `application/octet-stream`, which is
 * what the vision detector already treats as an image.
 */
export function splitInlineDataUrl(value) {
  if (typeof value !== "string") return null;
  const match = INLINE_DATA_URL.exec(value.trim());
  if (!match) return null;
  return { mimeType: match[1] || "application/octet-stream", data: match[2] };
}
