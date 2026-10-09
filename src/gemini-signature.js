/**
 * Gemini 3 models reject a request with a 400 ("Function call is missing a
 * thought_signature") when a `functionCall` in the history carries no
 * `thoughtSignature`. A signature only exists if the call was produced by a
 * Gemini model *and* this process still remembers it. Neither is guaranteed:
 *
 *   - the call may have come from another provider before a fallback to Gemini,
 *   - the in-memory signature cache is empty after a restart,
 *   - a client may rewrite tool-call ids, so the cache lookup misses.
 *
 * Google documents this placeholder as the way to skip validation for calls
 * that did not originate from Gemini. It is only added where a real signature
 * is missing, and real signatures are never replaced.
 */
export const SKIP_THOUGHT_SIGNATURE = "skip_thought_signature_validator";

/**
 * Returns `contents` with a placeholder `thoughtSignature` on the first
 * `functionCall` part of every model turn that lacks one. Parallel calls only
 * need the first part signed, so later parts are left alone.
 *
 * The input is never mutated: the same request body is reused when the router
 * retries another target, and that target may not want the placeholder.
 */
export function ensureThoughtSignatures(contents) {
  if (!Array.isArray(contents)) return contents;
  return contents.map((content) => {
    if (!content || content.role !== "model" || !Array.isArray(content.parts)) return content;
    const first = content.parts.findIndex((part) => part && part.functionCall);
    if (first === -1 || content.parts[first].thoughtSignature) return content;
    const parts = content.parts.slice();
    parts[first] = { ...parts[first], thoughtSignature: SKIP_THOUGHT_SIGNATURE };
    return { ...content, parts };
  });
}

/** True when an upstream 400 body complains about a missing/invalid thought signature. */
export function isSignatureRejection(message) {
  return /thought[_ ]?signature/i.test(String(message || ""));
}
