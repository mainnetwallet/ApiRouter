import { useMemo, useState } from "react";
import { getProviders } from "../api/providers.js";
import { useApi } from "../hooks/useApi.js";
import { useConnection } from "../context/ConnectionContext.jsx";
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
import { formatLatency, formatPercent, formatRelativeTime, protocolLabel, providerLabel, EMPTY } from "../lib/format.js";

/**
 * Providers.
 *
 * Text and vision are two independent routing pools, so they are presented as
 * two tables rather than one merged list: a provider healthy for text and
 * failing for vision must be able to say exactly that, and the models, keys and
 * base URLs behind each pool are different configuration.
 *
 * The drawer answers "is this provider set up correctly?" using only values the
 * gateway is willing to expose: base URL, model lists, protocol support and a
 * *count* of configured keys. There is no code path that reads key material
 * into the browser, so nothing here can leak one.
 */

const POOL_LABEL = Object.freeze({ text: "Text", vision: "Vision" });

/** ✓/✗ badges for the two capabilities, derived from configuration by the backend. */
function CapabilityBadges({ capabilities }) {
  const text = capabilities?.text === true;
  const vision = capabilities?.vision === true;
  return (
    <div className="row row--wrap" style={{ gap: "var(--sp-1)" }}>
      <StatusBadge tone={text ? "ok" : "neutral"} dot={false}>
        <span aria-hidden="true">{text ? "✓" : "✗"}</span> Text
      </StatusBadge>
      <StatusBadge tone={vision ? "info" : "neutral"} dot={false}>
        <span aria-hidden="true">{vision ? "✓" : "✗"}</span> Vision
      </StatusBadge>
    </div>
  );
}

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
        provider={selected}
        onClose={() => setSelection(null)}
      />
    </div>
  );
}

function ProviderDrawer({ provider, onClose }) {
  // Model lists are separated by pool. An older gateway that predates the
  // capability metadata still gets its single list shown for its own pool.
  const textModels = Array.isArray(provider?.textModels)
    ? provider.textModels
    : provider?.pool === "text" ? provider?.models ?? [] : [];
  const visionModels = Array.isArray(provider?.visionModels)
    ? provider.visionModels
    : provider?.pool === "vision" ? provider?.models ?? [] : [];
  const targets = provider?.targets ?? [];

  return (
    <Drawer
      open={Boolean(provider)}
      onClose={onClose}
      wide
      title={provider ? providerLabel(provider.id) : ""}
      subtitle={provider ? `${POOL_LABEL[provider.pool] ?? "Text"} pool · ${provider.envPrefix}_* environment variables` : null}
    >
      {provider ? (
        <div className="stack" style={{ gap: "var(--sp-4)" }}>
          <div className="row row--wrap">
            {provider.configured
              ? <StatusBadge tone="ok">configured</StatusBadge>
              : <StatusBadge tone="neutral">not configured</StatusBadge>}
            <StatusBadge tone={provider.pool === "vision" ? "info" : "neutral"} dot={false}>
              {POOL_LABEL[provider.pool] ?? "Text"} pool
            </StatusBadge>
            <StatusBadge tone="info" dot={false}>{provider.targetCount} targets</StatusBadge>
            {provider.protocols.map((protocol) => (
              <StatusBadge key={protocol} tone="neutral" dot={false}>{protocolLabel(protocol)}</StatusBadge>
            ))}
          </div>

          {!provider.configured ? (
            <div className="notice notice--warn">
              <div>
                This provider is incomplete and is excluded from the {POOL_LABEL[provider.pool] ?? "text"} pool. Missing:
                {" "}<strong>{provider.missing.join(", ")}</strong>.
              </div>
            </div>
          ) : null}

          <section>
            <div className="section__title" style={{ marginBottom: "var(--sp-2)" }}>Capabilities</div>
            <div className="row row--wrap" style={{ gap: "var(--sp-3)" }}>
              <CapabilityBadges capabilities={provider.capabilities} />
            </div>
            <dl className="dl" style={{ marginTop: "var(--sp-3)" }}>
              <dt className="dl__term">Text models</dt>
              <dd className="dl__desc">
                {textModels.length > 0
                  ? <span className="mono tiny">{textModels.join(", ")}</span>
                  : <span className="dim">none configured</span>}
              </dd>

              <dt className="dl__term">Vision models</dt>
              <dd className="dl__desc">
                {visionModels.length > 0
                  ? <span className="mono tiny">{visionModels.join(", ")}</span>
                  : <span className="dim">none configured</span>}
              </dd>
            </dl>
            <p className="tiny dim" style={{ marginTop: "var(--sp-2)" }}>
              Capabilities are derived from what is configured for each pool, never assumed from
              the provider's name.
            </p>
          </section>

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
              {POOL_LABEL[provider.pool] ?? "Text"} targets ({targets.length})
            </div>
            {targets.length === 0 ? (
              <span className="dim small">No targets — this provider is not routable in this pool.</span>
            ) : (
              <div className="table-wrap">
                <table className="table table--compact">
                  <caption className="sr-only">Per-target health for {provider.id} ({provider.pool} pool)</caption>
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
