const DEFAULT_RETRY_STATUS_CODES = [402, 408, 429, 500, 502, 503, 504];

const PROVIDER_IDS = [
  "agentrouter", "gemini", "groq", "huggingface", "mistral",
  "openrouter", "cerebras", "cloudflare", "sambanova", "cohere", "zai"
];

const split = (value) => String(value || "")
  .split(",")
  .map((v) => v.trim())
  .filter(Boolean);

export function isProviderConfigured(provider) {
  return Boolean(
    provider &&
    provider.apiKeys.length > 0 &&
    provider.models.length > 0 &&
    provider.baseUrl
  );
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
      baseUrl: String(env[key + "_BASE_URL"] || "").trim()
    };
  }

  const retryableValues = split(
    env.RETRY_STATUS_CODES || DEFAULT_RETRY_STATUS_CODES.join(",")
  )
    .map(Number)
    .filter((v) => Number.isInteger(v) && v >= 100 && v <= 599);

  return {
    port: Number(env.PORT || 8788),
    timeoutMs: Number(env.REQUEST_TIMEOUT_MS || 120000),
    retryableStatus: new Set(retryableValues),
    providers
  };
}
