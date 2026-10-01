import { useMemo, useState } from "react";
import { PageHeader } from "../components/layout/PageHeader.jsx";
import { MetricCard } from "../components/ui/MetricCard.jsx";
import { MetricSkeleton, TableSkeleton } from "../components/ui/LoadingSkeleton.jsx";
import { ErrorState } from "../components/ui/ErrorState.jsx";
import { EmptyState } from "../components/ui/EmptyState.jsx";
import { DataTable } from "../components/ui/DataTable.jsx";
import { StatusBadge } from "../components/ui/StatusBadge.jsx";
import { HealthDistribution, BarList, Sparkline } from "../components/charts/Charts.jsx";
import { RequestDrawer } from "../components/domain/RequestDrawer.jsx";
import { useHealth } from "../context/HealthContext.jsx";
import { useApi } from "../hooks/useApi.js";
import { getAnalytics } from "../api/analytics.js";
import { getRequests } from "../api/requests.js";
import { Link } from "../router.jsx";
import {
  formatLatency, formatNumber, formatPercent, formatRelativeTime,
  providerLabel, protocolLabel, EMPTY
} from "../lib/format.js";

/**
 * Dashboard.
 *
 * Every figure comes from the gateway. Where a metric has no data source yet
 * — most obviously request counts on a freshly restarted process — the card
 * reads "n/a" rather than 0, because "no traffic recorded" and "all traffic
 * failing" must not look the same.
 *
 * Health comes from `useHealth` (its own context) while traffic comes from two
 * local queries, so a health tick re-renders only the panels that show health.
 */
