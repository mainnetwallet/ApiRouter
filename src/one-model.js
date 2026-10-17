import fs from "node:fs";
import path from "node:path";
import { targetId } from "./health.js";

/**
 * One Model Fallback.
 *
 * When switched on, the gateway serves every request from ONE provider/model the
 * operator picked and from nothing else: no other provider and no other model is
 * ever used as a fallback. Within that model the keys are used like this:
 *
 *   - By default a key has NO cooldown and nothing ever waits. A key that
 *     succeeded is the first one tried for the next request; if its call fails,
 *     the next key is tried, and so on until every key has been tried once for
 *     this request.
 *   - The operator can set a cooldown on a key. Then, the moment a call is made
 *     with that key, it goes into that cooldown (success or failure) and is
 *     called again once it is over. A key with no cooldown set is never paced.
 *   - Only when every key that is left is cooling does a request wait, for the
 *     first one to become ready (up to a bound), instead of failing at once.
 *
 * The cooldown lives in `KeyPacer`, not in the health registry, on purpose. The
 * health registry's cooldown is cleared by a success and is read by the normal
 * routing modes; this one is an unconditional pacing rule that only this mode
 * applies, so switching the mode off leaves no key stuck in a cooldown that the
 * normal modes would honour.
 *
 * The file holds ids, a flag and per-key cooldown numbers, never credentials.
 */

export const ONE_MODEL_DEFAULT_MAX_WAIT_MS = 120 * 1000;
// A cooldown is a pacing rule, not a ban: a day is the most it can be set to.
export const ONE_MODEL_MAX_COOLDOWN_MS = 24 * 60 * 60 * 1000;

/** A key's id inside the chosen model: its pool and key index. */
export const oneModelKeyId = (target) => `${target?.pool ?? "text"}:${target?.keyIndex}`;
const KEY_ID_PATTERN = /^(text|vision):\d{1,4}$/;
const validCooldown = (value) =>
  Number.isSafeInteger(value) && value >= 1 && value <= ONE_MODEL_MAX_COOLDOWN_MS;

// Waiting is done in short slices so a client that goes away, a paused gateway or
// a model that was switched off is noticed within a second.
const WAIT_SLICE_MS = 1000;

const normProvider = (value) => String(value ?? "").trim().toLowerCase();
const normModel = (value) => String(value ?? "").trim();

export class OneModelStore {
  /** @param file path to persist to ("" / null disables persistence, as in tests) */
  constructor({ file = null } = {}) {
    this.file = file ? path.resolve(file) : null;
    this.enabled = false;
    this.provider = "";
    this.model = "";
    // "pool:keyIndex" -> cooldown ms. A key with no entry has no cooldown.
    this.cooldowns = new Map();
    this.listeners = new Set();
    this.load();
  }

  load() {
    if (!this.file) return;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, "utf8"));
      const provider = normProvider(parsed?.provider);
      const model = normModel(parsed?.model);
      if (provider && model && provider.length <= 100 && model.length <= 300) {
        this.provider = provider;
        this.model = model;
        this.enabled = parsed?.enabled === true;
        for (const [id, ms] of Object.entries(parsed?.cooldowns ?? {})) {
          if (KEY_ID_PATTERN.test(id) && validCooldown(ms)) this.cooldowns.set(id, ms);
        }
      }
    } catch (error) {
      // A missing file is the normal first run; a corrupt one must not stop the
      // gateway, and is not overwritten until the operator's next change.
      if (error?.code !== "ENOENT") console.warn(`one model: ignoring unreadable ${path.basename(this.file)}`);
    }
  }

  get() {
    return { enabled: this.enabled, provider: this.provider, model: this.model };
  }

  /** Cooldown the operator set on this key, in ms; 0 means none. */
  cooldownFor(target) {
    return this.cooldowns.get(oneModelKeyId(target)) ?? 0;
  }

  /** Every key cooldown that is set, as { "pool:keyIndex": ms }. */
  getCooldowns() {
    return Object.fromEntries(this.cooldowns);
  }

  /** The selection while the mode is ON and a model is chosen, otherwise null. */
  active() {
    return this.enabled && this.provider && this.model
      ? { provider: this.provider, model: this.model }
      : null;
  }

  /** True for a target of the chosen model (every key, every pool). */
  matches(target) {
    return Boolean(target)
      && target.provider === this.provider
      && target.model === this.model;
  }

  /**
   * Called after every real change with { enabled, provider, model, scope,
   * changedKeys }. `scope` is "selection" when the mode or the model changed, and
   * "cooldowns" when only key cooldowns did (`changedKeys` lists those keys).
   */
  onChange(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Updates the selection, the on/off flag and/or key cooldowns, and persists it.
   * `cooldowns` is a partial { "pool:keyIndex": ms | null }: a number sets that
   * key's cooldown, null (or 0) removes it, a key left out is untouched. Choosing
   * a different model clears every cooldown, because they described other keys.
   * Memory only changes once the write has landed, so a failed save leaves the
   * running state as it was. Returns false when nothing changed.
   */
  set({ enabled = this.enabled, provider = this.provider, model = this.model, cooldowns = {} } = {}) {
    const next = {
      enabled: Boolean(enabled),
      provider: normProvider(provider),
      model: normModel(model)
    };
    if (next.provider.length > 100 || next.model.length > 300) throw new Error("provider or model is too long");
    if (next.enabled && (!next.provider || !next.model)) throw new Error("choose a provider and a model first");

    const modelChanged = next.provider !== this.provider || next.model !== this.model;
    const nextCooldowns = new Map(modelChanged ? [] : this.cooldowns);
    for (const [id, ms] of Object.entries(cooldowns ?? {})) {
      if (!KEY_ID_PATTERN.test(id)) throw new Error(`invalid key id "${String(id).slice(0, 20)}"`);
      if (ms === null || ms === 0) nextCooldowns.delete(id);
      else if (validCooldown(ms)) nextCooldowns.set(id, ms);
      else throw new Error("a cooldown must be a whole number of milliseconds from 1 to 86400000");
    }

    const changedKeys = [...new Set([...this.cooldowns.keys(), ...nextCooldowns.keys()])]
      .filter((id) => this.cooldowns.get(id) !== nextCooldowns.get(id));
    const selectionChanged = next.enabled !== this.enabled || modelChanged;
    if (!selectionChanged && changedKeys.length === 0) return false;

    this.persist(next, nextCooldowns);
    this.enabled = next.enabled;
    this.provider = next.provider;
    this.model = next.model;
    this.cooldowns = nextCooldowns;

    const event = { ...this.get(), scope: selectionChanged ? "selection" : "cooldowns", changedKeys };
    for (const listener of this.listeners) {
      try { listener(event); }
      catch (error) { console.warn(`one model: listener failed (${error?.message || error})`); }
    }
    return true;
  }

  persist(state = this.get(), cooldowns = this.cooldowns) {
    if (!this.file) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, ...state, cooldowns: Object.fromEntries(cooldowns) }, null, 2));
    fs.renameSync(tmp, this.file);
  }
}

