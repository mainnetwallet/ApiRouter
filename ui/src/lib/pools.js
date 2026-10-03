/**
 * View model for the Dashboard's TEXT / VISION pool separation.
 *
 * The router keeps two independent pools. A provider can appear in one, the
 * other, or both — and when it appears in both, the models, targets, keys,
 * health and latency behind each pool are *different configuration*. The whole
 * point of this module is to keep those two records apart: nothing here ever
 * adds a text figure to a vision figure.
 *
 * Pure functions only, so the behaviour the Dashboard depends on (counts,
 * filters, capability labels, the cross-pool warning) is unit-testable without
 * a DOM.
 */

import { matchesSearch } from "./table.js";
import { POOLS } from "./targets.js";

export const POOL_LABEL = Object.freeze({ text: "Text", vision: "Vision" });

/** Group headings for the matrix's two column blocks (spec §2). */
export const POOL_GROUP_LABEL = Object.freeze({
  text: "TEXT (Chat / Coding / Reasoning)",
  vision: "VISION (Image / Multimodal)"
});

export function poolLabel(pool) {
  return POOL_LABEL[pool] ?? POOL_LABEL.text;
}

/** CSS class for a pool badge. Pool is identity, not health, so it is not a
 *  StatusBadge tone — text reads cyan/blue, vision reads purple. */
export function poolBadgeClass(pool) {
  return pool === "vision" ? "pool-badge--vision" : "pool-badge--text";
}

/**
 * Row filters above the matrix (spec §6). Keys are stable; labels are shown.
 *
 * These are mutually exclusive capability *combinations* (text only / vision
 * only / both). The ALL / TEXT / VISION pool view below already answers "can
 * it serve this pool", so there is deliberately no "Vision Capable" or "No
 * Vision" here — they would just repeat the pool view.
 */
export const MATRIX_FILTERS = Object.freeze([
  { key: "all", label: "All" },
  { key: "textOnly", label: "Text Only" },
  { key: "visionOnly", label: "Vision Only" },
  { key: "both", label: "Both" }
]);

/** The ALL / TEXT / VISION view selector (spec §7). */
export const POOL_VIEWS = Object.freeze([
  { key: "all", label: "ALL" },
  { key: "text", label: "TEXT" },
  { key: "vision", label: "VISION" }
]);

const isPlainObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);

const strings = (value) =>
  Array.isArray(value) ? value.filter((item) => typeof item === "string" && item) : [];

/** A counter that is genuinely absent stays absent, so the UI can say "n/a". */
const num = (value) => (Number.isFinite(value) ? value : null);
const pickCount = (value, fallback) => (Number.isFinite(value) ? value : fallback);
const sumBy = (rows, accessor) =>
  rows.reduce((total, row) => total + (Number.isFinite(accessor(row)) ? accessor(row) : 0), 0);
const average = (values) =>
  values.length === 0 ? null : Math.round(values.reduce((total, value) => total + value, 0) / values.length);

/**
 * The configured model ids for one pool on one provider record.
 *
 * `/api/providers` rows carry both `textModels` and `visionModels` (the
 * capability descriptor is shared), so the pool decides which list is read.
 */
function modelList(record, pool) {
  const list = pool === "vision" ? record?.visionModels : record?.textModels;
  if (Array.isArray(list) && list.length > 0) return strings(list);
  // Fallback for a gateway that predates the split model lists: only the
  // record's own pool may claim its single `models` list.
  return record?.pool === pool ? strings(record?.models) : [];
}

/** Can this matrix row route in `pool`? Capability metadata wins when present. */
function capabilityOf(row, pool) {
  const caps = row?.text?.capabilities ?? row?.vision?.capabilities;
  if (caps && typeof caps[pool] === "boolean") return caps[pool];
  const record = pool === "vision" ? row?.vision : row?.text;
  return Boolean(record && record.configured !== false);
}

/**
 * Join the text and vision provider lists into one row per provider.
 *
 * Each row keeps `text` and `vision` as separate records — the same provider
 * appearing in both produces exactly one row with two independent sides, never
 * a merged total.
 */
export function buildProviderMatrix({ textProviders = [], visionProviders = [] } = {}) {
  const byId = new Map();
  const ensure = (id) => {
    if (!byId.has(id)) byId.set(id, { id, text: null, vision: null });
    return byId.get(id);
  };

  for (const record of Array.isArray(textProviders) ? textProviders : []) {
    if (isPlainObject(record) && record.id) ensure(record.id).text = record;
  }
  for (const record of Array.isArray(visionProviders) ? visionProviders : []) {
    if (isPlainObject(record) && record.id) ensure(record.id).vision = record;
  }

  return [...byId.values()]
    .map((row) => ({
      ...row,
      capabilities: {
        text: capabilityOf(row, "text"),
        vision: capabilityOf(row, "vision")
      }
    }))
    .sort((a, b) => String(a.id).localeCompare(String(b.id)));
}

/**
 * One pool's headline figures.
 *
 * Backend values win wherever they exist (`poolSummary` for health, the config
 * summary for provider/target counts) because they are computed over the same
 * response and cannot disagree with the detail views. The client-side recount
 * only covers a payload that arrived without them.
 */
