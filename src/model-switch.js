import fs from "node:fs";
import path from "node:path";

/**
 * The Model Switch: which provider/model pairs the operator has turned OFF.
 *
 * It is deliberately separate from the Fallback Chain. The chain only exists in
 * Manual Model Selection (an empty chain is the automatic order), so a flag on a
 * chain entry cannot switch off a model that was never added to a chain. This
 * store applies to BOTH modes: a disabled model is removed from the candidate
 * targets before any plan is built, so it can appear neither in the selected
 * batch nor in the health batch nor in the automatic order.
 *
 * The switch is global to a provider/model (every key, every pool). Disabling is
 * not a health event: nothing is cooled down and no measurement changes, so
 * enabling the model again restores exactly the behaviour it had before.
 *
 * The file holds ids only, never credentials.
 */

const MAX_IDS = 500;

export const modelSwitchId = (provider, model) =>
  `${String(provider ?? "").trim().toLowerCase()}/${String(model ?? "").trim()}`;

function normalizeIds(value) {
  const ids = [];
  const seen = new Set();
  for (const raw of Array.isArray(value) ? value : []) {
    const provider = typeof raw?.provider === "string" ? raw.provider.trim().toLowerCase() : "";
    const model = typeof raw?.model === "string" ? raw.model.trim() : "";
    if (!provider || !model || provider.length > 100 || model.length > 300) continue;
    const id = modelSwitchId(provider, model);
    if (seen.has(id)) continue;
    seen.add(id);
    ids.push({ provider, model });
    if (ids.length >= MAX_IDS) break;
  }
  return ids;
}

export class ModelSwitchStore {
  /** @param file path to persist to ("" / null disables persistence, as in tests) */
  constructor({ file = null } = {}) {
    this.file = file ? path.resolve(file) : null;
    this.disabled = new Map();
    this.listeners = new Set();
    this.load();
  }

  load() {
    if (!this.file) return;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, "utf8"));
      for (const entry of normalizeIds(parsed?.disabled)) {
        this.disabled.set(modelSwitchId(entry.provider, entry.model), entry);
      }
    } catch (error) {
      // A missing file is the normal first run; a corrupt one must not stop the
      // gateway, and is not overwritten until the operator's next change.
      if (error?.code !== "ENOENT") console.warn(`model switch: ignoring unreadable ${path.basename(this.file)}`);
    }
  }

  isDisabled(provider, model) {
    return this.disabled.has(modelSwitchId(provider, model));
  }

  /** The disabled models, as plain { provider, model } objects. */
  list() {
    return [...this.disabled.values()].map((entry) => ({ ...entry }));
  }

  /** Called with ({ provider, model, disabled }) after every real change. */
  onChange(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Turns one model off or on and persists it. Memory only changes once the
   * write has landed, so a failed save leaves the running state as it was.
   * Returns false when nothing changed (already in that state).
   */
  set(provider, model, disabled) {
    const [entry] = normalizeIds([{ provider, model }]);
    if (!entry) throw new Error("provider and model are required");
    const id = modelSwitchId(entry.provider, entry.model);
    const wasDisabled = this.disabled.has(id);
    if (wasDisabled === Boolean(disabled)) return false;

    const next = new Map(this.disabled);
    if (disabled) next.set(id, entry);
    else next.delete(id);
    this.persist(next);
    this.disabled = next;

    for (const listener of this.listeners) {
      try { listener({ ...entry, disabled: Boolean(disabled) }); }
      catch (error) { console.warn(`model switch: listener failed (${error?.message || error})`); }
    }
    return true;
  }

  persist(map = this.disabled) {
    if (!this.file) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, disabled: [...map.values()] }, null, 2));
    fs.renameSync(tmp, this.file);
  }
}
