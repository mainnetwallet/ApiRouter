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
 * A whole PROVIDER can be switched off too. `isDisabled(provider, model)` is true
 * when the model itself is off OR its provider is off, so every place that
 * already filters by the switch (routing, fallback, health batch, previews)
 * drops all of that provider's models without any further change. The two
 * switches are independent: enabling a provider never touches a model the
 * operator turned off on its own, and turning a model off never touches its
 * provider.
 *
 * The file holds ids only, never credentials.
 */

const MAX_IDS = 500;
const MAX_PROVIDERS = 200;

const providerId = (provider) => String(provider ?? "").trim().toLowerCase();

function normalizeProviders(value) {
  const ids = [];
  const seen = new Set();
  for (const raw of Array.isArray(value) ? value : []) {
    const id = providerId(typeof raw === "string" ? raw : raw?.provider);
    if (!id || id.length > 100 || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
    if (ids.length >= MAX_PROVIDERS) break;
  }
  return ids;
}

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
    this.disabledProviders = new Set();
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
      for (const id of normalizeProviders(parsed?.disabledProviders)) {
        this.disabledProviders.add(id);
      }
    } catch (error) {
      // A missing file is the normal first run; a corrupt one must not stop the
      // gateway, and is not overwritten until the operator's next change.
      if (error?.code !== "ENOENT") console.warn(`model switch: ignoring unreadable ${path.basename(this.file)}`);
    }
  }

  /** True when the model is off on its own OR its whole provider is off. */
  isDisabled(provider, model) {
    return this.isProviderDisabled(provider) || this.isModelDisabled(provider, model);
  }

  /** The model's own switch only, ignoring its provider's. */
  isModelDisabled(provider, model) {
    return this.disabled.has(modelSwitchId(provider, model));
  }

  isProviderDisabled(provider) {
    return this.disabledProviders.has(providerId(provider));
  }

  /** The disabled models, as plain { provider, model } objects. */
  list() {
    return [...this.disabled.values()].map((entry) => ({ ...entry }));
  }

  /** The disabled providers, as plain { provider } objects. */
  listProviders() {
    return [...this.disabledProviders].map((provider) => ({ provider }));
  }

  /**
   * Called after every real change, with ({ provider, model, disabled }) for a
   * model and ({ provider, model: null, disabled, scope: "provider" }) for a
   * whole provider.
   */
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
    this.persist(next, this.disabledProviders);
    this.disabled = next;

    this.emit({ ...entry, disabled: Boolean(disabled) });
    return true;
  }

  /**
   * Turns a whole provider off or on and persists it. While a provider is off
   * every one of its models is out of routing and fallback; its models' own
   * switches and all health data are left exactly as they were, so enabling it
   * again restores the previous behaviour. Returns false when nothing changed.
   */
  setProvider(provider, disabled) {
    const id = providerId(provider);
    if (!id || id.length > 100) throw new Error("provider is required");
    const wasDisabled = this.disabledProviders.has(id);
    if (wasDisabled === Boolean(disabled)) return false;

    const next = new Set(this.disabledProviders);
    if (disabled) next.add(id);
    else next.delete(id);
    this.persist(this.disabled, next);
    this.disabledProviders = next;

    this.emit({ provider: id, model: null, disabled: Boolean(disabled), scope: "provider" });
    return true;
  }

  emit(event) {
    for (const listener of this.listeners) {
      try { listener(event); }
      catch (error) { console.warn(`model switch: listener failed (${error?.message || error})`); }
    }
  }

  persist(map = this.disabled, providers = this.disabledProviders) {
    if (!this.file) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({
      version: 1,
      disabled: [...map.values()],
      disabledProviders: [...providers]
    }, null, 2));
    fs.renameSync(tmp, this.file);
  }
}
