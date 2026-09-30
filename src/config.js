export const RETRYABLE_STATUS = new Set([402, 408, 429, 500, 502, 503, 504]);

export function loadConfig(env = process.env) {
  const splitKeys = (name) => String(env[name] || "").split(",").map((v) => v.trim()).filter(Boolean);
  return { port: Number(env.PORT || 8788), timeoutMs: Number(env.REQUEST_TIMEOUT_MS || 120000), retryableStatus: RETRYABLE_STATUS,
    providers: {
      agentrouter: { keys: splitKeys("AGENTROUTER_API_KEYS"), baseUrl: env.AGENTROUTER_BASE_URL || "https://agentrouter.org/" },
      gemini: { keys: splitKeys("GEMINI_API_KEYS") }, groq: { keys: splitKeys("GROQ_API_KEYS") },
      huggingface: { keys: splitKeys("HUGGINGFACE_API_KEYS") }, mistral: { keys: splitKeys("MISTRAL_API_KEYS") },
      openrouter: { keys: splitKeys("OPENROUTER_API_KEYS") }, cerebras: { keys: splitKeys("CEREBRAS_API_KEYS") },
      cloudflare: { keys: splitKeys("CLOUDFLARE_API_KEYS") }, sambanova: { keys: splitKeys("SAMBANOVA_API_KEYS") },
      cohere: { keys: splitKeys("COHERE_API_KEYS") }, zai: { keys: splitKeys("ZAI_API_KEYS") }
    }
  };
}
