import { bridgeProtocol, selectBridgeTargets } from "../anthropic-bridge.js";
import { codexProtocol, selectCodexTargets } from "../codex-bridge.js";
import { chatProtocol, selectChatTargets } from "../chat-bridge.js";
import { geminiProtocol, selectGeminiTargets } from "../gemini-bridge.js";

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

/**
 * Strict target pinning, used by the Playground (and any client that sends the
 * `x-multi-ai-pin-provider` / `x-multi-ai-pin-key-index` headers).
 *
 * A pin narrows the candidate list *before* selection, so the request can only
 * reach the chosen provider, and only the chosen key when one is given. When a
 * model is requested alongside a pin, only that provider's targets for that
 * model qualify: a pin means "this exact target", never "this target, then
 * anything else". With no model, every model of the pinned provider stays
 * eligible and the usual health ranking orders them.
 *
 * An empty result means the pin names something that is not configured; the
 * caller reports that instead of silently routing elsewhere.
 */
export function pinTargets(targets, pin = {}, requestedModel = "") {
  const all = Array.isArray(targets) ? targets : [];
  const provider = String(pin?.provider ?? "").trim().toLowerCase();
  if (!provider) return { pinned: false, targets: all, provider: null, keyIndex: null };

  const keyIndex = Number.isInteger(pin?.keyIndex) && pin.keyIndex >= 0 ? pin.keyIndex : null;
  const model = typeof requestedModel === "string" ? requestedModel : "";

  const providerTargets = all.filter((target) =>
    target.provider === provider
    && (keyIndex === null || target.keyIndex === keyIndex));
  const narrowed = providerTargets.filter((target) => !model || target.model === model);

  // Custom model: the operator is trying a model id that is not in the provider's
  // configured list (a freshly released one, say). Reuse the provider's own
  // credentials, base URL and protocols, one target per key, with only the model
  // swapped. Only ever for a model that is not configured, and only when the
  // client opted in, so a typo against the configured list still returns no_route.
  if (pin?.customModel === true && model && narrowed.length === 0 && providerTargets.length > 0) {
    const byKey = new Map();
    for (const target of providerTargets) {
      if (!byKey.has(target.keyIndex)) byKey.set(target.keyIndex, { ...target, model });
    }
    return { pinned: true, targets: [...byKey.values()], provider, keyIndex, model, custom: true };
  }

  return { pinned: true, targets: narrowed, provider, keyIndex, model: model || null };
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
