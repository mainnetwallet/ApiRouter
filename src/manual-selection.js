import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Operator-chosen model order, one list per pool.
 *
 * When a pool has a manual list, every request of that pool tries those
 * provider/model entries first, in exactly the saved order (every key of an
 * entry before the next entry). Only when all of them fail does the router
 * fall through to the normal plan: sticky, then TEXT_/VISION_PRIORITY_MODELS,
 * then the Provider -> Key -> Models fallback. An empty list changes nothing.
 *
 * The list is edited from the panel while the gateway runs, so it lives in a
 * small JSON file (not .env) and is read through `get()` on every request.
 */

export const MANUAL_POOLS = Object.freeze(["text", "vision"]);
const MAX_ENTRIES_PER_POOL = 200;
const MAX_ENTRY_LENGTH = 300;

const DEFAULT_FILE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "data",
  "manual-selection.json"
);

/** "provider/model" -> { provider, model }. The model keeps everything after the FIRST "/". */
export function parseManualEntry(value) {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!text || text.length > MAX_ENTRY_LENGTH) return null;
  const slash = text.indexOf("/");
  if (slash <= 0 || slash === text.length - 1) return null;
  const provider = text.slice(0, slash).trim().toLowerCase();
  const model = text.slice(slash + 1).trim();
  if (!provider || !model) return null;
  return { provider, model };
}

export const manualEntryId = (entry) => `${entry.provider}/${entry.model}`;

/**
 * Validates one pool's list. Throws a 400-tagged error for anything that is not
 * an array of well-formed "provider/model" strings, instead of silently
 * dropping what the operator typed.
 */
function normalizeList(value, pool) {
  if (value === undefined) return null;
  if (!Array.isArray(value)) {
    const error = new Error(`"${pool}" must be an array of "provider/model" strings`);
    error.status = 400;
    throw error;
  }
  if (value.length > MAX_ENTRIES_PER_POOL) {
    const error = new Error(`"${pool}" can hold at most ${MAX_ENTRIES_PER_POOL} entries`);
    error.status = 400;
    throw error;
  }
  const entries = [];
  const seen = new Set();
  for (const raw of value) {
    const entry = parseManualEntry(raw);
    if (!entry) {
      const error = new Error(`"${pool}" contains an invalid entry; expected "provider/model"`);
      error.status = 400;
      throw error;
    }
    const id = manualEntryId(entry);
    if (seen.has(id)) continue;
    seen.add(id);
    entries.push(entry);
  }
  return entries;
}

export class ManualSelection {
  constructor({ file = process.env.MANUAL_SELECTION_FILE || DEFAULT_FILE } = {}) {
    this.file = file;
    this.lists = { text: [], vision: [] };
    this.updatedAt = null;
    this.persistError = null;
    this.mtimeMs = null;
    this.lastCheck = 0;
    this.load();
  }

  /**
   * The file is the source of truth. If another process (a second gateway on the
   * same checkout, an old instance that was never stopped) rewrote it, pick the
   * change up instead of serving a stale in-memory copy that would bring removed
   * entries back. Checked at most once a second, so it costs nothing per request.
   */
  refresh() {
    const now = Date.now();
    if (now - this.lastCheck < 1000) return;
    this.lastCheck = now;
    let mtime = null;
    try { mtime = fs.statSync(this.file).mtimeMs; } catch { mtime = null; }
    if (mtime !== this.mtimeMs) this.load();
  }

  /** Entries of one pool, in the saved order. Never null. */
  get(pool = "text") {
    this.refresh();
    return this.lists[pool === "vision" ? "vision" : "text"];
  }

  /** `{ text, vision }`, the shape `routeOrderByPool` / `buildRoutePlan` consume. */
  all() {
    this.refresh();
    return { text: this.lists.text, vision: this.lists.vision };
  }

  /** A pool omitted from `next` keeps its current list; `[]` clears it. */
  set(next = {}) {
    const text = normalizeList(next?.text, "text");
    const vision = normalizeList(next?.vision, "vision");
    if (text) this.lists.text = text;
    if (vision) this.lists.vision = vision;
    this.updatedAt = new Date().toISOString();
    this.persist();
    return this.snapshot();
  }

  snapshot() {
    this.refresh();
    return {
      text: this.lists.text.map(manualEntryId),
      vision: this.lists.vision.map(manualEntryId),
      updatedAt: this.updatedAt,
      persisted: this.persistError === null
    };
  }

  load() {
    let raw;
    try {
      this.mtimeMs = fs.statSync(this.file).mtimeMs;
      raw = fs.readFileSync(this.file, "utf8");
    } catch {
      this.mtimeMs = null;
      return; // no file yet: no manual selection
    }
    try {
      const parsed = JSON.parse(raw);
      this.lists.text = normalizeList(parsed?.text ?? [], "text") ?? [];
      this.lists.vision = normalizeList(parsed?.vision ?? [], "vision") ?? [];
      this.updatedAt = typeof parsed?.updatedAt === "string" ? parsed.updatedAt : null;
    } catch (error) {
      // A corrupt file must not stop the gateway; it simply means "no manual order".
      this.lists = { text: [], vision: [] };
      console.warn(`[router] ignoring unreadable manual selection file ${this.file}: ${error.message}`);
    }
  }

  /** Atomic write (temp file + rename) so a crash never leaves half a file. */
  persist() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const temp = `${this.file}.${process.pid}.tmp`;
      fs.writeFileSync(temp, `${JSON.stringify({ ...this.snapshot(), persisted: undefined }, null, 2)}\n`);
      fs.renameSync(temp, this.file);
      this.mtimeMs = fs.statSync(this.file).mtimeMs;
      this.persistError = null;
    } catch (error) {
      // Still applied in memory; the panel is told it will not survive a restart.
      this.persistError = error;
      console.warn(`[router] could not save manual selection to ${this.file}: ${error.message}`);
    }
  }
}
