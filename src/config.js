import { providerProtocols } from "./adapters.js";
import { readPriority } from "./routing-plan.js";

const DEFAULT_RETRY_STATUS_CODES = [401, 402, 403, 404, 408, 409, 425, 429, 500, 501, 502, 503, 504, 520, 521, 522, 523, 524, 529];

/**
 * Parse `RETRY_STATUS_CODES`. Unlike a free-form list, every entry has to be a
 * real HTTP status code: a typo used to be filtered out silently, so
 * `RETRY_STATUS_CODES=abc` quietly retried nothing while looking configured.
 * An unset or empty variable keeps the default set.
 */
function readStatusCodes(env, name, fallback) {
  const raw = env[name];
  if (raw === undefined || raw === null || String(raw).trim() === "") return new Set(fallback);
  const entries = String(raw).split(",").map((value) => value.trim()).filter((value) => value !== "");
  if (entries.length === 0) {
    throw new Error(`Invalid ${name}: expected a comma-separated list of HTTP status codes (100-599), got "${String(raw).slice(0, 40)}"`);
  }
  const codes = entries.map((entry) => {
    const value = Number(entry);
    if (!Number.isInteger(value) || value < 100 || value > 599) {
      throw new Error(`Invalid ${name}: "${entry.slice(0, 20)}" is not an HTTP status code (100-599)`);
    }
    return value;
  });
  return new Set(codes);
}

/** Default request-body ceiling: large enough for real payloads, bounded. */
export const DEFAULT_MAX_BODY_BYTES = 64 * 1024 * 1024;
/**
 * The single source of truth for which providers exist. Every other list —
 * `providers/catalog.js`, the `/health` payload, the env-var audit — hangs off
 * this one, so adding a provider cannot half-register it.
 */
export const PROVIDER_IDS = ["agentrouter", "gemini", "groq", "huggingface", "mistral", "openrouter", "cerebras", "cloudflare", "sambanova", "cohere", "zai", "vercel", "opencode", "nvidia", "nous", "pollinations", "siliconflow", "modelscope", "llm7"];

const split = (value) => String(value || "").split(",").map((v) => v.trim()).filter(Boolean);

/**
 * Numeric env settings fail fast. An unset or empty variable keeps its default;
 * anything else must be a valid number inside the stated bounds, otherwise
 * startup stops with a clear message. A bad value must never degrade into NaN,
 * 0 or "no limit" (`size > NaN` is never true, which would disable the body cap).
 */
function readNumber(env, name, fallback, { integer = true, min, max = Infinity, expected }) {
  const raw = env[name];
  if (raw === undefined || raw === null || String(raw).trim() === "") return fallback;
  const value = Number(String(raw).trim());
  const valid = Number.isFinite(value) && (!integer || Number.isSafeInteger(value)) && value >= min && value <= max;
  if (!valid) throw new Error(`Invalid ${name}: expected ${expected}, got "${String(raw).slice(0, 40)}"`);
  return value;
}

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
function applyCloudflareAccounts(provider, env, prefix = "CLOUDFLARE") {
  const accountIds = split(env[`${prefix}_ACCOUNT_IDS`] || env[`${prefix}_ACCOUNT_ID`]);
  const accountFor = (keyIndex) => (accountIds.length === 1 ? accountIds[0] : accountIds[keyIndex] || "");
  provider.accountIds = accountIds;
  provider.baseUrls = provider.apiKeys.map((_, keyIndex) =>
    resolveCloudflareBaseUrl(env[`${prefix}_BASE_URL`], accountFor(keyIndex)));
  provider.baseUrl = provider.baseUrls.find(Boolean) || resolveCloudflareBaseUrl(env[`${prefix}_BASE_URL`], accountIds[0]);
}

export function isProviderConfigured(provider) {
  return Boolean(provider && provider.apiKeys.length > 0 && provider.models.length > 0 && provider.baseUrl);
}

export const VISION_POOL = "vision";

