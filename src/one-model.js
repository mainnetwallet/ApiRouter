import fs from "node:fs";
import path from "node:path";
import { targetId } from "./health.js";

/**
 * One Provider Fallback.
 *
 * When switched on, the gateway serves every request from ONE provider the
 * operator picked and from nothing else: no other provider is ever used as a
 * fallback. The operator gives that provider an ordered list of models (model 1,
 * model 2, ... as many as wanted) and each model has its own keys. A request
 * walks them like this:
 *
 *   - Model 1 leads. Its keys are tried first; a key that is cooling, or that
 *     fails, is passed over. When every key of model 1 has failed or is cooling,
 *     model 2 is tried, then model 3, and so on in the saved order.
 *   - Every request starts again from model 1, so as soon as a key of an earlier
 *     model is out of its cooldown it is used again.
 *   - By default a key has NO cooldown and nothing waits. The key of a model
 *     that answered last leads the next request for that model.
 *   - The operator can set a cooldown on a key. Then, the moment a call is made
 *     with that key, it goes into that cooldown (success or failure) and is
 *     called again once it is over. A key with no cooldown set is never paced.
 *   - When every key of every model has failed or is cooling, the request waits
 *     for the first cooldown to end (up to a bound) and tries again, instead of
 *     failing at once. A key without a cooldown is tried once per request.
 *
 * The cooldown lives in `KeyPacer`, not in the health registry, on purpose. The
 * health registry's cooldown is cleared by a success and is read by the normal
 * routing modes; this one is an unconditional pacing rule that only this mode
 * applies, so switching the mode off leaves no key stuck in a cooldown that the
 * normal modes would honour.
 *
 * The file holds ids, a flag, the model order and per-key cooldown numbers,
 * never credentials.
 */

export const ONE_MODEL_DEFAULT_MAX_WAIT_MS = 120 * 1000;
// A cooldown is a pacing rule, not a ban: a day is the most it can be set to.
export const ONE_MODEL_MAX_COOLDOWN_MS = 24 * 60 * 60 * 1000;
export const ONE_PROVIDER_MAX_MODELS = 50;
// A key may be called again after its cooldown within one request, once.
const MAX_ATTEMPTS_PER_KEY = 2;

/** A key's id inside the chosen provider: its model, pool and key index. */
export const oneModelKeyId = (target) => `${target?.model}::${target?.pool ?? "text"}:${target?.keyIndex}`;
const KEY_ID_PATTERN = /^(.{1,300})::(text|vision):\d{1,4}$/;
// Before the provider could have several models a key was just "text:0".
const LEGACY_KEY_ID_PATTERN = /^(text|vision):\d{1,4}$/;
const validCooldown = (value) =>
  Number.isSafeInteger(value) && value >= 1 && value <= ONE_MODEL_MAX_COOLDOWN_MS;

// Waiting is done in short slices so a client that goes away, a paused gateway or
// a provider that was switched off is noticed within a second.
const WAIT_SLICE_MS = 1000;

const normProvider = (value) => String(value ?? "").trim().toLowerCase();
const normModel = (value) => String(value ?? "").trim();

/** Cleans a model list: trimmed strings, no blanks, no duplicates, order kept. */
function normModels(value) {
  const list = Array.isArray(value) ? value : [];
  const seen = new Set();
  const out = [];
  for (const entry of list) {
    const model = normModel(entry);
    if (!model || seen.has(model)) continue;
    seen.add(model);
    out.push(model);
  }
  return out;
}

/**
 * Turns a saved or requested key id into the current "model::pool:index" form.
 * An old "text:0" belongs to the first model. Returns null for anything else.
 */
function normalizeKeyId(id, models) {
  if (KEY_ID_PATTERN.test(id)) return id;
  if (LEGACY_KEY_ID_PATTERN.test(id) && models.length > 0) return `${models[0]}::${id}`;
  return null;
}

const modelOfKeyId = (id) => KEY_ID_PATTERN.exec(id)?.[1] ?? null;

