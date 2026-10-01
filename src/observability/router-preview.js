import { selectTargetsForProtocol, fallbackGroups, planFallbackGroups } from "./route-select.js";

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

function describeCandidate(target, health, { rank = null, available, status }) {
  const state = health.get(health.key(target));

  return {
    id: health.key(target),
    provider: target.provider,
    model: target.model,
    keyIndex: target.keyIndex,
    protocols: [...(target.protocols ?? [])],
    rank,
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

export function describeRouting({ targets = [], config, health, protocol, model = "", stickyTargetId = null, now = Date.now() } = {}) {
  const selection = selectTargetsForProtocol(targets, protocol, model);
  const { compatible, exact, selected, modelMatched } = selection;
  const bridged = BRIDGED_PROTOCOLS.has(protocol);

  // The same grouping and the same ranking the proxy applies, so the order
  // shown here is the order the request will actually be attempted in.
  const groups = fallbackGroups(selection);
  const ranked = groups.flatMap((group) => health.rank(group, now));
  const rankedIds = new Set(ranked.map((target) => health.key(target)));

  const order = planFallbackGroups(groups, health, stickyTargetId, now);

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
      protocols: [...(target.protocols ?? [])],
      reason: `does not support protocol "${protocol}"`
    }));

  const unavailable = candidates.filter((candidate) => !candidate.available);
  const primary = order[0] ?? null;

  const stages = [
    {
      key: "received",
      label: "Incoming request",
      detail: `${protocol} request`,
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
      label: "Ranking",
      detail: groups.length > 1
        ? `exact-match group tried first (${groups[0].length} target(s)), then ${groups[1].length} fallback target(s); health score orders each group`
        : exact.length > 0
          ? "ordered by health score; every reachable target matches the requested model"
          : "ordered by health score; ties keep the caller's order",
      count: ranked.length,
      state: "info"
    },
    {
      key: "sticky",
      label: "Session preference",
      detail: stickyTargetId
        ? order[0] && health.key(order[0]) === stickyTargetId
          ? "session's sticky target is available and tried first"
          : "session's sticky target is unavailable — falling back to ranking"
        : "no session preference — highest ranked target wins",
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
    requestedModel: selection.requestedModel,
    modelMatched,
    targetIdentity: "provider + model + keyIndex",
    retryableStatus: config ? [...config.retryableStatus].sort((a, b) => a - b) : [],
    stages,
    candidates,
    unavailable,
    excluded,
    selected: order[0]
      ? describeCandidate(order[0], health, {
          rank: 1,
          available: true,
          // The selected target's *own* status, not the first candidate's.
          status: statusOf(order[0])
        })
      : null,
    fallbackOrder: order.map((target, index) =>
      describeCandidate(target, health, {
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
