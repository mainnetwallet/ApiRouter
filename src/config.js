const DEFAULT_RETRY_STATUS_CODES = [402, 408, 429, 500, 502, 503, 504];

const PROVIDER_DEFAULTS = {
  agentrouter: { baseUrl: "https://agentrouter.org/" },
  gemini: { baseUrl: "https://generativelanguage.googleapis.com/" },
  groq: { baseUrl: "https://api.groq.com/openai/v1" },
  huggingface: { baseUrl: "https://router.huggingface.co/" },
  mistral: { baseUrl: "https://api.mistral.ai/v1" },
  openrouter: { baseUrl: "https://openrouter.ai/api/v1" },
  cerebras: { baseUrl: "https://api.cerebras.ai/v1" },
  cloudflare: { baseUrl: "" },
  sambanova: { baseUrl: "https://api.sambanova.ai/v1" },
  cohere: { baseUrl: "https://api.cohere.com/compatibility/v1" },
  zai: { baseUrl: "https://api.z.ai/api/paas/v4" }
};

export function loadConfig(env = process.env) {
  const split = (name) => String(env[name] || "").split(",").map((v) => v.trim()).filter(Boolean);
  const providers = {};

  for (const [id, defaults] of Object.entries(PROVIDER_DEFAULTS)) {
    const key = id.toUpperCase();
    providers[id] = {
      baseUrl: env[key + "_BASE_URL"] || defaults.baseUrl,
      models: split(key + "_MODELS"),
      keys: split(key + "_API_KEYS")
    };
  }

  return {
    port: Number(env.PORT || 8788),
    timeoutMs: Number(env.REQUEST_TIMEOUT_MS || 120000),
    retryableStatus: new Set(\n      (env.RETRY_STATUS_CODES || DEFAULT_RETRY_STATUS_CODES.join(","))\n        .split(",")\n        .map((v) => Number(v.trim()))\n        .filter((v) => Number.isInteger(v) && v >= 100 && v <= 599)\n    ),
    providers
  };
}
