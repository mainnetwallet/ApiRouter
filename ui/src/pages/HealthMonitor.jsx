import { useEffect, useMemo, useRef, useState } from "react";
import { PageHeader } from "../components/layout/PageHeader.jsx";
import { DataTable } from "../components/ui/DataTable.jsx";
import { FilterBar, FilterSelect } from "../components/ui/FilterBar.jsx";
import { SearchInput } from "../components/ui/SearchInput.jsx";
import { HealthBadge } from "../components/ui/HealthBadge.jsx";
import { PoolBadge } from "../components/ui/PoolBadge.jsx";
import { LatencyBadge } from "../components/ui/LatencyBadge.jsx";
import { StatusBadge } from "../components/ui/StatusBadge.jsx";
import { MetricCard } from "../components/ui/MetricCard.jsx";
import { Drawer } from "../components/ui/Overlays.jsx";
import { MetricSkeleton } from "../components/ui/LoadingSkeleton.jsx";
import { EmptyState } from "../components/ui/EmptyState.jsx";
import { ErrorState } from "../components/ui/ErrorState.jsx";
import { Icon } from "../components/ui/Icon.jsx";
import { HealthDistribution } from "../components/charts/Charts.jsx";
import { useHealth } from "../context/HealthContext.jsx";
import { useDebouncedValue } from "../hooks/useDebounce.js";
import {
  HEALTH_STATUSES, filterTargets, findTarget, normalizeHealthPayload, providerOptions, summarizeTargets
} from "../lib/targets.js";
import { poolLabel } from "../lib/pools.js";
import { sortRows } from "../lib/table.js";
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
 * The page lives at `/health-monitor`, not `/health`: the gateway answers
 * `GET /health` with its raw JSON contract, and a panel route there would be
 * shadowed by it in the browser.
 *
 * The cooldown countdown re-renders on its own one-second ticker, isolated in
 * `CooldownCell`, so a ticking clock never re-renders the table.
 */
