import { useEffect, useMemo, useRef, useState } from "react";
import { PageHeader } from "../components/layout/PageHeader.jsx";
import { DataTable } from "../components/ui/DataTable.jsx";
import { FilterBar, FilterSelect } from "../components/ui/FilterBar.jsx";
import { SearchInput } from "../components/ui/SearchInput.jsx";
import { HealthBadge } from "../components/ui/HealthBadge.jsx";
import { LatencyBadge } from "../components/ui/LatencyBadge.jsx";
import { MetricCard } from "../components/ui/MetricCard.jsx";
import { MetricSkeleton } from "../components/ui/LoadingSkeleton.jsx";
import { EmptyState } from "../components/ui/EmptyState.jsx";
import { ErrorState } from "../components/ui/ErrorState.jsx";
import { Icon } from "../components/ui/Icon.jsx";
import { HealthDistribution } from "../components/charts/Charts.jsx";
import { useHealth } from "../context/HealthContext.jsx";
import { useDebouncedValue } from "../hooks/useDebounce.js";
import { matchesSearch, nextSort, sortRows } from "../lib/table.js";
import {
  formatCountdown, formatDateTime, formatDuration, formatNumber,
  formatRelativeTime, protocolLabel, providerLabel, EMPTY
} from "../lib/format.js";

/**
 * Health monitor.
 *
 * The authoritative view of every routing target. All values come straight from
 * `/api/health`; nothing here is inferred except the transition log, which is
 * derived from observably different consecutive snapshots and labelled as such.
 *
 * The cooldown countdown re-renders on its own one-second ticker, isolated in
 * `CooldownCell`, so a ticking clock never re-renders the table.
 */
