import { targetId } from "./health.js";

/**
 * Priority + key-scoped fallback planning.
 *
 * The plan is the ordered list of concrete targets a request may try. It is
 * built once per request from the pool the request already belongs to, so a
 * text request can only ever contain text targets and a vision request only
 * vision targets. Nothing here looks at health: eligibility (cooldown) is
 * applied while the plan is walked, against the one shared HealthRegistry.
 *
 *   PRIORITY phase   PRIORITY_MODELS entries, in exactly the configured order
 *   FALLBACK phase   Provider -> Key -> Models (config order) -> next Key
 *                    -> next Provider. Each key restarts at its own first model.
 *
 * Targets already in the priority phase are NOT removed from the fallback
 * phase here; the walker skips them with an `already_attempted` record, which
 * is what keeps the skip visible in the request timeline.
 */

export const PHASES = Object.freeze({ PRIORITY: "priority", FALLBACK: "fallback" });

/**
 * Parses "gemini/G1,groq/GR2". The model keeps everything after the FIRST "/",
 * because model ids such as "meta/llama-3" legitimately contain slashes.
 * Malformed entries (no provider or no model) are dropped, not guessed at.
 */
export function parsePriorityModels(value) {
  const entries = [];
  const seen = new Set();
  for (const raw of String(value || "").split(",")) {
    const text = raw.trim();
    const slash = text.indexOf("/");
    if (slash <= 0 || slash === text.length - 1) continue;
    const provider = text.slice(0, slash).trim().toLowerCase();
    const model = text.slice(slash + 1).trim();
    if (!provider || !model) continue;
    const id = `${provider}/${model}`;
    if (seen.has(id)) continue;
    seen.add(id);
    entries.push({ provider, model });
  }
  return entries;
}

/**
 * Priority list for one pool. TEXT_PRIORITY_MODELS / VISION_PRIORITY_MODELS win
 * over the shared PRIORITY_MODELS. A shared entry only ever matches targets of
 * the pool being routed, so it can never pull a request across pools.
 */
export function readPriority(env, pool = "text") {
  const specific = pool === "vision" ? env.VISION_PRIORITY_MODELS : env.TEXT_PRIORITY_MODELS;
  const raw = specific !== undefined && String(specific).trim() !== "" ? specific : env.PRIORITY_MODELS;
  return parsePriorityModels(raw);
}

/** Providers in first-appearance (configuration) order, then keys, then models. */
function groupByProvider(targets) {
  const providers = new Map();
  for (const target of targets) {
    if (!providers.has(target.provider)) providers.set(target.provider, { id: target.provider, models: [], keys: new Map() });
    const provider = providers.get(target.provider);
    if (!provider.models.includes(target.model)) provider.models.push(target.model);
    if (!provider.keys.has(target.keyIndex)) provider.keys.set(target.keyIndex, new Map());
    provider.keys.get(target.keyIndex).set(target.model, target);
  }
  return [...providers.values()];
}

/**
 * The normal fallback order. `requestedModel`, when a provider has it
 * configured, leads that provider's per-key chain and the remaining models
 * follow in configured order. Providers that serve the requested model are
 * tried before providers that do not.
 */
export function buildHierarchicalOrder(targets, requestedModel = "") {
  const wanted = typeof requestedModel === "string" ? requestedModel : "";
  const providers = groupByProvider(Array.isArray(targets) ? targets : []);
  const serves = (provider) => Boolean(wanted) && provider.models.includes(wanted);
  const ordered = [...providers.filter(serves), ...providers.filter((p) => !serves(p))];

  const order = [];
  for (const provider of ordered) {
    const models = serves(provider)
      ? [wanted, ...provider.models.filter((model) => model !== wanted)]
      : provider.models;
    for (const keyIndex of [...provider.keys.keys()].sort((a, b) => a - b)) {
      const byModel = provider.keys.get(keyIndex);
      for (const model of models) {
        const target = byModel.get(model);
        if (target) order.push(target);
      }
    }
  }
  return order;
}

/**
 * Resolves priority entries to concrete targets: provider + model + pool, with
 * every configured key of that provider (in key order) so key handling and
 * health stay per key. Entries that match nothing eligible are simply absent.
 */
export function resolvePriorityTargets(targets, priority = []) {
  const all = Array.isArray(targets) ? targets : [];
  const resolved = [];
  const seen = new Set();
  for (const entry of Array.isArray(priority) ? priority : []) {
    const matches = all
      .filter((target) => target.provider === entry.provider && target.model === entry.model)
      .sort((a, b) => a.keyIndex - b.keyIndex);
    for (const target of matches) {
      const id = targetId(target);
      if (seen.has(id)) continue;
      seen.add(id);
      resolved.push(target);
    }
  }
  return resolved;
}

/**
 * @param targets         protocol-reachable targets of the request's own pool
 * @param requestedModel  the client's model ("" when none)
 * @param priority        parsed priority entries (may be empty => no phase)
 * @param stickyTargetId  the session's last good target, if any
 * @returns {{ steps: Array<{target, phase}>, priorityCount: number }}
 */
export function buildRoutePlan({ targets = [], requestedModel = "", priority = [], stickyTargetId = null } = {}) {
  const priorityTargets = resolvePriorityTargets(targets, priority);
  const normal = buildHierarchicalOrder(targets, requestedModel);

  // Precedence: pin (handled by the caller) > priority > sticky > hierarchy.
  // The sticky target is promoted to the head of the normal phase, but only
  // when it belongs to the first provider tier, so an available exact model
  // still outranks a sticky different-model fallback.
  if (stickyTargetId && normal.length > 0) {
    const index = normal.findIndex((target) => targetId(target) === stickyTargetId);
    const firstProvider = normal[0].provider;
    if (index > 0 && normal[index].provider === firstProvider) {
      const [sticky] = normal.splice(index, 1);
      normal.unshift(sticky);
    }
  }

  const steps = [
    ...priorityTargets.map((target) => ({ target, phase: PHASES.PRIORITY })),
    ...normal.map((target) => ({ target, phase: PHASES.FALLBACK }))
  ];
  return { steps, priorityCount: priorityTargets.length };
}
