import { useMemo, useState } from "react";
import { PageHeader } from "../components/layout/PageHeader.jsx";
import { DataTable } from "../components/ui/DataTable.jsx";
import { Drawer } from "../components/ui/Overlays.jsx";
import { StatusBadge } from "../components/ui/StatusBadge.jsx";
import { HealthBadge } from "../components/ui/HealthBadge.jsx";
import { LatencyBadge } from "../components/ui/LatencyBadge.jsx";
import { MaskedValue } from "../components/ui/MaskedValue.jsx";
import { EmptyState } from "../components/ui/EmptyState.jsx";
import { ErrorState } from "../components/ui/ErrorState.jsx";
import { TableSkeleton } from "../components/ui/LoadingSkeleton.jsx";
import { HealthDistribution } from "../components/charts/Charts.jsx";
import { useHealth } from "../context/HealthContext.jsx";
import { formatLatency, formatPercent, formatRelativeTime, protocolLabel, providerLabel, EMPTY } from "../lib/format.js";

/**
 * Providers.
 *
 * The drawer answers "is this provider set up correctly?" using only values
 * the gateway is willing to expose: base URL, model list, protocol support,
 * and a *count* of configured keys. There is no code path that reads key
 * material into the browser, so nothing here can leak one.
 */
export default function Providers() {
  const { providers, targets, error, loading, reload, lastUpdatedAt, refreshing } = useHealth();
  const [selectedId, setSelectedId] = useState(null);
  const [sort, setSort] = useState({ key: "provider", direction: "asc" });

  const selected = useMemo(
    () => (providers ?? []).find((provider) => provider.id === selectedId) ?? null,
    [providers, selectedId]
  );

  const columns = useMemo(() => [
    {
      key: "provider",
      header: "Provider",
      sortable: true,
      get: (row) => row.id,
      render: (row) => (
        <div>
          <div>{providerLabel(row.id)}</div>
          <div className="tiny dim mono">{row.envPrefix}_*</div>
        </div>
      )
    },
    {
      key: "status",
      header: "Status",
      sortable: true,
      get: (row) => row.health.status,
      render: (row) => row.configured
        ? <HealthBadge status={row.health.status} />
        : <StatusBadge tone="neutral">not configured</StatusBadge>
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
      key: "keys",
      header: "Keys",
      align: "right",
      sortable: true,
      get: (row) => row.keyCount,
      render: (row) => row.keyCount > 0
        ? <MaskedValue configured noun={`${row.keyCount} key(s)`} />
        : <MaskedValue configured={false} />
    },
    {
      key: "targets",
      header: "Targets",
      align: "right",
      sortable: true,
      get: (row) => row.targetCount,
      render: (row) => <span className="mono">{row.targetCount}</span>
    },
    {
      key: "healthy",
      header: "Healthy",
      align: "right",
      sortable: true,
      get: (row) => row.health.healthy,
      render: (row) => <span className="mono" style={{ color: row.health.healthy > 0 ? "var(--ok)" : undefined }}>{row.health.healthy}</span>
    },
    {
      key: "failed",
      header: "Failed",
      align: "right",
      sortable: true,
      get: (row) => row.health.failed + row.health.cooldown,
      render: (row) => {
        const bad = row.health.failed + row.health.cooldown;
        return <span className="mono" style={{ color: bad > 0 ? "var(--danger)" : undefined }}>{bad}</span>;
      }
    },
    {
      key: "latency",
      header: "Avg latency",
      align: "right",
      sortable: true,
      get: (row) => row.health.latencyMs,
      render: (row) => <LatencyBadge ms={row.health.latencyMs} />
    },
    {
      key: "checked",
      header: "Last check",
      align: "right",
      sortable: true,
      get: (row) => row.health.lastUpdatedAt,
      render: (row) => <span className="dim tiny nowrap">{formatRelativeTime(row.health.lastUpdatedAt)}</span>
    }
  ], []);

  if (loading && !providers) {
    return (
      <div className="page">
        <PageHeader title="Providers" description="Configured providers, credentials and per-provider health" />
        <div className="panel"><div className="panel__body"><TableSkeleton rows={8} label="Loading providers" /></div></div>
      </div>
    );
  }

  return (
    <div className="page">
      <PageHeader
        title="Providers"
        description="Configured providers, credentials and per-provider health"
        lastUpdatedAt={lastUpdatedAt}
        refreshing={refreshing}
        actions={<button type="button" className="btn" onClick={reload} disabled={refreshing}>Refresh</button>}
      />

      {error ? <ErrorState error={error} onRetry={reload} compact /> : null}

      <section className="section">
        <HealthDistribution counts={{
          healthy: (providers ?? []).reduce((sum, p) => sum + p.health.healthy, 0),
          cooldown: (providers ?? []).reduce((sum, p) => sum + p.health.cooldown, 0),
          failed: (providers ?? []).reduce((sum, p) => sum + p.health.failed, 0),
          unknown: (providers ?? []).reduce((sum, p) => sum + p.health.unknown, 0)
        }} />
      </section>

      <div className="panel">
        <DataTable
          columns={columns}
          rows={providers ?? []}
          sort={sort}
          onSortChange={setSort}
          rowKey={(row) => row.id}
          onRowClick={(row) => setSelectedId(row.id)}
          caption="All known providers and their routing targets"
          emptyState={<EmptyState title="No providers" icon="server" />}
        />
      </div>

      <ProviderDrawer
        provider={selected}
        targets={(targets ?? []).filter((target) => target.provider === selected?.id)}
        onClose={() => setSelectedId(null)}
      />
    </div>
  );
}

