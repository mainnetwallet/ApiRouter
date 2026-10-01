import { bridgeProtocol, selectBridgeTargets } from "../anthropic-bridge.js";
import { codexProtocol, selectCodexTargets } from "../codex-bridge.js";
import { chatProtocol, selectChatTargets } from "../chat-bridge.js";
import { geminiProtocol, selectGeminiTargets } from "../gemini-bridge.js";
import { targetId } from "../health.js";

export function selectRouteTargets(targets, protocol, requestedModel) {
  const all = Array.isArray(targets) ? targets : [];
  const compatible = all.filter((target) => Array.isArray(target.protocols) && target.protocols.includes(protocol));
  const model = typeof requestedModel === "string" && requestedModel ? requestedModel : "";
  const exact = model ? compatible.filter((target) => target.model === model) : [];
  // Exact matches lead, but they do not replace the rest of the candidates.
  // The four live protocols route through the bridge selectors below, which all
  // return `[...exact, ...rest]`; this generic shape has to agree with them, or
  // a protocol routed here would silently lose every fallback the moment the
  // requested model happened to be configured.
  const rest = compatible.filter((target) => !exact.includes(target));
  return {
    protocol,
    requestedModel: model || null,
    modelMatched: exact.length > 0,
    compatible,
    exact,
    selected: exact.length > 0 ? [...exact, ...rest] : compatible
  };
}

export function selectTargetsForProtocol(targets, protocol, requestedModel) {
  if (protocol === "anthropic") return selectBridgeTargets(targets, requestedModel);
  if (protocol === "openai-responses") return selectCodexTargets(targets, requestedModel);
  if (protocol === "openai-chat") return selectChatTargets(targets, requestedModel);
  if (protocol === "gemini") return selectGeminiTargets(targets, requestedModel);
  return selectRouteTargets(targets, protocol, requestedModel);
}

export function servableProtocols(targets) {
  const all = Array.isArray(targets) ? targets : [];
  const protocols = new Set();
  for (const target of all) for (const protocol of target.protocols ?? []) protocols.add(protocol);
  if (all.some((target) => bridgeProtocol(target))) protocols.add("anthropic");
  if (all.some((target) => codexProtocol(target))) protocols.add("openai-responses");
  if (all.some((target) => chatProtocol(target))) protocols.add("openai-chat");
  if (all.some((target) => geminiProtocol(target))) protocols.add("gemini");
  return protocols;
}

/**
 * The groups the router walks, in order.
 *
 * Every selector returns the requested model's targets first and the remaining
 * reachable targets after them (`selected = [...exact, ...rest]`). That split
 * has to survive ranking: a health score decides the order *within* a group,
 * but it may never promote a different-model fallback ahead of an exact match
 * the client asked for and that is still available. Sticky sessions are scoped
 * to a group for the same reason.
 *
 * `withFallback` walks these groups and `/api/router/preview` renders them, so
 * the panel cannot show an order the proxy would not use.
 */
export function fallbackGroups(selection) {
  const selected = Array.isArray(selection?.selected) ? selection.selected : [];
  if (selected.length === 0) return [];

  const exact = Array.isArray(selection?.exact) ? selection.exact : [];
  if (exact.length === 0) return [selected];

  const exactIds = new Set(exact.map(targetId));
  const primary = selected.filter((target) => exactIds.has(targetId(target)));
  // A selector that disagrees with the contract above still routes; it just
  // routes as one undivided group rather than silently dropping targets.
  if (primary.length === 0) return [selected];

  const rest = selected.filter((target) => !exactIds.has(targetId(target)));
  return rest.length > 0 ? [primary, rest] : [primary];
}

export function planFallbackOrder(ranked, health, stickyTargetId = null) {
  if (ranked.length === 0) return [];
  if (!stickyTargetId) return ranked;
  // Mirrors RouteSession: with a MODEL_PRIORITY there is no sticky preference.
  if (typeof health.hasModelPriority === "function" && health.hasModelPriority()) return ranked;
  const preferredIndex = ranked.findIndex((target) => health.key(target) === stickyTargetId);
  if (preferredIndex <= 0) return ranked;
  const preferred = ranked[preferredIndex];
  return [preferred, ...ranked.filter((_, index) => index !== preferredIndex)];
}

/**
 * The full order `withFallback` will walk, across every group: each group is
 * ranked and sticky-preferenced on its own, then the groups are concatenated.
 */
export function planFallbackGroups(groups, health, stickyTargetId = null, now = Date.now()) {
  const order = [];
  const seen = new Set();

  for (const group of Array.isArray(groups) ? groups : []) {
    const ranked = health.rank(group, now);
    for (const target of planFallbackOrder(ranked, health, stickyTargetId)) {
      const id = health.key(target);
      if (seen.has(id)) continue;
      seen.add(id);
      order.push(target);
    }
  }

  return order;
}
