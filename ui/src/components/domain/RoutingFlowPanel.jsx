import { Fragment } from "react";
import { Icon } from "../ui/Icon.jsx";
import { providerLabel, EMPTY } from "../../lib/format.js";

/**
 * Routing Flow (spec §8).
 *
 * A request declares the capabilities it needs, and the router walks eligible
 * targets — those whose capabilities cover the request — through the fallback
 * chain. Nothing here implies one modality can fall back into another: a target
 * is either eligible for the request's capabilities or it is not.
 *
 * The first-choice target per capability set comes from `health.ranked`, which
 * already carries each target's capabilities, so no extra fetch is needed.
 */
export function RoutingFlowPanel({ ranked = [] }) {
  const top = ranked[0] ?? null;
  const eligibleCount = ranked.filter((r) => r?.eligible !== false).length;

  return (
    <div className="panel">
      <div className="panel__header">
        <span className="panel__title">Routing Flow</span>
        <div className="panel__actions">
          <span className="badge badge--info badge--static">CAPABILITY-ROUTED</span>
        </div>
      </div>

      <div className="panel__body">
        <ol className="flow">
          <li className="flow__step">
            <span className="flow__num mono">1</span>
            <div className="flow__content">
              <div className="flow__label">Incoming Request</div>
              <div className="flow__row">
                <span className="flow__cap flow__cap--text">text</span>
                <span className="dim tiny">+</span>
                <span className="flow__cap flow__cap--vision">vision</span>
              </div>
            </div>
          </li>
          <li className="flow__step">
            <span className="flow__num mono">2</span>
            <div className="flow__content">
              <div className="flow__label">Detect Required Capabilities</div>
              <div className="flow__split">
                <div className="flow__mini flow__mini--text">
                  <span className="flow__mini-title">text</span>
                  <span className="dim tiny">chat / coding / reasoning</span>
                </div>
                <div className="flow__mini flow__mini--vision">
                  <span className="flow__mini-title">vision</span>
                  <span className="dim tiny">image / multimodal</span>
                </div>
              </div>
            </div>
          </li>
          <li className="flow__step">
            <span className="flow__num mono">3</span>
            <div className="flow__content">
              <div className="flow__label">Route to Eligible Targets</div>
              <div className="flow__split">
                <EligibleRoute label="text" target={top} count={eligibleCount} />
                <EligibleRoute label="vision" target={top} count={eligibleCount} />
              </div>
            </div>
          </li>
          <li className="flow__step">
            <span className="flow__num mono">4</span>
            <div className="flow__content">
              <div className="flow__label">Walk the Fallback Chain</div>
              <div className="flow__detail">
                The configured order for this capability set, exactly as saved.
                Every eligible API key of a model is tried, in key order, before
                the next model. Health only skips targets that are cooling down.
              </div>
            </div>
          </li>
          <li className="flow__step">
            <span className="flow__num mono">5</span>
            <div className="flow__content">
              <div className="flow__label">Automatic Health-Based Fallback</div>
              <div className="flow__detail">
                Used when no chain is configured, or when the automatic mode is
                selected: healthy models with lower measured latency first,
                unmeasured models in a stable configured order.
              </div>
            </div>
          </li>
          <li className="flow__step flow__step--warn">
            <span className="flow__num mono">6</span>
            <div className="flow__content">
              <div className="flow__label">Fallback (Eligible Targets Only)</div>
              <div className="flow__warning">
                <Icon name="alert" size={13} />
                <span>
                  A failed request is retried only among targets that cover the
                  request&rsquo;s required capabilities.
                </span>
              </div>
            </div>
          </li>
        </ol>
      </div>
    </div>
  );
}

function EligibleRoute({ label, target, count }) {
  return (
    <div className={`flow__mini flow__mini--${label}`}>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <span className="flow__cap flow__cap--{label}">{label.toUpperCase()}</span>
        <span className="tiny dim mono">{count} target{count === 1 ? "" : "s"}</span>
      </div>
      <span className="flow__route truncate" title={target ? `${target.provider} / ${target.model}` : undefined}>
        {target
          ? `${providerLabel(target.provider)} / ${target.model ?? EMPTY}`
          : `no eligible target for ${label}`}
      </span>
    </div>
  );
}