function ProviderDrawer({ provider, targets, onClose }) {
  return (
    <Drawer
      open={Boolean(provider)}
      onClose={onClose}
      wide
      title={provider ? providerLabel(provider.id) : ""}
      subtitle={provider ? `${provider.envPrefix}_* environment variables` : null}
    >
      {provider ? (
        <div className="stack" style={{ gap: "var(--sp-4)" }}>
          <div className="row row--wrap">
            {provider.configured
              ? <StatusBadge tone="ok">configured</StatusBadge>
              : <StatusBadge tone="neutral">not configured</StatusBadge>}
            <StatusBadge tone="info" dot={false}>{provider.targetCount} targets</StatusBadge>
            {provider.protocols.map((protocol) => (
              <StatusBadge key={protocol} tone="neutral" dot={false}>{protocolLabel(protocol)}</StatusBadge>
            ))}
          </div>

          {!provider.configured ? (
            <div className="notice notice--warn">
              <div>
                This provider is incomplete and is excluded from routing. Missing:
                {" "}<strong>{provider.missing.join(", ")}</strong>.
              </div>
            </div>
          ) : null}

          <section>
            <div className="section__title" style={{ marginBottom: "var(--sp-2)" }}>Configuration</div>
            <dl className="dl">
              <dt className="dl__term">Base URL</dt>
              <dd className="dl__desc mono">{provider.baseUrl ?? EMPTY}</dd>

              <dt className="dl__term">Protocols</dt>
              <dd className="dl__desc">{provider.protocols.map(protocolLabel).join(", ") || EMPTY}</dd>

              <dt className="dl__term">API keys</dt>
              <dd className="dl__desc">
                {provider.keyCount > 0
                  ? <span>{provider.keyCount} configured — values never leave the server</span>
                  : <span className="dim">none configured</span>}
              </dd>

              {provider.clientHeaderNames.length > 0 ? (
                <>
                  <dt className="dl__term">Client headers</dt>
                  <dd className="dl__desc">
                    {provider.clientHeaderNames.join(", ")}
                    <div className="tiny dim">Names only — header values are not exposed.</div>
                  </dd>
                </>
              ) : null}

              <dt className="dl__term">Models</dt>
              <dd className="dl__desc">
                {provider.models.length > 0
                  ? <span className="mono tiny">{provider.models.join(", ")}</span>
                  : <span className="dim">none configured</span>}
              </dd>
            </dl>
          </section>

          <section>
            <div className="section__title" style={{ marginBottom: "var(--sp-2)" }}>Health</div>
            <dl className="dl dl--tight">
              <dt className="dl__term">Overall</dt>
              <dd className="dl__desc"><HealthBadge status={provider.health.status} /></dd>

              <dt className="dl__term">Success rate</dt>
              <dd className="dl__desc">
                {provider.health.successRate === null
                  ? <span className="dim">no observations yet</span>
                  : formatPercent(provider.health.successRate)}
              </dd>

              <dt className="dl__term">Observations</dt>
              <dd className="dl__desc mono">
                {provider.health.successes} ok / {provider.health.failures} failed
              </dd>

              <dt className="dl__term">Latency</dt>
              <dd className="dl__desc"><LatencyBadge ms={provider.health.latencyMs} /></dd>

              <dt className="dl__term">Last check</dt>
              <dd className="dl__desc">{formatRelativeTime(provider.health.lastUpdatedAt)}</dd>
            </dl>
          </section>

          <section>
            <div className="section__title" style={{ marginBottom: "var(--sp-2)" }}>
              Targets ({targets.length})
            </div>
            {targets.length === 0 ? (
              <span className="dim small">No targets — this provider is not routable.</span>
            ) : (
              <div className="table-wrap">
                <table className="table table--compact">
                  <caption className="sr-only">Per-target health for {provider.id}</caption>
                  <thead>
                    <tr>
                      <th scope="col">Model</th>
                      <th scope="col" className="right">Key</th>
                      <th scope="col">Health</th>
                      <th scope="col" className="right">Score</th>
                      <th scope="col" className="right">Latency</th>
                      <th scope="col">Last reason</th>
                    </tr>
                  </thead>
                  <tbody>
                    {targets.map((target) => (
                      <tr key={target.id}>
                        <td className="mono truncate">{target.model}</td>
                        <td className="mono table__num">{target.keyIndex}</td>
                        <td><HealthBadge status={target.status} /></td>
                        <td className="mono table__num">{Math.round(target.score)}</td>
                        <td className="table__num"><LatencyBadge ms={target.latencyMs} /></td>
                        <td className="truncate tiny dim" title={target.lastReason ?? undefined}>
                          {target.lastReason ?? EMPTY}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <div className="notice">
            <span>
              Provider credentials are configured server-side in <code>.env</code> and are never
              sent to this panel. Only the count is shown.
            </span>
          </div>
        </div>
      ) : null}
    </Drawer>
  );
}
