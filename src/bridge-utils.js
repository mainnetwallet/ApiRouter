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