export class OneModelStore {
  /** @param file path to persist to ("" / null disables persistence, as in tests) */
  constructor({ file = null } = {}) {
    this.file = file ? path.resolve(file) : null;
    this.enabled = false;
    this.provider = "";
    // The models of the provider, in priority order: the first leads.
    this.models = [];
    // "model::pool:keyIndex" -> cooldown ms. A key with no entry has no cooldown.
    this.cooldowns = new Map();
    this.listeners = new Set();
    this.load();
  }

  load() {
    if (!this.file) return;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, "utf8"));
      const provider = normProvider(parsed?.provider);
      // A file written when only one model could be chosen has `model`, not `models`.
      const models = normModels(Array.isArray(parsed?.models) ? parsed.models : [parsed?.model]);
      if (provider && models.length > 0 && provider.length <= 100
        && models.length <= ONE_PROVIDER_MAX_MODELS && models.every((model) => model.length <= 300)) {
        this.provider = provider;
        this.models = models;
        this.enabled = parsed?.enabled === true;
        for (const [rawId, ms] of Object.entries(parsed?.cooldowns ?? {})) {
          const id = normalizeKeyId(rawId, models);
          if (id && models.includes(modelOfKeyId(id)) && validCooldown(ms)) this.cooldowns.set(id, ms);
        }
      }
    } catch (error) {
      // A missing file is the normal first run; a corrupt one must not stop the
      // gateway, and is not overwritten until the operator's next change.
      if (error?.code !== "ENOENT") console.warn(`one provider: ignoring unreadable ${path.basename(this.file)}`);
    }
  }

  get() {
    return { enabled: this.enabled, provider: this.provider, models: [...this.models] };
  }

  /** Cooldown the operator set on this key, in ms; 0 means none. */
  cooldownFor(target) {
    return this.cooldowns.get(oneModelKeyId(target)) ?? 0;
  }

  /** Every key cooldown that is set, as { "model::pool:keyIndex": ms }. */
  getCooldowns() {
    return Object.fromEntries(this.cooldowns);
  }

  /** The selection while the mode is ON and a provider with models is chosen, otherwise null. */
  active() {
    return this.enabled && this.provider && this.models.length > 0
      ? { provider: this.provider, models: [...this.models] }
      : null;
  }

  /** True for a target of the chosen provider whose model is in the list (every key, every pool). */
  matches(target) {
    return Boolean(target)
      && target.provider === this.provider
      && this.models.includes(target.model);
  }

  /** Position of the target's model in the list (0 = leads), or -1. */
  modelRank(target) {
    return target ? this.models.indexOf(target.model) : -1;
  }

  /**
   * Called after every real change with { enabled, provider, models, scope,
   * reset, changedKeys }. `scope` is "selection" when the mode, the provider or
   * the model list changed, and "cooldowns" when only key cooldowns did
   * (`changedKeys` lists those keys). `reset` is true when the mode was turned on
   * or off or the provider changed, so nothing learned before still applies.
   */
  onChange(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Updates the selection, the on/off flag, the model list and/or key cooldowns,
   * and persists it. `models` is the whole ordered list (`model` is shorthand for
   * a list of one). `cooldowns` is a partial { "model::pool:keyIndex": ms | null }:
   * a number sets that key's cooldown, null (or 0) removes it, a key left out is
   * untouched. Choosing a different provider clears every cooldown, and dropping a
   * model from the list clears that model's. Memory only changes once the write has
   * landed, so a failed save leaves the running state as it was. Returns false when
   * nothing changed.
   */
  set({ enabled = this.enabled, provider = this.provider, models, model, cooldowns = {} } = {}) {
    const requestedModels = models !== undefined ? models : (model !== undefined ? [model] : this.models);
    if (models !== undefined && !Array.isArray(models)) throw new Error("models must be a list");
    const nextModels = normModels(requestedModels);
    const next = { enabled: Boolean(enabled), provider: normProvider(provider), models: nextModels };
    if (next.provider.length > 100 || nextModels.some((entry) => entry.length > 300)) {
      throw new Error("provider or model is too long");
    }
    if (nextModels.length > ONE_PROVIDER_MAX_MODELS) throw new Error(`at most ${ONE_PROVIDER_MAX_MODELS} models`);
    if (next.enabled && (!next.provider || nextModels.length === 0)) {
      throw new Error("choose a provider and at least one model first");
    }

    const providerChanged = next.provider !== this.provider;
    const modelsChanged = nextModels.length !== this.models.length
      || nextModels.some((entry, index) => entry !== this.models[index]);
    const nextCooldowns = new Map();
    if (!providerChanged) {
      for (const [id, ms] of this.cooldowns) if (nextModels.includes(modelOfKeyId(id))) nextCooldowns.set(id, ms);
    }
    for (const [rawId, ms] of Object.entries(cooldowns ?? {})) {
      const id = normalizeKeyId(rawId, nextModels);
      if (!id) throw new Error(`invalid key id "${String(rawId).slice(0, 20)}"`);
      if (ms === null || ms === 0) nextCooldowns.delete(id);
      else if (validCooldown(ms)) nextCooldowns.set(id, ms);
      else throw new Error("a cooldown must be a whole number of milliseconds from 1 to 86400000");
    }

    const changedKeys = [...new Set([...this.cooldowns.keys(), ...nextCooldowns.keys()])]
      .filter((id) => this.cooldowns.get(id) !== nextCooldowns.get(id));
    const enabledChanged = next.enabled !== this.enabled;
    const selectionChanged = enabledChanged || providerChanged || modelsChanged;
    if (!selectionChanged && changedKeys.length === 0) return false;

    this.persist(next, nextCooldowns);
    this.enabled = next.enabled;
    this.provider = next.provider;
    this.models = nextModels;
    this.cooldowns = nextCooldowns;

    const event = {
      ...this.get(),
      scope: selectionChanged ? "selection" : "cooldowns",
      reset: enabledChanged || providerChanged,
      changedKeys
    };
    for (const listener of this.listeners) {
      try { listener(event); }
      catch (error) { console.warn(`one provider: listener failed (${error?.message || error})`); }
    }
    return true;
  }

  persist(state = this.get(), cooldowns = this.cooldowns) {
    if (!this.file) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version: 2, ...state, cooldowns: Object.fromEntries(cooldowns) }, null, 2));
    fs.renameSync(tmp, this.file);
  }
}

