import fs from "node:fs";
import path from "node:path";

/**
 * The Fallback Chain: the single, persisted source of truth for routing order,
 * per pool (text / vision).
 *
 *   text   [ gemini/m2, groq/m3, gemini/m1 ]
 *   vision [ gemini/v2, openrouter/v1 ]
 *
 * Each entry is one provider/model GROUP. `keys` narrows it to specific API
 * keys (`null` = every configured key of that provider/model, tried in key
 * order). Entries carry `enabled` so an operator can park a model without
 * losing its position.
 *
 * This module owns *configuration* only: normalization, validation, atomic
 * persistence and migration. It has no routing logic — the planner
 * (fallback-plan.js) reads a snapshot of it.
 *
 * The file holds ids and flags, never credentials.
 */

export const FALLBACK_POOLS = Object.freeze(["text", "vision"]);

/**
 * The two ways a chain is walked. A custom order always wins; the automatic
 * order is only ever built when the operator has configured no entries at all.
 *
 *   fixed         every request starts at the first entry and its first key
 *   last-success  the last successful target leads, then the chain continues
 *   auto          the chain is ordered by measured health and latency each cycle
 */
export const FALLBACK_MODES = Object.freeze({
  FIXED: "fixed",
  LAST_SUCCESS: "last-success",
  AUTO: "auto"
});

export const DEFAULT_MODE = FALLBACK_MODES.FIXED;

/** Operator-facing description of each mode, shared by the API and the panel. */
export const FALLBACK_MODE_INFO = Object.freeze([
  {
    id: FALLBACK_MODES.FIXED,
    label: "Fixed Order",
    detail: "Every request starts at the first model in the chain and its first eligible key. A success never changes what is tried next."
  },
  {
    id: FALLBACK_MODES.LAST_SUCCESS,
    label: "Remember Last Successful",
    detail: "The model and key that last answered are tried first. If they fail or are cooling down, the chain continues in its saved order. The saved order itself is never modified."
  },
  {
    id: FALLBACK_MODES.AUTO,
    label: "Automatic Health-Based Fallback",
    detail: "The chain is re-ordered from measured health and latency on each cycle: healthy models with lower measured latency first, unmeasured models in a stable configured order. A configured order is still what decides which models are in the chain."
  }
]);

export function fallbackModeLabel(mode) {
  return FALLBACK_MODE_INFO.find((entry) => entry.id === normalizeMode(mode))?.label ?? DEFAULT_MODE;
}

/** Modes in which a successful target is remembered and leads the next request. */
export const REMEMBERING_MODES = Object.freeze([FALLBACK_MODES.LAST_SUCCESS, FALLBACK_MODES.AUTO]);

export function remembersSuccess(mode) {
  return REMEMBERING_MODES.includes(normalizeMode(mode));
}

const MAX_ENTRIES = 200;
const MAX_KEYS = 64;

export function normalizeMode(value) {
  const text = typeof value === "string" ? value.trim().toLowerCase() : "";
  return Object.values(FALLBACK_MODES).includes(text) ? text : DEFAULT_MODE;
}

/**
 * `keys` accepts `null`/absent (every configured key) or an array of key
 * indexes. Anything else is treated as "every key": a malformed key list must
 * not silently narrow a model to a subset the operator never chose.
 */
function normalizeKeys(value) {
  if (!Array.isArray(value)) return null;
  const keys = [];
  const seen = new Set();
  for (const raw of value) {
    const index = Number(raw);
    if (!Number.isInteger(index) || index < 0 || index >= MAX_KEYS) continue;
    if (seen.has(index)) continue;
    seen.add(index);
    keys.push(index);
  }
  keys.sort((a, b) => a - b);
  // An empty array is indistinguishable from "no restriction was intended".
  return keys.length > 0 ? keys : null;
}

export function normalizeEntry(value) {
  const raw = value && typeof value === "object" ? value : {};
  const provider = typeof raw.provider === "string" ? raw.provider.trim().toLowerCase() : "";
  const model = typeof raw.model === "string" ? raw.model.trim() : "";
  if (!provider || !model) return null;
  if (provider.length > 100 || model.length > 300) return null;
  return {
    provider,
    model,
    keys: normalizeKeys(raw.keys),
    enabled: raw.enabled === false ? false : true
  };
}