export default function Dashboard() {
  const { summary: healthSummary, providers, targets, error: healthError, loading: healthLoading, reload: reloadHealth, lastUpdatedAt, refreshing } = useHealth();

  const analytics = useApi(
    ({ signal }) => getAnalytics({ range: "24h" }, { signal }),
    { intervalMs: 15_000 }
  );

  const recent = useApi(
    ({ signal }) => getRequests({ limit: 8 }, { signal }),
    { intervalMs: 8_000 }
  );

  const [selected, setSelected] = useState(null);

  const traffic = analytics.data?.summary ?? null;
  const hasTraffic = (traffic?.total ?? 0) > 0;

  const providerRows = useMemo(() => providers ?? [], [providers]);

  const providerColumns = useMemo(() => [
    {
      key: "provider",
      header: "Provider",
      sortable: true,
      get: (row) => row.provider,
      render: (row) => (
        <Link to="/providers" className="row" style={{ gap: 6 }}>
          {providerLabel(row.provider)}
        </Link>
      )
    },
    {
      key: "models",
      header: "Models",
      align: "right",
      sortable: true,
      get: (row) => row.modelCount,
      render: (row) => <span className="mono">{row.modelCount}</span>
    },
    {
      key: "healthy",
      header: "Healthy",
      align: "right",
      sortable: true,
      get: (row) => row.healthy,
      render: (row) => <span className="mono" style={{ color: row.healthy > 0 ? "var(--ok)" : undefined }}>{row.healthy}</span>
    },
    {
      key: "cooldown",
      header: "Cooldown",
      align: "right",
      sortable: true,
      get: (row) => row.cooldown,
      render: (row) => <span className="mono" style={{ color: row.cooldown > 0 ? "var(--warn)" : undefined }}>{row.cooldown}</span>
    },
    {
      key: "failed",
      header: "Failed",
      align: "right",
      sortable: true,
      get: (row) => row.failed,
      render: (row) => <span className="mono" style={{ color: row.failed > 0 ? "var(--danger)" : undefined }}>{row.failed}</span>
    },
    {
      key: "latency",
      header: "Latency",
      align: "right",
      sortable: true,
      get: (row) => row.latencyMs,
      render: (row) => <span className="mono tabular">{formatLatency(row.latencyMs)}</span>
    }
  ], []);

  const recentColumns = useMemo(() => [
    {
      key: "time",
      header: "Time",
      get: (row) => row.receivedAt,
      render: (row) => <span className="dim tiny nowrap">{formatRelativeTime(row.receivedAt)}</span>
    },
    {
      key: "target",
      header: "Target",
      get: (row) => `${row.finalProvider ?? ""}${row.finalModel ?? ""}`,
      render: (row) => (
        <span className="truncate">
          <span className="muted">{providerLabel(row.finalProvider)}</span> / {row.finalModel ?? EMPTY}
        </span>
      )
    },
    {
      key: "protocol",
      header: "Protocol",
      get: (row) => row.protocol,
      render: (row) => <span className="tiny dim nowrap">{protocolLabel(row.protocol)}</span>
    },
    {
      key: "fallbacks",
      header: "Fallbacks",
      align: "right",
      get: (row) => row.fallbackCount,
      render: (row) => (
        <span className="mono" style={{ color: row.fallbackCount > 0 ? "var(--warn)" : undefined }}>
          {row.fallbackCount}
        </span>
      )
    },
    {
      key: "status",
      header: "Status",
      align: "right",
      get: (row) => row.httpStatus,
      render: (row) => (
        <StatusBadge tone={row.outcome === "success" ? "ok" : "danger"} dot={false}>
          {row.httpStatus ?? EMPTY}
        </StatusBadge>
      )
    }
  ], []);

  const [sort, setSort] = useState({ key: "provider", direction: "asc" });

  if (healthLoading && !healthSummary) {
    return (
      <div className="page">
        <PageHeader title="Dashboard" description="Live gateway health, traffic and fallback activity" />
        <MetricSkeleton count={9} />
      </div>
    );
  }

  return (
    <div className="page">
      <PageHeader
        title="Dashboard"
        description="Live gateway health, traffic and fallback activity"
        lastUpdatedAt={lastUpdatedAt}
        refreshing={refreshing}
        actions={
          <>
            <button type="button" className="btn" onClick={reloadHealth} disabled={refreshing}>
              Refresh health
            </button>
            <Link className="btn" to="/playground">Send a test request</Link>
          </>
        }
      />

      {healthError ? <ErrorState error={healthError} onRetry={reloadHealth} compact /> : null}

      {!healthSummary || healthSummary.total === 0 ? (
        <div className="panel" style={{ marginBottom: "var(--sp-4)" }}>
          <EmptyState title="No routing targets are configured" icon="server">
            The gateway is running, but no provider has an API key, model list and base URL
            configured together. Add one to <code>.env</code> and restart — see the
            {" "}<Link to="/configuration">Configuration</Link> page for exactly which variables are missing.
          </EmptyState>
        </div>
      ) : null}

      <section className="section">
        <div className="metrics">
          <MetricCard
            label="Total Providers"
            value={formatNumber(providerRows.length)}
            hint={`${providerRows.filter((p) => p.configured).length} configured`}
            icon="server"
          />
          <MetricCard
            label="Configured Targets"
            value={formatNumber(healthSummary?.total)}
            hint="provider + model + key"
            icon="box"
            title="Each provider/model/key combination routes independently"
          />
          <MetricCard
            label="Healthy Targets"
            value={formatNumber(healthSummary?.healthy)}
            tone={healthSummary?.healthy > 0 ? "ok" : null}
            icon="check"
          />
          <MetricCard
            label="Cooldown Targets"
            value={formatNumber(healthSummary?.cooldown)}
            tone={healthSummary?.cooldown > 0 ? "warn" : null}
            icon="clock"
            title="Failed targets still inside their cooldown window"
          />
          <MetricCard
            label="Failed Targets"
            value={formatNumber(healthSummary?.failed)}
            tone={healthSummary?.failed > 0 ? "danger" : null}
            icon="alert"
          />
          <MetricCard
            label="Total Requests"
            value={hasTraffic ? formatNumber(traffic.total) : null}
            hint={analytics.data ? "last 24h" : "loading"}
            icon="list"
            title="Requests recorded by this process. The log is in-memory and resets on restart."
          />
          <MetricCard
            label="Successful"
            value={hasTraffic ? formatNumber(traffic.successful) : null}
            tone={hasTraffic ? "ok" : null}
            hint={hasTraffic ? formatPercent(traffic.successRate) : null}
            icon="check"
          />
          <MetricCard
            label="Failed"
            value={hasTraffic ? formatNumber(traffic.failed) : null}
            tone={traffic?.failed > 0 ? "danger" : null}
            hint={hasTraffic ? formatPercent(traffic.failureRate) : null}
            icon="alert"
          />
          <MetricCard
            label="Average Latency"
            value={hasTraffic ? formatLatency(traffic.avgLatencyMs) : null}
            hint={hasTraffic && Number.isFinite(traffic.p95LatencyMs) ? `p95 ${formatLatency(traffic.p95LatencyMs)}` : null}
            icon="gauge"
          />
        </div>
      </section>

      <div className="split split--sidebar section">
        <div className="panel">
          <div className="panel__header">
            <span className="panel__title">Provider overview</span>
            <div className="panel__actions">
              <Link className="btn btn--sm" to="/providers">All providers</Link>
            </div>
          </div>
          <DataTable
            columns={providerColumns}
            rows={providerRows}
            sort={sort}
            onSortChange={setSort}
            rowKey={(row) => row.provider}
            compact
            caption="Health summary per provider"
            emptyState={<EmptyState title="No providers configured" icon="server" />}
          />
        </div>

        <div className="stack">
          <div className="panel">
            <div className="panel__header">
              <span className="panel__title">Overall system health</span>
            </div>
            <div className="panel__body">
              <HealthDistribution counts={healthSummary} />
            </div>
          </div>

          <div className="panel">
            <div className="panel__header">
              <span className="panel__title">Model availability</span>
            </div>
            <div className="panel__body">
              <BarList
                items={providerRows.map((row) => ({
                  key: providerLabel(row.provider),
                  count: row.healthy,
                  share: row.targets > 0 ? row.healthy / row.targets : 0
                }))}
                emptyLabel="No providers configured"
                valueFormatter={(value) => `${value} healthy`}
              />
            </div>
          </div>

          <div className="panel">
            <div className="panel__header">
              <span className="panel__title">Requests (24h)</span>
            </div>
            <div className="panel__body">
              {analytics.loading && !analytics.data ? (
                <TableSkeleton rows={3} label="Loading traffic" />
              ) : (analytics.data?.series ?? []).some((bucket) => bucket.total > 0) ? (
                <Sparkline
                  values={(analytics.data.series ?? []).map((bucket) => bucket.total)}
                  label="Requests per interval"
                />
              ) : (
                <span className="dim small">No requests recorded in the last 24 hours.</span>
              )}
            </div>
          </div>
        </div>
      </div>

      <div className="split split--2 section">
        <div className="panel">
          <div className="panel__header">
            <span className="panel__title">Recent requests</span>
            <div className="panel__actions">
              <Link className="btn btn--sm" to="/requests">Open log</Link>
            </div>
          </div>

          {recent.error ? (
            <div className="panel__body"><ErrorState error={recent.error} onRetry={recent.reload} compact /></div>
          ) : recent.loading && !recent.data ? (
            <div className="panel__body"><TableSkeleton rows={5} label="Loading recent requests" /></div>
          ) : (recent.data?.entries ?? []).length === 0 ? (
            <EmptyState title="No requests yet" icon="list">
              Traffic through the gateway will appear here as it happens.
            </EmptyState>
          ) : (
            <DataTable
              columns={recentColumns}
              rows={recent.data.entries}
              rowKey={(row) => row.seq}
              onRowClick={setSelected}
              compact
              caption="Most recent requests through the gateway"
            />
          )}
        </div>

        <div className="panel">
          <div className="panel__header">
            <span className="panel__title">Recent failures</span>
            <div className="panel__actions">
              <Link className="btn btn--sm" to="/analytics">Analytics</Link>
            </div>
          </div>

          {analytics.loading && !analytics.data ? (
            <div className="panel__body"><TableSkeleton rows={4} label="Loading failures" /></div>
          ) : (analytics.data?.recentFailures ?? []).length === 0 ? (
            <EmptyState title="No failures recorded" icon="check">
              No request has failed in the last 24 hours.
            </EmptyState>
          ) : (
            <div className="table-wrap">
              <table className="table table--compact">
                <caption className="sr-only">Recent failed requests</caption>
                <thead>
                  <tr>
                    <th scope="col">Time</th>
                    <th scope="col">Target</th>
                    <th scope="col">Reason</th>
                  </tr>
                </thead>
                <tbody>
                  {analytics.data.recentFailures.map((failure) => (
                    <tr key={failure.seq}>
                      <td className="dim tiny nowrap">{formatRelativeTime(failure.receivedAt)}</td>
                      <td className="truncate">{providerLabel(failure.provider)} / {failure.model ?? EMPTY}</td>
                      <td>
                        <StatusBadge tone="danger" dot={false}>{failure.category}</StatusBadge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      <div className="panel section">
        <div className="panel__header">
          <span className="panel__title">Current fallback activity</span>
          <div className="panel__actions">
            <Link className="btn btn--sm" to="/fallback">Fallback chain</Link>
          </div>
        </div>

        {analytics.loading && !analytics.data ? (
          <div className="panel__body"><TableSkeleton rows={3} label="Loading fallback activity" /></div>
        ) : (analytics.data?.recentFallbacks ?? []).length === 0 ? (
          <EmptyState title="No fallback activity" icon="layers">
            Every request in the last 24 hours was served by its first-choice target.
          </EmptyState>
        ) : (
          <div className="table-wrap">
            <table className="table table--compact">
              <caption className="sr-only">Requests that fell back to another target</caption>
              <thead>
                <tr>
                  <th scope="col">Time</th>
                  <th scope="col">Final target</th>
                  <th scope="col">Chain</th>
                  <th scope="col">Hops</th>
                  <th scope="col">Outcome</th>
                </tr>
              </thead>
              <tbody>
                {analytics.data.recentFallbacks.map((item) => (
                  <tr key={item.seq} onClick={() => setSelected(item)} data-clickable="true">
                    <td className="dim tiny nowrap">{formatRelativeTime(item.receivedAt)}</td>
                    <td className="truncate">{providerLabel(item.finalProvider)} / {item.finalModel ?? EMPTY}</td>
                    <td className="truncate tiny dim">
                      {item.attempts.map((attempt) => attempt.ok ? "ok" : `×${attempt.status ?? "err"}`).join(" → ")}
                    </td>
                    <td className="mono">{item.fallbackCount}</td>
                    <td>
                      <StatusBadge tone={item.outcome === "success" ? "ok" : "danger"} dot={false}>
                        {item.outcome}
                      </StatusBadge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <RequestDrawer
        entry={selected}
        open={Boolean(selected)}
        onClose={() => setSelected(null)}
      />
    </div>
  );
}
