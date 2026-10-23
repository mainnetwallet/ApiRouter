import { useMemo, useState } from "react";
import { PageHeader } from "../components/layout/PageHeader.jsx";
import { MetricCard } from "../components/ui/MetricCard.jsx";
import { MetricSkeleton, TableSkeleton } from "../components/ui/LoadingSkeleton.jsx";
import { ErrorState } from "../components/ui/ErrorState.jsx";
import { EmptyState } from "../components/ui/EmptyState.jsx";
import { DataTable } from "../components/ui/DataTable.jsx";
import { StatusBadge } from "../components/ui/StatusBadge.jsx";
import { HealthDistribution, Sparkline } from "../components/charts/Charts.jsx";
import { RequestDrawer } from "../components/domain/RequestDrawer.jsx";
import { ProviderDrawer } from "../components/domain/ProviderDrawer.jsx";
import { RoutingFlowPanel } from "../components/domain/RoutingFlowPanel.jsx";
import { useHealth } from "../context/HealthContext.jsx";
import { useConnection } from "../context/ConnectionContext.jsx";
import { useApi } from "../hooks/useApi.js";
import { getAnalytics } from "../api/analytics.js";
import { getRequests } from "../api/requests.js";
import { getProviders } from "../api/providers.js";
import { Link } from "../router.jsx";
import {
  formatLatency, formatNumber, formatPercent, formatRelativeTime,
  providerLabel, EMPTY
} from "../lib/format.js";

/**
 * Dashboard.
 *
 * One unified view of the gateway. Text and vision are capabilities of a model,
 * declared in the Model Configurator — not separate routing pools — so every
 * figure here is computed over all targets together.
 *
 * Every figure comes from the gateway. Where a metric has no data source yet —
 * most obviously request counts on a freshly restarted process — the card reads
 * "n/a" rather than 0, because "no traffic recorded" and "all traffic failing"
 * must not look the same.
 *
 * Health comes from `useHealth`, provider configuration from `/api/providers`,
 * and traffic from two local queries, so a health tick re-renders only the
 * panels that show health.
 */
