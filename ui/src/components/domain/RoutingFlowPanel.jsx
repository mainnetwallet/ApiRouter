/**
 * Routing Flow (spec §8).
 *
 * A request declares the capabilities it needs (derived from its content and
 * request type), and the router walks eligible targets — those whose declared
 * capabilities an adapter can execute — through the unified Fallback Chain.
 * Nothing here implies one modality can fall back into another: a target is
 * either eligible for the request's capabilities or it is not.
 *
 * `ranked` comes from `GET /api/health`: the current ordered set of routable
 * targets (health and manual selection applied). It is a general ordering, not
 * a request-specific eligibility result — each request is further constrained
 * by protocol, required capabilities, adapter execution support, enabled
 * switches, key availability and cooldowns.
 */
import { Icon } from "../ui/Icon.jsx";
import { providerLabel, EMPTY } from "../../lib/format.js";

export function RoutingFlowPanel({ ranked = [] }) {
  const list = Array.isArray(ranked) ? ranked : [];
  const top = list[0] ?? null;
  const orderedCount = list.length;

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
                <span className="flow__cap flow__cap--req">text input</span>
                <span className="dim tiny">+</span>
                <span className="dim tiny">anything the request carries</span>
              </div>
            </div>
          </li>
          <li className="flow__step">
            <span className="flow__num mono">2</span>
            <div className="flow__content">
              <div className="flow__label">Detect Required Capabilities</div>
              <div className="flow__detail">
                Image parts add an image_input requirement. Tool use adds
                tool_calling. Plain chat needs text_input and text output only.
                Every requirement must be declared by a model — capabilities are
                never inferred from a model name, provider or protocol.
              </div>
            </div>
          </li>
          <li className="flow__step">
            <span className="flow__num mono">3</span>
            <div className="flow__content">
              <div className="flow__label">Route to Eligible Targets</div>
              <div className="flow__eligible">
                <span className="flow__cap flow__cap--req">ordered</span>
                <span className="tiny dim mono">{orderedCount} target{orderedCount === 1 ? "" : "s"}</span>
                <span className="flow__route truncate" title={top ? `${top.provider} / ${top.model}` : undefined}>
                  {top
                    ? `${providerLabel(top.provider)} / ${top.model ?? EMPTY}`
                    : `no ordered target`}
                </span>
              </div>
              <div className="flow__detail" style={{ marginTop: "var(--sp-2)" }}>
                The first target in the current fallback order is not
                automatically eligible for every request: protocol, required
                capabilities, adapter execution support, key availability and
                cooldowns all still apply.
              </div>
            </div>
          </li>
          <li className="flow__step">
            <span className="flow__num mono">4</span>
            <div className="flow__content">
              <div className="flow__label">Walk the Fallback Chain</div>
              <div className="flow__detail">
                The configured order, exactly as saved. Every eligible API key
                of a model is tried, in key order, before the next model. Health
                only skips targets that are cooling down.
              </div>
            </div>
          </li>
          <li className="flow__step">
            <span className="flow__num mono">5</span>
            <div className="flow__content">
              <div className="flow__label">Automatic Health-Based Fallback</div>
              <div className="flow__detail">
                Used when no chain is configured, and as fallback after a saved
                selection is exhausted: healthy models with lower measured
                latency first, unmeasured models in a stable order.
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