/**
 * The per-key pacing cooldown, plus which key last answered. In memory only:
 * after a restart every key is ready and the first key leads, which is the safe
 * direction (the upstream's own limits still apply).
 */
export class KeyPacer {
  constructor() {
    this.readyAtById = new Map();
    this.goodKeyIndexByPool = new Map();
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

  /** The key that answered last in this pool leads the next request. */
  markGood(target) {
    this.goodKeyIndexByPool.set(target.pool ?? "text", target.keyIndex);
  }

  preferredKeyIndex(pool = "text") {
    return this.goodKeyIndexByPool.get(pool);
  }

  /** Forgets every cooldown and the preferred key (used when the model changes). */
  clear() {
    this.readyAtById.clear();
    this.goodKeyIndexByPool.clear();
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

/** Same rule as the normal walk: every key refused with the same request-level 4xx. */
function sharedClientErrorStatus(failures) {
  if (failures.length === 0) return null;
  const status = failures[0].status;
  if (!(status >= 400 && status < 500) || NOT_A_REQUEST_FAULT.has(status)) return null;
  return failures.every((failure) => failure.status === status) ? status : null;
}

/**
 * Serves one request from the keys of ONE model.
 *
 * `targets` are the chosen model's targets (one per key). `invoke(target)` makes
 * the upstream call and throws on failure, exactly as in `withFallback`.
 *
 * `checkpoint()` is called before every call and during every wait; it throws to
 * end the request (client gone, gateway shut down, model switched off).
 */
export async function withOneModel(
  targets,
  invoke,
  {
    pacer,
    cooldownFor = () => 0,
    health = null,
    checkpoint = () => {},
    maxWaitMs = ONE_MODEL_DEFAULT_MAX_WAIT_MS,
    onSkip = null
  } = {}
) {
  let ordered = [...(Array.isArray(targets) ? targets : [])]
    .sort((a, b) => (a.keyIndex ?? 0) - (b.keyIndex ?? 0));

  if (ordered.length === 0) {
    const err = new Error("No fully configured routing targets available");
    err.status = 503;
    throw err;
  }

  // The key that answered last leads, then the rest in key order. With no
  // cooldowns set this keeps calling the key that works instead of re-trying one
  // that just failed.
  const preferredIndex = pacer.preferredKeyIndex?.(ordered[0]?.pool ?? "text");
  const preferredAt = ordered.findIndex((target) => target.keyIndex === preferredIndex);
  if (preferredAt > 0) ordered = [...ordered.slice(preferredAt), ...ordered.slice(0, preferredAt)];

  const tried = new Set();
  const failures = [];
  const skipped = [];
  const waitDeadline = Date.now() + maxWaitMs;
  let reportedWait = false;

  while (tried.size < ordered.length) {
    checkpoint();
    const remaining = ordered.filter((target) => !tried.has(targetId(target)));
    const now = Date.now();
    const target = remaining.find((candidate) => pacer.isReady(candidate, now));

    if (!target) {
      // Every key that is left is cooling: wait for the first to be ready.
      const readyAt = Math.min(...remaining.map((candidate) => pacer.readyAt(candidate)));
      if (readyAt > waitDeadline) {
        const err = new Error(
          `Every key of this model is cooling down; the next one is ready in ${Math.max(1, Math.ceil((readyAt - now) / 1000))}s`
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
    tried.add(id);
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
        skipped.push(error);
        continue;
      }

      // Recorded for the dashboards. `cooldownMs: 0` keeps the health registry's
      // own cooldown out of it: this mode's only cooldown is the pacing above.
      health?.markFailure(target, status, { cooldownMs: 0 });
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
  const err = new Error(clientStatus ? failures[failures.length - 1].message : "Every key of the selected model failed");
  err.status = clientStatus ?? 502;
  err.errorType = clientStatus ? undefined : "one_model_failed";
  err.failures = failures;
  throw err;
}
