/** Helpers shared by the protocol bridges. */

/**
 * Gemini output = response candidates + thinking tokens. Google bills thinking
 * as output and defines `totalTokenCount` as prompt + thoughts + candidates, so
 * leaving `thoughtsTokenCount` out under-reports what the client was charged.
 */
export function geminiOutputTokens(meta) {
  const count = (value) => (Number.isFinite(value) && value > 0 ? value : 0);
  return count(meta?.candidatesTokenCount) + count(meta?.thoughtsTokenCount);
}

/**
 * Which tool call an OpenAI-chat stream fragment belongs to.
 *
 * Standard providers put `index` on every fragment. Some omit it and send each
 * call whole with its own id; keying those on a constant would merge separate
 * calls into one with concatenated, invalid arguments. A fragment with neither
 * `index` nor `id` continues the call opened last.
 *
 * `state` is a per-stream `{ last: null }` object.
 */
export function toolCallKey(call, state) {
  if (Number.isInteger(call?.index)) return (state.last = call.index);
  if (call?.id) return (state.last = "id:" + call.id);
  return state.last ?? 0;
}

/** Message text of an upstream stream `error` chunk, whatever shape it has. */
export function streamErrorMessage(error) {
  const text = typeof error === "string" ? error : error?.message || JSON.stringify(error ?? {});
  return String(text).slice(0, 500);
}

/**
 * Split an inline base64 `data:` URL into its media type and payload.
 * `null` for anything else — a remote `https:` URL, or a `data:` URL that is not
 * base64 — because the Gemini protocol has no inline-bytes form for those.
 */
export function base64DataUrl(url) {
  const match = /^data:([^;,]+);base64,(.+)$/s.exec(String(url ?? ""));
  return match ? { mimeType: match[1], data: match[2] } : null;
}

/**
 * The error a bridge raises for media the target's protocol cannot carry.
 *
 * Raised instead of dropping the part. A bridge that silently discards an image
 * (or a message) answers as though the model had seen it, so the client gets a
 * plausible reply about content that was never sent. Refusing is the honest
 * outcome, and the message tells the caller what to change.
 *
 * The status/`retryable`/`skipCooldown` combination makes the fallback walk read
 * this as "this target cannot serve this request": it records the attempt, moves
 * on to the next target, and does not cool this one down, because the limitation
 * belongs to the request's content rather than to the provider. A target that
 * CAN carry the media (an OpenAI-compatible one, for instance) still answers.
 * When no target can, the walk ends all-400 and the client sees this message.
 */
export function unsupportedMediaError(message) {
  const error = new Error(message);
  error.name = "UnsupportedMediaError";
  error.status = 400;
  error.retryable = true;
  error.skipCooldown = true;
  return error;
}

/** Raised when an image has no representation in the Gemini protocol. */
export function geminiImageUnsupportedError() {
  return unsupportedMediaError(
    "This request carries an image that cannot be converted for a Gemini provider. "
    + "Gemini accepts inline base64 images only: send the image as an inline "
    + "base64 data URL (data:image/png;base64,...), or configure a provider that "
    + "accepts remote image URLs."
  );
}

/**
 * Raised when an image sits in a position that carries only text.
 *
 * A system prompt, an assistant turn or a tool result has nowhere to put image
 * bytes in these protocols. The previous behaviour substituted the literal
 * string `"[image]"` and sent the request anyway, so the model was handed
 * plausible-looking text for content it never received and the client was told
 * nothing. This is the same rule the conversion paths already follow; because
 * the refusal is retryable, the fallback walk still reaches a target that can
 * carry the image, and only a request no target can serve fails.
 */
export function textPositionImageUnsupportedError() {
  return unsupportedMediaError(
    "This request carries an image in a position that holds only text — a system "
    + "prompt, an assistant turn, or a tool result. Forwarding it would mean "
    + "substituting text the model never saw. Move the image into a user message, "
    + "or configure a provider that accepts image content in that position."
  );
}

/** Raised when Gemini-native media has no representation in an OpenAI-compatible protocol. */
export function geminiNativeMediaUnsupportedError(field) {
  return unsupportedMediaError(
    `This request carries Gemini \`${field}\` content that cannot be converted for an `
    + "OpenAI-compatible provider. Send the media inline as base64 `inlineData`, "
    + "or configure a Gemini provider."
  );
}
