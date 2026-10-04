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
  [/\bnvapi-[A-Za-z0-9_-]{8,}/gi, PLACEHOLDER],
  [/\bcsk-[A-Za-z0-9_-]{8,}/gi, PLACEHOLDER],
  // Credentials carried in a URL query string (`?key=...`, `&access_token=...`).
  [/([?&](?:key|api[_-]?key|access[_-]?token|token)=)[^&\s"'<>]+/gi, "$1" + PLACEHOLDER],
  // Bare keywords, so a header name alone can never be echoed back.
  [/\bx-goog-api-key\b/gi, PLACEHOLDER],
  [/\bauthorization\b/gi, PLACEHOLDER],
  [/\bBearer\b/gi, PLACEHOLDER],
  // `api_key=...` / `apikey: ...` style assignments.
  [/\bapi[_-]?key\b\s*[:=]\s*\S+/gi, PLACEHOLDER]
];

/**
 * The router's own configured credentials. Prefix patterns can only recognise
 * key shapes we already know about; a provider key in any other format would
 * pass straight through if an upstream echoed it. So every configured secret
 * is also redacted by exact value, whatever it looks like.
 *
 * Values shorter than MIN_SECRET_LENGTH are not registered: a 3-character
 * "secret" would redact ordinary words everywhere. Real provider keys are far
 * longer than this.
 */
const MIN_SECRET_LENGTH = 8;
let configuredSecrets = [];

function secretForms(value) {
  const raw = String(value ?? "").trim();
  if (raw.length < MIN_SECRET_LENGTH) return [];
  const forms = new Set([raw]);
  // An upstream may echo the value URL-encoded or JSON-escaped.
  try { forms.add(encodeURIComponent(raw)); } catch { /* lone surrogate: keep the raw form only */ }
  forms.add(JSON.stringify(raw).slice(1, -1));
  return [...forms].filter((form) => form.length >= MIN_SECRET_LENGTH);
}

/**
 * Replace the set of configured secrets that must never be echoed. Longest
 * values first, so a secret that contains another one is redacted whole.
 */
export function registerConfiguredSecrets(values) {
  const forms = new Set();
  for (const value of values ?? []) for (const form of secretForms(value)) forms.add(form);
  configuredSecrets = [...forms].sort((a, b) => b.length - a.length);
}

function redactConfiguredSecrets(text) {
  let result = text;
  for (const secret of configuredSecrets) {
    if (result.includes(secret)) result = result.split(secret).join(PLACEHOLDER);
  }
  return result;
}

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

  // Configured secrets go first, on the raw text: a pattern pass could split a
  // secret apart and leave a fragment the exact match would no longer find.
  let result = redactConfiguredSecrets(text.replace(CONTROL_CHARS, ""));

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
  if (configuredSecrets.some((secret) => value.includes(secret))) return true;
  return CREDENTIAL_PATTERNS.some(([pattern]) => {
    // A fresh lastIndex per call: these are /g regexes and are shared.
    pattern.lastIndex = 0;
    const hit = pattern.test(value);
    pattern.lastIndex = 0;
    return hit;
  });
}

export const REDACTION_PLACEHOLDER = PLACEHOLDER;
