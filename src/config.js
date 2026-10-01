import { providerProtocols } from "./adapters.js";

const DEFAULT_RETRY_STATUS_CODES = [401, 402, 403, 404, 408, 409, 425, 429, 500, 501, 502, 503, 504, 520, 521, 522, 523, 524, 529];
const PROVIDER_IDS = ["agentrouter", "gemini", "groq", "huggingface", "mistral", "openrouter", "cerebras", "cloudflare", "sambanova", "cohere", "zai"];

const split = (value) => String(value || "").split(",").map((v) => v.trim()).filter(Boolean);

const CLOUDFLARE_API_ROOT = "https://api.cloudflare.com/client/v4/accounts";

/**
 * Cloudflare Workers AI is account-scoped: its OpenAI-compatible endpoint is
 * `https://api.cloudflare.com/client/v4/accounts/<ACCOUNT_ID>/ai/v1`, so an API
 * token alone is not enough. Accept either a full CLOUDFLARE_BASE_URL (which may
 * use an `{ACCOUNT_ID}` placeholder) or just CLOUDFLARE_ACCOUNT_ID.
 */
export function resolveCloudflareBaseUrl(baseUrl, accountId) {
  const base = String(baseUrl || "").trim();
  const account = String(accountId || "").trim();
  if (base) {
    return account ? base.replace(/\{\s*account[_-]?id\s*\}/gi, account) : base;
  }
  return account ? `${CLOUDFLARE_API_ROOT}/${encodeURIComponent(account)}/ai/v1` : "";
}

export function isProviderConfigured(provider) {
  return Boolean(provider && provider.apiKeys.length > 0 && provider.models.length > 0 && provider.baseUrl);
}

export function buildTargets(providers) {
  const targets = [];
  for (const [providerId, provider] of Object.entries(providers)) {
    if (!isProviderConfigured(provider)) continue;
    for (const model of provider.models) {
      for (let keyIndex = 0; keyIndex < provider.apiKeys.length; keyIndex += 1) {
        targets.push({
          provider: providerId,
          model,
          baseUrl: provider.baseUrl,
          apiKey: provider.apiKeys[keyIndex],
          protocols: providerProtocols(providerId),
          clientHeaders: provider.clientHeaders || {},
          keyIndex
        });
      }
    }
  }
  return targets;
}

export function loadConfig(env = process.env) {
  const providers = {};
  for (const id of PROVIDER_IDS) {
    const key = id.toUpperCase();
    providers[id] = {
      apiKeys: split(env[key + "_API_KEYS"]),
      models: split(env[key + "_MODELS"]),
      baseUrl: id === "cloudflare"
        ? resolveCloudflareBaseUrl(env.CLOUDFLARE_BASE_URL, env.CLOUDFLARE_ACCOUNT_ID)
        : String(env[key + "_BASE_URL"] || "").trim(),
      // Cloudflare only: kept so the dashboard can say what is missing.
      ...(id === "cloudflare" ? { accountId: String(env.CLOUDFLARE_ACCOUNT_ID || "").trim() } : {}),
      clientHeaders: id === "agentrouter" ? {
        originator: String(env.AGENTROUTER_ORIGINATOR || "").trim(),
        version: String(env.AGENTROUTER_VERSION || "").trim(),
        "user-agent": String(env.AGENTROUTER_USER_AGENT || "").trim()
      } : {}
    };
  }
  const retryableValues = split(env.RETRY_STATUS_CODES || DEFAULT_RETRY_STATUS_CODES.join(","))
    .map(Number).filter((v) => Number.isInteger(v) && v >= 100 && v <= 599);
  return {
    routerApiKeys: split(env.MULTIAI_ROUTER_API_KEYS),
    port: Number(env.PORT || 8788),
    timeoutMs: Number(env.REQUEST_TIMEOUT_MS || 120000),
    // Streaming requests should get response headers within seconds. If a
    // provider hangs, give up on it quickly and fall back instead of waiting
    // for the full REQUEST_TIMEOUT_MS.
    // Largest client request body the router accepts. Claude Code resends the
    // whole conversation (including pasted images) each turn, so 10 MB is easily
    // exceeded; 32 MB matches Anthropic's own limit.
    maxBodyBytes: Math.max(1, Number(env.MAX_REQUEST_BODY_MB || 32)) * 1024 * 1024,
    connectTimeoutMs: Number(env.STREAM_CONNECT_TIMEOUT_MS || 30000),
    retryableStatus: new Set(retryableValues),
    providers
  };
}