/** Unique by provider/model, order preserved. Later duplicates are dropped. */
export function normalizeEntries(value) {
  const entries = [];
  const seen = new Set();
  for (const raw of Array.isArray(value) ? value : []) {
    const entry = normalizeEntry(raw);
    if (!entry) continue;
    const id = `${entry.provider}/${entry.model}`;
    if (seen.has(id)) continue;
    seen.add(id);
    entries.push(entry);
    if (entries.length >= MAX_ENTRIES) break;
  }
  return entries;
}

/** Entries the walker may attempt: enabled, and naming a model id. */
export function activeEntries(entries) {
  return normalizeEntries(entries).filter((entry) => entry.enabled);
}

/** Entries that are part of the configured (order-preserving) view. */
export function allEntries(entries) {
  return normalizeEntries(entries);
}

export function entryId(entry) {
  return `${entry?.provider ?? ""}/${entry?.model ?? ""}`;
}

/**
 * Key indexes an entry permits for a group of targets, still in key order.
 * `keys: null` means every key the provider/model actually has configured.
 */
export function allowedKeyIndexes(entry, keyIndexes) {
  const available = [...new Set(keyIndexes)].filter((index) => Number.isInteger(index)).sort((a, b) => a - b);
  if (!Array.isArray(entry?.keys)) return available;
  const allowed = new Set(entry.keys);
  return available.filter((index) => allowed.has(index));
}

const FILE_VERSION = 2;

export class FallbackChainStore {
  /**
   * @param file       path to persist to ("" disables persistence, as in tests)
   * @param migrate    optional () => ({ text, vision, mode }) used ONCE, when no
   *                   file exists yet, to seed from the legacy configuration.
   *                   Never applied over an existing file, so a saved chain is
   *                   never silently overwritten by the old format.
   */
  constructor({ file = null, migrate = null } = {}) {
    this.file = file ? path.resolve(file) : null;
    this.mode = DEFAULT_MODE;
    this.byPool = { text: [], vision: [] };
    this.migrated = false;
    this.load(migrate);
  }

  load(migrate = null) {
    if (!this.file) {
      this.seed(migrate);
      return;
    }
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, "utf8"));
      this.apply(parsed);
      return;
    } catch (error) {
      // Missing file is the normal first run; a corrupt file must not stop the
      // gateway, and must not be overwritten here either — the operator's next
      // save replaces it deliberately.
      if (error?.code !== "ENOENT") {
        console.warn(`fallback chain: ignoring unreadable ${path.basename(this.file)}`);
        return;
      }
    }

    // First run: no chain has ever been saved. Seed from the legacy systems so
    // an upgrade keeps the operator's routing, then write the new format once.
    const seeded = this.seed(migrate);
    if (seeded) this.persist();
  }

  seed(migrate) {
    if (typeof migrate !== "function") return false;
    let legacy = null;
    try {
      legacy = migrate();
    } catch (error) {
      console.warn(`fallback chain: legacy migration failed (${error?.message || error})`);
      return false;
    }
    if (!legacy) return false;
    const next = {
      mode: normalizeMode(legacy.mode),
      text: normalizeEntries(legacy.text),
      vision: normalizeEntries(legacy.vision)
    };
    if (next.text.length === 0 && next.vision.length === 0) return false;
    this.apply(next);
    this.migrated = true;
    return true;
  }

  apply(parsed) {
    const data = parsed && typeof parsed === "object" ? parsed : {};
    this.mode = normalizeMode(data.mode);
    for (const pool of FALLBACK_POOLS) this.byPool[pool] = normalizeEntries(data?.[pool]);
  }

  get(pool) {
    return (this.byPool[pool] ?? []).map((entry) => ({ ...entry, keys: entry.keys ? [...entry.keys] : null }));
  }

  snapshot() {
    return { mode: this.mode, text: this.get("text"), vision: this.get("vision") };
  }

  /** Replaces one pool's chain (an empty array clears it) and persists atomically. */
  set(pool, entries) {
    if (!FALLBACK_POOLS.includes(pool)) throw new Error(`unknown pool "${pool}"`);
    const next = normalizeEntries(entries);
    this.persist({ ...this.byPool, [pool]: next });
    this.byPool[pool] = next;
    return this.get(pool);
  }

  clear(pool) {
    return this.set(pool, []);
  }

  setMode(mode) {
    const next = normalizeMode(mode);
    this.persist({ ...this.byPool, mode: next });
    this.mode = next;
    return this.mode;
  }

  /**
   * Written to a temporary file and renamed, so a crash mid-write cannot leave a
   * half-written chain that the next start would refuse to read.
   */
  persist(data = this.byPool) {
    if (!this.file) return;
    const payload = {
      version: FILE_VERSION,
      mode: normalizeMode(data.mode ?? this.mode),
      text: normalizeEntries(data.text),
      vision: normalizeEntries(data.vision)
    };
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2));
    fs.renameSync(tmp, this.file);
  }
}

