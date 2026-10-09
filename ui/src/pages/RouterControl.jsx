import { useMemo, useState } from "react";
import { PageHeader } from "../components/layout/PageHeader.jsx";
import { RoutingGraph } from "../components/domain/RoutingGraph.jsx";
import { DataTable } from "../components/ui/DataTable.jsx";
import { HealthBadge } from "../components/ui/HealthBadge.jsx";
import { StatusBadge } from "../components/ui/StatusBadge.jsx";
import { PoolBadge } from "../components/ui/PoolBadge.jsx";
import { LatencyBadge } from "../components/ui/LatencyBadge.jsx";
import { EmptyState } from "../components/ui/EmptyState.jsx";
import { ErrorState } from "../components/ui/ErrorState.jsx";
import { MetricCard } from "../components/ui/MetricCard.jsx";
import { TableSkeleton } from "../components/ui/LoadingSkeleton.jsx";
import { useApi } from "../hooks/useApi.js";
import { useHealth } from "../context/HealthContext.jsx";
import { getRoutingPreview } from "../api/router.js";
import { POOLS } from "../lib/targets.js";
import { poolLabel } from "../lib/pools.js";
import { formatLatency, protocolLabel, providerLabel, EMPTY } from "../lib/format.js";

/**
 * Router control centre.
 *
 * Every value on this page is produced by the backend. The pipeline, the
 * candidate list, the ranking and the selected target all come from
 * `/api/router/preview`, which runs the same selection the live proxy runs:
 *
 *   1. a protocol-specific bridge selector picks the reachable targets —
 *      `selectBridgeTargets` (Anthropic), `selectCodexTargets` (Responses),
 *      `selectChatTargets` (Chat) or `selectGeminiTargets` (Gemini);
 *   2. `buildRoutePlan` orders them: the session's valid sticky target, then
 *      priority targets, then Provider -> Key -> Models (a requested model
 *      leads its provider's chain);
 *   3. health only removes cooling targets; the normal list is never reordered
 *      by health score or by the sticky target.
 *
 * The frontend performs no routing arithmetic of its own — it cannot, because
 * it has no copy of the rule to drift out of date.
 */
