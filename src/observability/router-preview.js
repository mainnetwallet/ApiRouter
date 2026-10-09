import { selectTargetsForProtocol } from "./route-select.js";
import { buildRoutePlan, effectiveOrder } from "../fallback-plan.js";
import { FALLBACK_MODES, fallbackModeLabel } from "../fallback-chain.js";

/** Client protocols whose requests can be bridged to a non-native provider. */
const BRIDGED_PROTOCOLS = new Set(["anthropic", "openai-chat", "openai-responses", "gemini"]);

/**
 * A faithful, read-only rendering of the decision the router makes for a given
 * request shape.
 *
 * This deliberately contains no routing policy of its own. Target selection
 * comes from `selectTargetsForProtocol` and ranking from the caller's health
 * registry — the same code the live proxy path executes. The frontend is
 * therefore unable to show a route the router would not actually take.
 *
 * The one thing this cannot know is a session's sticky target, so the caller
 * may pass `stickyTargetId` to include that step. Without it the preview shows
 * the stateless decision, which is what a fresh client receives.
 */

function describeCandidate(target, health, { rank = null, available, status, phase = null }) {
  const state = health.get(health.key(target));

  return {
    id: health.key(target),
    provider: target.provider,
    model: target.model,
    keyIndex: target.keyIndex,
    // Every candidate belongs to exactly one pool. Carried explicitly so a
    // reader never has to infer it from the id prefix.
    pool: target.pool ?? "text",
    protocols: [...(target.protocols ?? [])],
    rank,
    phase,
    available,
    status,
    score: Number.isFinite(state?.score) ? state.score : null,
    latencyMs: Number.isFinite(state?.latencyMs) ? state.latencyMs : null,
    cooldownUntil: Number(state?.cooldownUntil) || 0,
    lastStatus: state?.lastStatus ?? null,
    lastReason: state?.lastReason ?? null,
    consecutiveFailures: Number(state?.consecutiveFailures) || 0
  };
}

