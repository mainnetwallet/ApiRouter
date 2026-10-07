import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Gemini thought signatures.
 *
 * Gemini 3 returns an opaque `thoughtSignature` with a function call and requires
 * it to be echoed back with that call in the next request, otherwise it answers
 * HTTP 400. The client protocols the router translates (Anthropic, Chat,
 * Responses) have no field for it, so it is kept here, keyed by the tool-call id
 * the router handed out.
 *
 * Properties this store guarantees:
 *   - scoped: an entry belongs to the session (`x-multi-ai-session-id`) whose
 *     response created it, so another session reusing the same id cannot read it;
 *   - bounded: LRU with a cap, refreshed on read, so an active conversation's
 *     signatures are the last to be evicted;
 *   - expiring: an entry unused for SIGNATURE_TTL_MS is dropped;
 *   - never silently broken: when a signature is gone (eviction, restart), the
 *     translation falls back to Google's documented `skip_thought_signature_validator`
 *     placeholder for Gemini 3 models, instead of sending a request that is
 *     certain to be rejected. The placeholder is documented as a last resort that
 *     costs some quality, and every use is counted and warned about.
 */

export const SKIP_THOUGHT_SIGNATURE = "skip_thought_signature_validator";
export const MAX_SIGNATURES = 5000;
export const SIGNATURE_TTL_MS = 12 * 60 * 60 * 1000;

const scopeStorage = new AsyncLocalStorage();
const entries = new Map();   // `${scope}\u0000${id}` -> { signature, at }
const stats = { remembered: 0, hits: 0, fallbacks: 0 };
let lastWarnAt = 0;

/** Run `fn` with `scope` as the current signature scope (async-context aware). */
export function runInSignatureScope(scope, fn) {
  return scopeStorage.run(String(scope ?? ""), fn);
}

/**
 * Make `scope` current for the rest of the calling async execution. A request
 * handler calls this once it knows the session; every bridge call and stream
 * that follows (they all run inside that handler's async chain) then reads and
 * writes signatures of that session only.
 */
export function enterSignatureScope(scope) {
  scopeStorage.enterWith(String(scope ?? ""));
}

const currentScope = () => scopeStorage.getStore() ?? "";
const keyOf = (scope, id) => `${scope}\u0000${id}`;

export function rememberSignature(id, signature, { scope = currentScope(), now = Date.now() } = {}) {
  if (!id || !signature) return;
  const key = keyOf(scope, id);
  entries.delete(key);
  entries.set(key, { signature, at: now });
  stats.remembered += 1;
  while (entries.size > MAX_SIGNATURES) entries.delete(entries.keys().next().value);
}

export function signatureFor(id, { scope = currentScope(), now = Date.now() } = {}) {
  if (!id) return undefined;
  const key = keyOf(scope, id);
  const entry = entries.get(key);
  if (!entry) return undefined;
  if (now - entry.at > SIGNATURE_TTL_MS) {
    entries.delete(key);
    return undefined;
  }
  // Touch: an id that is still being used must outlive ids that are not.
  entries.delete(key);
  entries.set(key, { ...entry, at: now });
  stats.hits += 1;
  return entry.signature;
}

export const signatureStats = () => ({ ...stats, size: entries.size });
export const clearSignatures = () => { entries.clear(); stats.remembered = 0; stats.hits = 0; stats.fallbacks = 0; };

/** Does this Gemini model enforce thought-signature validation (Gemini 3 and later)? */
export function requiresThoughtSignature(model) {
  const match = /^(?:models\/)?gemini-(\d+)/i.exec(String(model ?? ""));
  return Boolean(match) && Number(match[1]) >= 3;
}

/**
 * Make every model turn that contains function calls carry a signature on its
 * first call, which is what Gemini 3 validates. Called on the finished `contents`.
 */
export function ensureCallSignatures(contents, model) {
  if (!requiresThoughtSignature(model)) return contents;
  for (const content of contents) {
    if (content?.role !== "model" || !Array.isArray(content.parts)) continue;
    const first = content.parts.find((part) => part?.functionCall);
    if (first && !first.thoughtSignature) {
      first.thoughtSignature = SKIP_THOUGHT_SIGNATURE;
      stats.fallbacks += 1;
      const now = Date.now();
      if (now - lastWarnAt > 60_000) {
        lastWarnAt = now;
        console.warn("[router] a Gemini function call had no stored thought signature (evicted or router restarted); sent the documented skip placeholder instead");
      }
    }
  }
  return contents;
}
