import { targetId } from "./health.js";
import { FALLBACK_MODES, activeEntries, allEntries, allowedKeyIndexes, entryId } from "./fallback-chain.js";

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
 * Manual Model Selection (mode `manual`) is the one mode whose plan alternates
 * between two batches inside a single request:
 *
 *   MANUAL        the operator's selected entries, in exactly the saved order
 *   HEALTH        every reachable model that is NOT one of those entries, by health
 *   MANUAL_RETRY  the selected batch again, for targets a retry is permitted for
 *   HEALTH_RETRY  the health batch again, for targets a retry is permitted for
 *
 * i.e. MANUAL -> HEALTH -> MANUAL -> HEALTH -> ... The repetition is not a cycle
 * counter: every round after the first holds only `retry` steps, and the walker
 * (`withFallback`) authorises a retry per TARGET, never per round. A round that
 * has nothing a retry is permitted for simply walks nothing.
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
  AUTO: "auto",
  MANUAL: "manual-selection",
  HEALTH: "health-fallback",
  MANUAL_RETRY: "manual-retry",
  HEALTH_RETRY: "health-retry"
});

/**
 * How many times ONE target may be retried inside one request, after its first
 * attempt, by the Manual <-> Health alternation. This is the existing retry
 * policy (a target is retried at most once, and only after a transient failure
 * this request itself caused) given a name; it is a per-target bound, not a
 * limit on rounds or total attempts. The planner emits one retry round per unit
 * of it and the walker enforces it target by target, so the two cannot disagree.
 */
export const TARGET_RETRY_ALLOWANCE = 1;

