import { isProviderConfigured } from "../config.js";
import { providerProtocols } from "../adapters.js";

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

function describeProvider(id, provider, targets) {
  const providerTargets = targets.filter((target) => target.provider === id);
  const configured = isProviderConfigured(provider);

  return {
    id,
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

    // ONE model list per provider. What a model can do (image input, tools, ...)
    // is its declared capability set in the Model Configurator, not a property
    // of the provider, so none is reported here.
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

    // A custom endpoint saved from the control panel (edited there, not in env).
    custom: provider.custom === true,
    label: provider.label || null,

    // The env var names an operator would edit for this provider.
    envPrefix: provider.custom ? null : provider.envPrefix || id.toUpperCase()
  };
}

export function describeConfig(config, targets = []) {
  const providers = Object.entries(config.providers).map(([id, provider]) =>
    describeProvider(id, provider, targets)
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
      strategy: "single unified Fallback Chain, with optional remembered success",
      targetIdentity: "provider + model + keyIndex",
      exactModelPreferred: false,
      // Routing is capability-based: every configured target is a candidate,
      // and the request's required capabilities decide which ones are eligible.
      eligibility: "declared capabilities that an adapter can execute",
      // Where the order comes from. The strategy itself is not environment
      // configuration any more, so it is reported by /api/fallback.
      orderSource: "fallback-chain",
      chainFile: config.fallbackChainFile
    },
    providers,
    summary: {
      knownProviders: providers.length,
      configuredProviders: configuredProviders.length,
      unconfiguredProviders: providers.length - configuredProviders.length,
      configuredTargets: targets.length,
      configuredModels: new Set(targets.map((target) => `${target.provider}/${target.model}`)).size
    }
  };
}

/**
 * The env var names an operator can safely act on. Values are never included.
 * Grouped the way `.env.example` presents them so the UI can mirror that file.
 */
function providerEnvVars(providers) {
  // A saved custom endpoint is not environment configuration: no env var names.
  return Object.entries(providers).filter(([, provider]) => !provider.custom).map(([id, provider]) => {
    return {
      provider: id,
      vars: [
        { name: `${id.toUpperCase()}_API_KEYS`, configured: provider.apiKeys.length > 0, kind: "secret" },
        { name: `${id.toUpperCase()}_MODELS`, configured: provider.models.length > 0, kind: "list" },
        ...(id === "cloudflare"
          // Cloudflare's URL is built from the account id, so that is what to set.
          ? [{ name: `${id.toUpperCase()}_ACCOUNT_IDS`, configured: (provider.accountIds || []).length > 0, kind: "list" }]
          : [{ name: `${id.toUpperCase()}_BASE_URL`, configured: Boolean(provider.baseUrl), kind: "url" }])
      ]
    };
  });
}

export function describeEnvironment(config, env = process.env) {
  const providerVars = providerEnvVars(config.providers);

  return {
    server: [
      { name: "PORT", configured: true, kind: "number" },
      { name: "REQUEST_TIMEOUT_MS", configured: true, kind: "number" },
      { name: "RETRY_STATUS_CODES", configured: true, kind: "list" },
      { name: "APIROUTER_API_KEYS", configured: config.routerApiKeys.length > 0, kind: "secret" }
    ],
    // Routing order is configuration now, not environment: it lives in the
    // Fallback Chain, which the control panel owns. Listed here so an operator
    // can see exactly which legacy variables remain and what each one does.
    // `configured` reports whether the variable is set right now; none of them
    // is active routing configuration.
    legacy: [
      { name: "TEXT_PRIORITY_MODELS", configured: Boolean(String(env?.TEXT_PRIORITY_MODELS ?? "").trim()), kind: "list", note: "legacy — read once to seed the unified Fallback Chain" },
      { name: "VISION_PRIORITY_MODELS", configured: Boolean(String(env?.VISION_PRIORITY_MODELS ?? "").trim()), kind: "list", note: "legacy — read once to seed the unified Fallback Chain" },
      { name: "MANUAL_SELECTION_FILE", configured: false, kind: "text", note: "legacy — read once, to seed the Fallback Chain" },
      { name: "*_VISION_API_KEYS / *_VISION_MODELS / *_VISION_BASE_URL", configured: false, kind: "list", note: "retired — ignored; list those models under *_MODELS and declare image input in the Model Configurator" }
    ],
    providers: providerVars
  };
}