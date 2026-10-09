import { Icon } from "../ui/Icon.jsx";
import { formatLatency, formatTime, protocolLabel, providerLabel } from "../../lib/format.js";
import { describeAttempt } from "../../lib/errors.js";
import { phaseLabel as phaseName } from "../../lib/fallbackChain.js";

/**
 * The lifecycle of one routed request.
 *
 * Derived from the recorded attempt list rather than invented: the gateway
 * records every upstream try, so the stages here are a rendering of what
 * actually happened, including the fallback hops. A request that fell back
 * twice shows two failed targets and the fallback between them.
 */
/** "Fallback chain" / "Remembered" prefix for a recorded attempt; empty for rows without one. */
export const phaseLabel = (attempt) => phaseName(attempt?.phase) ?? "";

export function buildLifecycle(entry) {
  if (!entry) return [];

  const stages = [
    {
      key: "received",
      stage: "Received",
      title: protocolLabel(entry.protocol),
      meta: formatTime(entry.receivedAt),
      tone: "info"
    },
    {
      key: "routing",
      stage: "Routing",
      title: entry.autoRouted
        ? "Auto route — gateway selected the target"
        : entry.requestedModel
          ? `Pinned model: ${entry.requestedModel}`
          : "No model requested — all compatible targets eligible",
      meta: entry.requestedModel ?? null,
      tone: "info"
    }
  ];

  const attempts = Array.isArray(entry.attempts) ? entry.attempts : [];

  attempts.forEach((attempt, index) => {
    const verdict = describeAttempt(attempt);
    const phase = phaseLabel(attempt);
    const kind = attempt.skipped ? "Skipped" : attempt.ok ? "Target" : "Target failed";

    stages.push({
      key: `attempt-${attempt.index ?? index}`,
      stage: `${phase ? `${phase} · ` : ""}${kind} ${attempt.index ?? index + 1}`,
      title: `${providerLabel(attempt.provider)} / ${attempt.model ?? "unknown"} · key ${attempt.keyIndex ?? "?"}`,
      meta: [
        attempt.status ? `HTTP ${attempt.status}` : null,
        Number.isFinite(attempt.latencyMs) ? formatLatency(attempt.latencyMs) : null,
        verdict.label
      ].filter(Boolean).join(" · "),
      detail: attempt.errorMessage || null,
      tone: attempt.ok ? "ok" : verdict.tone
    });

    if (!attempt.ok && !attempt.skipped && index < attempts.length - 1) {
      stages.push({
        key: `fallback-${index}`,
        stage: "Fallback",
        title: "Routing moved to the next eligible target",
        meta: `attempt ${index + 2} of ${attempts.length}`,
        tone: "warn"
      });
    }
  });

  stages.push({
    key: "completed",
    stage: "Completed",
    title:
      entry.outcome === "success"
        ? `Served by ${providerLabel(entry.finalProvider)} / ${entry.finalModel ?? "unknown"}`
        : "No target could serve the request",
    meta: [
      entry.httpStatus ? `HTTP ${entry.httpStatus}` : null,
      Number.isFinite(entry.totalMs) ? `total ${formatLatency(entry.totalMs)}` : null,
      entry.fallbackCount > 0 ? `${entry.fallbackCount} fallback${entry.fallbackCount === 1 ? "" : "s"}` : "no fallback"
    ].filter(Boolean).join(" · "),
    detail: entry.errorMessage || null,
    tone: entry.outcome === "success" ? "ok" : "danger"
  });

  return stages;
}

export function RequestTimeline({ entry }) {
  const stages = buildLifecycle(entry);
  if (stages.length === 0) return null;

  return (
    <ol className="timeline" aria-label="Request lifecycle">
      {stages.map((stage) => (
        <li className="timeline__item" key={stage.key}>
          <div className="timeline__rail">
            <span className={`timeline__dot timeline__dot--${stage.tone}`} aria-hidden="true" />
            <span className="timeline__line" aria-hidden="true" />
          </div>
          <div className="timeline__content">
            <div className="timeline__stage">{stage.stage}</div>
            <div className="timeline__title">{stage.title}</div>
            {stage.meta ? <div className="timeline__meta">{stage.meta}</div> : null}
            {stage.detail ? <div className="timeline__detail">{stage.detail}</div> : null}
          </div>
        </li>
      ))}
    </ol>
  );
}

/**
 * The fallback hops of a request, compressed to a single line each — the shape
 * an operator wants when scanning several requests rather than inspecting one.
 */
export function FallbackTrace({ entry }) {
  const attempts = Array.isArray(entry?.attempts) ? entry.attempts : [];
  if (attempts.length === 0) {
    return <span className="dim tiny">no upstream attempts recorded</span>;
  }

  return (
    <div className="stack stack--tight">
      {attempts.map((attempt, index) => {
        const verdict = describeAttempt(attempt);
        return (
          <div key={attempt.index ?? index} className={`chain__card chain__card--${attempt.ok ? "ok" : verdict.tone}`}>
            <span className="chain__rank">{attempt.index ?? index + 1}</span>
            <div className="chain__main">
              <div className="chain__target">
                <span className="chain__provider">{providerLabel(attempt.provider)}</span> / {attempt.model ?? "unknown"}
              </div>
              <div className="chain__meta">
                {phaseLabel(attempt) ? <span>{phaseLabel(attempt)}</span> : null}
                <span>key {attempt.keyIndex ?? "?"}</span>
                {attempt.status ? <span>HTTP {attempt.status}</span> : null}
                {Number.isFinite(attempt.latencyMs) ? <span>{formatLatency(attempt.latencyMs)}</span> : null}
              </div>
            </div>
            <div className="chain__side">
              <span className={`tiny ${attempt.ok ? "" : "muted"}`} style={{ color: attempt.ok ? "var(--ok)" : undefined }}>
                {verdict.label}
              </span>
              <Icon name={attempt.ok ? "check" : "close"} size={13} />
            </div>
          </div>
        );
      })}
    </div>
  );
}
