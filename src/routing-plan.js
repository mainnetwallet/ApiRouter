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
 *   MANUAL phase     operator-selected models (UI), exact saved order, optional; when
 *                    present it leads priority/fallback. Sticky still applies but only
 *                    inside the selection: the last good manual target (then the other
 *                    keys of its model) is tried first, then the saved order continues.
 *   PRIORITY phase   TEXT_/VISION_PRIORITY_MODELS entries, in exactly the configured order
 *   FALLBACK phase   Provider -> Key -> Models (config order) -> next Key
 *                    -> next Provider. Each key restarts at its own first model.
 *
 *   STICKY phase    the session's last good target, then the OTHER keys of that same
 *                   provider/model (key order), only while its TTL is valid.
 *                   When the sticky model is itself a priority entry, the priority
 *                   entries ranked ABOVE it are still tried first (A,B,C,D with
 *                   sticky B -> A, B, C, D), so a recovered higher-priority model
 *                   takes traffic back as soon as its cooldown ends; while it is
 *                   cooling down the walker simply skips it.
 *
 * The normal fallback list is fully deterministic. Health, latency and
 * previous successes never reorder it. Sticky is a separate leading phase and
 * never edits that list; health only decides, while walking, whether a target
 * is eligible right now.
 *
 * A priority entry (provider/model) is one GROUP: every key that serves it, in
 * key order, is a priority step. The walker exhausts a group (each eligible
 * key, until one succeeds) before it advances to the next configured entry.
 * Priority steps keep their `group` so the entry boundary stays visible.
 *
 * Targets already attempted in the priority phase are NOT removed from the
 * fallback phase here; the walker skips them with an `already_attempted`
 * record, which keeps the skip visible in the request timeline.
 */

export const PHASES = Object.freeze({ MANUAL: "manual", STICKY: "sticky", PRIORITY: "priority", FALLBACK: "fallback" });

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
 * Priority list for one pool: TEXT_PRIORITY_MODELS for the text pool,
 * VISION_PRIORITY_MODELS for the vision pool. An empty/unset
 * VISION_PRIORITY_MODELS inherits TEXT_PRIORITY_MODELS, so both pools use the
 * same priority models in the same order unless vision is configured on its
 * own. An entry only ever matches targets of the pool being routed, so it can
 * never pull a request across pools (a text-only entry matches nothing in the
 * vision pool and is simply absent there).
 */
