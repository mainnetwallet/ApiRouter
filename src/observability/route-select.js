/**
 * The gateway's target-selection rule, in one place.
 *
 * This logic previously lived inline in `proxy()`. It is extracted here so the
 * routing preview can report the decision the router will *actually* make
 * rather than a re-implementation that could silently drift from it. Both the
 * proxy path and `/api/router/preview` call `selectRouteTargets`.
 *
 * The rule, in order:
 *   1. Only targets declaring the client's protocol are candidates.
 *   2. If the client named a model, targets for that exact model are preferred.
 *   3. Otherwise every protocol-compatible target is eligible.
 *
 * Health filtering and ranking are deliberately NOT part of this function:
 * they belong to the health registry (`rankTargets`), which applies cooldown
 * at read time. Mixing them here would duplicate that logic.
 */
export function selectRouteTargets(targets, protocol, requestedModel) {
  const all = Array.isArray(targets) ? targets : [];
  const compatible = all.filter(
    (target) => Array.isArray(target.protocols) && target.protocols.includes(protocol)
  );

  // Compared verbatim, matching the original inline rule: a model name is
  // either configured exactly or it is not. Trimming happens at the API
  // boundary (`/api/router/preview`) rather than here.
  const model = typeof requestedModel === "string" && requestedModel ? requestedModel : "";
  const exact = model ? compatible.filter((target) => target.model === model) : [];

  return {
    protocol,
    requestedModel: model || null,
    // The model the client asked for is not configured; routing widens to every
    // compatible target rather than failing.
    modelMatched: exact.length > 0,
    compatible,
    exact,
    selected: exact.length > 0 ? exact : compatible
  };
}

/**
 * The order `withFallback` will walk, given a health registry and an optional
 * sticky target. Mirrors `src/router.js` exactly: the session's sticky target
 * is tried first when it is still available, then the remaining ranked targets.
 *
 * Ranking itself is delegated to the caller's registry so this can never
 * disagree with the live router.
 */
export function planFallbackOrder(ranked, health, stickyTargetId = null) {
  if (ranked.length === 0) return [];
  if (!stickyTargetId) return ranked;

  const preferredIndex = ranked.findIndex(
    (target) => health.key(target) === stickyTargetId
  );
  if (preferredIndex <= 0) return ranked;

  const preferred = ranked[preferredIndex];
  return [preferred, ...ranked.filter((_, index) => index !== preferredIndex)];
}
