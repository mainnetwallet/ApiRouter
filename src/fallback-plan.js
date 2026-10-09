import { targetId } from "./health.js";
import { FALLBACK_MODES, activeEntries, allowedKeyIndexes, entryId } from "./fallback-chain.js";

/**
 * The one routing planner. Text and vision use this same code; they differ only
 * in the target list and the chain they are given, both of which are already
 * scoped to one pool by the caller.
 *
 *   STICKY  the remembered last-success target (only in the modes that remember)
 *   CHAIN   the operator's configured order, entry by entry, every eligible key
 *   AUTO    the same entries (or every configured target when the chain is
 *           empty) ordered by measured health and latency
 *
 * There is no priority phase and no separate normal-fallback phase any more:
 * the configured chain IS the order, and the automatic order is what takes over
 * when the operator has configured nothing. Nothing here re-ranks a configured
 * order — automatic sorting applies only when it was asked for.
 *
 * A step is `{ target, phase, group }`. `group` is the `provider/model` entry a
 * step belongs to, so the walker can tell "still exhausting this model's keys"
 * from "this model is done, move on" without re-deriving it.
 */

export const PHASES = Object.freeze({
  STICKY: "sticky",
  CHAIN: "chain",
  AUTO: "auto"
});

export const PLAN_SOURCE = Object.freeze({
  CHAIN: "chain",
  AUTO: "auto"
});

/** Modes in which a success is remembered and leads the next request. */
const rememberedModes = new Set([FALLBACK_MODES.LAST_SUCCESS, FALLBACK_MODES.AUTO]);

/** The model a target belongs to, as the chain names it. */
const groupKey = (target) => `${target.provider}/${target.model}`;

/**
 * Targets grouped by provider/model, keys in ascending key order. Insertion
 * order follows the target list, so "configuration order" is the deterministic
 * tiebreak everywhere below.
 */
export function groupTargets(targets) {
  const groups = new Map();
  for (const target of Array.isArray(targets) ? targets : []) {
    const id = groupKey(target);
    if (!groups.has(id)) groups.set(id, { id, provider: target.provider, model: target.model, targets: [] });
    groups.get(id).targets.push(target);
  }
  for (const group of groups.values()) {
    group.targets.sort((a, b) => a.keyIndex - b.keyIndex);
  }
  return groups;
}

/**
 * The configured order. Every enabled entry that has targets in this pool, in
 * the order the operator saved, each expanded to its eligible keys — or to
 * every configured key when the entry names no subset. An entry naming a model
 * this pool does not serve simply contributes nothing; it is never guessed at.
 */
export function chainGroups(chain, targets) {
  const grouped = groupTargets(targets);
  const used = new Set();
  const groups = [];

  for (const entry of activeEntries(chain)) {
    const id = entryId(entry);
    const group = grouped.get(id);
    if (!group) continue;
    const keys = allowedKeyIndexes(entry, group.targets.map((target) => target.keyIndex));
    const narrowed = group.targets.filter((target) => keys.includes(target.keyIndex));
    if (narrowed.length === 0) continue;
    used.add(id);
    groups.push({ ...group, targets: narrowed, entryOrder: groups.length });
  }

  return { groups, used };
}

/**
 * Measured latency for a target, preferring a real request measurement over a
 * probe measurement. Never invents a value: an unmeasured target is `null`, and
 * the ordering below has an explicit, deterministic place for those.
 */
export function targetLatency(target, health) {
  const state = health?.get?.(targetId(target));
  if (!state) return null;
  if (Number.isFinite(state.requestLatencyMs)) return state.requestLatencyMs;
  if (Number.isFinite(state.probeLatencyMs)) return state.probeLatencyMs;
  return null;
}

function groupStats(group, health, now) {
  let available = 0;
  let latency = null;
  let score = 0;
  for (const target of group.targets) {
    const state = health?.get?.(targetId(target));
    if (!(Number(state?.cooldownUntil) > now)) available += 1;
    const measured = targetLatency(target, health);
    if (measured !== null && (latency === null || measured < latency)) latency = measured;
    const targetScore = Number(state?.score);
    if (Number.isFinite(targetScore) && targetScore > score) score = targetScore;
  }
  return { available, latency, score };
}

/**
 * Orders groups by what is actually measured.
 *
 *   1. a group with an available key before one whose every key is cooling down
 *   2. lower measured latency first
 *   3. higher health score first
 *   4. the order the group appears in the target list (configuration order),
 *      which is what makes an unmeasured router fully deterministic
 *
 * A group with no measurement sorts after every measured one, so a fresh
 * install routes in a stable configured order until real numbers exist.
 */
export function orderGroupsByHealth(groups, health, now) {
  return [...groups]
    .map((group, index) => ({ group, index, ...groupStats(group, health, now) }))
    .sort((a, b) => {
      if ((b.available > 0) !== (a.available > 0)) return b.available > 0 ? 1 : -1;
      if ((a.latency === null) !== (b.latency === null)) return a.latency === null ? 1 : -1;
      if (a.latency !== null && b.latency !== null && a.latency !== b.latency) return a.latency - b.latency;
      if (a.score !== b.score) return b.score - a.score;
      return a.index - b.index;
    })
    .map((item) => item.group);
}

/**
 * Ordered group ids for the automatic order, cached against the health
 * registry's version and a coarse time bucket.
 *
 * The bucket is what lets a target that has finished cooling down rejoin the
 * order without a full recomputation on every request; the version is what
 * makes a real health change take effect immediately. Ids — not target objects —
 * are cached, so a caller whose target list narrowed (a pin, a protocol filter)
 * simply ignores ids it no longer has.
 */
const AUTO_CACHE = new Map();
export const AUTO_ORDER_BUCKET_MS = 30_000;