export function buildTargets(providers, pool = "text") {
  const targets = [];
  for (const [providerId, provider] of Object.entries(providers)) {
    if (!isProviderConfigured(provider)) continue;
    for (const model of provider.models) {
      for (let keyIndex = 0; keyIndex < provider.apiKeys.length; keyIndex += 1) {
        const baseUrl = Array.isArray(provider.baseUrls) ? provider.baseUrls[keyIndex] : provider.baseUrl;
        if (!baseUrl) continue;
        targets.push({
          ...(pool === VISION_POOL ? { id: `vision:${providerId}:${model}:key-${keyIndex}`, pool: VISION_POOL } : {}),
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

export function readProviders(env, { vision = false } = {}) {
  const providers = {};
  for (const id of PROVIDER_IDS) {
    const key = id.toUpperCase() + (vision ? "_VISION" : "");
    providers[id] = {
      apiKeys: split(env[key + "_API_KEYS"]),
      models: split(env[key + "_MODELS"]),
      baseUrl: id === "cloudflare" ? "" : String(env[key + "_BASE_URL"] || "").trim(),
      envPrefix: key,
      clientHeaders: id === "agentrouter" ? {
        originator: String(env.AGENTROUTER_ORIGINATOR || "").trim(),
        version: String(env.AGENTROUTER_VERSION || "").trim(),
        "user-agent": String(env.AGENTROUTER_USER_AGENT || "").trim()
      } : {}
    };
  }
  applyCloudflareAccounts(providers.cloudflare, env, vision ? "CLOUDFLARE_VISION" : "CLOUDFLARE");
  return providers;
}

export function loadConfig(env = process.env) {
  const providers = readProviders(env);
  const visionProviders = readProviders(env, { vision: true });
  return {
    routerApiKeys: split(env.MULTIAI_ROUTER_API_KEYS),
    port: readNumber(env, "PORT", 999, { min: 0, max: 65535, expected: "an integer from 0 to 65535" }),
    // Bind address. Unset keeps the historical behaviour (all interfaces);
    // `HOST=127.0.0.1` keeps an unauthenticated gateway on loopback.
    host: String(env.HOST || "").trim(),
    timeoutMs: readNumber(env, "REQUEST_TIMEOUT_MS", 120000, { min: 1, expected: "a positive integer" }),
    // 0 is meaningful here: server.js then uses the full request timeout for streams.
    connectTimeoutMs: readNumber(env, "STREAM_CONNECT_TIMEOUT_MS", 30000, { min: 0, expected: "a non-negative integer (0 disables the separate connect timeout)" }),
    // After the headers arrive, a stream is bounded by the gap between chunks,
    // not by the total duration: a provider that answers 200 and then stalls
    // must not hold the client (and the walk) open forever. 0 disables it.
    streamIdleTimeoutMs: readNumber(env, "STREAM_IDLE_TIMEOUT_MS", 120000, { min: 0, expected: "a non-negative integer (0 disables the idle timeout)" }),
    retryableStatus: readStatusCodes(env, "RETRY_STATUS_CODES", DEFAULT_RETRY_STATUS_CODES),
    // Request-body ceiling. The gateway forwards bodies to providers, so it
    // cannot size them itself; it only guards its own memory. `0` disables the
    // guard, and MAX_REQUEST_BODY_MB stays ignored for backwards compatibility
    // (see .env.example).
    maxBodyBytes: readNumber(env, "MAX_REQUEST_BODY_BYTES", DEFAULT_MAX_BODY_BYTES, { min: 0, expected: "a non-negative integer (0 disables the limit)" }),
    // Sticky target lifetime after a success: 20 minutes. Unlike older
    // numeric settings, this must not silently fall back when configured:
    // a typo or zero would change routing semantics in a surprising way.
    stickyTtlMs: readNumber(env, "STICKY_TTL_MS", 20 * 60 * 1000, {
      min: 1,
      expected: "a positive integer"
    }),
    // Priority is optional: an empty list means no priority phase at all.
    priority: { text: readPriority(env, "text"), vision: readPriority(env, "vision") },
    providers,
    visionProviders
  };
}
