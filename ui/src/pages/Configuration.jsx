import { PageHeader } from "../components/layout/PageHeader.jsx";
import { DataTable } from "../components/ui/DataTable.jsx";
import { MaskedValue } from "../components/ui/MaskedValue.jsx";
import { StatusBadge } from "../components/ui/StatusBadge.jsx";
import { EmptyState } from "../components/ui/EmptyState.jsx";
import { ErrorState } from "../components/ui/ErrorState.jsx";
import { TableSkeleton } from "../components/ui/LoadingSkeleton.jsx";
import { useApi } from "../hooks/useApi.js";
import { getConfig } from "../api/config.js";
import { getSystem } from "../api/system.js";
import { formatDuration, protocolLabel, providerLabel, EMPTY } from "../lib/format.js";

/**
 * Configuration overview.
 *
 * Shows the gateway's *effective* configuration — exactly what the running
 * process parsed — which is the thing an operator actually needs when the
 * `.env` file and reality disagree.
 *
 * Secrets are represented as presence only. Provider keys are never sent to
 * the browser, and router keys are shown as a count. Env var *names* are shown
 * (they are not secret and they tell the operator what to edit); values are
 * not.
 */
export default function Configuration() {
  const config = useApi(getConfig, { intervalMs: 60_000 });
  const system = useApi(getSystem, { intervalMs: 60_000 });

  const data = config.data;

  const providerColumns = [
    {
      key: "provider",
      header: "Provider",
      get: (row) => row.id,
      render: (row) => (
        <div>
          <div>{providerLabel(row.id)}</div>
          <div className="tiny dim mono">{row.envPrefix}_*</div>
        </div>
      )
    },
    {
      key: "pool",
      header: "Pool",
      get: (row) => row.pool ?? "text",
      render: (row) => (
        <StatusBadge tone={row.pool === "vision" ? "info" : "neutral"} dot={false}>
          {(row.pool ?? "text").toUpperCase()}
        </StatusBadge>
      )
    },
    {
      key: "capabilities",
      header: "Capabilities",
      get: (row) => `${row.capabilities?.text ? "T" : ""}${row.capabilities?.vision ? "V" : ""}`,
      render: (row) => (
        <div className="row row--wrap" style={{ gap: "var(--sp-1)" }}>
          <StatusBadge tone={row.capabilities?.text ? "ok" : "neutral"} dot={false}>
            <span aria-hidden="true">{row.capabilities?.text ? "✓" : "✗"}</span> Text
          </StatusBadge>
          <StatusBadge tone={row.capabilities?.vision ? "info" : "neutral"} dot={false}>
            <span aria-hidden="true">{row.capabilities?.vision ? "✓" : "✗"}</span> Vision
          </StatusBadge>
        </div>
      )
    },
    {
      key: "configured",
      header: "Status",
      get: (row) => row.configured,
      render: (row) => row.configured
        ? <StatusBadge tone="ok">configured</StatusBadge>
        : <StatusBadge tone="neutral">incomplete</StatusBadge>
    },
    {
      key: "baseUrl",
      header: "Base URL",
      get: (row) => row.baseUrl ?? "",
      render: (row) => (
        <span className="mono tiny truncate table__truncate" title={row.baseUrl ?? undefined}>
          {row.baseUrl ?? <span className="dim">not set</span>}
        </span>
      )
    },
    {
      key: "keys",
      header: "API keys",
      align: "right",
      get: (row) => row.keyCount,
      render: (row) => <MaskedValue configured={row.keyCount > 0} noun={`${row.keyCount} key(s)`} />
    },
    {
      key: "models",
      header: "Models",
      align: "right",
      get: (row) => row.modelCount,
      render: (row) => <span className="mono">{row.modelCount}</span>
    },
    {
      key: "protocols",
      header: "Protocols",
      get: (row) => row.protocols.join(","),
      render: (row) => (
        <span className="tiny dim">{row.protocols.map(protocolLabel).join(", ") || EMPTY}</span>
      )
    },
    {
      key: "missing",
      header: "Missing",
      get: (row) => row.missing.join(","),
      render: (row) => row.missing.length === 0
        ? <span className="dim">—</span>
        : <span className="tiny" style={{ color: "var(--warn)" }}>{row.missing.join(", ")}</span>
    }
  ];

  if (config.loading && !data) {
    return (
      <div className="page">
        <PageHeader title="Configuration" description="Safe view of the gateway's effective configuration" />
        <div className="panel"><div className="panel__body"><TableSkeleton rows={8} label="Loading configuration" /></div></div>
      </div>
    );
  }

  return (
    <div className="page">
      <PageHeader
        title="Configuration"
        description="Safe view of the gateway's effective configuration"
        lastUpdatedAt={config.lastUpdatedAt}
        refreshing={config.refreshing}
        actions={
          <button type="button" className="btn" onClick={() => { config.reload(); system.reload(); }} disabled={config.refreshing}>
            Refresh
          </button>
        }
      />

      {config.error ? <ErrorState error={config.error} onRetry={config.reload} compact /> : null}

      <div className="notice notice--info section">
        <span>
          Values are read from the running process. Secret values are never sent to this panel —
          only whether they are configured.
        </span>
      </div>

      {data ? (
        <>
          <div className="split split--2 section">
            <div className="panel">
              <div className="panel__header"><span className="panel__title">Server</span></div>
              <div className="panel__body">
                <dl className="dl dl--tight">
                  <dt className="dl__term"><code>PORT</code></dt>
                  <dd className="dl__desc mono">{data.server.port}</dd>

                  <dt className="dl__term"><code>REQUEST_TIMEOUT_MS</code></dt>
                  <dd className="dl__desc mono">{data.server.requestTimeoutMs} ms</dd>

                  <dt className="dl__term"><code>MULTIAI_ROUTER_API_KEYS</code></dt>
                  <dd className="dl__desc">
                    {data.server.clientAuthRequired
                      ? <span>{data.server.clientKeyCount} configured — client auth enforced</span>
                      : <span className="dim">not set — gateway is open to local clients</span>}
                  </dd>
                </dl>
              </div>
            </div>

            <div className="panel">
              <div className="panel__header"><span className="panel__title">Routing</span></div>
              <div className="panel__body">
                <dl className="dl dl--tight">
                  <dt className="dl__term">Strategy</dt>
                  <dd className="dl__desc">{data.routing.strategy}</dd>

                  <dt className="dl__term">Target identity</dt>
                  <dd className="dl__desc mono">{data.routing.targetIdentity}</dd>

                  <dt className="dl__term">Exact model preferred</dt>
                  <dd className="dl__desc">{data.routing.exactModelPreferred ? "yes" : "no"}</dd>

                  <dt className="dl__term">Routing pools</dt>
                  <dd className="dl__desc">
                    <div className="row row--wrap" style={{ gap: "var(--sp-1)" }}>
                      {(data.routing.pools ?? ["text"]).map((pool) => (
                        <StatusBadge key={pool} tone={pool === "vision" ? "info" : "neutral"} dot={false}>
                          {pool.toUpperCase()}
                        </StatusBadge>
                      ))}
                    </div>
                  </dd>

                  <dt className="dl__term">Cross-pool fallback</dt>
                  <dd className="dl__desc">
                    {data.routing.crossPoolFallback === "blocked"
                      ? "blocked — an image request never falls back into the text pool"
                      : (data.routing.crossPoolFallback ?? EMPTY)}
                  </dd>

                  <dt className="dl__term"><code>RETRY_STATUS_CODES</code></dt>
                  <dd className="dl__desc">
                    <div className="row row--wrap" style={{ gap: "var(--sp-1)" }}>
                      {data.routing.retryableStatus.map((status) => (
                        <StatusBadge key={status} tone="neutral" dot={false}>{status}</StatusBadge>
                      ))}
                    </div>
                  </dd>
                </dl>
              </div>
            </div>
          </div>

          <div className="split split--2 section">
            <div className="panel">
              <div className="panel__header"><span className="panel__title">Health</span></div>
              <div className="panel__body">
                <dl className="dl dl--tight">
                  <dt className="dl__term">Probe strategy</dt>
                  <dd className="dl__desc">
                    Provider-aware and quota-free — each capability lists models rather than
                    generating, so a probe never consumes generation quota.
                  </dd>

                  <dt className="dl__term">Cycle interval</dt>
                  <dd className="dl__desc mono">
                    {system.data?.healthMonitor
                      ? formatDuration(system.data.healthMonitor.intervalMs)
                      : EMPTY}
                  </dd>

                  <dt className="dl__term">Cooldown</dt>
                  <dd className="dl__desc">
                    Applied per target on a retryable failure. Reported by
                    <code>/api/health</code> as <code>cooldownUntil</code>.
                  </dd>

                  <dt className="dl__term">States</dt>
                  <dd className="dl__desc">
                    <div className="row row--wrap" style={{ gap: "var(--sp-1)" }}>
                      <StatusBadge tone="ok" dot={false}>healthy</StatusBadge>
                      <StatusBadge tone="warn" dot={false}>cooldown</StatusBadge>
                      <StatusBadge tone="danger" dot={false}>failed</StatusBadge>
                      <StatusBadge tone="neutral" dot={false}>unknown</StatusBadge>
                    </div>
                  </dd>
                </dl>
              </div>
            </div>

            <div className="panel">
              <div className="panel__header"><span className="panel__title">Fallback</span></div>
              <div className="panel__body">
                <dl className="dl dl--tight">
                  <dt className="dl__term">Behaviour</dt>
                  <dd className="dl__desc">
                    Targets are tried in ranked order. A retryable failure cools that exact target
                    down and routing continues to the next candidate.
                  </dd>

                  <dt className="dl__term">Non-retryable</dt>
                  <dd className="dl__desc">
                    Authentication failures (401/403) and other non-retryable codes are returned to
                    the client immediately, without failover.
                  </dd>

                  <dt className="dl__term">Sticky sessions</dt>
                  <dd className="dl__desc">
                    A successful target becomes the session's preferred target. Clients may pin a
                    session with <code>X-Multi-AI-Session-ID</code>.
                  </dd>
                </dl>
              </div>
            </div>
          </div>

          <div className="panel section">
            <div className="panel__header">
              <span className="panel__title">Providers</span>
              <div className="panel__actions">
                <span className="tiny dim">
                  {data.summary.configuredProviders} of {data.summary.knownProviders} configured ·{" "}
                  {data.summary.configuredTargets} targets
                </span>
              </div>
            </div>
            <DataTable
              columns={providerColumns}
              rows={data.providers}
              rowKey={(row) => row.id}
              compact
              caption="Effective provider configuration"
              emptyState={<EmptyState title="No providers known" icon="server" />}
            />
          </div>

          <div className="panel section">
            <div className="panel__header">
              <span className="panel__title">Vision providers</span>
              <div className="panel__actions">
                <span className="tiny dim">
                  {data.summary.configuredVisionTargets ?? 0} vision targets ·{" "}
                  {data.summary.visionCapableProviders ?? 0} providers
                </span>
              </div>
            </div>
            <DataTable
              columns={providerColumns}
              rows={data.visionProviders ?? []}
              rowKey={(row) => `vision:${row.id}`}
              compact
              caption="Effective vision-pool configuration"
              emptyState={(
                <EmptyState title="No vision pool configured" icon="server">
                  Image requests fail with <code>503 no_vision_route</code> until a provider's
                  _VISION_API_KEYS, _VISION_MODELS and _VISION_BASE_URL are set.
                </EmptyState>
              )}
            />
          </div>

          <div className="panel section">
            <div className="panel__header">
              <span className="panel__title">Environment</span>
              <div className="panel__actions">
                <span className="tiny dim">names and presence only — never values</span>
              </div>
            </div>
            <div className="panel__body">
              <div className="section__title">Server variables</div>
              <div className="table-wrap" style={{ marginBottom: "var(--sp-4)" }}>
                <table className="table table--compact">
                  <caption className="sr-only">Server environment variables</caption>
                  <thead>
                    <tr>
                      <th scope="col">Variable</th>
                      <th scope="col">Kind</th>
                      <th scope="col">State</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.environment.server.map((variable) => (
                      <tr key={variable.name}>
                        <td className="mono">{variable.name}</td>
                        <td className="tiny dim">{variable.kind}</td>
                        <td>
                          {variable.configured
                            ? <StatusBadge tone="ok" dot={false}>configured</StatusBadge>
                            : <StatusBadge tone="neutral" dot={false}>default / empty</StatusBadge>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="section__title">Provider variables</div>
              <div className="table-wrap">
                <table className="table table--compact">
                  <caption className="sr-only">Provider environment variables</caption>
                  <thead>
                    <tr>
                      <th scope="col">Provider</th>
                      <th scope="col">Variable</th>
                      <th scope="col">Kind</th>
                      <th scope="col">State</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.environment.providers.flatMap((entry) =>
                      entry.vars.map((variable) => (
                        <tr key={`${entry.provider}-${variable.name}`}>
                          <td>{providerLabel(entry.provider)}</td>
                          <td className="mono">{variable.name}</td>
                          <td className="tiny dim">{variable.kind}</td>
                          <td>
                            {variable.configured
                              ? <StatusBadge tone="ok" dot={false}>configured</StatusBadge>
                              : <StatusBadge tone="neutral" dot={false}>not set</StatusBadge>}
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>

              <div className="section__title" style={{ marginTop: "var(--sp-4)" }}>Vision provider variables</div>
              <div className="table-wrap">
                <table className="table table--compact">
                  <caption className="sr-only">Vision provider environment variables</caption>
                  <thead>
                    <tr>
                      <th scope="col">Provider</th>
                      <th scope="col">Variable</th>
                      <th scope="col">Kind</th>
                      <th scope="col">State</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(data.environment.visionProviders ?? []).flatMap((entry) =>
                      entry.vars.map((variable) => (
                        <tr key={`vision-${entry.provider}-${variable.name}`}>
                          <td>{providerLabel(entry.provider)}</td>
                          <td className="mono">{variable.name}</td>
                          <td className="tiny dim">{variable.kind}</td>
                          <td>
                            {variable.configured
                              ? <StatusBadge tone="ok" dot={false}>configured</StatusBadge>
                              : <StatusBadge tone="neutral" dot={false}>not set</StatusBadge>}
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>

              <p className="tiny dim" style={{ marginTop: "var(--sp-3)" }}>
                Edit these in <code>.env</code> and restart the gateway. Secret values stay in that
                file and are never transmitted to this panel.
              </p>
            </div>
          </div>
        </>
      ) : null}
    </div>
  );
}