export function resetAutomaticOrderCache() {
  AUTO_CACHE.clear();
}

export function automaticGroupIds({ cacheKey, groups, health, now, bucketMs = AUTO_ORDER_BUCKET_MS }) {
  const version = Number(health?.version) || 0;
  const bucket = Math.floor(now / bucketMs);
  const key = `${cacheKey}|${version}|${bucket}`;
  const cached = AUTO_CACHE.get(key);
  if (cached) return cached;

  const ids = orderGroupsByHealth(groups, health, now).map((group) => group.id);
  // One entry per key would grow without bound on a long-running gateway; the
  // cache only ever needs the current bucket and a handful of recent versions.
  if (AUTO_CACHE.size > 64) AUTO_CACHE.clear();
  AUTO_CACHE.set(key, ids);
  return ids;
}

function toSteps(groups, phase) {
  return groups.flatMap((group) =>
    group.targets.map((target) => ({ target, phase, group: group.id })));
}

/**
 * Builds the order a request will walk.
 *
 * @param targets         protocol-reachable targets of the request's own pool
 * @param chain           this pool's configured entries
 * @param mode            fixed | last-success | auto
 * @param stickyTargetId  remembered target id, already TTL-checked by the caller
 * @param pinned          a pinned request bypasses the chain entirely
 */
export function buildRoutePlan({
  targets = [],
  chain = [],
  mode = FALLBACK_MODES.FIXED,
  stickyTargetId = null,
  health = null,
  now = Date.now(),
  pinned = false,
  cacheKey = "pool"
} = {}) {
  const all = Array.isArray(targets) ? targets : [];
  const grouped = groupTargets(all);
  const { groups: configured } = chainGroups(chain, all);
  // No usable entry: the chain is not a source of order, so the automatic
  // health-based order takes over — that is the documented behaviour of an
  // unconfigured router, whatever mode is selected.
  const useChain = !pinned && configured.length > 0;

  let ordered;
  let source;
  if (pinned) {
    // A pin means "this exact target": no chain, no automatic order, no sticky.
    ordered = [...grouped.values()];
    source = PLAN_SOURCE.CHAIN;
  } else if (!useChain) {
    ordered = automaticGroupsOrder([...grouped.values()], { cacheKey, health, now });
    source = PLAN_SOURCE.AUTO;
  } else if (mode === FALLBACK_MODES.AUTO) {
    ordered = automaticGroupsOrder(configured, { cacheKey, health, now });
    source = PLAN_SOURCE.AUTO;
  } else {
    ordered = configured;
    source = PLAN_SOURCE.CHAIN;
  }

  const phase = source === PLAN_SOURCE.AUTO ? PHASES.AUTO : PHASES.CHAIN;
  const base = toSteps(ordered, phase);

  const sticky = resolveSticky({ stickyTargetId, ordered, grouped, all, mode, pinned });
  if (!sticky) {
    return { steps: base, source, mode, sticky: null, groups: ordered, configured: configured.length };
  }

  // The remembered target leads, and the rest of its own model is exhausted
  // before the configured order resumes — otherwise a working second key of the
  // remembered model would be passed over in favour of another model entirely.
  const remembered = grouped.get(groupKey(sticky)) ?? null;
  const siblings = (remembered?.targets ?? [])
    .filter((target) => targetId(target) !== targetId(sticky))
    .sort((a, b) => a.keyIndex - b.keyIndex);

  return {
    steps: [
      { target: sticky, phase: PHASES.STICKY },
      ...siblings.map((target) => ({ target, phase: PHASES.STICKY, group: groupKey(target) })),
      ...base
    ],
    source,
    mode,
    sticky,
    groups: ordered,
    configured: configured.length
  };
}

function automaticGroupsOrder(groups, { cacheKey, health, now }) {
  const byId = new Map(groups.map((group) => [group.id, group]));
  const ids = automaticGroupIds({ cacheKey, groups, health, now });
  return ids.map((id) => byId.get(id)).filter(Boolean);
}

/**
 * The remembered target, when the selected mode remembers one and it is still
 * part of this request's pool, protocol and order.
 *
 * `fixed` never resolves one: that is the whole point of the mode, and it is
 * also what makes "Reset Fallback" trivially correct there.
 */
function resolveSticky({ stickyTargetId, ordered, grouped, all, mode, pinned }) {
  if (pinned || !stickyTargetId) return null;
  if (mode === FALLBACK_MODES.FIXED) return null;
  if (!rememberedModes.has(mode)) return null;

  const candidate = all.find((target) => targetId(target) === stickyTargetId) ?? null;
  if (!candidate) return null;
  // Only a target this request could actually reach: the chain may have been
  // edited since the success was remembered.
  const inOrder = ordered.some((group) => group.id === groupKey(candidate));
  if (!inOrder) return null;
  return grouped.get(groupKey(candidate)) ? candidate : null;
}

/**
 * The order a request would actually attempt right now, given which targets are
 * eligible. Pure; the walker applies the same rules dynamically.
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
 * router would walk it for a request that names no model and carries no
 * session. Used by the health endpoints so `ranked` is the real route order.
 */
export function routeOrderByPool(targets, {
  chains = {},
  mode = FALLBACK_MODES.FIXED,
  health = null,
  isEligible = () => true,
  now = Date.now()
} = {}) {
  const all = Array.isArray(targets) ? targets : [];
  const out = [];
  for (const pool of ["text", "vision"]) {
    const inPool = all.filter((target) => (target.pool ?? "text") === pool);
    const { steps } = buildRoutePlan({
      targets: inPool,
      chain: chains?.[pool] ?? [],
      mode,
      health,
      now,
      cacheKey: `pool:${pool}`
    });
    out.push(...effectiveOrder(steps, isEligible).map((step) => step.target));
  }
  return out;
}
