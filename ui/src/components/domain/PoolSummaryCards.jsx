import { Icon } from "../ui/Icon.jsx";
import { PoolBadge } from "../ui/PoolBadge.jsx";
import { poolLabel } from "../../lib/pools.js";
import { formatNumber, formatPercent } from "../../lib/format.js";

/**
 * The two headline pool cards (spec §1 / §10).
 *
 * Each card is fed a `summarizePool` result, which is already pool-scoped —
 * no figure here is ever the sum of both pools. A value that is genuinely
 * absent renders "n/a" rather than 0, so "not configured" and "all failing"
 * cannot look the same.
 */
export function PoolSummaryCards({ text, vision }) {
  return (
    <div className="pool-cards">
      <PoolSummaryCard pool="text" summary={text} />
      <PoolSummaryCard pool="vision" summary={vision} />
    </div>
  );
}

function PoolSummaryCard({ pool, summary }) {
  const stats = summary ?? {};
  const counts = stats.counts ?? {};
  const total = (counts.healthy ?? 0) + (counts.cooldown ?? 0) + (counts.failed ?? 0) + (counts.unknown ?? 0);

  return (
    <div className={`pool-card pool-card--${pool}`}>
      <div className="pool-card__head">
        <Icon name={pool === "vision" ? "image" : "terminal"} size={15} className="pool-card__icon" />
        <PoolBadge pool={pool} />
        <span className="pool-card__title">{poolLabel(pool)} Pool</span>
        <span className="pool-card__providers mono">
          {finite(stats.providers)} providers configured
        </span>
      </div>

      <div className="pool-card__stats">
        <PoolStat label="Models" value={stats.models} />
        <PoolStat label="Targets" value={stats.targets} />
        <PoolStat label="Healthy" value={stats.healthy} tone="ok" />
        <PoolStat label="Cooldown" value={stats.cooldown} tone="warn" />
        <PoolStat label="Failed" value={stats.failed} tone="danger" />
      </div>

      <div className="pool-card__meter">
        <div
          className="health-bar"
          role="img"
          aria-label={total === 0
            ? `${poolLabel(pool)} pool has no configured targets`
            : `${poolLabel(pool)} pool: ${counts.healthy ?? 0} healthy, ${counts.cooldown ?? 0} cooldown, ${counts.failed ?? 0} failed, ${counts.unknown ?? 0} unknown`}
        >
          {total > 0 ? (
            <>
              <span className="health-bar__seg health-bar__seg--ok" style={{ width: `${((counts.healthy ?? 0) / total) * 100}%` }} />
              <span className="health-bar__seg health-bar__seg--warn" style={{ width: `${((counts.cooldown ?? 0) / total) * 100}%` }} />
              <span className="health-bar__seg health-bar__seg--danger" style={{ width: `${((counts.failed ?? 0) / total) * 100}%` }} />
              <span className="health-bar__seg health-bar__seg--neutral" style={{ width: `${((counts.unknown ?? 0) / total) * 100}%` }} />
            </>
          ) : null}
        </div>
        <span className="pool-card__pct mono">
          {stats.healthPercent === null || stats.healthPercent === undefined
            ? "n/a"
            : `${formatPercent(stats.healthPercent)} Healthy`}
        </span>
      </div>
    </div>
  );
}

function PoolStat({ label, value, tone = null }) {
  return (
    <div className="pool-stat">
      <span className="pool-stat__label">{label}</span>
      <span className={`pool-stat__value mono${tone ? ` pool-stat__value--${tone}` : ""}${!Number.isFinite(value) ? " is-empty" : ""}`}>
        {finite(value)}
      </span>
    </div>
  );
}

/** An absent figure reads "n/a"; a genuine count reads as itself (never blank). */
function finite(value) {
  return Number.isFinite(value) ? formatNumber(value) : "n/a";
}
