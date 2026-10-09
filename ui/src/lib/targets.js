/**
 * Shared view model for the two target-shaped endpoints.
 *
 * `/api/models` and `/api/health` both return one row per routing *target* —
 * provider + model + key index. `/api/models` is the richer projection (it adds
 * per-target usage joined from the request log); `/api/health` is the health
 * projection.
 *
 * They are normalized by the same function on purpose. The Providers page once
 * regressed by reading a health rollup as if it were provider configuration;
 * the defence is that each payload is narrowed here, once, to the shape the
 * page actually renders — rather than each page reaching into a raw response.
 *
 * Everything below is defensive. A missing `summary`, a null `protocols`, or a
 * row that is not an object at all must narrow to a safe default rather than
 * become a property access on `undefined`.
 */

import { matchesSearch } from "./table.js";

export const HEALTH_STATUSES = Object.freeze(["healthy", "cooldown", "failed", "unknown"]);

/**
 * The two routing pools. A target belongs to exactly one, and the pools are
 * routed independently — an image request can never fall back into the text
 * pool. The UI labels the pool wherever a target or a routing decision is shown.
 */
export const POOLS = Object.freeze(["text", "vision"]);


const isPlainObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);

/** Numbers that are genuinely absent become null, so the UI can render "n/a". */
const num = (value) => (Number.isFinite(value) ? value : null);

/** Counters that are genuinely absent become 0 — "none observed" is the truth. */
const count = (value) => (Number.isFinite(value) ? value : 0);

const strings = (value) =>
  Array.isArray(value) ? value.filter((item) => typeof item === "string" && item) : [];

const pick = (value, fallback) => (Number.isFinite(value) ? value : fallback);

/**
 * A target is routable when it is not cooling down.
 *
 * `cooldownUntil` is absolute and therefore authoritative: a row rendered from
 * a payload fetched a minute ago still evaluates correctly. `status` is the
 * fallback for a row carrying no timestamp — the backend derives
 * `status: "cooldown"` from exactly this comparison, so the two agree.
 */
export function isRoutable(target, now = Date.now()) {
  const until = Number(target?.cooldownUntil);
  if (Number.isFinite(until) && until > 0) return until <= now;
  return target?.status !== "cooldown";
}

/** Narrow one raw row to the shape both pages render. Never throws. */
export function normalizeTarget(row, index = 0) {
  const provider = typeof row?.provider === "string" ? row.provider : "";
  const model = typeof row?.model === "string" ? row.model : "";
  const keyIndex = Number.isFinite(row?.keyIndex) ? row.keyIndex : null;

  return {
    id: typeof row?.id === "string" && row.id
      ? row.id
      : `${provider}:${model}:key-${keyIndex ?? index}`,
    provider,
    model,
    keyIndex: keyIndex ?? index,
    // Defaults to "text": an older gateway that omits the field only ever had
    // the text pool, so anything else would mislabel its rows.
    pool: POOLS.includes(row?.pool) ? row.pool : "text",
    protocols: strings(row?.protocols),
    status: HEALTH_STATUSES.includes(row?.status) ? row.status : "unknown",
    score: num(row?.score),
    latencyMs: num(row?.latencyMs),
    successes: count(row?.successes),
    failures: count(row?.failures),
    consecutiveFailures: count(row?.consecutiveFailures),
    lastStatus: num(row?.lastStatus),
    lastReason: typeof row?.lastReason === "string" && row.lastReason ? row.lastReason : null,
    // Whether the provider's model catalogue listed this target's model.
    // Tri-state on purpose: `true` listed, `false` absent from a catalogue read
    // to the end, `null` the catalogue could not be inspected. Only `false` is
    // evidence, and only `false` is ever rendered as a warning.
    //
    // `modelListed` is the LATEST observation; `modelListedConfirmed` is the
    // last definite one, kept separately so an indeterminate probe cannot leave
    // an older `false` on screen looking freshly confirmed.
    modelListed: typeof row?.modelListed === "boolean" ? row.modelListed : null,
    modelListedAt: typeof row?.modelListedAt === "string" ? row.modelListedAt : null,
    modelListedConfirmed: typeof row?.modelListedConfirmed === "boolean" ? row.modelListedConfirmed : null,
    modelListedConfirmedAt: typeof row?.modelListedConfirmedAt === "string" ? row.modelListedConfirmedAt : null,
    cooldownUntil: count(row?.cooldownUntil),
    updatedAt: typeof row?.updatedAt === "string" ? row.updatedAt : null,
    // /api/models only. Null rather than 0 on the health projection, so the
    // panel says "not reported" instead of implying a measured zero.
    successRate: num(row?.successRate),
    requests: num(row?.requests),
    requestFailures: num(row?.requestFailures)
  };
}

/** Recount from the rows themselves — the fallback when `summary` is absent. */
function deriveSummary(rows) {
  const summary = { total: rows.length, healthy: 0, cooldown: 0, failed: 0, unknown: 0, available: 0, averageLatencyMs: null };
  const latencies = [];

  for (const row of rows) {
    if (row.status === "healthy") summary.healthy += 1;
    else if (row.status === "cooldown") summary.cooldown += 1;
    else if (row.status === "failed") summary.failed += 1;
    else summary.unknown += 1;

    if (Number.isFinite(row.latencyMs)) latencies.push(row.latencyMs);
    if (isRoutable(row)) summary.available += 1;
  }

  if (latencies.length > 0) {
    summary.averageLatencyMs = Math.round(
      latencies.reduce((total, value) => total + value, 0) / latencies.length
    );
  }

  return summary;
}