export function describeRouting({
  targets = [],
  health,
  protocol,
  model = "",
  stickyTargetId = null,
  now = Date.now(),
  pool = "text",
  chain = [],
  mode = FALLBACK_MODES.FIXED,
  retryableStatus = [],
  maxCycles = undefined
} = {}) {
  const selection = selectTargetsForProtocol(targets, protocol, model);
  const { compatible, exact, selected, modelMatched } = selection;
  const bridged = BRIDGED_PROTOCOLS.has(protocol);
  const poolLabel = pool === "vision" ? "VISION" : "TEXT";

  // The same plan the proxy walks: the operator's Fallback Chain, or the
  // automatic health-based order when the chain is empty or the mode asks for
  // it, preceded by the remembered target in the modes that remember one.
  // Health decides eligibility here exactly as it does on the live path; it
  // never reorders a configured chain.
  const plan = buildRoutePlan({
    targets: selected,
    chain,
    mode,
    stickyTargetId,
    health,
    now,
    cacheKey: `preview:${pool}`,
    ...(maxCycles === undefined ? {} : { maxCycles })
  });
  const automatic = plan.source === "auto";
  const eligible = selected.filter((target) => health.isAvailable(target, now));
  const rankedIds = new Set(eligible.map((target) => health.key(target)));
  const ranked = eligible;

  // Exactly what the walker will attempt right now, and in which phase.
  const effective = effectiveOrder(plan.steps, (target) => rankedIds.has(health.key(target)));
  const order = effective.map((step) => step.target);
  const phaseById = new Map(effective.map((step) => [health.key(step.target), step.phase]));

  /**
   * The reporting status of a target. Derived the same way for every list on
   * this page, so a target cannot read as "healthy" in the candidate table and
   * "cooldown" in the selected panel.
   *
   * Availability comes from the registry's ranking; the underlying status is
   * reported by the registry at read time.
   */
  const statusOf = (target) => {
    if (!rankedIds.has(health.key(target))) return "cooldown";
    return health.get(health.key(target))?.status ?? "unknown";
  };

  const rankOf = (target) => {
    const index = order.findIndex((item) => health.key(item) === health.key(target));
    return index === -1 ? null : index + 1;
  };

  const candidates = selected.map((target) => describeCandidate(target, health, {
    phase: phaseById.get(health.key(target)) ?? null,
    rank: rankOf(target),
    available: rankedIds.has(health.key(target)),
    status: statusOf(target)
  }));

  // Candidates that were filtered out before the client protocol was even
  // considered — useful for explaining "why is this provider not in the list?".
  const excluded = targets
    .filter((target) => !compatible.some((item) => health.key(item) === health.key(target)))
    .map((target) => ({
      id: health.key(target),
      provider: target.provider,
      model: target.model,
      keyIndex: target.keyIndex,
      pool: target.pool ?? "text",
      protocols: [...(target.protocols ?? [])],
      reason: `does not support protocol "${protocol}"`
    }));

  const unavailable = candidates.filter((candidate) => !candidate.available);
  const primary = order[0] ?? null;

  const stages = [
    {
      key: "received",
      label: "Incoming request",
      // The pool is decided before anything else and never changes: an image
      // request is served by the vision pool or not at all.
      detail: `${protocol} request · ${poolLabel} pool`,
      state: "info"
    },
    {
      key: "protocol",
      label: "Protocol detection",
      detail: `resolved to "${protocol}"`,
      state: "info"
    },
    {
      key: "compatible",
      label: bridged ? "Reachable targets" : "Compatible targets",
      detail: bridged
        ? `${compatible.length} of ${targets.length} targets reachable (native or bridged)`
        : `${compatible.length} of ${targets.length} targets support this protocol`,
      count: compatible.length,
      state: compatible.length === 0 ? "error" : "ok"
    },
    {
      key: "model",
      label: "Model selection",
      detail: modelMatched
        ? `requested model "${model}" is configured`
        : model
          ? `model "${model}" is not configured — routing widened to all compatible targets`
          : "no model requested — all compatible targets eligible",
      count: selection.selected.length,
      state: "info"
    },
    {
      key: "health",
      label: "Health filtering",
      detail:
        unavailable.length === 0
          ? `${ranked.length} targets available`
          : `${unavailable.length} target(s) in cooldown, ${ranked.length} available`,
      count: ranked.length,
      state: ranked.length === 0 ? "error" : unavailable.length > 0 ? "warn" : "ok"
    },
    {
      key: "ranking",
      label: "Route order",
      detail: plan.failClosed
        // The chain exists and permits nothing. Say that, rather than describing
        // an automatic order the router will not actually use.
        ? `The saved Fallback Chain holds ${plan.entries} entr${plan.entries === 1 ? "y" : "ies"} but no target it names can serve this request, so nothing is walked. `
          + "The router will not substitute a model outside the chain — clear the chain to hand routing back to the automatic order"
        : plan.source === "manual"
        ? `Manual Model Selection: your ${plan.configured} selected model(s) in the saved order, then every model you did not select ordered by measured health and latency; that Manual -> Health cycle repeats up to ${plan.cycles} time(s) in all, and the first model that answers ends the request. Every eligible key of a model is tried before the next model`
        : automatic
        ? plan.configured > 0
          ? `Automatic Health-Based Fallback: the ${plan.configured} configured model(s) are ordered by measured health and latency (lower measured latency first; unmeasured models keep a stable configured order). Every eligible key of a model is tried before the next model`
          : "no fallback chain is configured, so the automatic health-based order applies: healthy models with lower measured latency first, unmeasured models in a stable configured order. Every eligible key of a model is tried before the next model"
        : `${plan.configured} configured model(s), in the saved Fallback Chain order; every eligible key of a model is tried before the next model. Health only skips cooling targets`,
      count: ranked.length,
      state: plan.failClosed ? "error" : "info"
    },
    {
      key: "remembered",
      label: "Remembered target",
      detail: mode === FALLBACK_MODES.MANUAL
        ? `Manual Model Selection: nothing is remembered; every request starts at the first selected model and its first eligible key (mode: ${fallbackModeLabel(mode)})`
        : mode === FALLBACK_MODES.FIXED
        ? `Fixed Order: every request starts at the first model of the chain and its first eligible key. Nothing is remembered (mode: ${fallbackModeLabel(mode)})`
        : plan.sticky
          ? `the target that last answered (20-minute TTL) is tried first, then the chain resumes in its saved order (mode: ${fallbackModeLabel(mode)})`
          : stickyTargetId
            ? "the given target is not part of this request's chain, pool or protocol, so it is ignored"
            : `nothing remembered for this session yet, so the chain starts at its first model (mode: ${fallbackModeLabel(mode)})`,
      state: "info"
    },
    {
      key: "selected",
      label: "Primary target",
      detail: primary ? `${primary.provider} / ${primary.model} / key ${primary.keyIndex}` : "no target available",
      state: primary ? "ok" : "error"
    },
    {
      key: "fallback",
      label: "Fallback sequence",
      detail: order.length > 1 ? `${order.length - 1} fallback target(s) queued` : "no fallback targets",
      count: Math.max(0, order.length - 1),
      state: order.length > 1 ? "warn" : "info"
    }
  ];

  return {
    protocol,
    pool,
    poolLabel,
    requestedModel: selection.requestedModel,
    modelMatched,
    targetIdentity: "provider + model + keyIndex",
    // The ordering actually in force, so the panel never has to guess between a
    // configured chain and the automatic health-based order.
    mode,
    modeLabel: fallbackModeLabel(mode),
    orderSource: plan.source,
    automatic,
    chain: (Array.isArray(chain) ? chain : []).map((entry) => ({
      provider: entry.provider,
      model: entry.model,
      enabled: entry.enabled !== false,
      keys: entry.keys ?? null
    })),
    chainTargets: plan.configured,
    // The chain is saved but permits nothing for this request: the panel shows
    // this state instead of describing an order that will not be walked.
    chainFailClosed: plan.failClosed,
    chainEntries: plan.entries,
    retryableStatus: Array.isArray(retryableStatus) ? [...retryableStatus].sort((a, b) => a - b) : [],
    stages,
    candidates,
    unavailable,
    excluded,
    selected: order[0]
      ? describeCandidate(order[0], health, {
          phase: phaseById.get(health.key(order[0])) ?? null,
          rank: 1,
          available: true,
          // The selected target's *own* status, not the first candidate's.
          status: statusOf(order[0])
        })
      : null,
    fallbackOrder: order.map((target, index) =>
      describeCandidate(target, health, {
        phase: phaseById.get(health.key(target)) ?? null,
        rank: index + 1,
        available: rankedIds.has(health.key(target)),
        status: statusOf(target)
      })
    ),
    counts: {
      totalTargets: targets.length,
      compatible: compatible.length,
      exactMatch: exact.length,
      available: ranked.length,
      unavailable: unavailable.length,
      excluded: excluded.length
    }
  };
}