export const PLAN_SOURCE = Object.freeze({
  CHAIN: "chain",
  AUTO: "auto",
  MANUAL: "manual"
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
 * The configured order. Every enabled entry that has a target in this pool, in
 * the order the operator saved, each expanded to its eligible keys — or to
 * every configured key when the entry names no subset.
 *
 * Two ways an entry can contribute nothing to the ORDER, and they must not be
 * confused:
 *
 *   - The model is not reachable for this request at all (not in this pool, not
 *     speaking this protocol, or its provider no longer configured). It adds no
 *     group, because there is nothing to walk. The chain still COUNTS as
 *     configured, though — see `savedEntries` below: an entry the router cannot
 *     honour is a reason to fail closed, not a reason to route somewhere else.
 *   - The model is reachable but the entry's key subset matches none of the keys
 *     the provider currently has (an old key index, or one narrowed away). That
 *     is kept as a group with NO targets, so it keeps its position and the model
 *     is simply not routable.
 *
 * Either way, dropping an entry must never leave the pool looking unconfigured:
 * an empty chain means the automatic order over EVERY target, which would
 * quietly route to models the operator did not name and keys they excluded.
 */
export function chainGroups(chain, targets) {
  const grouped = groupTargets(targets);
  const groups = [];

  for (const entry of activeEntries(chain)) {
    const id = entryId(entry);
    const group = grouped.get(id);
    if (!group) continue;
    const keys = allowedKeyIndexes(entry, group.targets.map((target) => target.keyIndex));
    const narrowed = group.targets.filter((target) => keys.includes(target.keyIndex));
    groups.push({ ...group, targets: narrowed, entryOrder: groups.length });
  }

  return { groups };
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
 * A stable fingerprint of the exact set being ordered: which groups, in which
 * order, each still holding which keys.
 *
 * This is what makes the cache safe to key on time and health alone. Those two
 * say nothing about the configuration, so without this a chain edited within
 * the same 30-second bucket — a model added, an entry disabled, a key subset
 * narrowed — would keep being served the order computed before the edit.
 * Including the shape of the input makes the key change the moment the
 * configuration does, and leaves it identical when nothing has changed, so an
 * unchanged configuration still reuses its cached order.
 */
function groupFingerprint(groups) {
  return groups.map((group) => `${group.id}[${group.targets.map((target) => target.keyIndex).join(",")}]`).join("|");
}

/**
 * Ordered group ids for the automatic order, cached against the configuration
 * being ordered, the health registry's version, and a coarse time bucket.
 *
 * The bucket is what lets a target that has finished cooling down rejoin the
 * order without a full recomputation on every request; the version is what
 * makes a real health change take effect immediately; the fingerprint is what
 * makes a CONFIGURATION change take effect immediately. Ids — not target
 * objects — are cached, so a caller whose target list narrowed (a pin, a
 * protocol filter) simply ignores ids it no longer has.
 */
const AUTO_CACHE = new Map();
export const AUTO_ORDER_BUCKET_MS = 30_000;

export function resetAutomaticOrderCache() {
  AUTO_CACHE.clear();
}

export function automaticGroupIds({ cacheKey, groups, health, now, bucketMs = AUTO_ORDER_BUCKET_MS }) {
  const version = Number(health?.version) || 0;
  const bucket = Math.floor(now / bucketMs);
  const key = `${cacheKey}|${version}|${bucket}|${groupFingerprint(groups)}`;
  const cached = AUTO_CACHE.get(key);
  if (cached) return cached;

  const ids = orderGroupsByHealth(groups, health, now).map((group) => group.id);
  // One entry per key would grow without bound on a long-running gateway; the
  // cache only ever needs the current bucket and a handful of recent versions.
  if (AUTO_CACHE.size > 64) AUTO_CACHE.clear();
  AUTO_CACHE.set(key, ids);
  return ids;
}

function toSteps(groups, phase, extra = {}) {
  // A target appears once per phase: two list entries naming the same
  // provider/model/key must not become two calls.
  const seen = new Set();
  const steps = [];
  for (const group of groups) {
    for (const target of group.targets) {
      const id = targetId(target);
      if (seen.has(id)) continue;
      seen.add(id);
      steps.push({ target, phase, group: group.id, ...extra });
    }
  }
  return steps;
}

/**
 * Manual Model Selection: Manual and Health alternate within one plan.
 *
 *   MANUAL        the saved entries, in the exact order saved. Interleaved
 *                 providers stay interleaved (gemini A, groq B, gemini C ...):
 *                 nothing here groups or sorts by provider, because groups
 *                 are keyed by provider/model and walked in `configured` order.
 *   HEALTH        every reachable target whose provider/model is not one of
 *                 the saved entries, ordered by the existing health + latency
 *                 ordering. "Saved" includes parked (disabled) entries — an
 *                 operator who parked a model did not ask for it as a fallback
 *                 — and entries whose key subset narrowed to nothing, so a
 *                 restriction can never leak a model's other keys into this
 *                 phase. Exclusion is by MODEL, never by provider: an unselected
 *                 model of a provider that appears in the selection stays here.
 *   then MANUAL_RETRY, HEALTH_RETRY, MANUAL_RETRY, ... — the same two batches in
 *                 the same order, every step flagged `retry` and numbered by
 *                 `round`, so the walker can authorise (or refuse) each one
 *                 against that target's own state instead of replaying anything.
 *
 * Both batches are computed ONCE, here, so the health order is stable for the
 * whole request; a later health refresh can only change the next request's plan.
 *
 * Fail closed: when the selection itself has nothing walkable for this request,
 * the plan is empty. The health batch exists to catch FAILURES of the operator's
 * order, not to substitute for an order that cannot be honoured at all.
 */
function buildManualPlan({ grouped, configured, savedEntries, cacheKey, health, now }) {
  const selected = new Set(savedEntries.map((entry) => entryId(entry)));
  const manualFirst = toSteps(configured, PHASES.MANUAL);
  const meta = {
    source: PLAN_SOURCE.MANUAL,
    mode: FALLBACK_MODES.MANUAL,
    configured: configured.length,
    entries: savedEntries.length,
    sticky: null,
    rememberedKey: null
  };

  if (manualFirst.length === 0) {
    return { steps: [], groups: configured, failClosed: true, ...meta };
  }

  const others = [...grouped.values()].filter((group) => !selected.has(group.id));
  const fallbackGroups = automaticGroupsOrder(others, { cacheKey: `${cacheKey}|manual-fallback`, health, now });
  const healthFirst = toSteps(fallbackGroups, PHASES.HEALTH);

  const steps = [...manualFirst, ...healthFirst];
  for (let round = 1; round <= TARGET_RETRY_ALLOWANCE; round += 1) {
    steps.push(
      ...toSteps(configured, PHASES.MANUAL_RETRY, { retry: true, round }),
      ...toSteps(fallbackGroups, PHASES.HEALTH_RETRY, { retry: true, round })
    );
  }

  return {
    steps,
    groups: [...configured, ...fallbackGroups],
    failClosed: false,
    ...meta
  };
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
  /**
   * "A chain is configured" and "a chain is usable" are different questions,
   * and the difference is the whole of fail-closed routing.
   *
   * No saved entries at all means the operator has not configured this pool, so
   * the automatic order applies — that is the documented behaviour of an
   * unconfigured router. Entries that ARE saved but yield nothing walkable mean
   * the operator has stated an order the router cannot honour; widening to
   * other models, or to keys an entry excludes, would be a silent fallback to
   * exactly what the chain exists to rule out. That case walks nothing.
   */
  const savedEntries = allEntries(chain);
  const useChain = !pinned && savedEntries.length > 0;

  // Manual Model Selection has its own alternating plan; every other mode, and
  // every pinned request, takes the paths below untouched.
  if (useChain && mode === FALLBACK_MODES.MANUAL) {
    return buildManualPlan({ grouped, configured, savedEntries, cacheKey, health, now });
  }

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

  // Fixed Order remembers a success too, but only to choose WHICH KEY of that
  // model is tried first. The model keeps the position the operator gave it, so
  // the remembered target can never move ahead of an earlier configured model.
  let rememberedKey = null;
  if (!pinned && useChain && source === PLAN_SOURCE.CHAIN && mode === FALLBACK_MODES.FIXED) {
    const placed = placeRememberedKey(ordered, stickyTargetId);
    if (placed) {
      ordered = placed.groups;
      rememberedKey = placed.target;
    }
  }

  const phase = source === PLAN_SOURCE.AUTO ? PHASES.AUTO : PHASES.CHAIN;
  const base = toSteps(ordered, phase);

  /**
   * A chain is saved for this pool but there is nothing walkable in it. The plan
   * is deliberately empty: the caller must report "your chain cannot serve this
   * request", never quietly reach for a target the chain does not cover.
   */
  const failClosed = useChain && base.length === 0;
  const meta = {
    source,
    mode,
    groups: ordered,
    configured: configured.length,
    entries: savedEntries.length,
    failClosed
  };

  const sticky = resolveSticky({ stickyTargetId, ordered, mode, pinned });
  if (!sticky) {
    return { steps: base, sticky: null, rememberedKey, ...meta };
  }

  // The remembered target leads, and the rest of its own model is exhausted
  // before the configured order resumes — otherwise a working second key of the
  // remembered model would be passed over in favour of another model entirely.
  //
  // Both halves come from the REMEMBERED GROUP AS THE ORDER HOLDS IT, never from
  // the raw target list: `ordered` is what the configuration narrowed each entry
  // to, so a key the operator has excluded is not in it to be remembered or to
  // be tried as a sibling. Reading the unrestricted group here would let an old
  // remembered target — and every key beside it — silently bypass a key
  // restriction the operator has since applied.
  const siblings = sticky.group.targets
    .filter((target) => targetId(target) !== targetId(sticky.target));

  return {
    steps: [
      { target: sticky.target, phase: PHASES.STICKY, group: sticky.group.id },
      ...siblings.map((target) => ({ target, phase: PHASES.STICKY, group: sticky.group.id })),
      ...base
    ],
    sticky: sticky.target,
    rememberedKey: null,
    ...meta
  };
}

/**
 * Fixed Order's use of a remembered success: the remembered key is tried first
 * WITHIN its own model, and the model's other keys follow in key order.
 *
 * Groups are never reordered — this returns the same groups in the same
 * positions, with only the remembered group's key order changed. The search runs
 * over the groups as the configuration narrowed them, so a key the operator has
 * since excluded (or a model they have since disabled) is simply not found and
 * the plan is the plain configured order.
 */
function placeRememberedKey(groups, stickyTargetId) {
  if (!stickyTargetId) return null;
  for (let index = 0; index < groups.length; index += 1) {
    const group = groups[index];
    const target = group.targets.find((item) => targetId(item) === stickyTargetId);
    if (!target) continue;
    if (group.targets[0] === target) return { groups, target };
    const rest = group.targets.filter((item) => item !== target);
    const next = groups.slice();
    next[index] = { ...group, targets: [target, ...rest] };
    return { groups: next, target };
  }
  return null;
}

function automaticGroupsOrder(groups, { cacheKey, health, now }) {
  const byId = new Map(groups.map((group) => [group.id, group]));
  const ids = automaticGroupIds({ cacheKey, groups, health, now });
  return ids.map((id) => byId.get(id)).filter(Boolean);
}

/**
 * The remembered target, when the selected mode remembers one and the ORDER
 * still contains it.
 *
 * The search runs over `ordered` — the groups as the configuration narrowed
 * them, entry by entry — and not over the raw target list. That is the whole
 * point: a remembered target whose key the current entry no longer allows is
 * simply not found, so it cannot lead the walk, and the group it is returned
 * with is already narrowed to the keys that are still permitted.
 *
 * `fixed` never resolves one: that is the whole point of the mode, and it is
 * also what makes "Reset Fallback" trivially correct there. A pinned request is
 * strict — it uses neither the chain nor the remembered target.
 */
function resolveSticky({ stickyTargetId, ordered, mode, pinned }) {
  if (pinned || !stickyTargetId) return null;
  if (!rememberedModes.has(mode)) return null;

  for (const group of ordered) {
    const target = group.targets.find((item) => targetId(item) === stickyTargetId);
    if (target) return { target, group };
  }
  return null;
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

/**
 * Per-pool routing status, for the health surface.
 *
 * `ranked` alone cannot say WHY a pool is empty: an unusable Fallback Chain and
 * a provider that is simply down both leave the ranked list without that pool's
 * targets. Monitoring needs to tell them apart — one is a configuration fault
 * that every request for that pool will fail on, the other is ordinary weather.
 *
 * Derived from the same `buildRoutePlan` the proxy calls, so this can never
 * describe a state the router would not actually be in.
 */
export function chainStatusByPool(targets, {
  chains = {},
  mode = FALLBACK_MODES.FIXED,
  health = null,
  now = Date.now()
} = {}) {
  const all = Array.isArray(targets) ? targets : [];
  const out = {};
  for (const pool of ["text", "vision"]) {
    const inPool = all.filter((target) => (target.pool ?? "text") === pool);
    const plan = buildRoutePlan({
      targets: inPool,
      chain: chains?.[pool] ?? [],
      mode,
      health,
      now,
      cacheKey: `status:${pool}`
    });
    out[pool] = {
      // Saved entries that permit nothing: requests for this pool fail rather
      // than route to a model outside the chain. This is the signal that
      // separates a configuration fault from a provider being down.
      failClosed: plan.failClosed,
      // Saved entries, and how many of them name a target this pool can reach.
      // Both are about the CHAIN, not about the pool: an unconfigured pool
      // reports 0/0 while still routing every target automatically.
      entries: plan.entries,
      resolved: plan.configured,
      source: plan.source
    };
  }
  return out;
}
