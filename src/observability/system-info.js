/**
 * Runtime facts about the gateway process.
 *
 * Everything here is non-secret: version strings, counts, timings. `.env` is
 * loaded by the process, so the environment name is reported but never any
 * variable's value — the same rule that governs `config-view.js`.
 */

function runtimeName() {
  // "node" is the only supported runtime today; reporting it explicitly keeps
  // the UI honest if that ever changes.
  return "node";
}

/** Wall-clock start time, derived from `process.uptime()` so it cannot drift. */
export function processStartedAt(now = Date.now()) {
  return new Date(now - Math.round(process.uptime() * 1000)).toISOString();
}

const isRoutable = (provider) =>
  provider.apiKeys.length > 0 && provider.models.length > 0 && Boolean(provider.baseUrl);
const isTouched = (provider) =>
  provider.apiKeys.length > 0 || provider.models.length > 0 || Boolean(provider.baseUrl);

/**
 * One pool's slice of the runtime report. Text and vision have their own keys,
 * base URLs and models, so each is counted on its own and never merged.
 */
function describePool(providers = {}, targets = [], pool) {
  const entries = Object.entries(providers);
  const loaded = entries.filter(([, provider]) => isTouched(provider)).map(([id]) => id);

  return {
    pool,
    providers: {
      loaded,
      loadedCount: loaded.length,
      configuredCount: entries.filter(([, provider]) => isRoutable(provider)).length,
      knownCount: entries.length
    },
    configuredTargets: targets.filter((target) => (target.pool ?? "text") === pool).length
  };
}

export function describeSystem({ config, targets = [], monitor = null, startedAt = null, now = Date.now() } = {}) {
  const configuredProviders = Object.values(config?.providers ?? {}).filter(
    (provider) => provider.apiKeys.length > 0 && provider.models.length > 0 && provider.baseUrl
  ).length;

  const loadedProviders = Object.entries(config?.providers ?? {})
    .filter(([, provider]) => provider.apiKeys.length > 0 || provider.models.length > 0 || provider.baseUrl)
    .map(([id]) => id);

  return {
    service: "apirouter",
    status: "ok",
    address: `http://localhost:${config?.port ?? null}`,
    port: config?.port ?? null,

    runtime: runtimeName(),
    nodeVersion: process.version,
    v8Version: process.versions.v8 ?? null,
    platform: process.platform,
    architecture: process.arch,
    pid: process.pid,

    environment: process.env.NODE_ENV || "development",

    startedAt: startedAt ?? processStartedAt(now),
    uptimeMs: Math.round(process.uptime() * 1000),

    providers: {
      loaded: loadedProviders,
      loadedCount: loadedProviders.length,
      configuredCount: configuredProviders,
      knownCount: Object.keys(config?.providers ?? {}).length
    },

    configuredTargets: targets.length,

    // The same figures split by routing pool. The totals above are kept for
    // existing consumers; the System page renders these instead.
    pools: {
      text: describePool(config?.providers, targets, "text"),
      vision: describePool(config?.visionProviders, targets, "vision")
    },

    // Health-monitor status is supplied by the tracker in `monitor-state.js`,
    // which observes the real cycles rather than guessing at them.
    healthMonitor: monitor,

    requestTimeoutMs: config?.timeoutMs ?? null,
    clientAuthRequired: (config?.routerApiKeys?.length ?? 0) > 0,
    telemetry: {
      // Stated plainly so the UI never implies persistence it does not have.
      persistence: "in-memory",
      note: "Health state, request log and metrics reset when the process restarts."
    }
  };
}
