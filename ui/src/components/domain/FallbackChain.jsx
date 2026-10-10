import { Icon } from "../ui/Icon.jsx";
import { HealthBadge } from "../ui/HealthBadge.jsx";
import { LatencyBadge } from "../ui/LatencyBadge.jsx";
import { OrderLatency } from "./OrderLatency.jsx";
import { formatCountdown, protocolLabel } from "../../lib/format.js";

/**
 * The ordered fallback chain.
 *
 * Two modes, because the same question ("what happens when this fails?") has
 * two answers:
 *
 *   planned  the order `withFallback` will walk right now, given current health
 *   traced   the order a specific request actually walked, from its attempts
 *
 * Both are rendered by the same component so the two views cannot drift into
 * telling different stories about the same routing rule.
 */
export function FallbackChain({ targets, mode = "planned", emptyMessage = "No targets in the chain." }) {
  if (!targets || targets.length === 0) {
    return <div className="chart__empty">{emptyMessage}</div>;
  }

  return (
    <ol className="chain" aria-label={mode === "planned" ? "Planned fallback order" : "Attempted fallback order"}>
      {targets.map((target, index) => (
        <li className="chain__item" key={target.id ?? `${target.provider}-${target.model}-${target.keyIndex}-${index}`}>
          {index > 0 ? (
            <div className={`chain__connector chain__connector--${connectorTone(target, mode)}`}>
              <Icon name="arrowDown" className="chain__arrow" size={12} />
              <span>{connectorLabel(target, mode)}</span>
            </div>
          ) : null}

          <ChainCard target={target} index={index} mode={mode} />
        </li>
      ))}
    </ol>
  );
}

function connectorLabel(target, mode) {
  if (mode === "traced") {
    return target.ok ? "succeeded — chain stopped" : "failed — moved to next target";
  }
  if (!target.available) return "in cooldown — skipped by the router";
  return "tried next only if the one above fails";
}

function connectorTone(target, mode) {
  if (mode === "traced") return target.ok ? "success" : "failed";
  return target.available ? "" : "failed";
}

function ChainCard({ target, index, mode }) {
  const isTraced = mode === "traced";
  const status = isTraced ? (target.ok ? "healthy" : "failed") : target.status;

  const classes = ["chain__card", `chain__card--${toneFor(status)}`];
  if (index === 0 && !isTraced) classes.push("chain__card--selected");
  if (isTraced && !target.ok) classes.push("chain__card--attempted-failed");

  const cooldown = formatCountdown(target.cooldownUntil);

  return (
    <div className={classes.join(" ")}>
      <span className="chain__rank" aria-hidden="true">{index + 1}</span>

      <div className="chain__main">
        <div className="chain__target">
          <span className="chain__provider">{target.provider}</span> / {target.model ?? "unknown"}
        </div>
        <div className="chain__meta">
          <span>key {target.keyIndex ?? "?"}</span>
          {target.protocols?.length ? <span>{protocolLabel(target.protocols[0])}</span> : null}
          {Number.isFinite(target.score) ? <span>score {Math.round(target.score)}</span> : null}
          <OrderLatency item={target} />
          {Number.isFinite(target.latencyMs) ? (
            <span>last <LatencyBadge ms={target.latencyMs} /></span>
          ) : null}
          {cooldown ? <span>cooldown {cooldown} left</span> : null}
        </div>
        {target.lastReason || target.errorMessage ? (
          <div className="chain__meta" title="Last observed reason">
            <span className="truncate">{target.lastReason ?? target.errorMessage}</span>
          </div>
        ) : null}
      </div>

      <div className="chain__side">
        {index === 0 && !isTraced ? <span className="tiny dim">primary</span> : null}
        <HealthBadge status={status} />
      </div>
    </div>
  );
}

function toneFor(status) {
  if (status === "healthy") return "ok";
  if (status === "cooldown") return "warn";
  if (status === "failed") return "danger";
  return "neutral";
}

/**
 * Animation of a request walking the chain.
 *
 * Shows real recorded attempts only — the brief asks for "real request events
 * if available", and the gateway records every upstream try, so there is no
 * need to simulate. The steps appear in the order they happened.
 */
export function FallbackTraceAnimation({ attempts, outcome }) {
  if (!attempts || attempts.length === 0) {
    return <div className="chart__empty">No upstream attempts were recorded for this request.</div>;
  }

  return (
    <ol className="chain" aria-label="Attempt sequence">
      {attempts.map((attempt, index) => (
        <li className="chain__item" key={attempt.index ?? index}>
          {index > 0 ? (
            <div className={`chain__connector chain__connector--${attempt.ok ? "success" : "failed"}`}>
              <Icon name="arrowDown" className="chain__arrow" size={12} />
              <span>{attempt.ok ? "SUCCESS" : "FAILED — falling back"}</span>
            </div>
          ) : null}
          <div className={`chain__card chain__card--${attempt.ok ? "ok" : "danger"}`}>
            <span className="chain__rank">{attempt.index ?? index + 1}</span>
            <div className="chain__main">
              <div className="chain__target">
                <span className="chain__provider">{attempt.provider}</span> / {attempt.model ?? "unknown"}
              </div>
              <div className="chain__meta">
                <span>key {attempt.keyIndex ?? "?"}</span>
                {attempt.status ? <span>HTTP {attempt.status}</span> : null}
                {attempt.errorMessage ? <span className="truncate">{attempt.errorMessage}</span> : null}
              </div>
            </div>
            <div className="chain__side">
              <span className="tiny" style={{ color: attempt.ok ? "var(--ok)" : "var(--danger)" }}>
                {attempt.ok ? "SUCCESS" : "FAILED"}
              </span>
            </div>
          </div>
        </li>
      ))}
      <li className="chain__item">
        <div className={`chain__connector chain__connector--${outcome === "success" ? "success" : "failed"}`}>
          <Icon name="arrowDown" className="chain__arrow" size={12} />
          <span>{outcome === "success" ? "COMPLETED" : "ALL TARGETS EXHAUSTED"}</span>
        </div>
      </li>
    </ol>
  );
}
