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

/**
 * Pairs each Cloudflare API key with its account id.
 *   CLOUDFLARE_API_KEYS=key1,key2   CLOUDFLARE_ACCOUNT_IDS=id1,id2   -> key1/id1, key2/id2
 * A single id is shared by every key (several tokens, one account). When there
 * are several ids, a key with no matching id is skipped rather than guessed.
 * CLOUDFLARE_ACCOUNT_ID (singular) is accepted as an alias.
 */
function applyCloudflareAccounts(provider, env) {
  const accountIds = split(env.CLOUDFLARE_ACCOUNT_IDS || env.CLOUDFLARE_ACCOUNT_ID);
  const accountFor = (keyIndex) => (accountIds.length === 1 ? accountIds[0] : accountIds[keyIndex] || "");
  provider.accountIds = accountIds;
  provider.baseUrls = provider.apiKeys.map((_, keyIndex) =>
    resolveCloudflareBaseUrl(env.CLOUDFLARE_BASE_URL, accountFor(keyIndex)));
  // First usable URL, for the "is this provider configured / what does it point at" views.
  provider.baseUrl = provider.baseUrls.find(Boolean) || resolveCloudflareBaseUrl(env.CLOUDFLARE_BASE_URL, accountIds[0]);
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
        // Cloudflare keys each have their own account, hence their own URL.
        const baseUrl = Array.isArray(provider.baseUrls) ? provider.baseUrls[keyIndex] : provider.baseUrl;
        if (!baseUrl) continue;
        targets.push({
          provider: providerId,
          model,
          baseUrl,
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
      baseUrl: id === "cloudflare" ? "" : String(env[key + "_BASE_URL"] || "").trim(),
      clientHeaders: id === "agentrouter" ? {
        originator: String(env.AGENTROUTER_ORIGINATOR || "").trim(),
        version: String(env.AGENTROUTER_VERSION || "").trim(),
        "user-agent": String(env.AGENTROUTER_USER_AGENT || "").trim()
      } : {}
    };
  }
  applyCloudflareAccounts(providers.cloudflare, env);
  const retryableValues = split(env.RETRY_STATUS_CODES || DEFAULT_RETRY_STATUS_CODES.join(","))
    .map(Number).filter((v) => Number.isInteger(v) && v >= 100 && v <= 599);
  return {
    routerApiKeys: split(env.MULTIAI_ROUTER_API_KEYS),
    port: Number(env.PORT || 8788),
    // Fallback order by model quality, best first (see MODEL_PRIORITY in .env.example).
    modelPriority: split(env.MODEL_PRIORITY),
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
