import { useState } from "react";
import { PageHeader } from "../components/layout/PageHeader.jsx";
import { MetricCard } from "../components/ui/MetricCard.jsx";
import { MetricSkeleton, TableSkeleton } from "../components/ui/LoadingSkeleton.jsx";
import { EmptyState } from "../components/ui/EmptyState.jsx";
import { ErrorState } from "../components/ui/ErrorState.jsx";
import { StatusBadge } from "../components/ui/StatusBadge.jsx";
import { TimeSeriesChart, BarList } from "../components/charts/Charts.jsx";
import { useApi } from "../hooks/useApi.js";
import { getAnalytics, RANGES } from "../api/analytics.js";
import { formatLatency, formatNumber, formatPercent, formatRelativeTime, providerLabel, EMPTY } from "../lib/format.js";

/**
 * Analytics.
 *
 * Every figure is computed by the backend from the in-memory request log. When
 * a range contains no traffic the page says so explicitly and refuses to draw
 * a chart — an empty graph and a graph of zeros look identical to an operator
 * but mean very different things.
 *
 * The panel also states its own limits rather than letting an operator assume
 * the data goes further back than it does.
 */
export default function Analytics() {
  const [range, setRange] = useState("1h");

  const analytics = useApi(
    ({ signal }) => getAnalytics({ range }, { signal }),
    { intervalMs: 15_000, deps: [range] }
  );

  const data = analytics.data;
  const empty = data && data.sampleSize === 0;

  return (
    <div className="page">
      <PageHeader
        title="Analytics"
        description="Traffic, latency, fallback and error breakdowns"
        lastUpdatedAt={analytics.lastUpdatedAt}
        refreshing={analytics.refreshing}
        paused={analytics.paused}
        actions={
          <div className="row" style={{ gap: "var(--sp-2)" }}>
            <div className="row" role="group" aria-label="Time range">
              {RANGES.map((value) => (
                <button
                  key={value}
                  type="button"
                  className={`btn btn--sm${range === value ? " btn--primary" : ""}`}
                  onClick={() => setRange(value)}
                  aria-pressed={range === value}
                >
                  {value}
                </button>
              ))}
            </div>
            <button type="button" className="btn" onClick={analytics.reload} disabled={analytics.refreshing}>
              Refresh
            </button>
          </div>
        }
      />

      {analytics.error ? <ErrorState error={analytics.error} onRetry={analytics.reload} compact /> : null}

      <div className="notice notice--info section">
        <span>
          Metrics are computed from the gateway's in-memory request log
          {data ? ` (${data.sampleSize} request${data.sampleSize === 1 ? "" : "s"} in this range)` : ""}.
          The log is bounded and resets when the process restarts, so historical data before the
          last restart is not available.
        </span>
      </div>

      {analytics.loading && !data ? (
        <MetricSkeleton count={6} />
      ) : empty ? (
        <div className="panel">
          <EmptyState title={`No requests in the last ${range}`} icon="chart">
            {data.unavailable.length > 0
              ? `${data.unavailable.join(", ")}. Send traffic through the gateway — the Playground is the quickest way — and this page will populate.`
              : "Send traffic through the gateway to populate this page."}
          </EmptyState>
        </div>
      ) : data ? (
        <>
          <section className="section">
            <div className="metrics">
              <MetricCard label="Requests" value={formatNumber(data.summary.total)} icon="list" hint={range} />
              <MetricCard
                label="Success rate"
                value={data.summary.successRate === null ? null : formatPercent(data.summary.successRate)}
                tone={data.summary.failed > 0 ? "warn" : "ok"}
                icon="check"
              />
              <MetricCard
                label="Failure rate"
                value={data.summary.failureRate === null ? null : formatPercent(data.summary.failureRate)}
                tone={data.summary.failed > 0 ? "danger" : null}
                icon="alert"
              />
              <MetricCard
                label="Average latency"
                value={formatLatency(data.summary.avgLatencyMs)}
                hint={Number.isFinite(data.summary.p95LatencyMs) ? `p95 ${formatLatency(data.summary.p95LatencyMs)}` : null}
                icon="gauge"
              />
              <MetricCard
                label="Fallbacks"
                value={formatNumber(data.summary.totalFallbacks)}
                hint={`${data.summary.requestsWithFallback} request(s) affected`}
                tone={data.summary.totalFallbacks > 0 ? "warn" : null}
                icon="undo"
              />
              <MetricCard
                label="Tokens"
                value={data.summary.tokenReportingRequests === 0 ? null : formatNumber(data.summary.tokens)}
                hint={
                  data.summary.tokenReportingRequests === 0
                    ? "no provider reported usage"
                    : `${data.summary.tokenReportingRequests} of ${data.summary.total} reported`
                }
                icon="zap"
              />
            </div>
          </section>

          <div className="panel section">
            <div className="panel__header">
              <span className="panel__title">Requests over time</span>
              <div className="panel__actions">
                <span className="tiny dim nowrap">
                  {new Date(data.range.from).toLocaleString()} → {new Date(data.range.to).toLocaleString()}
                </span>
              </div>
            </div>
            <div className="panel__body">
              <TimeSeriesChart series={data.series} showLatency />
            </div>
          </div>

          <div className="split split--3 section">
            <div className="panel">
              <div className="panel__header"><span className="panel__title">Provider usage</span></div>
              <div className="panel__body">
                <BarList
                  items={data.breakdowns.provider.map((row) => ({ ...row, key: providerLabel(row.key) }))}
                  emptyLabel="No provider usage recorded"
                  valueFormatter={(value) => `${value} req`}
                />
              </div>
            </div>

            <div className="panel">
              <div className="panel__header"><span className="panel__title">Model usage</span></div>
              <div className="panel__body">
                <BarList
                  items={data.breakdowns.model}
                  emptyLabel="No model usage recorded"
                  valueFormatter={(value) => `${value} req`}
                />
              </div>
            </div>

            <div className="panel">
              <div className="panel__header"><span className="panel__title">Protocol usage</span></div>
              <div className="panel__body">
                <BarList
                  items={data.breakdowns.protocol}
                  emptyLabel="No protocol usage recorded"
                  valueFormatter={(value) => `${value} req`}
                />
              </div>
            </div>
          </div>

          <div className="split split--2 section">
            <div className="panel">
              <div className="panel__header">
                <span className="panel__title">Error distribution</span>
                <div className="panel__actions">
                  <span className="tiny dim">{data.summary.failed} failed request(s)</span>
                </div>
              </div>
              <div className="panel__body">
                <BarList
                  items={data.breakdowns.errors}
                  emptyLabel="No failures in this range"
                  valueFormatter={(value) => `${value}`}
                />
              </div>
            </div>

            <div className="panel">
              <div className="panel__header">
                <span className="panel__title">Fallback frequency</span>
                <div className="panel__actions">
                  <span className="tiny dim">by final target</span>
                </div>
              </div>
              <div className="panel__body">
                <BarList
                  items={data.breakdowns.fallback}
                  emptyLabel="No fallbacks in this range"
                  valueFormatter={(value) => `${value} req`}
                />
              </div>
            </div>
          </div>

          <div className="split split--2 section">
            <div className="panel">
              <div className="panel__header"><span className="panel__title">Recent failures</span></div>
              {data.recentFailures.length === 0 ? (
                <EmptyState title="No failures in this range" icon="check" />
              ) : (
                <div className="table-wrap">
                  <table className="table table--compact">
                    <caption className="sr-only">Most recent failed requests</caption>
                    <thead>
                      <tr>
                        <th scope="col">Time</th>
                        <th scope="col">Target</th>
                        <th scope="col">Category</th>
                        <th scope="col">Message</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.recentFailures.map((failure) => (
                        <tr key={failure.seq}>
                          <td className="dim tiny nowrap">{formatRelativeTime(failure.receivedAt)}</td>
                          <td className="truncate">{providerLabel(failure.provider)} / {failure.model ?? EMPTY}</td>
                          <td><StatusBadge tone="danger" dot={false}>{failure.category}</StatusBadge></td>
                          <td className="tiny dim truncate" title={failure.message ?? undefined}>{failure.message ?? EMPTY}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            <div className="panel">
              <div className="panel__header"><span className="panel__title">Recent fallbacks</span></div>
              {data.recentFallbacks.length === 0 ? (
                <EmptyState title="No fallbacks in this range" icon="check" />
              ) : (
                <div className="table-wrap">
                  <table className="table table--compact">
                    <caption className="sr-only">Most recent requests that used a fallback</caption>
                    <thead>
                      <tr>
                        <th scope="col">Time</th>
                        <th scope="col">Final target</th>
                        <th scope="col" className="right">Hops</th>
                        <th scope="col">Outcome</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.recentFallbacks.map((item) => (
                        <tr key={item.seq}>
                          <td className="dim tiny nowrap">{formatRelativeTime(item.receivedAt)}</td>
                          <td className="truncate">{providerLabel(item.finalProvider)} / {item.finalModel ?? EMPTY}</td>
                          <td className="mono table__num">{item.fallbackCount}</td>
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
          </div>
        </>
      ) : (
        <div className="panel"><div className="panel__body"><TableSkeleton rows={8} label="Loading analytics" /></div></div>
      )}
    </div>
  );
}