export default function Dashboard() {
  const {
    health: healthData, summary, ranked, error: healthError, loading: healthLoading,
    reload: reloadHealth, lastUpdatedAt, refreshing
  } = useHealth();
  const { generation } = useConnection();

  const providersApi = useApi(getProviders, { intervalMs: 10_000, deps: [generation] });

  const analytics = useApi(
    ({ signal }) => getAnalytics({ range: "24h" }, { signal }),
    { intervalMs: 15_000 }
  );

  const recent = useApi(
    ({ signal }) => getRequests({ limit: 8 }, { signal }),
    { intervalMs: 8_000 }
  );

  const [selectedRequest, setSelectedRequest] = useState(null);
  const [selectedProvider, setSelectedProvider] = useState(null);

  const traffic = analytics.data?.summary ?? null;
  const hasTraffic = (traffic?.total ?? 0) > 0;

  const providerSummary = providersApi.data?.summary ?? null;
  const providerRows = Array.isArray(providersApi.data?.providers) ? providersApi.data.providers : [];

  const globalTargets = summary?.total ?? 0;

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
      key: "status",
      header: "Status",
      align: "right",
      get: (row) => row.httpStatus,
      render: (row) => (
        <StatusBadge tone={row.outcome === "success" ? "ok" : "danger"} dot={false}>
          {row.httpStatus ?? EMPTY}
        </StatusBadge>
      )
    },
    {
      key: "latency",
      header: "Latency",
      align: "right",
      get: (row) => row.latencyMs,
      render: (row) => <span className="mono tabular">{formatLatency(row.latencyMs)}</span>
    }
  ], []);

  if (healthLoading && !healthData) {
    return (
      <div className="page">
        <PageHeader title="Dashboard" description="Live gateway health, traffic and routing activity" />
        <MetricSkeleton count={6} />
      </div>
    );
  }

  const noTargets = !summary || summary.total === 0;

  return (
    <div className="page">
      <PageHeader
        title="Dashboard"
        description="Live gateway health, traffic and routing activity"
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

      <section className="section" aria-label="Global statistics">
        <div className="metrics">
          <MetricCard
            label="Total Providers"
            value={formatNumber(providerSummary?.knownProviders ?? providerRows.length)}
            hint={[
              Number.isFinite(providerSummary?.configuredProviders) ? `${providerSummary.configuredProviders} configured` : null,
              providerSummary?.disabledProviders ? `${providerSummary.disabledProviders} switched off` : null
            ].filter(Boolean).join(" · ") || null}
            icon="server"
          />
          <MetricCard
            label="Total Targets"
            value={formatNumber(globalTargets)}
            icon="box"
            title="Each provider/model/key combination routes independently"
          />
          <MetricCard
            label="Total Requests"
            value={hasTraffic ? formatNumber(traffic.total) : null}
            hint={analytics.data ? "last 24h" : "loading"}
            icon="list"
            title="Requests recorded by this process. The log is in-memory and resets on restart."
          />
          <MetricCard
            label="Average Latency"
            value={hasTraffic ? formatLatency(traffic.avgLatencyMs) : null}
            hint={hasTraffic && Number.isFinite(traffic.p95LatencyMs) ? `p95 ${formatLatency(traffic.p95LatencyMs)}` : null}
            icon="gauge"
          />
          <MetricCard
            label="Success Rate"
            value={hasTraffic ? formatPercent(traffic.successRate) : null}
            tone={hasTraffic ? "ok" : null}
            hint={hasTraffic ? `${formatNumber(traffic.successful)} successful` : null}
            icon="check"
          />
          <MetricCard
            label="Failed Requests"
            value={hasTraffic ? formatNumber(traffic.failed) : null}
            tone={traffic?.failed > 0 ? "danger" : null}
            hint={hasTraffic ? formatPercent(traffic.failureRate) : null}
            icon="alert"
          />
        </div>
      </section>

      {noTargets ? (
        <div className="panel" style={{ marginBottom: "var(--sp-4)" }}>
          <EmptyState title="No routing targets are configured" icon="server">
            The gateway is running, but no provider has an API key, model list and base URL
            configured together. Add one to <code>.env</code> and restart — see the
            {" "}<Link to="/configuration">Configuration</Link> page for exactly which variables are missing.
          </EmptyState>
        </div>
      ) : null}

      <div className="split split--sidebar section">
        <div className="stack">
          <div className="panel">
            <div className="panel__header">
              <span className="panel__title">System Health</span>
            </div>
            <div className="panel__body stack" style={{ gap: "var(--sp-4)" }}>
              <div>
                <div className="row" style={{ justifyContent: "space-between", marginBottom: "var(--sp-2)" }}>
                  <span className="section__title">Targets</span>
                  <span className="tiny dim mono">
                    {summary?.healthPercent === null ? "n/a" : `${formatPercent(summary.healthPercent)} healthy`}
                  </span>
                </div>
                <HealthDistribution counts={summary ?? null} />
              </div>
            </div>
          </div>

          <RoutingFlowPanel ranked={ranked} />

          <div className="panel">
            <div className="panel__header">
              <span className="panel__title">Requests (24h)</span>
            </div>
            <div className="panel__body">
              {analytics.loading && !analytics.data ? (
                <TableSkeleton rows={3} label="Loading traffic" />
              ) : analytics.data?.series.some((bucket) => bucket.total > 0) ? (
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
              onRowClick={setSelectedRequest}
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
              <caption className="sr-only">Requests that fell back to another eligible target</caption>
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
                  <tr key={item.seq} onClick={() => setSelectedRequest(item)} data-clickable="true">
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
        entry={selectedRequest}
        open={Boolean(selectedRequest)}
        onClose={() => setSelectedRequest(null)}
      />

      <ProviderDrawer
        open={Boolean(selectedProvider)}
        onClose={() => setSelectedProvider(null)}
        id={selectedProvider?.id}
        record={selectedProvider ?? null}
      />
    </div>
  );
}
