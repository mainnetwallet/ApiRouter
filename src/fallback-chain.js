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
 * There is no mode switch any more: the Manual Model Selection list IS the
 * configuration, and the mode is derived from it.
 *
 *   manual  a Manual Model Selection is saved for the pool: those models are
 *           tried in their saved order, then every model NOT selected, by health
 *   auto    the selection is empty: the automatic health/latency order applies
 *
 * Both remember the last successful provider + model + key so the next request
 * prefers it, so neither is a separate switch the operator has to choose.
 */
export const FALLBACK_MODES = Object.freeze({
  AUTO: "auto",
  MANUAL: "manual"
});

export const DEFAULT_MODE = FALLBACK_MODES.AUTO;

/**
 * The mode a set of per-pool selections derives to — the single definition of
 * the rule that the store's `mode` getter and `persist()` both read.
 *
 * It takes the selections as an argument rather than reading the store's own
 * state, so it can be applied to the data about to be written. Deriving from
 * `this.byPool` instead would be wrong inside `update()`, where the new
 * selection has not been adopted yet: the file would then record the *previous*
 * mode next to the *new* entries, and a reader that trusts the field (an older
 * build, or a person reading the file) would be told the opposite of what the
 * selection means.
 */
function derivedMode(byPool) {
  return FALLBACK_POOLS.some((pool) => (byPool?.[pool] ?? []).length > 0)
    ? FALLBACK_MODES.MANUAL
    : FALLBACK_MODES.AUTO;
}

/**
 * Mode ids that predate this design. They are still ACCEPTED at the API
 * boundary — an older UI posting "fixed" or "last-success" must not be handed a
 * validation error — but they all mean the derived mode now: Fixed Order and
 * Remember Last Successful were removed in favour of the selection list, and an
 * empty list is exactly the automatic health-based routing those modes shared.
 */
const LEGACY_MODE_ALIASES = Object.freeze({
  fixed: FALLBACK_MODES.AUTO,
  "last-success": FALLBACK_MODES.AUTO
});

/** Operator-facing description of each mode, shared by the API and the panel. */
export const FALLBACK_MODE_INFO = Object.freeze([
  {
    id: FALLBACK_MODES.AUTO,
    label: "Automatic Health-Based Fallback",
    detail: "No models are selected, so the router orders every configured model by measured health and latency: healthy models with lower measured latency first, unmeasured models in a stable configured order. Every eligible key of a model is tried before the next model. The last successful provider, model and key is remembered and tried first on the next request."
  },
  {
    id: FALLBACK_MODES.MANUAL,
    label: "Manual Model Selection",
    detail: "Two batches that alternate within one request. 1) Your selected models, in exactly the order you saved them — except that the model that last answered leads when it is one of them — every eligible key of a model before the next. 2) If all of those fail, every model you did NOT select, ordered by measured health and latency. Then selected, health, selected, health again — but only for targets that failed transiently in this request, each at most once more. Cooldowns and key restrictions apply throughout; a credential failure or a cooling key is never retried."
  }
]);

export function fallbackModeLabel(mode) {
  const normalized = normalizeMode(mode);
  return FALLBACK_MODE_INFO.find((entry) => entry.id === normalized)?.label
    ?? FALLBACK_MODE_INFO.find((entry) => entry.id === DEFAULT_MODE)?.label
    ?? DEFAULT_MODE;
}

/**
 * Whether a successful target is remembered and preferred on the next request.
 * Every mode remembers now, so this is always true; it is kept as a named
 * predicate because the API and the panel report it as a distinct fact.
 */
export const REMEMBERING_MODES = Object.freeze([FALLBACK_MODES.AUTO, FALLBACK_MODES.MANUAL]);

export function remembersSuccess() {
  return true;
}

const MAX_ENTRIES = 200;
/**
 * The highest key index a chain entry may name. Exported so the API boundary
 * rejects an out-of-range index with the same number the store normalizes
 * against, rather than a second copy of it that could drift.
 */
export const MAX_KEYS = 64;

/**
 * Whether a value names a mode the API will accept: a current mode, or one of
 * the retired ids above. This is what the PUT boundary checks, so an old client
 * can still post the mode it knows while a typo is still rejected.
 */
export function isKnownMode(value) {
  const text = typeof value === "string" ? value.trim().toLowerCase() : "";
  return Object.values(FALLBACK_MODES).includes(text) || text in LEGACY_MODE_ALIASES;
}

/**
 * The mode a value means now. Retired ids resolve to the mode that replaced
 * them; anything unrecognized falls back to `DEFAULT_MODE`. Callers that must
 * tell "unrecognized" from "recognized" use `isKnownMode` first.
 */
export function normalizeMode(value) {
  const text = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (Object.values(FALLBACK_MODES).includes(text)) return text;
  return LEGACY_MODE_ALIASES[text] ?? DEFAULT_MODE;
}