export default function RouterControl() {
  const { targets: healthTargets } = useHealth();

  const [pool, setPool] = useState("text");
  const [protocol, setProtocol] = useState("");
  const [model, setModel] = useState("");
  const [session, setSession] = useState("");

  // Only this pool's targets are offered. The two pools have separate models,
  // separate health and separate fallback chains, so a text model must never
  // appear as a vision choice (or the other way round).
  const poolTargets = useMemo(
    () => healthTargets.filter((target) => (target.pool ?? "text") === pool),
    [healthTargets, pool]
  );

  const poolCounts = useMemo(() => {
    const counts = { text: 0, vision: 0 };
    for (const target of healthTargets) counts[(target.pool ?? "text") === "vision" ? "vision" : "text"] += 1;
    return counts;
  }, [healthTargets]);

  const protocols = useMemo(() => {
    const set = new Set();
    for (const target of poolTargets) {
      for (const protocol of target.protocols ?? []) set.add(protocol);
    }
    return [...set].sort();
  }, [poolTargets]);

  const models = useMemo(
    () => [...new Set(poolTargets.map((target) => target.model))].sort(),
    [poolTargets]
  );

  // Fall back to the first protocol the selected pool actually serves, so a
  // protocol chosen for one pool cannot carry over to the other as an error.
  const activeProtocol = protocols.includes(protocol) ? protocol : (protocols[0] ?? "");

  const preview = useApi(
    ({ signal }) => getRoutingPreview(
      { protocol: activeProtocol, model, session, pool },
      { signal }
    ),
    { deps: [activeProtocol, model, session, pool], enabled: Boolean(activeProtocol) }
  );

  const data = preview.data;

  const candidateColumns = useMemo(() => [
    {
      key: "rank",
      header: "#",
      align: "right",
      get: (row) => row.rank ?? 999,
      render: (row) => (
        <span className="mono" style={{ fontWeight: row.rank === 1 ? 600 : 400 }}>
          {row.rank ?? "—"}
        </span>
      )
    },
    {
      key: "provider",
      header: "Provider",
      get: (row) => row.provider,
      render: (row) => <span className="nowrap">{providerLabel(row.provider)}</span>
    },
    {
      key: "model",
      header: "Model",
      get: (row) => row.model,
      render: (row) => <span className="mono truncate table__truncate" title={row.model}>{row.model}</span>
    },
    {
      key: "key",
      header: "Key",
      align: "right",
      get: (row) => row.keyIndex,
      render: (row) => <span className="mono">{row.keyIndex}</span>
    },
    {
      key: "status",
      header: "Health",
      get: (row) => row.status,
      render: (row) => <HealthBadge status={row.status} title={row.lastReason ?? undefined} />
    },
    {
      key: "score",
      header: "Score",
      align: "right",
      get: (row) => row.score ?? -1,
      render: (row) => <span className="mono">{Number.isFinite(row.score) ? Math.round(row.score) : EMPTY}</span>
    },
    {
      key: "latency",
      header: "Latency",
      align: "right",
      get: (row) => row.latencyMs,
      render: (row) => <LatencyBadge ms={row.latencyMs} />
    },
    {
      key: "available",
      header: "Eligible",
      align: "right",
      get: (row) => row.available,
      render: (row) => row.available
        ? <StatusBadge tone="ok" dot={false}>yes</StatusBadge>
        : <StatusBadge tone="warn" dot={false}>cooldown</StatusBadge>
    }
  ], []);

  const supportsProtocols = protocols.length > 0;

  return (
    <div className="page">
      <PageHeader
        title="Router"
        description="How the gateway resolves a request to a target"
        lastUpdatedAt={preview.lastUpdatedAt}
        refreshing={preview.refreshing}
        actions={
          <button type="button" className="btn" onClick={preview.reload} disabled={preview.refreshing}>
            Re-evaluate
          </button>
        }
      />

      {/* Outside the conditional on purpose: a pool with no targets (vision is
          often unconfigured) must not hide the switch, or the operator would
          have no way back to the other pool. */}
      <div className="row row--wrap section" style={{ gap: "var(--sp-3)" }}>
        <span className="field__label">Routing pool</span>
        <div className="chips" role="group" aria-label="Routing pool">
          {POOLS.map((value) => (
            <button
              key={value}
              type="button"
              className={`chip${pool === value ? " is-active" : ""}${value === "vision" ? " chip--vision" : " chip--text"}`}
              aria-pressed={pool === value}
              onClick={() => { setPool(value); setModel(""); }}
            >
              {poolLabel(value).toUpperCase()} · {poolCounts[value]} targets
            </button>
          ))}
        </div>
      </div>

      {!supportsProtocols ? (
        <div className="panel">
          <EmptyState title="No routable protocols" icon="route">
            No provider is configured well enough to serve a request in the{" "}
            <strong>{pool.toUpperCase()}</strong> pool, so there is no routing decision to show.
            {pool === "vision" ? " Image requests will fail with 503 until a vision provider is set up." : ""}
          </EmptyState>
        </div>
      ) : (
        <>
          <div className="panel section">
            <div className="panel__header">
              <span className="panel__title">Simulate a request</span>
              <div className="panel__actions">
                <PoolBadge pool={pool} />
              </div>
            </div>
            <div className="panel__body">
              <div className="row row--wrap" style={{ alignItems: "flex-end", gap: "var(--sp-3)" }}>
                <div className="field">
                  <label className="field__label" htmlFor="router-protocol">Client protocol</label>
                  <select
                    id="router-protocol"
                    className="select"
                    value={activeProtocol}
                    onChange={(event) => setProtocol(event.target.value)}
                  >
                    {protocols.map((value) => (
                      <option key={value} value={value}>{protocolLabel(value)}</option>
                    ))}
                  </select>
                </div>

                <div className="field grow">
                  <label className="field__label" htmlFor="router-model">Requested model</label>
                  <input
                    id="router-model"
                    className="input input--mono"
                    list="router-model-options"
                    placeholder="Leave blank to auto route"
                    value={model}
                    onChange={(event) => setModel(event.target.value)}
                  />
                  <datalist id="router-model-options">
                    {models.map((value) => <option key={value} value={value} />)}
                  </datalist>
                </div>

                <div className="field">
                  <label className="field__label" htmlFor="router-session">Sticky session id</label>
                  <input
                    id="router-session"
                    className="input input--mono"
                    placeholder="optional"
                    value={session}
                    onChange={(event) => setSession(event.target.value)}
                  />
                </div>
              </div>
              <p className="tiny dim" style={{ marginTop: "var(--sp-2)" }}>
                Pass a remembered target id to see the sticky phase: in the modes that remember one it is
                tried first (20-minute TTL), and the Fallback Chain then resumes in its saved order, which is
                never reordered by health or latency.
              </p>
            </div>
          </div>

          {preview.error ? (
            <div className="section"><ErrorState error={preview.error} onRetry={preview.reload} compact /></div>
          ) : null}

          {preview.loading && !data ? (
            <div className="panel section"><div className="panel__body"><TableSkeleton rows={8} label="Resolving route" /></div></div>
          ) : data ? (
            <>
              <section className="section">
                <div className="metrics">
                  <MetricCard label="Compatible targets" value={data.counts.compatible} icon="box" hint={`of ${data.counts.totalTargets} total`} />
                  <MetricCard label="Eligible now" value={data.counts.available} tone={data.counts.available > 0 ? "ok" : "danger"} icon="check" hint="not in cooldown" />
                  <MetricCard label="In cooldown" value={data.counts.unavailable} tone={data.counts.unavailable > 0 ? "warn" : null} icon="clock" />
                  <MetricCard label="Excluded" value={data.counts.excluded} icon="filter" hint="wrong protocol" />
                </div>
              </section>

              <div className="split split--sidebar section">
                <div className="panel">
                  <div className="panel__header">
                    <span className="panel__title">Routing pipeline</span>
                    {data.selected ? (
                      <div className="panel__actions">
                        <StatusBadge tone="ok">primary: {data.selected.model}</StatusBadge>
                      </div>
                    ) : (
                      <div className="panel__actions">
                        <StatusBadge tone="danger">no target available</StatusBadge>
                      </div>
                    )}
                  </div>
                  <div className="panel__body">
                    <RoutingGraph stages={data.stages} targetIdentity={data.targetIdentity} />
                  </div>
                </div>

                <div className="stack">
                  <div className="panel">
                    <div className="panel__header">
                      <span className="panel__title">Selected target</span>
                    </div>
                    <div className="panel__body">
                      {data.selected ? (
                        <dl className="dl dl--tight">
                          <dt className="dl__term">Pool</dt>
                          <dd className="dl__desc">
                            <PoolBadge pool={data.pool ?? pool} />
                          </dd>
                          <dt className="dl__term">Provider</dt>
                          <dd className="dl__desc">{providerLabel(data.selected.provider)}</dd>
                          <dt className="dl__term">Model</dt>
                          <dd className="dl__desc mono">{data.selected.model}</dd>
                          <dt className="dl__term">Key index</dt>
                          <dd className="dl__desc mono">{data.selected.keyIndex}</dd>
                          <dt className="dl__term">Health</dt>
                          <dd className="dl__desc"><HealthBadge status={data.selected.status} /></dd>
                          <dt className="dl__term">Score</dt>
                          <dd className="dl__desc mono">{Number.isFinite(data.selected.score) ? Math.round(data.selected.score) : EMPTY}</dd>
                          <dt className="dl__term">Latency</dt>
                          <dd className="dl__desc"><LatencyBadge ms={data.selected.latencyMs} /></dd>
                        </dl>
                      ) : (
                        <EmptyState title="No eligible target" icon="alert">
                          Every compatible target is inside its cooldown window. Routing will fail
                          with <code>503</code> until one recovers.
                        </EmptyState>
                      )}
                    </div>
                  </div>

                  <div className="panel">
                    <div className="panel__header">
                      <span className="panel__title">Retryable statuses</span>
                    </div>
                    <div className="panel__body">
                      <div className="row row--wrap" style={{ gap: "var(--sp-1)" }}>
                        {(data.retryableStatus ?? []).map((status) => (
                          <StatusBadge key={status} tone="neutral" dot={false}>{status}</StatusBadge>
                        ))}
                      </div>
                      <p className="tiny dim" style={{ marginTop: "var(--sp-2)" }}>
                        A failure with one of these codes puts that exact target into cooldown and
                        moves routing to the next candidate.
                      </p>
                    </div>
                  </div>
                </div>
              </div>

              <div className="panel section">
                <div className="panel__header">
                  <span className="panel__title">Candidate targets</span>
                  <div className="panel__actions">
                    <span className="tiny dim">ranked in the order the router will try them</span>
                  </div>
                </div>
                <DataTable
                  columns={candidateColumns}
                  rows={data.candidates}
                  rowKey={(row) => row.id}
                  compact
                  caption="Candidate targets in routing order"
                  emptyState={<EmptyState title="No compatible targets" icon="route">No configured target supports this protocol.</EmptyState>}
                />
              </div>

              <div className="panel section">
                <div className="panel__header">
                  <span className="panel__title">Fallback order</span>
                </div>
                <div className="panel__body">
                  {data.fallbackOrder.length === 0 ? (
                    <span className="dim small">No fallback targets are available.</span>
                  ) : (
                    <ol className="stack stack--tight" style={{ margin: 0, paddingLeft: 18 }}>
                      {data.fallbackOrder.map((target, index) => (
                        <li key={target.id}>
                          <span className="mono tiny dim">{index + 1}.</span>{" "}
                          <span className="small">
                            {providerLabel(target.provider)} / <span className="mono">{target.model}</span>
                            {" · "}key {target.keyIndex}
                            {Number.isFinite(target.latencyMs) ? ` · ${formatLatency(target.latencyMs)}` : ""}
                          </span>
                          {index === 0 ? <span className="tiny dim"> — primary</span> : null}
                        </li>
                      ))}
                    </ol>
                  )}
                </div>
              </div>

              {data.excluded.length > 0 ? (
                <div className="panel section">
                  <div className="panel__header">
                    <span className="panel__title">Excluded by protocol</span>
                  </div>
                  <div className="panel__body">
                    <div className="row row--wrap" style={{ gap: "var(--sp-2)" }}>
                      {data.excluded.map((target) => (
                        <span key={target.id} className="badge badge--neutral" title={target.reason}>
                          {providerLabel(target.provider)} / {target.model}
                        </span>
                      ))}
                    </div>
                    <p className="tiny dim" style={{ marginTop: "var(--sp-2)" }}>
                      These targets are configured but do not declare support for{" "}
                      <code>{data.protocol}</code>, so the router never offers them the request.
                    </p>
                  </div>
                </div>
              ) : null}
            </>
          ) : null}
        </>
      )}
    </div>
  );
}
