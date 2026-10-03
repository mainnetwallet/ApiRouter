import { useMemo, useState } from "react";
import { getProviders } from "../api/providers.js";
import { useApi } from "../hooks/useApi.js";
import { useConnection } from "../context/ConnectionContext.jsx";
import { PageHeader } from "../components/layout/PageHeader.jsx";
import { DataTable } from "../components/ui/DataTable.jsx";
import { StatusBadge } from "../components/ui/StatusBadge.jsx";
import { HealthBadge } from "../components/ui/HealthBadge.jsx";
import { LatencyBadge } from "../components/ui/LatencyBadge.jsx";
import { MaskedValue } from "../components/ui/MaskedValue.jsx";
import { EmptyState } from "../components/ui/EmptyState.jsx";
import { ErrorState } from "../components/ui/ErrorState.jsx";
import { TableSkeleton } from "../components/ui/LoadingSkeleton.jsx";
import { HealthDistribution } from "../components/charts/Charts.jsx";
import { CapabilityBadges } from "../components/domain/CapabilityBadges.jsx";
import { ProviderDrawer } from "../components/domain/ProviderDrawer.jsx";
import { formatRelativeTime, providerLabel } from "../lib/format.js";

/**
 * Providers.
 *
 * Text and vision are two independent routing pools, so they are presented as
 * two tables rather than one merged list: a provider healthy for text and
 * failing for vision must be able to say exactly that, and the models, keys and
 * base URLs behind each pool are different configuration.
 *
 * Clicking a row opens the shared `ProviderDrawer`, which answers "is this
 * provider set up correctly?" using only values the gateway is willing to
 * expose: base URL, model lists, protocol support and a *count* of configured
 * keys. There is no code path that reads key material into the browser, so
 * nothing here can leak one.
 */

export default function Providers() {
  const { generation } = useConnection();
  const {
    data: providerData,
    error,
    loading,
    reload,
    lastUpdatedAt,
    refreshing
  } = useApi(getProviders, {
    intervalMs: 10_000,
    deps: [generation]
  });

  const textProviders = providerData?.providers ?? [];
  const visionProviders = providerData?.visionProviders ?? [];

  // One entry per pool, each rendered as its own table under its own heading.
  const groups = useMemo(() => ([
    {
      pool: "text",
      title: "Text providers",
      description: "Serve ordinary text requests. Separate keys, base URLs and models from the vision pool.",
      rows: textProviders
    },
    {
      pool: "vision",
      title: "Vision providers",
      description: "Serve requests carrying an image. An image request never falls back into the text pool.",
      rows: visionProviders
    }
  ]), [textProviders, visionProviders]);

  // { id, pool }: the same provider can have a row in both tables, and the two
  // rows describe different configuration.
  const [selection, setSelection] = useState(null);
  const [sort, setSort] = useState({ key: "provider", direction: "asc" });

  const selected = useMemo(() => {
    if (!selection) return null;
    const rows = selection.pool === "vision" ? visionProviders : textProviders;
    return rows.find((provider) => provider.id === selection.id) ?? null;
  }, [selection, textProviders, visionProviders]);

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
      key: "capabilities",
      header: "Capabilities",
      sortable: true,
      get: (row) => `${row.capabilities?.text ? "T" : ""}${row.capabilities?.vision ? "V" : ""}`,
      render: (row) => <CapabilityBadges capabilities={row.capabilities} />
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

  if (loading && !providerData) {
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

      {groups.map((group) => (
        <section className="section" key={group.pool}>
          <div className="section__title" style={{ marginBottom: "var(--sp-2)" }}>
            {group.title}
            <span className="tiny dim" style={{ marginLeft: "var(--sp-2)", fontWeight: 400 }}>
              {group.description}
            </span>
          </div>

          <div className="panel" style={{ marginBottom: "var(--sp-3)" }}>
            <div className="panel__body">
              <HealthDistribution counts={{
                healthy: group.rows.reduce((sum, p) => sum + p.health.healthy, 0),
                cooldown: group.rows.reduce((sum, p) => sum + p.health.cooldown, 0),
                failed: group.rows.reduce((sum, p) => sum + p.health.failed, 0),
                unknown: group.rows.reduce((sum, p) => sum + p.health.unknown, 0)
              }} />
            </div>
          </div>

          <div className="panel">
            <DataTable
              columns={columns}
              rows={group.rows}
              sort={sort}
              onSortChange={setSort}
              rowKey={(row) => `${group.pool}:${row.id}`}
              onRowClick={(row) => setSelection({ id: row.id, pool: group.pool })}
              caption={`${group.title} and their ${group.pool} routing targets`}
              emptyState={(
                <EmptyState title={`No ${group.title.toLowerCase()}`} icon="server">
                  {group.pool === "vision"
                    ? "No vision pool is configured. Image requests will fail with 503 until one is."
                    : "No text provider is configured."}
                </EmptyState>
              )}
            />
          </div>
        </section>
      ))}

      <ProviderDrawer
        open={Boolean(selected)}
        onClose={() => setSelection(null)}
        id={selected?.id}
        pools={selected ? [{ pool: selected.pool, record: selected }] : []}
      />
    </div>
  );
}