/**
 * The per-key pacing cooldown, plus which key of each model answered last. In
 * memory only: after a restart every key is ready and the first key leads, which
 * is the safe direction (the upstream's own limits still apply).
 */
export class KeyPacer {
  constructor() {
    this.readyAtById = new Map();
    this.goodKeyIndexByModel = new Map();
  }

  readyAt(target) {
    return this.readyAtById.get(targetId(target)) ?? 0;
  }

  isReady(target, now = Date.now()) {
    return this.readyAt(target) <= now;
  }

  /**
   * Called the moment a call is made with a key that has a cooldown set: it cools
   * for `cooldownMs` from now. A key with no cooldown is never claimed.
   */
  claim(target, now = Date.now(), cooldownMs = 0) {
    if (cooldownMs > 0) this.readyAtById.set(targetId(target), now + cooldownMs);
  }

  /**
   * Gives a claim back. Used when the call was never really made against the key
   * (the model was switched off, the target refused the request itself), or when
   * the operator changed that key's cooldown: it is ready again at once.
   */
  release(target) {
    this.readyAtById.delete(targetId(target));
  }

  /** The key that answered last for this model and pool leads that model's next request. */
  markGood(target) {
    this.goodKeyIndexByModel.set(`${target.model}\u0000${target.pool ?? "text"}`, target.keyIndex);
  }

