import { bridgeProtocol, selectBridgeTargets } from "../anthropic-bridge.js";
import { codexProtocol, selectCodexTargets } from "../codex-bridge.js";
import { chatProtocol, selectChatTargets } from "../chat-bridge.js";
import { geminiProtocol, selectGeminiTargets } from "../gemini-bridge.js";

export function selectRouteTargets(targets, protocol, requestedModel) {
  const all = Array.isArray(targets) ? targets : [];
  const compatible = all.filter((target) => Array.isArray(target.protocols) && target.protocols.includes(protocol));
  const model = typeof requestedModel === "string" && requestedModel ? requestedModel : "";
  const exact = model ? compatible.filter((target) => target.model === model) : [];
  return { protocol, requestedModel: model || null, modelMatched: exact.length > 0, compatible, exact, selected: exact.length > 0 ? exact : compatible };
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

export function planFallbackOrder(ranked, health, stickyTargetId = null) {
  if (ranked.length === 0) return [];
  if (!stickyTargetId) return ranked;
  const preferredIndex = ranked.findIndex((target) => health.key(target) === stickyTargetId);
  if (preferredIndex <= 0) return ranked;
  const preferred = ranked[preferredIndex];
  return [preferred, ...ranked.filter((_, index) => index !== preferredIndex)];
}
