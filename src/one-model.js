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
 *   - A key is used for a call and goes into a cooldown (default 1 minute) THE
 *     MOMENT the call is made, whether the call then succeeds or fails. It is
 *     called again once that minute is over. Calls therefore rotate across the
 *     model's keys, each key at most once per cooldown.
 *   - A key that is not cooling is used next, in key order. If its call fails,
 *     the next key that is not cooling is tried, and so on until every key has
 *     been tried once for this request.
 *   - When every key that is left is cooling, the request waits for the first one
 *     to become ready (up to a bound) instead of failing at once.
 *
 * The cooldown lives in `KeyPacer`, not in the health registry, on purpose. The
 * health registry's cooldown is cleared by a success and is read by the normal
 * routing modes; this one is an unconditional pacing rule that only this mode
 * applies, so switching the mode off leaves no key stuck in a cooldown that the
 * normal modes would honour.
 *
 * The file holds ids and a flag only, never credentials.
 */

export const ONE_MODEL_DEFAULT_COOLDOWN_MS = 60 * 1000;
export const ONE_MODEL_DEFAULT_MAX_WAIT_MS = 120 * 1000;

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

  /** Called with the new { enabled, provider, model } after every real change. */
  onChange(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Updates the selection and/or the on/off flag and persists it. Memory only
   * changes once the write has landed, so a failed save leaves the running state
   * as it was. Returns false when nothing changed.
   */
  set({ enabled = this.enabled, provider = this.provider, model = this.model } = {}) {
    const next = {
      enabled: Boolean(enabled),
      provider: normProvider(provider),
      model: normModel(model)
    };
    if (next.provider.length > 100 || next.model.length > 300) throw new Error("provider or model is too long");
    if (next.enabled && (!next.provider || !next.model)) throw new Error("choose a provider and a model first");
    if (next.enabled === this.enabled && next.provider === this.provider && next.model === this.model) return false;

    this.persist(next);
    this.enabled = next.enabled;
    this.provider = next.provider;
    this.model = next.model;

    for (const listener of this.listeners) {
      try { listener(this.get()); }
      catch (error) { console.warn(`one model: listener failed (${error?.message || error})`); }
    }
    return true;
  }

  persist(state = this.get()) {
    if (!this.file) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, ...state }, null, 2));
    fs.renameSync(tmp, this.file);
  }
}

/**
 * The per-key pacing cooldown. In memory only: after a restart every key is
 * ready, which is the safe direction (the upstream's own limits still apply).
 */
export class KeyPacer {
  constructor({ cooldownMs = ONE_MODEL_DEFAULT_COOLDOWN_MS } = {}) {
    this.cooldownMs = cooldownMs;
    this.readyAtById = new Map();
  }

  readyAt(target) {
    return this.readyAtById.get(targetId(target)) ?? 0;
  }

  isReady(target, now = Date.now()) {
    return this.readyAt(target) <= now;
  }

  /** Called the moment a call is made: the key cools for `cooldownMs` from now. */
  claim(target, now = Date.now()) {
    this.readyAtById.set(targetId(target), now + this.cooldownMs);
  }

  /**
   * Gives a claim back. Used when the call was never really made against the key
   * (the model was switched off, the target refused the request itself): that is
   * not a use of the key, so it must not cost it a minute.
   */
  release(target) {
    this.readyAtById.delete(targetId(target));
  }

  /** Forgets every cooldown (used when the selected model changes). */
  clear() {
    this.readyAtById.clear();
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
    health = null,
    checkpoint = () => {},
    maxWaitMs = ONE_MODEL_DEFAULT_MAX_WAIT_MS,
    onSkip = null
  } = {}
) {
  const ordered = [...(Array.isArray(targets) ? targets : [])]
    .sort((a, b) => (a.keyIndex ?? 0) - (b.keyIndex ?? 0));

  if (ordered.length === 0) {
    const err = new Error("No fully configured routing targets available");
    err.status = 503;
    throw err;
  }

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
    // Cooldown starts the moment the call is made, success or not.
    pacer.claim(target, now);
    const startedAt = Date.now();

    try {
      const result = await invoke(target, { phase: null });
      health?.markSuccess(target, { latencyMs: Date.now() - startedAt });
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