/**
 * The card figures.
 *
 * The backend's own `summary` wins when present: it is computed over the same
 * rows in the same response, so it cannot disagree with the table, and it
 * counts `available` with the router's own predicate. The client-side recount
 * only covers a response that arrived without one.
 */
export function summarizeTargets(rows = [], payloadSummary = null, extra = {}) {
  const summary = isPlainObject(payloadSummary) ? payloadSummary : {};
  const derived = deriveSummary(rows);

  return {
    total: pick(summary.total, derived.total),
    healthy: pick(summary.healthy, derived.healthy),
    cooldown: pick(summary.cooldown, derived.cooldown),
    failed: pick(summary.failed, derived.failed),
    unknown: pick(summary.unknown, derived.unknown),
    available: pick(summary.available, derived.available),
    averageLatencyMs: pick(summary.averageLatencyMs, derived.averageLatencyMs),
    ...extra
  };
}

/** Only the fields an operator would think to type. Never the key value. */
const SEARCH_FIELDS = [
  (row) => row.model,
  (row) => row.provider,
  (row) => row.lastReason ?? ""
];

export function filterTargets(rows = [], { provider = null, protocol = null, status = null, pool = null, search = "" } = {}) {
  return rows.filter((row) => {
    if (provider && row.provider !== provider) return false;
    if (protocol && !row.protocols.includes(protocol)) return false;
    if (status && row.status !== status) return false;
    if (pool && row.pool !== pool) return false;
    return matchesSearch(row, search, SEARCH_FIELDS);
  });
}

/** Sorted, de-duplicated provider ids. Tolerates a non-array, or a null row. */
export const providerOptions = (rows = []) =>
  [...new Set((Array.isArray(rows) ? rows : []).map((row) => row?.provider).filter(Boolean))].sort();

/**
 * The row a drawer should render, or null when there is nothing to show.
 *
 * Returns null rather than throwing for an id that is not in `rows`, which is
 * the normal case rather than an error: a poll can land between opening a
 * drawer and closing it, and the target that was selected may no longer be in
 * the response. The drawer closes instead of rendering a half-populated panel.
 */
export function findTarget(rows = [], id) {
  if (!id) return null;
  return rows.find((row) => row.id === id) ?? null;
}

/**
 * Option lists for a page's filter controls.
 *
 * The endpoint advertises its own vocabulary, and that is preferred when
 * present. When the block is missing — an older gateway, or a truncated
 * response — the choices are recounted from the rows, so the controls keep
 * offering every value that is actually in the table instead of collapsing to
 * an empty select the operator cannot recover from.
 */
export function filterChoices({ filters = null, rows = [] } = {}) {
  // A default parameter only covers `undefined`, but a JSON payload can carry an
  // explicit `null` — which is precisely the value that would reach `.map`.
  const list = Array.isArray(rows) ? rows : [];
  const providers = strings(filters?.providers);
  const protocols = strings(filters?.protocols);
  const statuses = strings(filters?.statuses);
  const pools = strings(filters?.pools);

  return {
    providers: providers.length > 0 ? providers : providerOptions(list),
    protocols: protocols.length > 0
      ? protocols
      : [...new Set(list.flatMap((row) => (Array.isArray(row?.protocols) ? row.protocols : [])))].sort(),
    // The two pools are a fixed contract, so an absent list falls back to both
    // rather than to whatever the rows happen to contain — filtering to an
    // empty pool is legitimate and must stay selectable.
    pools: pools.length > 0 ? pools : [...POOLS],
    // The four states are the gateway's own contract, so an absent list falls
    // back to the full set rather than to whatever the rows happen to contain:
    // filtering *to* a state that is currently empty is a legitimate thing to
    // want, and it must still be selectable to show the empty result.
    statuses: statuses.length > 0 ? statuses : [...HEALTH_STATUSES]
  };
}

/**
 * `GET /api/models` → rows + the filter vocabulary the endpoint advertises.
 *
 * `providers` is taken from the backend's own filter list when it sent one, and
 * recounted from the rows otherwise.
 */
export function normalizeModelPayload(payload) {
  const rows = (Array.isArray(payload?.models) ? payload.models : []).map(normalizeTarget);
  const filters = {
    providers: strings(payload?.filters?.providers),
    protocols: strings(payload?.filters?.protocols),
    statuses: strings(payload?.filters?.statuses),
    pools: strings(payload?.filters?.pools)
  };

  const providers = filters.providers.length > 0
    ? filters.providers.length
    : providerOptions(rows).length;

  return {
    rows,
    filters,
    summary: summarizeTargets(rows, payload?.summary, { providers })
  };
}

/** `GET /api/health` → rows + summary + per-provider rollups + monitor state. */
export function normalizeHealthPayload(payload) {
  const rows = (Array.isArray(payload?.targets) ? payload.targets : []).map(normalizeTarget);

  return {
    rows,
    summary: summarizeTargets(rows, payload?.summary),
    providers: Array.isArray(payload?.providers) ? payload.providers.filter(isPlainObject) : [],
    monitor: isPlainObject(payload?.monitor) ? payload.monitor : null
  };
}
