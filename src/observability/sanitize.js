/**
 * Credential scrubbing for anything the router reports back to an operator.
 *
 * The gateway has a hard rule (enforced by the existing suite): no response may
 * contain a provider key, and `/health` specifically may not contain the
 * substrings `authorization` or `Bearer `. Upstream error bodies are the one
 * piece of attacker-influenced text that reaches a response, so every message
 * that crosses the observability boundary passes through here first.
 *
 * Redaction is total rather than partial: a matched credential is replaced by
 * a fixed placeholder, so a partially-masked key can never be reconstructed.
 */

const PLACEHOLDER = "[redacted]";

/**
 * Order matters. Patterns that consume a token are applied before the bare
 * keyword patterns, so `Bearer sk-abc` collapses to a single placeholder.
 */
const CREDENTIAL_PATTERNS = [
  // `Bearer <token>` in any casing, including tokens with . _ ~ + / = : -
  [/\bBearer\s+[A-Za-z0-9._~+/=:-]+/gi, PLACEHOLDER],
  // Common provider key shapes.
  [/\bsk-[A-Za-z0-9_-]{6,}/gi, PLACEHOLDER],
  [/\bsk_live_[A-Za-z0-9_-]{6,}/gi, PLACEHOLDER],
  [/\bAIza[A-Za-z0-9_-]{10,}/gi, PLACEHOLDER],
  [/\bhf_[A-Za-z0-9]{10,}/gi, PLACEHOLDER],
  [/\bgsk_[A-Za-z0-9]{10,}/gi, PLACEHOLDER],
  // Bare keywords, so a header name alone can never be echoed back.
  [/\bx-goog-api-key\b/gi, PLACEHOLDER],
  [/\bauthorization\b/gi, PLACEHOLDER],
  [/\bBearer\b/gi, PLACEHOLDER],
  // `api_key=...` / `apikey: ...` style assignments.
  [/\bapi[_-]?key\b\s*[:=]\s*\S+/gi, PLACEHOLDER]
];

// Control characters other than tab/newline, which would otherwise let upstream
// text corrupt a log line or a rendered table cell.
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

const MAX_MESSAGE_LENGTH = 300;

/**
 * Scrub a message of credential-shaped text.
 *
 * Non-strings and empty values collapse to `null` so callers can distinguish
 * "no message" from "empty message" without a second check.
 */
export function sanitizeMessage(value, { maxLength = MAX_MESSAGE_LENGTH } = {}) {
  if (value === null || value === undefined) return null;

  const text = typeof value === "string" ? value : String(value);
  if (text.length === 0) return null;

  let result = text.replace(CONTROL_CHARS, "");

  for (const [pattern, replacement] of CREDENTIAL_PATTERNS) {
    result = result.replace(pattern, replacement);
  }

  result = result.replace(/\s+/g, " ").trim();

  if (result.length === 0) return null;
  return result.length > maxLength ? result.slice(0, maxLength) + "…" : result;
}

/**
 * Scan arbitrary text for anything that must never leave the gateway.
 * Used by tests and by the response guard to assert an endpoint is clean.
 */
export function containsCredentialShapedText(text) {
  const value = String(text ?? "");
  return CREDENTIAL_PATTERNS.some(([pattern]) => {
    // A fresh lastIndex per call: these are /g regexes and are shared.
    pattern.lastIndex = 0;
    const hit = pattern.test(value);
    pattern.lastIndex = 0;
    return hit;
  });
}

export const REDACTION_PLACEHOLDER = PLACEHOLDER;
