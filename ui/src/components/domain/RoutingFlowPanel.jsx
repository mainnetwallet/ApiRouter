import { Fragment } from "react";
import { Icon } from "../ui/Icon.jsx";
import { PoolBadge } from "../ui/PoolBadge.jsx";
import { CROSS_POOL_FALLBACK, ROUTING_FLOW_STEPS, groupRankedByPool, poolLabel } from "../../lib/pools.js";
import { providerLabel, EMPTY } from "../../lib/format.js";

/**
 * Routing Flow (spec §8).
 *
 * A request enters exactly one pool, is served from that pool's targets, and on
 * failure falls back *within that pool only*. The panel says so explicitly —
 * nothing here implies text can fall back to vision or the reverse.
 *
 * The first-choice target per pool comes from `health.ranked`, which already
 * carries each target's pool, so no extra fetch is needed.
 */
export function RoutingFlowPanel({ ranked = [] }) {
  const byPool = groupRankedByPool(ranked);
  const firstOf = (pool) => byPool[pool][0] ?? null;

  return (
    <div className="panel">
      <div className="panel__header">
        <span className="panel__title">Routing Flow</span>
        <div className="panel__actions">
          <span className="badge badge--danger badge--static">{CROSS_POOL_FALLBACK.label}</span>
        </div>
      </div>

      <div className="panel__body">
        <ol className="flow">
          {ROUTING_FLOW_STEPS.map((step, index) => (
            <Fragment key={step.key}>
              {index > 0 ? (
                <li className="flow__arrow" aria-hidden="true">
                  <Icon name="arrowDown" size={12} />
                </li>
              ) : null}
              <li className={`flow__step${step.warn ? " flow__step--warn" : ""}`}>
                <span className="flow__num mono">{step.step}</span>
                <div className="flow__content">
                  <div className="flow__label">{step.label}</div>

                  {step.key === "incoming" ? (
                    <div className="flow__row">
                      <span className="flow__pool flow__pool--text">TEXT</span>
                      <span className="dim tiny">or</span>
                      <span className="flow__pool flow__pool--vision">VISION</span>
                    </div>
                  ) : null}

                  {step.key === "detect" ? (
                    <div className="flow__split">
                      <div className="flow__mini flow__mini--text">
                        <span className="flow__mini-title">TEXT</span>
                        <span className="dim tiny">chat / coding / reasoning</span>
                      </div>
                      <div className="flow__mini flow__mini--vision">
                        <span className="flow__mini-title">VISION</span>
                        <span className="dim tiny">image / multimodal</span>
                      </div>
                    </div>
                  ) : null}

                  {step.key === "pool" ? (
                    <div className="flow__split">
                      <PoolRoute pool="text" target={firstOf("text")} count={byPool.text.length} />
                      <PoolRoute pool="vision" target={firstOf("vision")} count={byPool.vision.length} />
                    </div>
                  ) : null}

                  {step.key === "chain" || step.key === "auto" ? (
                    <div className="flow__detail">{step.detail}</div>
                  ) : null}

                  {step.key === "fallback" ? (
                    <div className="flow__warning">
                      <Icon name="alert" size={13} />
                      <span>
                        <strong>{CROSS_POOL_FALLBACK.label}</strong>
                        <span className="dim"> — {CROSS_POOL_FALLBACK.detail}</span>
                      </span>
                    </div>
                  ) : null}
                </div>
              </li>
            </Fragment>
          ))}
        </ol>
      </div>
    </div>
  );
}

function PoolRoute({ pool, target, count }) {
  return (
    <div className={`flow__mini flow__mini--${pool}`}>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <PoolBadge pool={pool} />
        <span className="tiny dim mono">{count} target{count === 1 ? "" : "s"}</span>
      </div>
      <span className="flow__route truncate" title={target ? `${target.provider} / ${target.model}` : undefined}>
        {target
          ? `${providerLabel(target.provider)} / ${target.model ?? EMPTY}`
          : `${poolLabel(pool)} pool not configured`}
      </span>
    </div>
  );
}
