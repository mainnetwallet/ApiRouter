import { isProviderConfigured, VISION_POOL } from "./config.js";

/**
 * Provider and model capability metadata.
 *
 * The router keeps two independent pools — text and vision — and a provider's
 * capability in each is derived from what is *actually configured* for that
 * pool, never from what the provider might be able to do in general:
 *
 *   text-capable    TEXT_API_KEYS    + TEXT_BASE_URL    + TEXT_MODELS
 *   vision-capable  TEXT_VISION_API_KEYS + ..._BASE_URL + ..._VISION_MODELS
 *
 * The two are independent. A provider can be text-only, vision-only, or both;
 * the same provider appearing in both pools is normal (Gemini, OpenRouter, ...)
 * and its two capabilities still stand or fall on their own configuration.
 *
 * The individual *model* matters as much as the provider: an image request must
 * not be served by a model that is only configured for text. `modelPoolIndex`
 * records which pools each configured model id belongs to, and
 * `validateModelForPool` turns that into the capability error the proxy returns
 * when a client explicitly asks for a model the requested pool cannot serve.
 */

export const TEXT_POOL = "text";

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
 */
export function describeProviderCapabilities(config) {
  const providers = {};

  for (const id of Object.keys(config?.providers ?? {})) {
    const textProvider = config.providers[id];
    const visionProvider = config.visionProviders?.[id];

    providers[id] = {
      id,
      capabilities: {
        text: isProviderConfigured(textProvider),
        vision: isProviderConfigured(visionProvider)
      },
      textModels: [...(textProvider?.models ?? [])],
      visionModels: [...(visionProvider?.models ?? [])]
    };
  }

  return providers;
}

/**
 * Which pools each configured model id is available in.
 *
 * Only configured providers contribute: a model listed under a provider that
 * has no keys or no base URL cannot serve anything, so it is not evidence that
 * the model is text- or vision-capable.
 *
 * Value shape: `{ text: bool, vision: bool, providers: { text: [], vision: [] } }`
 */
export function modelPoolIndex(config) {
  const index = new Map();

  const add = (id, pool) => {
    const provider = pool === VISION_POOL ? config?.visionProviders?.[id] : config?.providers?.[id];
    if (!isProviderConfigured(provider)) return;

    for (const model of provider.models) {
      if (!index.has(model)) {
        index.set(model, { text: false, vision: false, providers: { text: [], vision: [] } });
      }
      const entry = index.get(model);
      entry[pool] = true;
      entry.providers[pool].push(id);
    }
  };

  for (const id of Object.keys(config?.providers ?? {})) {
    add(id, TEXT_POOL);
    add(id, VISION_POOL);
  }

  return index;
}

/**
 * Is `model` explicitly configured for `pool`?
 * `null` when the model is unknown to the router, `true`/`false` otherwise.
 */
export function modelSupportsPool(index, model, pool) {
  const entry = index?.get?.(String(model ?? "").trim());
  if (!entry) return null;
  return entry[pool] === true;
}

/**
 * Capability validation for an explicitly requested model.
 *
 * Returns `null` when the request may proceed, otherwise the rejection to send
 * back. The rule is deliberately narrow, so existing behaviour is preserved:
 *
 *  - no/blank model                       -> proceed (nothing to validate);
 *  - a *text* request                     -> always proceed. A vision-only model
 *    named by a text request is simply never selected; the request widens to
 *    the compatible text targets exactly as it always has. Rejecting here would
 *    break long-standing, tested behaviour the spec does not ask to change;
 *  - model configured for the vision pool -> proceed (exact match);
 *  - model unknown to the router          -> proceed, and let the existing
 *    "widen to every compatible target" path handle it. That is how a custom or
 *    freshly released model id is served, and it must keep working;
 *  - model configured *only* for text, on a vision request -> reject. The
 *    client named a model that cannot see the image, so widening would silently
 *    answer with a different model than it asked for; the spec requires a clear
 *    `model_not_vision_capable` error instead.
 */
export function validateModelForPool(index, model, pool) {
  const wanted = String(model ?? "").trim();
  if (!wanted) return null;
  // Only an image request rejects; see the doc comment above.
  if (pool !== VISION_POOL) return null;

  const entry = index?.get?.(wanted);
  if (!entry) return null;
  if (entry[VISION_POOL]) return null;
  // Defensive: an entry with neither pool set cannot be built by
  // `modelPoolIndex`, but if one ever existed it is no reason to reject.
  if (!entry[TEXT_POOL]) return null;

  return {
    model: wanted,
    required_capability: VISION_POOL,
    type: "model_not_vision_capable"
  };
}

/** The message an operator sees for a capability rejection. */
export function capabilityErrorMessage(rejection) {
  return `Vision request rejected: model "${rejection.model}" `
    + `is not configured for the ${rejection.required_capability} pool`;
}
