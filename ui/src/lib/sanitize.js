/**
 * Client-side mirror of `src/observability/sanitize.js`.
 *
 * The server already scrubs everything it stores. This is a second line of
 * defence for the browser: upstream error text can reach the DOM, the console
 * and the clipboard, so it is scrubbed again before any of those. Redaction is
 * total, never partial — a partly-masked key is still a key.
 *
 * Kept in sync with the server by the shared pattern list below.
 */

const PLACEHOLDER = "[redacted]";

const CREDENTIAL_PATTERNS = [
  [/\bBearer\s+[A-Za-z0-9._~+/=:-]+/gi, PLACEHOLDER],
  [/\bsk-[A-Za-z0-9_-]{6,}/gi, PLACEHOLDER],
  [/\bsk_live_[A-Za-z0-9_-]{6,}/gi, PLACEHOLDER],
  [/\bAIza[A-Za-z0-9_-]{10,}/gi, PLACEHOLDER],
  [/\bhf_[A-Za-z0-9]{10,}/gi, PLACEHOLDER],
  [/\bgsk_[A-Za-z0-9]{10,}/gi, PLACEHOLDER],
  [/\bx-goog-api-key\b/gi, PLACEHOLDER],
  [/\bauthorization\b/gi, PLACEHOLDER],
  [/\bBearer\b/gi, PLACEHOLDER],
  [/\bapi[_-]?key\b\s*[:=]\s*\S+/gi, PLACEHOLDER]
];

const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

export const MAX_DISPLAY_LENGTH = 300;

/** Scrub credential-shaped text from anything about to be displayed. */
export function sanitizeText(value, { maxLength = MAX_DISPLAY_LENGTH } = {}) {
  if (value === null || value === undefined) return "";

  let result = (typeof value === "string" ? value : String(value)).replace(CONTROL_CHARS, "");

  for (const [pattern, replacement] of CREDENTIAL_PATTERNS) {
    result = result.replace(pattern, replacement);
  }

  result = result.trim();
  return result.length > maxLength ? result.slice(0, maxLength) + "…" : result;
}

/** Does this text contain something that must never be shown? */
export function containsCredentialShapedText(value) {
  const text = String(value ?? "");
  return CREDENTIAL_PATTERNS.some(([pattern]) => {
    pattern.lastIndex = 0;
    const hit = pattern.test(text);
    pattern.lastIndex = 0;
    return hit;
  });
}

export { PLACEHOLDER as REDACTION_PLACEHOLDER };