export function readPriority(env, pool = "text") {
  const text = parsePriorityModels(env.TEXT_PRIORITY_MODELS);
  if (pool !== "vision") return text;
  const vision = parsePriorityModels(env.VISION_PRIORITY_MODELS);
  return vision.length > 0 ? vision : text;
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
 * Resolves priority entries to candidate targets: provider + model (+ the
 * request's pool, because `targets` only ever holds that pool). Each entry
 * yields its keys in key order as ONE group; the walker attempts every
 * eligible key of a group before advancing to the next configured entry.
 * Entries matching nothing are simply absent.
 */
export function resolvePriorityTargets(targets, priority = []) {
  const all = Array.isArray(targets) ? targets : [];
  const resolved = [];
  const seen = new Set();
  for (const entry of Array.isArray(priority) ? priority : []) {
    const group = `${entry.provider}/${entry.model}`;
    const matches = all
      .filter((target) => target.provider === entry.provider && target.model === entry.model)
      .sort((a, b) => a.keyIndex - b.keyIndex);
    for (const target of matches) {
      const id = targetId(target);
      if (seen.has(id)) continue;
      seen.add(id);
      resolved.push({ target, group });
    }
  }
  return resolved;
}

/**
 * @param targets         protocol-reachable targets of the request's own pool
 * @param requestedModel  the client's model ("" when none)
 * @param priority        parsed priority entries (may be empty => no phase)
 * @param stickyTargetId  the session's sticky target id, ALREADY checked against
 *                        its TTL by the caller (RouteSession.validTargetId)
 * @returns {{ steps: Array<{target, phase, group?}>, priorityCount: number, sticky: object|null }}
 *
 * Sticky is its own first phase. It is honoured only when it is a target of
 * this request's pool/protocol (so another pool's or a stale id is ignored)
 * and does not override an explicit model choice: when the client names a
 * configured model, only a sticky target serving that model qualifies.
 * Its later appearance in the priority/normal phases is skipped by the walker
 * as already attempted; the normal list itself is never reordered.
 */
export function buildRoutePlan({ targets = [], requestedModel = "", priority = [], manual = [], stickyTargetId = null } = {}) {
  const all = Array.isArray(targets) ? targets : [];
  const named = typeof requestedModel === "string" ? requestedModel : "";
  // An explicit model the pool actually serves is the client's choice: neither
  // sticky nor priority may put a target of a DIFFERENT model ahead of it.
  // (A model nobody here serves is auto-routed and keeps the full plan.)
  const modelConfigured = Boolean(named) && all.some((target) => target.model === named);
  const priorityEntries = resolvePriorityTargets(all, priority)
    .filter(({ target }) => !modelConfigured || target.model === named);
  const normal = buildHierarchicalOrder(all, requestedModel);

  // Manual selection: each entry is one provider/model group, every eligible key
  // in key order, entries in saved order. It deliberately ignores the client's
  // requested model (the operator's explicit order wins) and leads priority and
  // fallback. Sticky only reorders WITHIN the selection (see below). Later
  // appearances of the same targets in priority/normal are skipped by the
  // walker as already attempted.
  const manualEntries = resolvePriorityTargets(all, manual);
  const manualActive = manualEntries.length > 0;

  // Sticky also works under manual selection, but only INSIDE the operator's
  // selection: the last good manual target (and the other keys of its model)
  // leads, then the saved order continues. A sticky target that is not one of
  // the selected models (e.g. recorded before manual mode was switched on) is
  // ignored, so the operator's explicit choice is never bypassed.
  let sticky = null;
  if (stickyTargetId) {
    const candidate = all.find((target) => targetId(target) === stickyTargetId) ?? null;
    if (candidate) {
      if (manualActive) {
        if (manualEntries.some(({ target }) => targetId(target) === targetId(candidate))) sticky = candidate;
      } else if (!modelConfigured || candidate.model === named) {
        sticky = candidate;
      }
    }
  }

  // The sticky model is exhausted before anything else is tried: after the
  // sticky key, the remaining keys of the SAME provider/model follow in key
  // order. Priority and normal fallback only start once the whole sticky model
  // has failed. Their later appearances are skipped by the walker as already
  // attempted; the priority and normal lists themselves are never reordered.
  const stickyGroup = sticky
    ? all
      .filter((target) => target.provider === sticky.provider && target.model === sticky.model && targetId(target) !== targetId(sticky))
      .sort((a, b) => a.keyIndex - b.keyIndex)
    : [];

  const stickyGroupId = sticky ? `${sticky.provider}/${sticky.model}` : null;
  const stickyIsPriority = !manualActive && Boolean(sticky) && priorityEntries.some(({ group }) => group === stickyGroupId);

  // Priority entries ranked ABOVE the sticky model are tried first. With
  // priority A -> B -> C -> D and sticky on B (because A failed earlier), A
  // leads the plan again: while A is cooling down the walker skips it for free,
  // and once the cooldown ends A is retried, so a recovered higher-priority
  // model takes traffic back. If it fails it cools down again and B (sticky)
  // answers. Entries below the sticky model (C, D) follow the sticky model's
  // own keys, then the normal fallback. A sticky target that is not a priority
  // model has no position in the list, so the full list still applies.
  // (The groups are contiguous and in configured order, so "above/below the
  // sticky group" is a straight split.)
  const groupOrder = [...new Set(priorityEntries.map(({ group }) => group))];
  const stickyIndex = stickyIsPriority ? groupOrder.indexOf(stickyGroupId) : -1;
  const higherPriority = stickyIsPriority
    ? priorityEntries.filter(({ group }) => groupOrder.indexOf(group) < stickyIndex)
    : [];
  const priorityPhase = stickyIsPriority
    ? priorityEntries.filter(({ group }) => groupOrder.indexOf(group) > stickyIndex)
    : priorityEntries;

  const steps = [
    ...higherPriority.map(({ target, group }) => ({ target, phase: PHASES.PRIORITY, group })),
    ...(sticky ? [{ target: sticky, phase: PHASES.STICKY }] : []),
    // Labelled for what they are in the timeline: the other keys of a configured
    // priority entry are priority attempts; for any other sticky model they are
    // still sticky-model attempts, so the "fallback" steps stay exactly the
    // untouched normal list.
    ...stickyGroup.map((target) => ({
      target,
      phase: stickyIsPriority ? PHASES.PRIORITY : PHASES.STICKY,
      group: `${sticky.provider}/${sticky.model}`
    })),
    ...manualEntries.map(({ target, group }) => ({ target, phase: PHASES.MANUAL, group })),
    ...priorityPhase.map(({ target, group }) => ({ target, phase: PHASES.PRIORITY, group })),
    ...normal.map((target) => ({ target, phase: PHASES.FALLBACK }))
  ];
  return {
    steps,
    priorityCount: new Set(priorityEntries.map((entry) => entry.group)).size,
    manualCount: new Set(manualEntries.map((entry) => entry.group)).size,
    sticky
  };
}

/**
 * The order a request would actually attempt right now, given which targets
 * are eligible. Pure; the walker applies the same rules dynamically.
 *   - sticky leads when present and eligible
 *   - every eligible key of a priority group is a priority attempt, in key order
 *   - an ineligible target is left out; a target is listed once
 */
export function effectiveOrder(steps, isEligible = () => true) {
  const order = [];
  const listed = new Set();
  for (const step of Array.isArray(steps) ? steps : []) {
    const id = targetId(step.target);
    if (listed.has(id) || !isEligible(step.target)) continue;
    listed.add(id);
    order.push(step);
  }
  return order;
}

/**
 * The deterministic order for a mixed target list, one pool at a time, as the
 * router would walk it for a request that names no model. Used by the health
 * endpoints so "ranked" is the real route order, not a health-score sort.
 */
export function routeOrderByPool(targets, priorityByPool = {}, isEligible = () => true, manualByPool = {}) {
  const all = Array.isArray(targets) ? targets : [];
  const out = [];
  for (const pool of ["text", "vision"]) {
    const inPool = all.filter((target) => (target.pool ?? "text") === pool);
    const { steps } = buildRoutePlan({ targets: inPool, priority: priorityByPool?.[pool] ?? [], manual: manualByPool?.[pool] ?? [] });
    out.push(...effectiveOrder(steps, isEligible).map((step) => step.target));
  }
  return out;
}