export default function HealthMonitor() {
  const {
    targets, summary, providers, monitor, error, loading,
    reload, runManualRefresh, manualBusy, lastUpdatedAt, refreshing,
    autoRefresh, setAutoRefresh
  } = useHealth();

  const [search, setSearch] = useState("");
  const [provider, setProvider] = useState(null);
  const [status, setStatus] = useState(null);
  const [sort, setSort] = useState({ key: "status", direction: "asc" });

  const debouncedSearch = useDebouncedValue(search, 220);
  const transitions = useHealthTransitions(targets);

  const providerOptions = useMemo(
    () => [...new Set(targets.map((target) => target.provider))].sort(),
    [targets]
  );

  const filtered = useMemo(() => {
    let result = targets;
    if (provider) result = result.filter((target) => target.provider === provider);
    if (status) result = result.filter((target) => target.status === status);
    result = result.filter((target) => matchesSearch(target, debouncedSearch, [
      (item) => item.model,
      (item) => item.provider,
      (item) => item.lastReason ?? ""
    ]));
    return sortRows(result, COLUMN_ACCESSORS, sort);
  }, [targets, provider, status, debouncedSearch, sort]);

  if (loading && targets.length === 0) {
    return (
      <div className="page">
        <PageHeader title="Health Monitor" description="Every routing target, its score and cooldown state" />
        <MetricSkeleton count={4} />
      </div>
    );
  }

  return (
    <div className="page">
      <PageHeader
        title="Health Monitor"
        description="Every routing target, its score and cooldown state"
        lastUpdatedAt={lastUpdatedAt}
        refreshing={refreshing}
        paused={!autoRefresh}
        actions={
          <>
            <button
              type="button"
              className="btn"
              onClick={() => setAutoRefresh(!autoRefresh)}
              aria-pressed={autoRefresh}
              title={autoRefresh ? "Pause automatic polling" : "Resume automatic polling"}
            >
              <Icon name={autoRefresh ? "stop" : "play"} className="btn__icon" size={12} />
              {autoRefresh ? "Pause auto refresh" : "Resume auto refresh"}
            </button>
            <button type="button" className="btn" onClick={reload} disabled={refreshing}>
              <Icon name="refresh" className="btn__icon" size={13} />
              Reload
            </button>
            <button
              type="button"
              className="btn btn--primary"
              onClick={runManualRefresh}
              disabled={manualBusy}
              title="Ask the gateway to probe every provider now"
            >
              {manualBusy ? <span className="spinner" aria-hidden="true" /> : <Icon name="zap" className="btn__icon" size={13} />}
              Run health cycle
            </button>
          </>
        }
      />

      {error ? <ErrorState error={error} onRetry={reload} compact /> : null}

      <section className="section">
        <div className="metrics">
          <MetricCard label="Targets" value={formatNumber(summary?.total)} icon="box" hint="provider + model + key" />
          <MetricCard label="Healthy" value={formatNumber(summary?.healthy)} tone={summary?.healthy > 0 ? "ok" : null} icon="check" />
          <MetricCard label="Cooldown" value={formatNumber(summary?.cooldown)} tone={summary?.cooldown > 0 ? "warn" : null} icon="clock" />
          <MetricCard label="Failed" value={formatNumber(summary?.failed)} tone={summary?.failed > 0 ? "danger" : null} icon="alert" />
        </div>
      </section>

      <section className="section">
        <HealthDistribution counts={summary} />
      </section>

      <MonitorStatus monitor={monitor} />

      <div className="panel section">
        <FilterBar
          actions={
            <span className="tiny dim nowrap">
              {filtered.length} of {targets.length} targets
            </span>
          }
        >
          <div className="field filter-bar__search">
            <label className="field__label" htmlFor="health-search">Search</label>
            <SearchInput
              id="health-search"
              value={search}
              onChange={setSearch}
              label="Search targets"
              placeholder="Model, provider or reason…"
            />
          </div>
          <FilterSelect label="Provider" value={provider} onChange={setProvider} options={providerOptions} />
          <FilterSelect
            label="Status"
            value={status}
            onChange={setStatus}
            options={["healthy", "cooldown", "failed", "unknown"]}
          />
        </FilterBar>

        <DataTable
          columns={COLUMNS}
          rows={filtered}
          sort={sort}
          onSortChange={(next) => setSort(next)}
          rowKey={(row) => row.id}
          caption="Routing targets and their observed health"
          emptyState={
            targets.length === 0 ? (
              <EmptyState title="No routing targets" icon="server">
                A provider becomes routable once it has API keys, models and a base URL configured.
              </EmptyState>
            ) : (
              <EmptyState title="No targets match these filters" icon="filter">
                <button
                  type="button"
                  className="btn btn--sm"
                  onClick={() => { setSearch(""); setProvider(null); setStatus(null); }}
                >
                  Clear filters
                </button>
              </EmptyState>
            )
          }
        />
      </div>

      <HealthTransitions transitions={transitions} />
    </div>
  );
}

const COLUMN_ACCESSORS = {
  provider: (row) => row.provider,
  model: (row) => row.model,
  keyIndex: (row) => row.keyIndex,
  status: (row) => row.status,
  score: (row) => row.score,
  latency: (row) => row.latencyMs,
  successes: (row) => row.successes,
  failures: (row) => row.failures,
  consecutive: (row) => row.consecutiveFailures,
  lastStatus: (row) => row.lastStatus,
  reason: (row) => row.lastReason ?? "",
  updated: (row) => row.updatedAt,
  cooldown: (row) => row.cooldownUntil
};

/** Status ordering weights the table so problems surface at the top. */
const SEVERITY = { failed: 0, cooldown: 1, unknown: 2, healthy: 3 };

