import { isProviderConfigured } from "../config.js";
import { providerProtocols } from "../adapters.js";
import { describeProviderCapabilities } from "../capabilities.js";

/**
 * A safe, read-only projection of the router's configuration.
 *
 * This is the one view an operator reads to answer "is this provider set up
 * correctly?" without opening `.env`. It is an allow-list: only fields named
 * here can ever be serialized, so a future config field cannot leak by default.
 *
 * Credentials are represented *only* as a count. There is deliberately no code
 * path that reads `apiKeys` into the response, not even a masked prefix —
 * the gateway has no way to prove a masked key is harmless, and an operator
 * who needs the value has the `.env` file.
 *
 * Env var *names* are reported (they are not secret and they tell the operator
 * exactly what to edit); env var *values* never are.
 */

/** Header names the router will attach for a provider — names only, never values. */
function configuredHeaderNames(provider) {
  const headers = provider?.clientHeaders;
  if (!headers || typeof headers !== "object") return [];

  return Object.entries(headers)
    .filter(([, value]) => String(value ?? "").trim().length > 0)
    .map(([name]) => name)
    .sort();
}

function describeProvider(id, provider, targets, pool = "text", capabilities = null) {
  const providerTargets = targets.filter((target) => target.provider === id && (target.pool ?? "text") === pool);
  const configured = isProviderConfigured(provider);
  const caps = capabilities ?? {
    capabilities: { text: pool === "text" && configured, vision: pool === "vision" && configured },
    textModels: pool === "text" ? [...provider.models] : [],
    visionModels: pool === "vision" ? [...provider.models] : []
  };

  return {
    id,
    // Which pool this row describes. The same provider is described once per
    // pool it participates in, and the two rows are never merged: a provider
    // healthy for text and failing for vision has to be able to say so.
    pool,
    configured,
    // Why a provider is not routable, so the UI can say more than "off".
    missing: configured
      ? []
      : [
          provider.apiKeys.length === 0 ? "api keys" : null,
          provider.models.length === 0 ? "models" : null,
          !provider.baseUrl
            ? (id === "cloudflare" ? "account ids (CLOUDFLARE_ACCOUNT_IDS)" : "base url")
            : null
        ].filter(Boolean),

    // Capability metadata: what this provider can route, per pool, and with
    // which models. Derived from configuration, never assumed.
    capabilities: { ...caps.capabilities },
    textModels: [...caps.textModels],
    visionModels: [...caps.visionModels],

    baseUrl: provider.baseUrl || null,
    models: [...provider.models],
    modelCount: provider.models.length,

    // Count only. This is the whole of what the dashboard may know about keys.
    keyCount: provider.apiKeys.length,

    protocols: providerTargets[0]?.protocols
      ? [...providerTargets[0].protocols]
      : providerProtocols(id),

    clientHeaderNames: configuredHeaderNames(provider),
    targetCount: providerTargets.length,

    // The env var names an operator would edit for this provider.
    envPrefix: provider.envPrefix || id.toUpperCase()
  };
}

export function describeConfig(config, targets = []) {
  const capabilities = describeProviderCapabilities(config);

  const providers = Object.entries(config.providers).map(([id, provider]) =>
    describeProvider(id, provider, targets, "text", capabilities[id])
  );

  const configuredProviders = providers.filter((provider) => provider.configured);

  return {
    server: {
      port: config.port,
      requestTimeoutMs: config.timeoutMs,
      // Whether the gateway demands a client token. Never the token itself.
      clientAuthRequired: config.routerApiKeys.length > 0,
      clientKeyCount: config.routerApiKeys.length
    },
    routing: {
      retryableStatus: [...config.retryableStatus].sort((a, b) => a - b),
      strategy: "health-ranked with sticky session and automatic fallback",
      targetIdentity: "provider + model + keyIndex",
      exactModelPreferred: true,
      // The two pools are routed independently; a request never crosses over.
      pools: ["text", "vision"],
      crossPoolFallback: "blocked"
    },
    providers,
    // Image requests use this separate pool (own keys, base URLs and models).
    visionProviders: Object.entries(config.visionProviders ?? {}).map(([id, provider]) =>
      describeProvider(id, provider, targets, "vision", capabilities[id])),
    // One entry per known provider, with both capabilities on one object.
    capabilities: Object.values(capabilities),
    summary: {
      knownProviders: providers.length,
      configuredProviders: configuredProviders.length,
      unconfiguredProviders: providers.length - configuredProviders.length,
      configuredTargets: targets.filter((target) => (target.pool ?? "text") === "text").length,
      configuredVisionTargets: targets.filter((target) => target.pool === "vision").length,
      textCapableProviders: Object.values(capabilities).filter((c) => c.capabilities.text).length,
      visionCapableProviders: Object.values(capabilities).filter((c) => c.capabilities.vision).length,
      dualCapableProviders: Object.values(capabilities)
        .filter((c) => c.capabilities.text && c.capabilities.vision).length
    }
  };
}

/**
 * The env var names an operator can safely act on. Values are never included.
 * Grouped the way `.env.example` presents them so the UI can mirror that file.
 */
function providerEnvVars(providers, { vision }) {
  return Object.entries(providers).map(([id, provider]) => {
    const prefix = id.toUpperCase() + (vision ? "_VISION" : "");
    return {
      provider: id,
      vars: [
        { name: `${prefix}_API_KEYS`, configured: provider.apiKeys.length > 0, kind: "secret" },
        { name: `${prefix}_MODELS`, configured: provider.models.length > 0, kind: "list" },
        ...(id === "cloudflare"
          // Cloudflare's URL is built from the account id, so that is what to set.
          ? [{ name: `${prefix}_ACCOUNT_IDS`, configured: (provider.accountIds || []).length > 0, kind: "list" }]
          : [{ name: `${prefix}_BASE_URL`, configured: Boolean(provider.baseUrl), kind: "url" }])
      ]
    };
  });
}

export function describeEnvironment(config) {
  const providerVars = providerEnvVars(config.providers, { vision: false });
  const visionProviderVars = providerEnvVars(config.visionProviders ?? {}, { vision: true });

  return {
    server: [
      { name: "PORT", configured: true, kind: "number" },
      { name: "REQUEST_TIMEOUT_MS", configured: true, kind: "number" },
      { name: "RETRY_STATUS_CODES", configured: true, kind: "list" },
      { name: "TEXT_PRIORITY_MODELS", configured: config.priority?.text?.length > 0, kind: "list" },
      { name: "VISION_PRIORITY_MODELS", configured: config.priority?.vision?.length > 0, kind: "list" },
      { name: "APIROUTER_API_KEYS", configured: config.routerApiKeys.length > 0, kind: "secret" }
    ],
    providers: providerVars,
    visionProviders: visionProviderVars
  };
}
