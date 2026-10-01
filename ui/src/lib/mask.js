/**
 * Credential masking.
 *
 * The backend never sends key material to the browser — `/api/config` reports
 * a `keyCount` and nothing else. So this is used for the one secret the client
 * legitimately holds: the router token the operator typed into connection
 * settings. It is shown masked, kept in sessionStorage (never localStorage),
 * and never logged.
 *
 * Masking preserves a short prefix and suffix purely so an operator can tell
 * *which* key is configured. It is a recognition aid, not a security control —
 * which is why the UI never offers to reveal, copy or export the value.
 */

const MIN_MASK_LENGTH = 12;

export function maskCredential(value) {
  const text = String(value ?? "").trim();
  if (!text) return "";

  if (text.length < MIN_MASK_LENGTH) return "•".repeat(text.length);

  const prefixMatch = /^(sk-|sk_live_|gsk_|hf_|AIza)/.exec(text);
  const prefix = prefixMatch ? prefixMatch[1] : text.slice(0, 3);
  const suffix = text.slice(-4);
  const hidden = Math.max(6, Math.min(20, text.length - prefix.length - suffix.length));

  return `${prefix}${"*".repeat(hidden)}${suffix}`;
}

/** Identifiers are safe to copy, but long ones are shortened for display. */
export function maskIdentifier(value, { head = 8, tail = 0 } = {}) {
  const text = String(value ?? "");
  if (!text) return "";
  if (tail > 0 && text.length > head + tail + 1) {
    return `${text.slice(0, head)}…${text.slice(-tail)}`;
  }
  return text.length > head ? `${text.slice(0, head)}…` : text;
}

/** True when a string looks like a secret, used to refuse to store one. */
export function looksSecret(value) {
  const text = String(value ?? "");
  return /^(sk-|sk_live_|gsk_|hf_|AIza)/.test(text) || text.length > 80;
}
