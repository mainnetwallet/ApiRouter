/**
 * Observes health-monitor cycles without modifying the monitor.
 *
 * `startHealthMonitor` (`src/health.js`) intentionally exposes only a stop
 * function, and its behaviour is pinned by tests. Rather than change that
 * contract, the server hands the monitor a *wrapped* probe function: the
 * wrapper sees every probe call, which is enough to reconstruct cycle count,
 * duration, outcome mix, and the next scheduled cycle.
 *
 * Cycle boundaries are inferred from in-flight probe count going 0 -> 1
 * (cycle start) and the last probe of the cycle completing (cycle end).
 * `refreshAllHealth` runs cycles strictly non-overlapping, so this inference
 * is exact for any non-empty target list.
 */
export class HealthMonitorState {
  #pending = 0;
  #completedInCycle = 0;
  #outcomes = { healthy: 0, failed: 0, passive: 0 };
  #startedAt = null;

  constructor({ intervalMs, targetCount = 0 } = {}) {
    this.intervalMs = intervalMs;
    this.targetCount = targetCount;

    this.enabled = true;
    this.running = false;
    this.cycles = 0;
    this.lastCycle = null;
    this.manualRunInProgress = false;
    this.startedAt = new Date().toISOString();
  }

  #beginCycle() {
    this.running = true;
    this.#completedInCycle = 0;
    this.#outcomes = { healthy: 0, failed: 0, passive: 0 };
    this.#startedAt = Date.now();
  }

  #endCycle() {
    const completedAt = Date.now();
    this.cycles += 1;
    this.running = false;
    this.lastCycle = {
      startedAt: new Date(this.#startedAt).toISOString(),
      completedAt: new Date(completedAt).toISOString(),
      completedAtMs: completedAt,
      durationMs: completedAt - this.#startedAt,
      probes: this.#completedInCycle,
      outcomes: { ...this.#outcomes }
    };
    this.#startedAt = null;
  }

  /** Wrap a probe function so cycles become observable. */
  wrapCheck(check) {
    return async (target) => {
      if (this.#pending === 0) this.#beginCycle();
      this.#pending += 1;

      let outcome = "failed";
      try {
        const result = await check(target);
        outcome = result?.ok === true ? "healthy" : result?.ok === false ? "failed" : "passive";
        return result;
      } finally {
        this.#outcomes[outcome] += 1;
        this.#pending -= 1;
        this.#completedInCycle += 1;
        if (this.targetCount > 0 && this.#completedInCycle >= this.targetCount) {
          this.#endCycle();
        }
      }
    };
  }

  /**
   * Run one operator-triggered cycle. Refuses to start while another cycle is
   * in flight, so a manual refresh cannot interleave with the interval timer.
   */
  async runManualCycle(refresh) {
    if (this.manualRunInProgress || this.#pending > 0 || this.running) {
      return { started: false, reason: "a health cycle is already running" };
    }

    this.manualRunInProgress = true;
    const startedAt = Date.now();
    try {
      const results = await refresh();
      return {
        started: true,
        durationMs: Date.now() - startedAt,
        probes: Array.isArray(results) ? results.length : null
      };
    } catch (error) {
      return {
        started: true,
        durationMs: Date.now() - startedAt,
        error: "health cycle failed"
      };
    } finally {
      this.manualRunInProgress = false;
    }
  }

  stop() {
    this.enabled = false;
  }

  snapshot(now = Date.now()) {
    const nextCycleAtMs = this.lastCycle?.completedAtMs
      ? this.lastCycle.completedAtMs + this.intervalMs
      : this.startedAt
        ? Date.parse(this.startedAt) + this.intervalMs
        : null;

    return {
      enabled: this.enabled,
      running: this.running || this.manualRunInProgress,
      inFlightProbes: this.#pending,
      intervalMs: this.intervalMs,
      targetCount: this.targetCount,
      cycles: this.cycles,
      lastCycle: this.lastCycle
        ? {
            startedAt: this.lastCycle.startedAt,
            completedAt: this.lastCycle.completedAt,
            durationMs: this.lastCycle.durationMs,
            probes: this.lastCycle.probes,
            outcomes: this.lastCycle.outcomes
          }
        : null,
      nextCycleAt: nextCycleAtMs ? new Date(nextCycleAtMs).toISOString() : null
    };
  }
}
