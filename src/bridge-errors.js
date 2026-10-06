/**
 * Tool-call translation guard.
 *
 * A client protocol that carries tool arguments as a JSON *string* (OpenAI Chat
 * `tool_calls[].function.arguments`, Responses `function_call.arguments`) can
 * hold text that is not valid JSON. Gemini `generateContent` needs a real
 * `functionCall.args` object, so the gateway would have to fabricate one — and
 * the historical fallback was a silent `{}`, i.e. the model's arguments were
 * dropped on the floor and the request answered `200`.
 *
 * Translation now refuses instead. The error is `retryable` with
 * `skipCooldown`: an OpenAI-compatible target carries the raw string verbatim,
 * so the same request can still succeed there, and a request-shape mismatch is
 * not provider ill health, so a healthy Gemini target is not cooled.
 */

export const INVALID_TOOL_ARGUMENTS = "invalid_tool_arguments";

export function invalidToolArguments(detail) {
  const error = new Error(
    `invalid_tool_arguments: ${detail}. ` +
    "The router will not replace a tool call's arguments with an empty object; " +
    "route the request to a target that carries the arguments as-is."
  );
  error.status = 400;
  error.errorType = INVALID_TOOL_ARGUMENTS;
  error.retryable = true;
  error.skipCooldown = true;
  return error;
}

/**
 * A translated stream that broke after the 200 headers were sent.
 *
 * The protocol bridges still emit their client-facing terminal event (an
 * `upstream_error` chunk + `[DONE]`, or a `response.failed` event) and then
 * re-throw this. `pipeline()` therefore rejects and the server files the
 * request as `truncated` — never a success, never healthy, never sticky — and
 * cools the target per the existing cooldown rules.
 *
 * The original error is returned unchanged whenever possible so the
 * `streamCause`/`code` tags from `guardUpstreamStream` survive; only an
 * untagged error is assumed to be an upstream fault. A concurrent client abort
 * (tagged `streamCause: "client"`) is deliberately left alone so the provider
 * is not charged for a client that walked away.
 */
export function markStreamFailure(error) {
  const cause = error instanceof Error ? error : new Error(String(error ?? "Upstream stream failed"));
  if (!cause.streamCause) cause.streamCause = "upstream";
  cause.failedAfterHeaders = true;
  return cause;
}