/**
 * Reads the legacy configuration exactly once, for the seed above.
 *
 *   MANUAL_SELECTION_FILE (data/manual-selection.json)  operator's model order
 *   TEXT_PRIORITY_MODELS / VISION_PRIORITY_MODELS       priority entries
 *
 * Manual entries lead, then any priority entry not already present, per pool.
 * The seeded mode is `last-success`: that is what the legacy manual-selection
 * behaviour actually did (the last good target of the selection led the next
 * request), so an upgrade preserves routing rather than changing it.
 *
 * Neither the old file nor the env vars are read again once a chain is saved.
 */
export function readLegacyConfig({ manualFile = null, env = {} } = {}) {
  const byPool = { text: [], vision: [] };

  if (manualFile) {
    try {
      const parsed = JSON.parse(fs.readFileSync(path.resolve(manualFile), "utf8"));
      for (const pool of FALLBACK_POOLS) byPool[pool].push(...normalizeEntries(parsed?.[pool]));
    } catch (error) {
      if (error?.code !== "ENOENT") {
        console.warn(`fallback chain: could not read legacy ${path.basename(String(manualFile))}`);
      }
    }
  }

  for (const pool of FALLBACK_POOLS) {
    const raw = pool === "vision" ? env.VISION_PRIORITY_MODELS : env.TEXT_PRIORITY_MODELS;
    byPool[pool].push(...parseLegacyPriority(raw));
  }

  const dedupe = (entries) => normalizeEntries(entries);
  return {
    mode: FALLBACK_MODES.LAST_SUCCESS,
    text: dedupe(byPool.text),
    vision: dedupe(byPool.vision)
  };
}

/**
 * `gemini/G1,groq/GR2` -> entries. The model keeps everything after the FIRST
 * "/", because model ids such as "meta/llama-3" legitimately contain slashes.
 * Malformed entries are dropped, never guessed at.
 */
export function parseLegacyPriority(value) {
  const entries = [];
  for (const raw of String(value || "").split(",")) {
    const text = raw.trim();
    const slash = text.indexOf("/");
    if (slash <= 0 || slash === text.length - 1) continue;
    entries.push({ provider: text.slice(0, slash).trim().toLowerCase(), model: text.slice(slash + 1).trim() });
  }
  return normalizeEntries(entries);
}

/** True when any legacy source still holds configuration, so startup can warn. */
export function hasLegacyConfig({ manualFile = null, env = {} } = {}) {
  const prioritySet = Boolean(String(env.TEXT_PRIORITY_MODELS || "").trim() || String(env.VISION_PRIORITY_MODELS || "").trim());
  if (prioritySet) return true;
  if (!manualFile) return false;
  try {
    const parsed = JSON.parse(fs.readFileSync(path.resolve(manualFile), "utf8"));
    return FALLBACK_POOLS.some((pool) => normalizeEntries(parsed?.[pool]).length > 0);
  } catch {
    return false;
  }
}
