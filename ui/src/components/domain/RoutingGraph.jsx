import { Icon } from "../ui/Icon.jsx";

/**
 * The routing pipeline.
 *
 * Renders the stages the backend reports for a routing decision. Nothing is
 * inferred here: `stages` comes straight from `/api/router/preview`, which
 * runs the same selection and ranking code the live proxy runs. If the
 * pipeline ever changes, this diagram changes with it.
 */
export function RoutingGraph({ stages, targetIdentity = null }) {
  if (!stages || stages.length === 0) {
    return <div className="chart__empty">No routing decision available.</div>;
  }

  return (
    <div>
      <ol className="stages" aria-label="Routing pipeline">
        {stages.map((stage, index) => (
          <li key={stage.key}>
            {index > 0 ? (
              <div className="stage-arrow" aria-hidden="true">
                <Icon name="arrowDown" className="stage-arrow__icon" size={12} />
              </div>
            ) : null}
            <div className={`stage stage--${stage.state ?? "info"}`}>
              <span className="stage__step" aria-hidden="true">{index + 1}</span>
              <div>
                <div className="stage__label">{stage.label}</div>
                <div className="stage__detail">{stage.detail}</div>
              </div>
              {Number.isFinite(stage.count) ? (
                <span className="stage__count">{stage.count}</span>
              ) : null}
            </div>
          </li>
        ))}
      </ol>

      {targetIdentity ? (
        <p className="tiny dim" style={{ marginTop: "var(--sp-3)" }}>
          Targets are identified as <code>{targetIdentity}</code>, so one failing key never affects
          its siblings.
        </p>
      ) : null}
    </div>
  );
}
