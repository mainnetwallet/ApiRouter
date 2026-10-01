import { useEffect, useState } from "react";
import { PageHeader } from "../components/layout/PageHeader.jsx";
import { MetricCard } from "../components/ui/MetricCard.jsx";
import { MetricSkeleton } from "../components/ui/LoadingSkeleton.jsx";
import { ErrorState } from "../components/ui/ErrorState.jsx";
import { StatusBadge } from "../components/ui/StatusBadge.jsx";
import { CopyableId } from "../components/ui/CopyableId.jsx";
import { useSystemStatus } from "../context/SystemStatusContext.jsx";
import { formatDateTime, formatDuration, formatNumber } from "../lib/format.js";

/**
 * System page.
 *
 * Runtime facts about the gateway process. Uptime and the countdown to the
 * next health cycle tick locally rather than being re-fetched every second —
 * the underlying values only change on the server's own schedule, so polling
 * them faster would be pure waste.
 */
export default function SystemPage() {
  const { system, connection, loading, error, reload, refreshing, lastUpdatedAt } = useSystemStatus();
  const [, setTick] = useState(0);

  // One-second local ticker, so uptime and the next-cycle countdown advance
  // smoothly without any network traffic.
  useEffect(() => {
    const timer = setInterval(() => setTick((value) => value + 1), 1000);
    return () => clearInterval(timer);
  }, []);

  if (loading && !system) {
    return (
      <div className="page">
        <PageHeader title="System" description="Runtime, health monitor scheduling and process details" />
        <MetricSkeleton count={6} />
      </div>
    );
  }

  if (!system) {
    return (
      <div className="page">
        <PageHeader title="System" description="Runtime, health monitor scheduling and process details" />
        <div className="panel">
          <ErrorState
            error={error ?? { label: "No system information", hint: "The gateway did not return a system report." }}
            onRetry={reload}
          />
        </div>
      </div>
    );
  }

  const monitor = system.healthMonitor;
  const uptimeMs = system.uptimeMs + (Date.now() - (lastUpdatedAt ?? Date.now()));
  const nextCycleInMs = monitor?.nextCycleAt ? Math.max(0, Date.parse(monitor.nextCycleAt) - Date.now()) : null;

  return (
    <div className="page">
      <PageHeader
        title="System"
        description="Runtime, health monitor scheduling and process details"
        lastUpdatedAt={lastUpdatedAt}
        refreshing={refreshing}
        actions={<button type="button" className="btn" onClick={reload} disabled={refreshing}>Refresh</button>}
      />

      {error ? <ErrorState error={error} onRetry={reload} compact /> : null}

      <section className="section">
        <div className="metrics">
          <MetricCard
            label="Server status"
            value={system.status === "ok" ? "running" : system.status}
            tone={connection.state === "ok" ? "ok" : connection.tone}
            hint={connection.label}
            icon="server"
            small
          />
          <MetricCard label="Uptime" value={formatDuration(uptimeMs)} icon="clock" small />
          <MetricCard
            label="Providers loaded"
            value={formatNumber(system.providers.configuredCount)}
            hint={`${system.providers.loadedCount} touched in config`}
            icon="box"
          />
          <MetricCard label="Configured targets" value={formatNumber(system.configuredTargets)} icon="layers" />
          <MetricCard
            label="Health monitor"
            value={monitor?.enabled ? (monitor.running ? "running" : "idle") : "stopped"}
            hint={monitor ? `every ${formatDuration(monitor.intervalMs)}` : null}
            tone={monitor?.enabled ? "ok" : "warn"}
            icon="activity"
            small
          />
          <MetricCard
            label="Next health cycle"
            value={nextCycleInMs === null ? null : formatDuration(nextCycleInMs)}
            hint={monitor?.nextCycleAt ? formatDateTime(monitor.nextCycleAt) : null}
            icon="refresh"
            small
          />
        </div>
      </section>

      <div className="split split--2 section">
        <div className="panel">
          <div className="panel__header"><span className="panel__title">Process</span></div>
          <div className="panel__body">
            <dl className="dl dl--tight">
              <dt className="dl__term">Service</dt>
              <dd className="dl__desc mono">{system.service}</dd>

              <dt className="dl__term">Server address</dt>
              <dd className="dl__desc mono">{system.address}</dd>

              <dt className="dl__term">Runtime</dt>
              <dd className="dl__desc">{system.runtime} {system.nodeVersion}</dd>

              <dt className="dl__term">V8</dt>
              <dd className="dl__desc mono">{system.v8Version ?? "—"}</dd>

              <dt className="dl__term">Platform</dt>
              <dd className="dl__desc mono">{system.platform} / {system.architecture}</dd>

              <dt className="dl__term">PID</dt>
              <dd className="dl__desc mono">{system.pid}</dd>

              <dt className="dl__term">Environment</dt>
              <dd className="dl__desc">
                <StatusBadge tone={system.environment === "production" ? "info" : "neutral"} dot={false}>
                  {system.environment}
                </StatusBadge>
              </dd>

              <dt className="dl__term">Started at</dt>
              <dd className="dl__desc">{formatDateTime(system.startedAt)}</dd>

              <dt className="dl__term">Client auth</dt>
              <dd className="dl__desc">
                {system.clientAuthRequired
                  ? <StatusBadge tone="warn" dot={false}>required</StatusBadge>
                  : <StatusBadge tone="neutral" dot={false}>open</StatusBadge>}
              </dd>
            </dl>
          </div>
        </div>

        <div className="stack">
          <div className="panel">
            <div className="panel__header"><span className="panel__title">Health monitor</span></div>
            <div className="panel__body">
              {!monitor ? (
                <span className="dim small">No monitor information available.</span>
              ) : (
                <dl className="dl dl--tight">
                  <dt className="dl__term">Enabled</dt>
                  <dd className="dl__desc">{monitor.enabled ? "yes" : "no"}</dd>

                  <dt className="dl__term">Cycles run</dt>
                  <dd className="dl__desc mono">{monitor.cycles}</dd>

                  <dt className="dl__term">Probes in flight</dt>
                  <dd className="dl__desc mono">{monitor.inFlightProbes}</dd>

                  <dt className="dl__term">Targets per cycle</dt>
                  <dd className="dl__desc mono">{monitor.targetCount}</dd>

                  <dt className="dl__term">Last cycle</dt>
                  <dd className="dl__desc">
                    {monitor.lastCycle ? (
                      <>
                        {formatDateTime(monitor.lastCycle.completedAt)}
                        <div className="tiny dim">
                          {monitor.lastCycle.probes} probes in {formatDuration(monitor.lastCycle.durationMs)}
                        </div>
                        <div className="tiny">
                          <span style={{ color: "var(--ok)" }}>{monitor.lastCycle.outcomes.healthy} healthy</span>
                          {" · "}
                          <span style={{ color: "var(--danger)" }}>{monitor.lastCycle.outcomes.failed} failed</span>
                          {" · "}
                          <span className="dim">{monitor.lastCycle.outcomes.passive} passive</span>
                        </div>
                      </>
                    ) : <span className="dim">no cycle completed yet</span>}
                  </dd>

                  <dt className="dl__term">Next cycle</dt>
                  <dd className="dl__desc">
                    {monitor.nextCycleAt
                      ? <>{formatDateTime(monitor.nextCycleAt)} <span className="dim">(in {formatDuration(nextCycleInMs)})</span></>
                      : <span className="dim">not scheduled</span>}
                  </dd>
                </dl>
              )}
            </div>
          </div>

          <div className="panel">
            <div className="panel__header"><span className="panel__title">Providers loaded</span></div>
            <div className="panel__body">
              {system.providers.loaded.length === 0 ? (
                <span className="dim small">
                  No provider has any configuration set. Define an API key, model list and base URL
                  to make one routable.
                </span>
              ) : (
                <div className="row row--wrap" style={{ gap: "var(--sp-2)" }}>
                  {system.providers.loaded.map((provider) => (
                    <StatusBadge
                      key={provider}
                      tone={system.providers.loaded.includes(provider) ? "info" : "neutral"}
                      dot={false}
                    >
                      {provider}
                    </StatusBadge>
                  ))}
                </div>
              )}
              <p className="tiny dim" style={{ marginTop: "var(--sp-2)" }}>
                &ldquo;Loaded&rdquo; means the process read some configuration for it; a provider is
                only <em>routable</em> when it also has models and a base URL.
              </p>
            </div>
          </div>

          <div className="notice">
            <span>
              {system.telemetry.note} A provider&apos;s credentials are configured server-side and are
              never part of this report.
            </span>
          </div>
        </div>
      </div>

      <div className="panel">
        <div className="panel__header"><span className="panel__title">Endpoints</span></div>
        <div className="panel__body">
          <div className="table-wrap">
            <table className="table table--compact">
              <caption className="sr-only">Gateway endpoints</caption>
              <thead>
                <tr>
                  <th scope="col">Method</th>
                  <th scope="col">Path</th>
                  <th scope="col">Purpose</th>
                  <th scope="col">Open</th>
                </tr>
              </thead>
              <tbody>
                {[
                  ["GET", "/health", "Gateway and per-target health", true],
                  ["GET", "/v1/models", "Model discovery", true],
                  ["GET", "/api/system", "This report", false],
                  ["GET", "/api/config", "Safe configuration view", false],
                  ["GET", "/api/health", "Health with rollups", false],
                  ["GET", "/api/requests", "Request log", false],
                  ["GET", "/api/analytics", "Metrics", false],
                  ["POST", "/v1/messages", "Anthropic proxy", true],
                  ["POST", "/v1/chat/completions", "OpenAI Chat proxy", true],
                  ["POST", "/v1/responses", "OpenAI Responses proxy", true],
                  ["POST", "/v1beta/models/{model}:generateContent", "Gemini proxy", true]
                ].map(([method, path, purpose, open]) => (
                  <tr key={`${method} ${path}`}>
                    <td className="mono tiny">{method}</td>
                    <td className="mono tiny">
                      {open ? <a href={path} target="_blank" rel="noreferrer">{path}</a> : path}
                    </td>
                    <td className="tiny dim">{purpose}</td>
                    <td>
                      {open
                        ? <StatusBadge tone="neutral" dot={false}>public</StatusBadge>
                        : <StatusBadge tone="warn" dot={false}>admin</StatusBadge>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="row" style={{ marginTop: "var(--sp-3)", gap: "var(--sp-2)" }}>
            <span className="tiny dim">Session id header:</span>
            <CopyableId value="X-Multi-AI-Session-ID" showFull label="Copy header name" />
          </div>
        </div>
      </div>
    </div>
  );
}
