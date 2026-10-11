import fs from "node:fs";
import path from "node:path";

/**
 * Master on/off switch for the gateway.
 *
 * "Shut down" here means PAUSED, not process exit: the HTTP server, the
 * Control Panel and the admin API stay up (so the UI can turn it back on),
 * but nothing talks to an upstream provider while paused:
 *   - proxy requests (/v1/..., /v1beta/...) are answered with 503
 *   - the periodic health monitor skips its cycles
 *   - a manual health refresh is refused
 *
 * The state is persisted to `file` (when given) so a shutdown survives a
 * restart: the next boot reads it back and stays paused until Resume. A missing
 * or unreadable file means "running". Persistence is best effort - a write that
 * fails is logged and never blocks the switch itself. Note that on hosts with
 * an ephemeral disk (Render without a persistent disk) a redeploy wipes the
 * file, which turns the gateway back on.
 */
export class GatewayState {
  #paused = false;
  #since = null;
  #reason = null;
  #file = null;

  constructor({ file = null } = {}) {
    this.#file = file ? path.resolve(file) : null;
    this.#load();
  }

  #load() {
    if (!this.#file) return;
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(this.#file, "utf8"));
    } catch (error) {
      if (error?.code !== "ENOENT") {
        console.warn(`gateway state: ignoring unreadable ${path.basename(this.#file)}`);
      }
      return;
    }
    if (parsed?.paused !== true) return;
    const at = Date.parse(parsed.pausedAt);
    this.#paused = true;
    this.#since = Number.isFinite(at) ? at : Date.now();
    this.#reason = typeof parsed.reason === "string" ? parsed.reason.slice(0, 200) : null;
  }

  #save() {
    if (!this.#file) return;
    try {
      fs.mkdirSync(path.dirname(this.#file), { recursive: true });
      const tmp = `${this.#file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({
        paused: this.#paused,
        pausedAt: this.#since ? new Date(this.#since).toISOString() : null,
        reason: this.#reason
      }, null, 2));
      fs.renameSync(tmp, this.#file);
    } catch (error) {
      console.warn(`gateway state: could not persist (${error?.code || error?.message})`);
    }
  }

  get paused() { return this.#paused; }

  pause(reason = null, now = Date.now()) {
    if (!this.#paused) {
      this.#paused = true;
      this.#since = now;
    }
    this.#reason = reason ? String(reason).slice(0, 200) : this.#reason;
    this.#save();
    return this.snapshot(now);
  }

  resume(now = Date.now()) {
    this.#paused = false;
    this.#since = null;
    this.#reason = null;
    this.#save();
    return this.snapshot(now);
  }

  snapshot(now = Date.now()) {
    return {
      state: this.#paused ? "paused" : "running",
      paused: this.#paused,
      pausedAt: this.#since ? new Date(this.#since).toISOString() : null,
      pausedForMs: this.#since ? Math.max(0, now - this.#since) : 0,
      reason: this.#reason
    };
  }
}
