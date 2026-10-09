import fs from "node:fs";
import path from "node:path";

/**
 * Manual model selection: an operator-chosen, ordered list of provider/model
 * entries per pool (text / vision), persisted as JSON so it survives restarts.
 *
 * The store holds only provider + model ids, never credentials. It is read by
 * the existing route planner (routing-plan.js) as a leading "manual" phase; it
 * has no routing logic of its own. Empty list = feature off for that pool.
 */

export const MANUAL_POOLS = Object.freeze(["text", "vision"]);
const MAX_ENTRIES = 200;

/** Normalizes untrusted input to unique {provider, model} entries, order kept. */
export function normalizeManualEntries(value) {
  const entries = [];
  const seen = new Set();
  for (const raw of Array.isArray(value) ? value : []) {
    const provider = typeof raw?.provider === "string" ? raw.provider.trim().toLowerCase() : "";
    const model = typeof raw?.model === "string" ? raw.model.trim() : "";
    if (!provider || !model || provider.length > 100 || model.length > 300) continue;
    const id = `${provider}/${model}`;
    if (seen.has(id)) continue;
    seen.add(id);
    entries.push({ provider, model });
    if (entries.length >= MAX_ENTRIES) break;
  }
  return entries;
}

export class ManualSelectionStore {
  constructor({ file = null } = {}) {
    this.file = file ? path.resolve(file) : null;
    this.byPool = { text: [], vision: [] };
    this.load();
  }

  load() {
    if (!this.file) return;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, "utf8"));
      for (const pool of MANUAL_POOLS) this.byPool[pool] = normalizeManualEntries(parsed?.[pool]);
    } catch (error) {
      // Missing file is the normal first run; a corrupt file must not stop the gateway.
      if (error?.code !== "ENOENT") console.warn(`manual selection: ignoring unreadable ${path.basename(this.file)}`);
    }
  }

  get(pool) {
    return (this.byPool[pool] ?? []).map((entry) => ({ ...entry }));
  }

  snapshot() {
    return { text: this.get("text"), vision: this.get("vision") };
  }

  /** Replaces one pool's list (empty array clears it) and persists atomically. */
  set(pool, entries) {
    if (!MANUAL_POOLS.includes(pool)) throw new Error(`unknown pool "${pool}"`);
    const next = normalizeManualEntries(entries);
    this.persist({ ...this.byPool, [pool]: next });
    this.byPool[pool] = next;
    return this.get(pool);
  }

  clear(pool) {
    return this.set(pool, []);
  }

  persist(data) {
    if (!this.file) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ text: data.text, vision: data.vision }, null, 2));
    fs.renameSync(tmp, this.file);
  }
}