const COLUMNS = [
  {
    key: "provider",
    header: "Provider",
    sortable: true,
    get: (row) => row.provider,
    render: (row) => <span className="nowrap">{providerLabel(row.provider)}</span>
  },
  {
    key: "model",
    header: "Model",
    sortable: true,
    get: (row) => row.model,
    render: (row) => <span className="mono truncate table__truncate" title={row.model}>{row.model}</span>
  },
  {
    key: "keyIndex",
    header: "Key",
    align: "right",
    sortable: true,
    get: (row) => row.keyIndex,
    render: (row) => <span className="mono">{row.keyIndex}</span>
  },
  {
    key: "status",
    header: "Status",
    sortable: true,
    get: (row) => SEVERITY[row.status] ?? 9,
    render: (row) => <HealthBadge status={row.status} title={row.lastReason ?? undefined} />
  },
  {
    key: "score",
    header: "Score",
    align: "right",
    sortable: true,
    get: (row) => row.score,
    render: (row) => <ScoreCell score={row.score} />
  },
  {
    key: "latency",
    header: "Latency",
    align: "right",
    sortable: true,
    get: (row) => row.latencyMs,
    render: (row) => <LatencyBadge ms={row.latencyMs} />
  },
  {
    key: "successes",
    header: "OK",
    align: "right",
    sortable: true,
    get: (row) => row.successes,
    render: (row) => <span className="mono">{row.successes}</span>
  },
  {
    key: "failures",
    header: "Failed",
    align: "right",
    sortable: true,
    get: (row) => row.failures,
    render: (row) => (
      <span className="mono" style={{ color: row.failures > 0 ? "var(--danger)" : undefined }}>{row.failures}</span>
    )
  },
  {
    key: "consecutive",
    header: "Streak",
    align: "right",
    sortable: true,
    get: (row) => row.consecutiveFailures,
    render: (row) => (
      <span className="mono" style={{ color: row.consecutiveFailures > 1 ? "var(--warn)" : undefined }}>
        {row.consecutiveFailures}
      </span>
    )
  },
  {
    key: "lastStatus",
    header: "HTTP",
    align: "right",
    sortable: true,
    get: (row) => row.lastStatus,
    render: (row) => <span className="mono dim">{row.lastStatus ?? EMPTY}</span>
  },
  {
    key: "reason",
    header: "Last reason",
    sortable: true,
    get: (row) => row.lastReason ?? "",
    render: (row) => (
      <span className="tiny dim truncate table__truncate" title={row.lastReason ?? undefined}>
        {row.lastReason ?? EMPTY}
      </span>
    )
  },
  {
    key: "cooldown",
    header: "Cooldown",
    align: "right",
    sortable: true,
    get: (row) => row.cooldownUntil,
    render: (row) => <CooldownCell until={row.cooldownUntil} />
  },
  {
    key: "updated",
    header: "Updated",
    align: "right",
    sortable: true,
    get: (row) => row.updatedAt,
    render: (row) => (
      <span className="dim tiny nowrap" title={formatDateTime(row.updatedAt)}>
        {formatRelativeTime(row.updatedAt)}
      </span>
    )
  }
];

/** Score bar: the number plus a proportional fill, so relative ranking reads instantly. */
function ScoreCell({ score }) {
  if (!Number.isFinite(score)) return <span className="dim mono">—</span>;
  const tone = score >= 70 ? "ok" : score >= 40 ? "warn" : "danger";

  return (
    <span className="row" style={{ gap: 6, justifyContent: "flex-end" }}>
      <span className={`health-bar`} style={{ width: 42 }} aria-hidden="true">
        <span className={`health-bar__seg health-bar__seg--${tone}`} style={{ width: `${score}%` }} />
      </span>
      <span className="mono tabular">{Math.round(score)}</span>
    </span>
  );
}

/**
 * Live cooldown countdown.
 *
 * Isolated in its own component with its own one-second ticker so that the
 * ticking clock re-renders a single cell rather than the whole table.
 */
