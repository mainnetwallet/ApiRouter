import { Icon } from "./Icon.jsx";

/**
 * A single headline figure.
 *
 * `value === null` renders as an explicit "n/a" rather than a zero: the
 * difference between "no traffic recorded" and "all traffic failing" is the
 * whole point of the metric, and a fabricated zero destroys it.
 */
export function MetricCard({ label, value, hint = null, tone = null, icon = null, title = null, small = false }) {
  const unavailable = value === null || value === undefined;

  return (
    <div className={`metric${tone ? ` metric--${tone}` : ""}`} title={title ?? undefined}>
      <div className="metric__label">
        {icon ? <Icon name={icon} size={12} /> : null}
        <span className="truncate">{label}</span>
      </div>
      <div
        className={`metric__value${small ? " metric__value--sm" : ""}${unavailable ? " metric__value--muted" : ""}`}
      >
        {unavailable ? "n/a" : value}
      </div>
      {hint ? <div className="metric__hint">{hint}</div> : null}
    </div>
  );
}