export function summarizePool({ pool = "text", providers = [], summary = null, poolSummary = null } = {}) {
  const specificPool = POOLS.includes(pool) ? pool : "text";
  const rows = (Array.isArray(providers) ? providers : []).filter(isPlainObject);
  const configuredRows = rows.filter((row) => row.configured !== false);

  const summaryObject = isPlainObject(summary) ? summary : null;
  const health = isPlainObject(poolSummary) ? poolSummary : null;

  const providerCount = pickCount(
    specificPool === "vision"
      ? summaryObject?.visionCapableProviders
      : summaryObject?.textCapableProviders,
    configuredRows.length
  );

  // Distinct models *within this pool only*. Unioning text and vision models
  // onto one card is exactly the merge this redesign exists to prevent.
  const models = new Set();
  for (const row of configuredRows) {
    for (const model of modelList(row, specificPool)) models.add(model);
  }

  // Recount over the configured rows only, so the fallback agrees with the
  // provider count (an unconfigured provider contributes no routable targets).
  const total = pickCount(health?.total, sumBy(configuredRows, (row) => row.health?.targets));
  const healthy = pickCount(health?.healthy, sumBy(configuredRows, (row) => row.health?.healthy));
  const cooldown = pickCount(health?.cooldown, sumBy(configuredRows, (row) => row.health?.cooldown));
  const failed = pickCount(health?.failed, sumBy(configuredRows, (row) => row.health?.failed));
  const unknown = pickCount(health?.unknown, sumBy(configuredRows, (row) => row.health?.unknown));

  const targets = pickCount(
    specificPool === "vision"
      ? summaryObject?.configuredVisionTargets
      : summaryObject?.configuredTargets,
    total
  );

  const latencyMs = Number.isFinite(health?.averageLatencyMs)
    ? health.averageLatencyMs
    : average(rows.map((row) => row.health?.latencyMs).filter((value) => Number.isFinite(value)));

  return {
    pool: specificPool,
    providers: providerCount,
    models: models.size,
    targets,
    healthy,
    cooldown,
    failed,
    unknown,
    latencyMs,
    // The two figures behind the bar. `null` when there is nothing to divide:
    // "no targets" must not read as "0% healthy".
    healthPercent: total > 0 ? healthy / total : null,
    counts: { healthy, cooldown, failed, unknown }
  };
}

/** Does one matrix row satisfy a capability filter? */
export function matchesMatrixFilter(row, filterKey = "all") {
  const text = row?.capabilities?.text === true;
  const vision = row?.capabilities?.vision === true;

  switch (filterKey) {
    case "textOnly": return text && !vision;
    case "visionOnly": return vision && !text;
    case "both": return text && vision;
    case "all":
    default: return true;
  }
}

/** Only the fields an operator would type: provider id, env prefix, models. */
const SEARCH_FIELDS = [
  (row) => row?.id ?? "",
  (row) => row?.text?.envPrefix ?? row?.vision?.envPrefix ?? "",
  (row) => modelList(row?.text, "text").join(" "),
  (row) => modelList(row?.vision, "vision").join(" ")
];

/**
 * Apply the matrix toolbar.
 *
 * `pool` scopes rows to providers actually configured for that pool, so the
 * TEXT / VISION view shows only rows that can serve that pool — it never hides
 * a column group while leaving unrelated rows in place.
 */
export function filterMatrixRows(rows, { filterKey = "all", search = "", pool = "all" } = {}) {
  return (Array.isArray(rows) ? rows : []).filter((row) => {
    if (pool === "text" && row?.capabilities?.text !== true) return false;
    if (pool === "vision" && row?.capabilities?.vision !== true) return false;
    if (!matchesMatrixFilter(row, filterKey)) return false;
    return matchesSearch(row, search, SEARCH_FIELDS);
  });
}

/**
 * Capability badge labels (spec §4 / §13).
 *
 * A provider that cannot serve a pool reads "No vision" / "No text" — never a
 * row of zeros, which would imply it is configured but idle.
 */
export function describeCapabilities(capabilities) {
  const text = capabilities?.text === true;
  const vision = capabilities?.vision === true;

  return {
    text: { configured: text, label: text ? "Text" : "No text", mark: text ? "✓" : "✗" },
    vision: { configured: vision, label: vision ? "Vision" : "No vision", mark: vision ? "✓" : "✗" }
  };
}

/** Split `health.ranked` into the two pools, preserving rank order. */
export function groupRankedByPool(ranked = []) {
  const grouped = { text: [], vision: [] };
  for (const entry of Array.isArray(ranked) ? ranked : []) {
    grouped[entry?.pool === "vision" ? "vision" : "text"].push(entry);
  }
  return grouped;
}

/**
 * The no-cross-pool fallback contract, mirroring the backend's
 * `routing.crossPoolFallback: "blocked"` (`src/observability/config-view.js`).
 * Held here as a constant rather than fetched, so the Routing Flow panel needs
 * no extra poll.
 */
export const CROSS_POOL_FALLBACK = Object.freeze({
  blocked: true,
  label: "NO CROSS-POOL FALLBACK",
  detail: "A failed request is retried only within its own pool."
});

/** The Routing Flow panel's steps (spec §8). */
export const ROUTING_FLOW_STEPS = Object.freeze([
  { key: "incoming", step: 1, label: "Incoming Request", detail: "TEXT or VISION" },
  { key: "detect", step: 2, label: "Detect Request Type", detail: "Text: chat / coding / reasoning · Vision: image / multimodal" },
  { key: "pool", step: 3, label: "Route to Correct Pool", detail: "The request enters exactly one pool" },
  { key: "priority", step: 4, label: "Priority Targets (optional)", detail: "PRIORITY_MODELS in exact env order; skipped entirely when empty. Stops on first success" },
  { key: "select", step: 5, label: "Normal Fallback: Provider → Key → Models", detail: "Every model of a key is tried in order before the next key; each key restarts at its first model, then the next provider. Targets already attempted are skipped; cooling targets are skipped" },
  { key: "fallback", step: 6, label: "Fallback (Same Pool Only)", detail: CROSS_POOL_FALLBACK.label, warn: true }
]);
