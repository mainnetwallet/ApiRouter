/**
 * Errors a protocol bridge raises when a request cannot be translated faithfully.
 *
 * Translation must never "succeed" by dropping part of the request: an image that
 * cannot be carried, a tool call whose arguments are not JSON, a tool result that
 * answers no call. Each of those is a typed error with an HTTP status, so the
 * client is told, instead of receiving a 200 for a request that was changed.
 *
 * `retryable` + `skipCooldown` mean "this particular target cannot take this
 * request; try the next one, but do not cool this target down" — the same
 * contract a provider's generic 400 already has in `router.js`. When every target
 * refuses, the client receives the 4xx.
 */

export class BridgeRequestError extends Error {
  constructor(message, { status = 400, type = "invalid_request_error", code = null, retryable = true } = {}) {
    super(message);
    this.name = "BridgeRequestError";
    this.status = status;
    this.errorType = type;
    this.code = code;
    // A bad request is not this target's fault: fall back without cooling it down.
    this.retryable = retryable;
    this.skipCooldown = true;
  }
}

/** Media the target cannot receive in the shape the client sent it. */
export class UnsupportedMediaError extends BridgeRequestError {
  constructor(message, code = "unsupported_media") {
    super(message, { status: 400, type: "unsupported_media", code });
    this.name = "UnsupportedMediaError";
  }
}

/** Tool-call arguments (client history) that are not a JSON object. */
export class InvalidToolArgumentsError extends BridgeRequestError {
  constructor(name) {
    super(`Arguments of tool call "${String(name || "tool").slice(0, 80)}" are not valid JSON`, { code: "invalid_tool_arguments" });
    this.name = "InvalidToolArgumentsError";
  }
}

/** The upstream answered with something that cannot be translated (a 502-class fault). */
export class UpstreamFormatError extends Error {
  constructor(message) {
    super(message);
    this.name = "UpstreamFormatError";
    this.status = 502;
    this.errorType = "upstream_error";
    this.retryable = true;
  }
}

/**
 * Parse tool-call arguments strictly. An empty/absent value is `{}` (a call with
 * no parameters); anything present but not a JSON object is an error.
 */
export function parseToolArguments(value, name, ErrorType = InvalidToolArgumentsError) {
  if (value === undefined || value === null) return {};
  if (typeof value === "object" && !Array.isArray(value)) return value;
  if (typeof value !== "string") throw new ErrorType(name);
  if (value.trim() === "") return {};
  let parsed;
  try { parsed = JSON.parse(value); } catch { throw new ErrorType(name); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new ErrorType(name);
  return parsed;
}

/** The upstream returned tool-call arguments that are not a JSON object. */
export class MalformedUpstreamArgumentsError extends UpstreamFormatError {
  constructor(name) {
    super(`Upstream returned malformed arguments for tool call "${String(name || "tool").slice(0, 80)}"`);
    this.name = "MalformedUpstreamArgumentsError";
  }
}
