/**
 * Pure helpers for the Fallback Chain page, kept out of the component so they
 * are unit-testable. Nothing here invents a routing decision: an entry is only
 * ever shown as it will be sent, and a latency is only ever shown with the
 * source it was measured from.
 */

export const FALLBACK_POOLS = ["text", "vision"];

export const POOL_LABEL = { text: "Text", vision: "Vision" };

/** The routing phases the gateway records on an attempt. */
export const PHASE_LABEL = {
  sticky: "Remembered",
  chain: "Fallback chain",
  auto: "Automatic (health + latency)"
};

export function phaseLabel(phase) {
  return PHASE_LABEL[phase] ?? null;
}

export const entryId = (entry) => `${entry?.provider ?? ""}/${entry?.model ?? ""}`;

/**
 * A chain entry as the API expects it. A newly added model is unrestricted:
 * `keys: null` means every key the provider has, which is the safe default —
 * narrowing a model to a subset must always be a deliberate act by the operator.
 *
 * Note the two different `keys` in this payload: an entry's `keys` is a subset
 * of key indexes, while a catalogue group carries `keyIndexes` (the provider's
 * inventory) and `keyStates` (per-key health). They must never be copied across.
 */
export function toEntry(group, extra = {}) {
  return {
    provider: group.provider,
    model: group.model,
    keys: null,
    enabled: group.enabled !== false,
    ...extra
  };
}

export function addEntry(list, group) {
  const entry = toEntry(group);
  return list.some((item) => entryId(item) === entryId(entry)) ? list : [...list, entry];
}

export function removeEntry(list, index) {
  return list.filter((_, i) => i !== index);
}

/** Moves the item at `from` to position `to` (clamped); returns a new array. */
export function moveEntry(list, from, to) {
  if (from < 0 || from >= list.length) return list;
  const target = Math.max(0, Math.min(list.length - 1, to));
  if (target === from) return list;
  const next = [...list];
  const [item] = next.splice(from, 1);
  next.splice(target, 0, item);
  return next;
}

export function toggleEnabled(list, index) {
  return list.map((item, i) => (i === index ? { ...item, enabled: item.enabled === false } : item));
}

/**
 * Sets which keys an entry may use. An empty selection means "every key", which
 * is how the gateway reads it too — narrowing a model to no keys at all would
 * be a model that can never be called.
 */
export function setKeys(list, index, keys) {
  const next = [...new Set(keys)].filter((key) => Number.isInteger(key) && key >= 0).sort((a, b) => a - b);
  return list.map((item, i) => (i === index ? { ...item, keys: next.length > 0 ? next : null } : item));
}

/** `null` and `[]` both mean "every key", so they must compare equal. */
const keySet = (value) => (Array.isArray(value) && value.length > 0 ? [...value].sort((a, b) => a - b) : null);

/** True when two chains would be sent identically, so the panel can spot a no-op save. */
export function sameChain(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  return a.every((item, i) => {
    const other = b[i];
    if (entryId(item) !== entryId(other)) return false;
    if ((item.enabled === false) !== (other.enabled === false)) return false;
    const left = keySet(item.keys);
    const right = keySet(other.keys);
    if (left === null || right === null) return left === right;
    return left.length === right.length && left.every((key, j) => key === right[j]);
  });
}

/** Case-insensitive match on provider and model, for the "add a model" search. */
export function filterCatalogue(catalogue, query) {
  const q = String(query || "").trim().toLowerCase();
  if (!q) return catalogue;
  return catalogue.filter((group) => entryId(group).toLowerCase().includes(q));
}

export function indexCatalogue(catalogue) {
  return new Map((catalogue ?? []).map((group) => [entryId(group), group]));
}

/** "key 0, key 2" / "all 3 keys" / "no keys configured" — never a bare count. */
export function keysLabel(entry, group) {
  const available = Array.isArray(group?.keyIndexes) ? group.keyIndexes : [];
  if (available.length === 0) return "no keys configured";
  if (!Array.isArray(entry?.keys)) return available.length === 1 ? "1 key" : `all ${available.length} keys`;
  const chosen = entry.keys.filter((key) => available.includes(key));
  return chosen.length === 0 ? "no eligible key selected" : `keys ${chosen.join(", ")}`;
}

/**
 * The measured latency to display, with its source. `null` means the router has
 * never measured this model — the panel must say so rather than show a number
 * the router does not have.
 */
export function latencyOf(group) {
  if (!group) return { ms: null, source: null, label: "not measured" };
  if (Number.isFinite(group.measuredLatencyMs)) {
    return { ms: group.measuredLatencyMs, source: "request", label: "measured from requests" };
  }
  if (Number.isFinite(group.probeLatencyMs)) {
    return { ms: group.probeLatencyMs, source: "probe", label: "from the health probe" };
  }
  return { ms: null, source: null, label: "not measured" };
}

/** How a configured entry will actually behave, so the panel never overstates it. */
export function entryState(entry, group) {
  if (!group) return { key: "missing", label: "Not configured in this pool", tone: "danger" };
  if (entry.enabled === false) return { key: "disabled", label: "Disabled — keeps its place, not routed to", tone: "muted" };
  if (group.available === false) return { key: "cooldown", label: "Cooling down — skipped until it recovers", tone: "warn" };
  return { key: "active", label: "Active", tone: group.status === "healthy" ? "ok" : "neutral" };
}

/**
 * The order the pool will actually be walked, as far as the panel can know it.
 * A configured chain is its own order; with no chain the gateway builds the
 * automatic order, which the preview endpoint reports — never guessed here.
 */
export function chainSummary(entries, catalogue = [], mode) {
  const index = indexCatalogue(catalogue);
  const active = (entries ?? []).filter((entry) => entry.enabled !== false && index.has(entryId(entry)));
  if (active.length > 0) {
    return {
      source: mode === "auto" ? "auto" : "chain",
      label: mode === "auto"
        ? "Automatic Health-Based Fallback over the configured models"
        : "Configured order",
      count: active.length
    };
  }
  return {
    source: "auto",
    label: "Automatic Health-Based Fallback (no valid chain configured)",
    count: 0
  };
}
