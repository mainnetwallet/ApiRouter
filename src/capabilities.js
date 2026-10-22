import { isProviderConfigured } from "./config.js";

/**
 * Provider and model capability metadata.
 *
 * The router keeps ONE unified model registry. A model's capability in the
 * routing system is derived from its declared capabilities in the Model
 * Configurator, never from pool membership. Each provider contributes its
 * configured models, and whether a model can serve a request is decided by
 * its declared capabilities matching the request's requirements.
 *
 * The individual *model* matters as much as the provider: a request requiring
 * image input must not be served by a model that only declares text.
 * `modelCapabilityIndex` records which capabilities each configured model
 * declares, and `validateRequestedModelCapabilities` turns that into the
 * capability error the proxy returns when a client explicitly asks for a
 * model that cannot serve the request.
 */

/**
 * Per-provider capability descriptor:
 *
 *   {
 *     id: "gemini",
 *     capabilities: { text: true, vision: true },
 *     textModels: [...],
 *     visionModels: [...]
 *   }
 *
 * `capabilities.*` is the routing truth (is this provider routable for that
 * pool at all); the model lists are what that pool would actually offer.
 *
 * @deprecated This function is retained for backward compatibility with
 * observability views that still report per-pool provider summaries.
 * New code should use the unified model index from model-config.js.
 */
export function describeProviderCapabilities(config) {
  const providers = {};

  for (const id of Object.keys(config?.providers ?? {})) {
    const provider = config.providers[id];

    providers[id] = {
      id,
      capabilities: {
        text: isProviderConfigured(provider),
        vision: isProviderConfigured(provider)
      },
      textModels: [...(provider?.models ?? [])],
      visionModels: [...(provider?.models ?? [])]
    };
  }

  return providers;
}

/**
 * Build a capability index from the unified model configuration.
 *
 * Value shape: `{ [provider/model]: { capabilities: Set, source, provider, model } }`
 *
 * Only configured providers contribute: a model listed under a provider that
 * has no keys or no base URL cannot serve anything, so it is not evidence that
 * the model has any capabilities.
 */
export function modelCapabilityIndex(config, modelConfigIndex) {
  const index = new Map();

  if (!modelConfigIndex) return index;

  for (const [id, entry] of modelConfigIndex.entries()) {
    if (!entry.provider || !entry.model) continue;
    const provider = config?.providers?.[entry.provider];
    if (!isProviderConfigured(provider)) continue;

    index.set(id, {
      provider: entry.provider,
      model: entry.model,
      capabilities: new Set(entry.capabilities || []),
      source: entry.capabilitiesSource || "inferred",
      executable: new Set(entry.executableCapabilities || [])
    });
  }

  return index;
}

/**
 * Is `model` explicitly configured to support the requested capabilities?
 * `null` when the model is unknown to the router, `true`/`false` otherwise.
 */
export function modelSupportsCapabilities(index, model, requiredCapabilities) {
  const entry = index?.get?.(String(model ?? "").trim());
  if (!entry) return null;
  const caps = entry.capabilities;
  for (const cap of requiredCapabilities) {
    if (!caps.has(cap)) return false;
  }
  return true;
}

/**
 * Capability validation for an explicitly requested model.
 *
 * Returns `null` when the request may proceed, otherwise the rejection to send
 * back. The rule is deliberately narrow, so existing behaviour is preserved:
 *
 *  - no/blank model                       -> proceed (nothing to validate);
 *  - a model that declares all required capabilities -> proceed;
 *  - model unknown to the router          -> proceed, and let the existing
 *    "widen to every compatible target" path handle it. That is how a custom or
 *    freshly released model id is served, and it must keep working;
 *  - model configured but missing a required capability -> reject. The
 *    client named a model that cannot serve this request, so widening would
 *    silently answer with a different model than it asked for; the spec requires
 *    a clear `model_not_capability_capable` error instead.
 */
export function validateRequestedModel(index, model, requiredCapabilities) {
  const wanted = String(model ?? "").trim();
  if (!wanted) return null;
  if (!requiredCapabilities || requiredCapabilities.length === 0) return null;

  const entry = index?.get?.(wanted);
  if (!entry) return null;
  // Model is known but doesn't declare all required capabilities.
  for (const cap of requiredCapabilities) {
    if (!entry.capabilities.has(cap)) {
      return {
        model: wanted,
        required_capabilities: [cap],
        type: "model_not_capability_capable"
      };
    }
  }
  return null;
}

/** The message an operator sees for a capability rejection. */
export function capabilityErrorMessage(rejection) {
  return `Request rejected: model "${rejection.model}" `
    + `does not declare the required capability${rejection.required_capabilities?.length > 1 ? "ies" : ""}: `
    + (rejection.required_capabilities || []).join(", ");
}

/** Message for a requested-model capability mismatch. */
export function requestedModelCapabilityMessage(rejection) {
  return `Model "${rejection.model}" cannot serve this request: `
    + `it does not declare the required capability${rejection.required_capabilities?.length > 1 ? "ies" : ""} `
    + `(${(rejection.required_capabilities || []).join(", ")})`;
}