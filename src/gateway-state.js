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
 * State is in-memory and resets to "running" on process restart, like the
 * rest of the telemetry.
 */
export class GatewayState {
  #paused = false;
  #since = null;
  #reason = null;

  get paused() { return this.#paused; }

  pause(reason = null, now = Date.now()) {
    if (!this.#paused) {
      this.#paused = true;
      this.#since = now;
    }
    this.#reason = reason ? String(reason).slice(0, 200) : this.#reason;
    return this.snapshot(now);
  }

  resume(now = Date.now()) {
    this.#paused = false;
    this.#since = null;
    this.#reason = null;
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