  preferredKeyIndex(model, pool = "text") {
    return this.goodKeyIndexByModel.get(`${model}\u0000${pool}`);
  }

  /** Forgets every cooldown and the preferred keys (used when the provider changes). */
  clear() {
    this.readyAtById.clear();
    this.goodKeyIndexByModel.clear();
  }

  /** Reporting view: when the key is next ready, as an epoch ms (0 = ready now). */
  describe(target, now = Date.now()) {
    const readyAt = this.readyAt(target);
    return { cooldownUntil: readyAt > now ? readyAt : 0, ready: readyAt <= now };
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const NOT_A_REQUEST_FAULT = new Set([401, 402, 403, 404, 408, 409, 425, 429]);

/** A 4xx that blames the request itself (not the key): trying it again later cannot help. */
const isRequestFault = (status) => status >= 400 && status < 500 && !NOT_A_REQUEST_FAULT.has(status);

/** Same rule as the normal walk: every key refused with the same request-level 4xx. */
function sharedClientErrorStatus(failures) {
  if (failures.length === 0) return null;
  const status = failures[0].status;
  if (!isRequestFault(status)) return null;
  return failures.every((failure) => failure.status === status) ? status : null;
}

/**
 * Serves one request from the models of ONE provider, in priority order.
 *
 * `targets` are the provider's targets for the listed models (one per key and
 * model). `models` is the priority order: the first model's keys are tried first,
 * then the second's, and so on. A key that is cooling, or that already failed for
 * this request, is passed over, so the request moves to the next model; it only
 * comes back to an earlier model's key once that key is ready. `invoke(target)`
 * makes the upstream call and throws on failure, exactly as in `withFallback`.
 *
 * `checkpoint()` is called before every call and during every wait; it throws to
 * end the request (client gone, gateway shut down, mode switched off).
 */
export async function withOneModel(
  targets,
  invoke,
  {
    pacer,
    models = null,
    cooldownFor = () => 0,
    health = null,
    checkpoint = () => {},
    maxWaitMs = ONE_MODEL_DEFAULT_MAX_WAIT_MS,
    onSkip = null
  } = {}
) {
  const list = [...(Array.isArray(targets) ? targets : [])];
  if (list.length === 0) {
    const err = new Error("No fully configured routing targets available");
    err.status = 503;
    throw err;
  }

  // Model by model in the saved order (a model that is not listed goes last, by
  // name); inside a model the key that answered last leads, then key order.
  const order = Array.isArray(models) ? models : [];
  const rankOf = (target) => {
    const at = order.indexOf(target.model);
    return at === -1 ? order.length : at;
  };
  const byModel = new Map();
  for (const target of list) {
    if (!byModel.has(target.model)) byModel.set(target.model, []);
    byModel.get(target.model).push(target);
  }
  const ordered = [...byModel.entries()]
    .sort((a, b) => rankOf(a[1][0]) - rankOf(b[1][0]) || a[0].localeCompare(b[0]))
    .flatMap(([model, keys]) => {
      const sorted = keys.sort((a, b) => (a.pool ?? "text").localeCompare(b.pool ?? "text") || (a.keyIndex ?? 0) - (b.keyIndex ?? 0));
      const preferred = pacer.preferredKeyIndex?.(model, sorted[0]?.pool ?? "text");
      const at = sorted.findIndex((target) => target.keyIndex === preferred);
      return at > 0 ? [...sorted.slice(at), ...sorted.slice(0, at)] : sorted;
    });

  // A key is cooling when its own pacing cooldown has not ended OR the health
  // registry has it in a cooldown (a 429/quota/timeout seen by any mode or probe).
  // A cooling key is never called: it is passed over until it is ready again.
  const readyAtOf = (target) => Math.max(
    pacer.readyAt(target),
    Number(health?.get?.(targetId(target))?.cooldownUntil) || 0
  );

  const attemptsById = new Map();
  const failures = [];
  const skipped = [];
  const waitDeadline = Date.now() + maxWaitMs;
  let reportedWait = false;

  // A key is tried once per request. One that has a cooldown set may be tried a
  // second time, after the cooldown, so that a request that finds every key of
  // every model failed or cooling waits for the first one to come back.
  const canTry = (target) => {
    const used = attemptsById.get(targetId(target)) ?? 0;
    return used === 0 || (used < MAX_ATTEMPTS_PER_KEY && cooldownFor(target) > 0);
  };

  for (;;) {
    checkpoint();
    const remaining = ordered.filter(canTry);
    if (remaining.length === 0) break;
    const now = Date.now();
    const target = remaining.find((candidate) => readyAtOf(candidate) <= now);

    if (!target) {
      // Every key that is left is cooling: wait for the first to be ready.
      const readyAt = Math.min(...remaining.map((candidate) => readyAtOf(candidate)));
      if (readyAt > waitDeadline) {
        const untried = remaining.some((candidate) => !attemptsById.has(targetId(candidate)));
        // Only keys that already failed are left and they will not be ready in
        // time: the failure is the answer, not "cooling down".
        if (!untried && failures.length > 0) break;
        const err = new Error(
          `Every key of every model is cooling down; the next one is ready in ${Math.max(1, Math.ceil((readyAt - now) / 1000))}s`
        );
        err.status = 503;
        err.errorType = "one_model_cooldown";
        err.retryAfterMs = readyAt - now;
        err.failures = failures;
        throw err;
      }
      if (!reportedWait) {
        reportedWait = true;
        if (typeof onSkip === "function") onSkip(remaining[0], { phase: null, reason: "cooldown" });
      }
      await sleep(Math.min(WAIT_SLICE_MS, Math.max(5, readyAt - now)));
      continue;
    }

    const id = targetId(target);
    attemptsById.set(id, (attemptsById.get(id) ?? 0) + 1);
    // A key with a cooldown set cools the moment the call is made, success or not.
    pacer.claim(target, now, cooldownFor(target));
    const startedAt = Date.now();

    try {
      const result = await invoke(target, { phase: null });
      health?.markSuccess(target, { latencyMs: Date.now() - startedAt });
      pacer.markGood?.(target);
      return result;
    } catch (error) {
      const status = Number(error?.status || 0);
      failures.push({ target, status, message: error?.message || String(error) });

      // The client went away (or the gateway was shut down): the request is over.
      if (error?.retryable === false) throw error;

      // The target refused the request for its own reasons, or was switched off:
      // not a use of the key, so it costs no cooldown, and it is not a failure.
      if (error?.skipCooldown) {
        pacer.release(target);
        attemptsById.set(id, MAX_ATTEMPTS_PER_KEY);
        skipped.push(error);
        continue;
      }

      // The request itself is at fault: asking again after a cooldown cannot help.
      if (isRequestFault(status)) attemptsById.set(id, MAX_ATTEMPTS_PER_KEY);

      // Recorded for the dashboards. A 503 (the upstream is unavailable) puts the
      // key in the health registry's default cooldown, so it is not called again
      // until that ends. Every other failure uses `cooldownMs: 0`: the only
      // cooldown is then the pacing above.
      health?.markFailure(target, status, status === 503 ? {} : { cooldownMs: 0 });
    }
  }

  // Not one key was really called (the model was switched off, or every key
  // refused the request itself): say that, rather than "every key failed".
  if (skipped.length === failures.length) {
    const last = skipped[skipped.length - 1];
    const err = new Error(last?.message || "No routing targets are currently available");
    err.status = Number(last?.status) || 503;
    err.errorType = last?.errorType;
    err.failures = failures;
    throw err;
  }

  const clientStatus = sharedClientErrorStatus(failures);
  const err = new Error(clientStatus ? failures[failures.length - 1].message : "Every key of every model of the selected provider failed");
  err.status = clientStatus ?? 502;
  err.errorType = clientStatus ? undefined : "one_model_failed";
  err.failures = failures;
  throw err;
}