function CooldownCell({ until }) {
  const [, forceTick] = useState(0);

  useEffect(() => {
    if (!until || until <= Date.now()) return undefined;
    const timer = setInterval(() => forceTick((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, [until]);

  const remaining = formatCountdown(until);
  if (!remaining) return <span className="dim">—</span>;

  return (
    <span className="mono tiny" style={{ color: "var(--warn)" }} title={formatDateTime(until)}>
      {remaining}
    </span>
  );
}

function MonitorStatus({ monitor }) {
  if (!monitor) return null;

  return (
    <div className="panel section">
      <div className="panel__header">
        <span className="panel__title">Monitor</span>
      </div>
      <div className="panel__body">
        <dl className="dl dl--tight">
          <dt className="dl__term">Status</dt>
          <dd className="dl__desc">
            {monitor.enabled
              ? monitor.running
                ? <span className="row" style={{ gap: 6 }}><span className="spinner" aria-hidden="true" /> cycle running</span>
                : "idle — waiting for the next interval"
              : "stopped"}
          </dd>

          <dt className="dl__term">Interval</dt>
          <dd className="dl__desc mono">{formatDuration(monitor.intervalMs)}</dd>

          <dt className="dl__term">Last cycle</dt>
          <dd className="dl__desc">
            {monitor.lastCycle
              ? `${formatRelativeTime(monitor.lastCycle.completedAt)} · ${monitor.lastCycle.probes} probes in ${formatDuration(monitor.lastCycle.durationMs)}`
              : <span className="dim">no cycle recorded yet</span>}
          </dd>

          <dt className="dl__term">Next cycle</dt>
          <dd className="dl__desc">
            {monitor.nextCycleAt ? formatDateTime(monitor.nextCycleAt) : <span className="dim">not scheduled</span>}
          </dd>

          {monitor.lastCycle ? (
            <>
              <dt className="dl__term">Last outcome</dt>
              <dd className="dl__desc">
                <span className="row" style={{ gap: "var(--sp-3)" }}>
                  <span style={{ color: "var(--ok)" }}>{monitor.lastCycle.outcomes.healthy} healthy</span>
                  <span style={{ color: "var(--danger)" }}>{monitor.lastCycle.outcomes.failed} failed</span>
                  <span className="dim">{monitor.lastCycle.outcomes.passive} passive</span>
                </span>
              </dd>
            </>
          ) : null}
        </dl>
      </div>
    </div>
  );
}

/**
 * Observed health transitions.
 *
 * The gateway does not keep a transition history, so this diffs consecutive
 * polls and records changes as they are noticed. It is explicitly labelled as
 * panel-observed and session-scoped because it is not server history — an
 * operator must not mistake it for an audit log.
 */
function useHealthTransitions(targets) {
  const previous = useRef(new Map());
  const [transitions, setTransitions] = useState([]);

  useEffect(() => {
    if (!targets || targets.length === 0) return;

    const changes = [];

    for (const target of targets) {
      const prior = previous.current.get(target.id);
      if (prior && prior !== target.status) {
        changes.push({
          id: `${target.id}-${Date.now()}`,
          at: Date.now(),
          target: `${target.provider} / ${target.model} / key ${target.keyIndex}`,
          from: prior,
          to: target.status,
          reason: target.lastReason ?? null
        });
      }
      previous.current.set(target.id, target.status);
    }

    if (changes.length > 0) {
      setTransitions((current) => [...changes.reverse(), ...current].slice(0, 40));
    }
  }, [targets]);

  return transitions;
}

function HealthTransitions({ transitions }) {
  return (
    <div className="panel">
      <div className="panel__header">
        <span className="panel__title">Health transitions</span>
        <div className="panel__actions">
          <span className="tiny dim nowrap">observed by this panel since it was opened</span>
        </div>
      </div>

      {transitions.length === 0 ? (
        <EmptyState title="No transitions observed yet" icon="activity">
          Health changes are recorded here as this panel notices them. The gateway does not keep a
          server-side history, so this list starts empty and is lost on reload.
        </EmptyState>
      ) : (
        <div className="table-wrap">
          <table className="table table--compact">
            <caption className="sr-only">Health state transitions observed by this panel</caption>
            <thead>
              <tr>
                <th scope="col">Time</th>
                <th scope="col">Target</th>
                <th scope="col">Transition</th>
                <th scope="col">Reason</th>
              </tr>
            </thead>
            <tbody>
              {transitions.map((transition) => (
                <tr key={transition.id}>
                  <td className="dim tiny nowrap">{formatRelativeTime(transition.at)}</td>
                  <td className="mono tiny truncate">{transition.target}</td>
                  <td className="nowrap">
                    <span className="row" style={{ gap: 6 }}>
                      <HealthBadge status={transition.from} />
                      <Icon name="arrowRight" size={12} />
                      <HealthBadge status={transition.to} />
                    </span>
                  </td>
                  <td className="tiny dim truncate" title={transition.reason ?? undefined}>
                    {transition.reason ?? EMPTY}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