/**
 * Normalizes an entry's `keys` to one of exactly three states:
 *
 *   null        no restriction was expressed — every configured key is allowed.
 *               This is the case for an absent field and for an explicit null,
 *               which are the documented ways to say "every key".
 *   [n, ...]    a restriction, to the key indexes it names.
 *   []          a restriction that could not be read (a non-array, or an array
 *               naming no usable index). It is preserved as an EMPTY
 *               restriction, never collapsed into `null`.
 *
 * The third state is the whole point. `null` means every key, so mapping an
 * unreadable restriction onto it can only ever BROADEN routing: a persisted or
 * hand-edited `keys: [true]`, `keys: ["1"]`, `keys: []` or `keys: "1"` would
 * quietly route to keys the file never granted. An empty restriction instead
 * resolves to zero eligible keys, so the entry is walked as unusable and the
 * pool fails closed — which is the safe reading of a configuration nobody can
 * interpret.
 *
 * This reader stays forgiving in the sense that matters at startup: it never
 * throws, so a malformed file cannot stop the gateway. It is simply not
 * generous with permissions.
 */
function normalizeKeys(value) {
  if (value === undefined || value === null) return null;
  // Meant as a restriction, but not one that can be read: allow nothing.
  if (!Array.isArray(value)) return [];

  const keys = [];
  const seen = new Set();
  for (const raw of value) {
    if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 0 || raw >= MAX_KEYS) continue;
    if (seen.has(raw)) continue;
    seen.add(raw);
    keys.push(raw);
  }
  keys.sort((a, b) => a - b);
  // `[]` when nothing usable was named — an unusable restriction, not a free pass.
  return keys;
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
 *
 *   keys: null      every key the provider/model actually has configured
 *   keys: [0, 2]    only those two, where the provider has them
 *   keys: []        none at all — an unreadable restriction permits nothing
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
    this.byPool = { text: [], vision: [] };
    this.migrated = false;
    this.load(migrate);
  }

  /**
   * The mode in force, DERIVED from the saved selection rather than stored.
   *
   * A pool with a saved Manual Model Selection is walked in `manual` mode; a
   * pool with none is walked by the automatic health/latency order. Because the
   * mode is a property of the configuration, an edit to the list takes effect
   * immediately and cannot drift from what is actually walked, and there is no
   * separate switch left to fall out of sync with it.
   */
  get mode() {
    return derivedMode(this.byPool);
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
    // A stored `mode` from an older file is read but not adopted: the mode is
    // derived from the entries below, so the file cannot force a mode the
    // selection does not support.
    for (const pool of FALLBACK_POOLS) this.byPool[pool] = normalizeEntries(data?.[pool]);
  }

  get(pool) {
    // Copy the array so a caller cannot mutate stored state. `keys` is either an
    // array — including the empty, unusable restriction — or the unrestricted
    // `null`, and those two must stay distinguishable, so the test is on the
    // type rather than on truthiness.
    return (this.byPool[pool] ?? []).map((entry) => ({
      ...entry,
      keys: Array.isArray(entry.keys) ? [...entry.keys] : null
    }));
  }

  snapshot() {
    return { mode: this.mode, text: this.get("text"), vision: this.get("vision") };
  }

  /**
   * Applies one pool's chain as ONE persisted update.
   *
   * The mode used to be written alongside the chain, so a request carrying both
   * could persist the mode and then fail on the chain — a half-applied
   * configuration the next start would load, and that the running process would
   * disagree with. The mode is now derived from the entries, so only the entries
   * are written: they are computed first, persisted exactly once, and adopted in
   * memory only once the write has landed. A failure at any point leaves both
   * the file and the running configuration as they were.
   *
   * `mode` is accepted and IGNORED so a client that still posts a mode (or a
   * retired one) keeps working; the mode follows from whether the pool has any
   * saved entries. `pool: null` leaves both chains alone.
   */
  update({ mode, pool = null, entries = null } = {}) {
    void mode;
    if (pool !== null && !FALLBACK_POOLS.includes(pool)) throw new Error(`unknown pool "${pool}"`);
    const nextByPool = pool === null ? this.byPool : { ...this.byPool, [pool]: normalizeEntries(entries) };

    // Durable state first: nothing in memory moves unless the write succeeds.
    this.persist(nextByPool);

    this.byPool = nextByPool;
    return this.snapshot();
  }

  /** Replaces one pool's chain (an empty array clears it) and persists atomically. */
  set(pool, entries) {
    this.update({ pool, entries });
    return this.get(pool);
  }

  clear(pool) {
    return this.set(pool, []);
  }

  /** Retained for callers written against the old switch; the mode is derived. */
  setMode() {
    return this.mode;
  }

  /**
   * Written to a temporary file and renamed, so a crash mid-write cannot leave a
   * half-written chain that the next start would refuse to read.
   *
   * The derived mode is still written, so a file produced here is readable by an
   * older build without it having to infer the mode from the entries. It is
   * derived from the entries being written — never from `this.byPool`, which
   * `update()` has deliberately not adopted yet.
   */
  persist(data = this.byPool) {
    if (!this.file) return;
    // Normalize once, and derive the mode from exactly these entries, so the
    // file can never describe a mode its own selection contradicts.
    const text = normalizeEntries(data.text);
    const vision = normalizeEntries(data.vision);
    const payload = {
      version: FILE_VERSION,
      mode: derivedMode({ text, vision }),
      text,
      vision
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
 * The seeded mode is `manual`, which is what the legacy manual-selection
 * behaviour actually was (the last good target of the selection led the next
 * request, then the rest of the selection) — and it is also what the seed's
 * non-empty entries derive to, so an upgrade preserves routing rather than
 * changing it.
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
    mode: FALLBACK_MODES.MANUAL,
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
