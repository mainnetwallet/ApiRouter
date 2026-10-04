import { selectTargetsForProtocol } from "./route-select.js";
import { buildRoutePlan, effectiveOrder } from "../routing-plan.js";

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

export function describeRouting({ targets = [], config, health, protocol, model = "", stickyTargetId = null, now = Date.now(), pool = "text" } = {}) {
  const selection = selectTargetsForProtocol(targets, protocol, model);
  const { compatible, exact, selected, modelMatched } = selection;
  const bridged = BRIDGED_PROTOCOLS.has(protocol);
  const poolLabel = pool === "vision" ? "VISION" : "TEXT";

  // The same plan the proxy walks: priority targets first (env order), then
  // Provider -> Key -> Models. Health only decides eligibility here, exactly as
  // it does when the plan is walked; it never reorders the plan.
  const priority = config?.priority?.[pool] ?? [];
  const plan = buildRoutePlan({ targets: selected, requestedModel: model, priority, stickyTargetId });
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
      detail: plan.priorityCount > 0
        ? `${plan.priorityCount} priority target(s) first, in TEXT_/VISION_PRIORITY_MODELS order; then Provider -> Key -> Models in configured order (each key restarts at its first model). Health only skips cooling targets`
        : "no priority configured; Provider -> Key -> Models in configured order (each key restarts at its first model). Health only skips cooling targets",
      count: ranked.length,
      state: "info"
    },
    {
      key: "sticky",
      label: "Session preference",
      detail: plan.sticky
        ? "valid sticky target (15-minute TTL) is the first phase; priority and normal fallback follow unchanged"
        : stickyTargetId
          ? "the given sticky target does not apply to this request (other pool, not reachable, or a different explicit model)"
          : "no valid sticky target; routing starts at priority, then normal fallback",
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
    priority: priority.map((entry) => ({ provider: entry.provider, model: entry.model })),
    priorityTargets: plan.priorityCount,
    retryableStatus: config ? [...config.retryableStatus].sort((a, b) => a - b) : [],
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