export default function HealthMonitor() {
  const {
    health, error, loading, reload, runManualRefresh, manualBusy,
    lastUpdatedAt, refreshing, autoRefresh, setAutoRefresh
  } = useHealth();

  const [selectedId, setSelectedId] = useState(null);

  // Narrowed once: a missing `summary`, a null target or a partial response
  // must not reach a property access in the table.
  const view = useMemo(() => normalizeHealthPayload(health), [health]);
  const { rows } = view;

  const transitions = useHealthTransitions(rows);

  // The two pools are routed, probed and ranked independently, so every figure
  // below is built from one pool's rows. The payload's combined `summary` is
  // deliberately unused: nothing on this page is the sum of text and vision.
  const byPool = useMemo(() => ({
    text: rows.filter((row) => row.pool === "text"),
    vision: rows.filter((row) => row.pool === "vision")
  }), [rows]);

  const selected = useMemo(() => findTarget(rows, selectedId), [rows, selectedId]);

  if (loading && rows.length === 0) {
    return (
      <div className="page">
        <PageHeader title="Health Monitor" description="Every routing target, its score and cooldown state" />
        <MetricSkeleton count={6} />
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

      <AutoRefreshIndicator autoRefresh={autoRefresh} lastUpdatedAt={lastUpdatedAt} />

      <MonitorStatus monitor={view.monitor} />

      {POOL_ORDER.map((pool) => (
        <PoolHealthSection
          key={pool}
          pool={pool}
          rows={byPool[pool]}
          transitions={transitions.filter((transition) => transition.pool === pool)}
          selectedId={selectedId}
          onSelect={setSelectedId}
        />
      ))}

      <TargetDrawer target={selected} onClose={() => setSelectedId(null)} />
    </div>
  );
}

const POOL_ORDER = ["text", "vision"];

/**
 * Everything for ONE pool: its own cards, distribution bar, filters, target
 * table and observed transitions. Filter and sort state is local, so filtering
 * the text table never touches the vision one.
 */
function PoolHealthSection({ pool, rows, transitions, selectedId, onSelect }) {
  const [search, setSearch] = useState("");
  const [provider, setProvider] = useState(null);
  const [status, setStatus] = useState(null);
  const [sort, setSort] = useState({ key: "status", direction: "asc" });

  const debouncedSearch = useDebouncedValue(search, 220);

  const summary = useMemo(() => summarizeTargets(rows), [rows]);
  const providers = useMemo(() => providerOptions(rows), [rows]);

  const filtered = useMemo(
    () => sortRows(
      filterTargets(rows, { provider, status, search: debouncedSearch }),
      COLUMN_ACCESSORS,
      sort
    ),
    [rows, provider, status, debouncedSearch, sort]
  );

  const idPrefix = `health-${pool}`;

  return (
    <section className="section" aria-labelledby={`${idPrefix}-title`}>
      <div className="section__header">
        <h2 id={`${idPrefix}-title`} className="section__title row" style={{ gap: 8 }}>
          <PoolBadge pool={pool} />
          {poolLabel(pool)} pool
        </h2>
      </div>

      {rows.length === 0 ? (
        <div className="panel">
          <EmptyState title={`No ${pool} targets`} icon="server">
            {pool === "vision"
              ? "No vision provider is configured. Image requests will fail until one is set up."
              : "A provider becomes routable once it has API keys, models and a base URL configured."}
          </EmptyState>
        </div>
      ) : (
        <>
          <div className="metrics">
            <MetricCard label="Total targets" value={formatNumber(summary.total)} icon="box" hint="provider + model + key" />
            <MetricCard label="Healthy" value={formatNumber(summary.healthy)} tone={summary.healthy > 0 ? "ok" : null} icon="check" />
            <MetricCard label="Failed" value={formatNumber(summary.failed)} tone={summary.failed > 0 ? "danger" : null} icon="alert" />
            <MetricCard label="Cooldown" value={formatNumber(summary.cooldown)} tone={summary.cooldown > 0 ? "warn" : null} icon="clock" />
            <MetricCard label="Unknown" value={formatNumber(summary.unknown)} tone={summary.unknown > 0 ? "warn" : null} icon="info" hint="never observed" />
            <MetricCard
              label="Average latency"
              value={summary.averageLatencyMs === null ? null : formatNumber(summary.averageLatencyMs) + " ms"}
              icon="gauge"
              hint="measured targets only"
            />
          </div>

          <div className="section">
            <HealthDistribution counts={summary} />
          </div>

          <div className="panel section">
            <div className="panel__header">
              <span className="panel__title">{poolLabel(pool)} target health</span>
              <div className="panel__actions">
                <span className="tiny dim nowrap">score and cooldown are the router's own</span>
              </div>
            </div>

            <FilterBar
              actions={
                <span className="tiny dim nowrap">
                  {filtered.length} of {rows.length} targets
                </span>
              }
            >
              <div className="field filter-bar__search">
                <label className="field__label" htmlFor={`${idPrefix}-search`}>Search</label>
                <SearchInput
                  id={`${idPrefix}-search`}
                  value={search}
                  onChange={setSearch}
                  label={`Search ${pool} targets`}
                  placeholder="Model, provider or reason…"
                />
              </div>
              <FilterSelect label="Provider" value={provider} onChange={setProvider} options={providers} />
              <FilterSelect label="Status" value={status} onChange={setStatus} options={HEALTH_STATUSES} />
            </FilterBar>

            <DataTable
              columns={COLUMNS}
              rows={filtered}
              sort={sort}
              onSortChange={(next) => setSort(next)}
              rowKey={(row) => row.id}
              onRowClick={(row) => onSelect(row.id)}
              isSelected={(row) => row.id === selectedId}
              caption={`${poolLabel(pool)} routing targets and their observed health`}
              emptyState={
                <EmptyState title="No targets match these filters" icon="filter">
                  <button
                    type="button"
                    className="btn btn--sm"
                    onClick={() => { setSearch(""); setProvider(null); setStatus(null); }}
                  >
                    Clear filters
                  </button>
                </EmptyState>
              }
            />
          </div>

          <HealthTransitions pool={pool} transitions={transitions} />
        </>
      )}
    </section>
  );
}

/**
 * Explicit auto-refresh state.
 *
 * The freshness line in the header only appears once a poll has landed, so an
 * operator who has just paused polling — or whose first poll has not returned —
 * would otherwise have no indication of which mode the page is in.
 *
 * Deliberately not a live region: "last updated" changes on every poll, and an
 * `aria-live` here would interrupt a screen-reader user every few seconds. The
 * toggle button's own `aria-pressed` already announces the mode when it
 * changes, which is the moment that actually matters.
 */
function AutoRefreshIndicator({ autoRefresh, lastUpdatedAt }) {
  return (
    <div className="row tiny dim" style={{ gap: "var(--sp-3)" }}>
      <span className="row" style={{ gap: 5 }}>
        <span className={`swatch swatch--${autoRefresh ? "ok" : "neutral"}`} aria-hidden="true" />
        {autoRefresh ? "Auto-refresh on" : "Auto-refresh paused"}
      </span>
      <span>
        {lastUpdatedAt
          ? `last updated ${formatRelativeTime(lastUpdatedAt)}`
          : "waiting for the first response"}
      </span>
    </div>
  );
}

const COLUMN_ACCESSORS = {
  provider: (row) => row.provider,
  model: (row) => row.model,
  keyIndex: (row) => row.keyIndex,
  protocol: (row) => row.protocols[0] ?? "",
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
    key: "protocol",
    header: "Protocol",
    sortable: true,
    get: (row) => row.protocols[0] ?? "",
    render: (row) => (
      <span className="tiny dim nowrap">
        {row.protocols.map(protocolLabel).join(", ") || EMPTY}
      </span>
    )
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

/**
 * Per-target detail.
 *
 * Everything here is a field `/api/health` already reports for the row that was
 * clicked. Credentials are not among them: the target's key *index* identifies
 * which configured key is in use, and the key value never leaves the gateway.
 */
function TargetDrawer({ target, onClose }) {
  return (
    <Drawer
      open={Boolean(target)}
      onClose={onClose}
      title={target?.model ?? ""}
      subtitle={target ? `${poolLabel(target.pool)} · ${providerLabel(target.provider)} · key ${target.keyIndex}` : null}
    >
      {target ? (
        <div className="stack" style={{ gap: "var(--sp-4)" }}>
          <div className="row row--wrap">
            <PoolBadge pool={target.pool} />
            <HealthBadge status={target.status} />
            <StatusBadge tone="neutral" dot={false}>
              {target.protocols.map(protocolLabel).join(", ") || "no protocol"}
            </StatusBadge>
          </div>

          <dl className="dl">
            <dt className="dl__term">Pool</dt>
            <dd className="dl__desc"><PoolBadge pool={target.pool} /></dd>

            <dt className="dl__term">Provider</dt>
            <dd className="dl__desc">{providerLabel(target.provider)}</dd>

            <dt className="dl__term">Model</dt>
            <dd className="dl__desc mono">{target.model}</dd>

            <dt className="dl__term">Target ID</dt>
            <dd className="dl__desc mono tiny">{target.id}</dd>

            <dt className="dl__term">Key index</dt>
            <dd className="dl__desc mono">
              {target.keyIndex}
              <div className="tiny dim">Identifies the configured key; the key value is never exposed.</div>
            </dd>

            <dt className="dl__term">Protocols</dt>
            <dd className="dl__desc">{target.protocols.map(protocolLabel).join(", ") || EMPTY}</dd>

            <dt className="dl__term">Health status</dt>
            <dd className="dl__desc"><HealthBadge status={target.status} /></dd>

            <dt className="dl__term">Score</dt>
            <dd className="dl__desc">
              <ScoreCell score={target.score} />
            </dd>

            <dt className="dl__term">Consecutive failures</dt>
            <dd className="dl__desc mono">{target.consecutiveFailures}</dd>

            <dt className="dl__term">Success count</dt>
            <dd className="dl__desc mono">{formatNumber(target.successes)}</dd>

            <dt className="dl__term">Failure count</dt>
            <dd className="dl__desc mono">{formatNumber(target.failures)}</dd>

            <dt className="dl__term">Latency</dt>
            <dd className="dl__desc"><LatencyBadge ms={target.latencyMs} /></dd>

            <dt className="dl__term">Last HTTP status</dt>
            <dd className="dl__desc mono">{target.lastStatus ?? EMPTY}</dd>

            <dt className="dl__term">Last reason</dt>
            <dd className="dl__desc">
              {target.lastReason || <span className="dim">none recorded</span>}
            </dd>

            <dt className="dl__term">Configured model</dt>
            <dd className="dl__desc">
              {/* Health above describes the KEY and the endpoint, not this
                  model. Say so explicitly when the provider's own catalogue
                  does not list it: a reachable API with a valid key must not
                  read as a confirmed usable model. */}
              {target.modelListed === false
                ? <span className="text--warn">Not listed in the provider's model catalogue</span>
                : target.modelListed === true
                  ? <span className="dim">Listed in the provider's model catalogue</span>
                  : <span className="dim">Catalogue unreadable — not verified</span>}
              {target.modelListedAt && <span className="dim"> · as of {formatDateTime(target.modelListedAt)}</span>}
              {/* The last confirmed value is a DIFFERENT fact from the latest
                  observation, so it is shown separately and dated. It is never
                  rendered as the current result, which is what would make a
                  stale `false` look freshly confirmed. */}
              {target.modelListed === null && target.modelListedConfirmed !== null && (
                <div className="dim tiny">
                  Last confirmed {target.modelListedConfirmed ? "present" : "absent"}
                  {target.modelListedConfirmedAt ? ` on ${formatDateTime(target.modelListedConfirmedAt)}` : ""}
                </div>
              )}
            </dd>

            <dt className="dl__term">Cooldown until</dt>
            <dd className="dl__desc">
              {target.cooldownUntil > Date.now()
                ? `${formatDateTime(target.cooldownUntil)} (${formatCountdown(target.cooldownUntil)})`
                : <span className="dim">not cooling down</span>}
            </dd>

            <dt className="dl__term">Updated</dt>
            <dd className="dl__desc">{formatDateTime(target.updatedAt)}</dd>
          </dl>
        </div>
      ) : null}
    </Drawer>
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
          pool: target.pool,
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

function HealthTransitions({ pool, transitions }) {
  return (
    <div className="panel">
      <div className="panel__header">
        <span className="panel__title">{poolLabel(pool)} health transitions</span>
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
