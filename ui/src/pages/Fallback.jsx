import { useMemo, useState } from "react";
import { PageHeader } from "../components/layout/PageHeader.jsx";
import { FallbackChain, FallbackTraceAnimation } from "../components/domain/FallbackChain.jsx";
import { DataTable } from "../components/ui/DataTable.jsx";
import { EmptyState } from "../components/ui/EmptyState.jsx";
import { ErrorState } from "../components/ui/ErrorState.jsx";
import { StatusBadge } from "../components/ui/StatusBadge.jsx";
import { MetricCard } from "../components/ui/MetricCard.jsx";
import { TableSkeleton } from "../components/ui/LoadingSkeleton.jsx";
import { useApi } from "../hooks/useApi.js";
import { useHealth } from "../context/HealthContext.jsx";
import { getRoutingPreview } from "../api/router.js";
import { getRequests } from "../api/requests.js";
import { formatRelativeTime, protocolLabel, providerLabel, EMPTY } from "../lib/format.js";

/**
 * Fallback visualiser.
 *
 * Two views of the same rule:
 *
 *   Planned  the order the router *would* walk right now, derived from the
 *            backend's own preview endpoint
 *   Traced   the order a real request *did* walk, from the recorded attempts
 *
 * The traced view exists because the brief asks for real request events when
 * available — and here they are, so no animation is simulated. A request that
 * hopped twice shows two failures and a success, in the order they occurred.
 */
export default function Fallback() {
  const { targets } = useHealth();
  const [tab, setTab] = useState("planned");
  const [selectedId, setSelectedId] = useState(null);

  const protocols = useMemo(() => {
    const set = new Set();
    for (const target of targets) for (const protocol of target.protocols ?? []) set.add(protocol);
    return [...set].sort();
  }, [targets]);

  const [protocol, setProtocol] = useState("");
  const activeProtocol = protocol || protocols[0] || "";

  const preview = useApi(
    ({ signal }) => getRoutingPreview({ protocol: activeProtocol }, { signal }),
    { deps: [activeProtocol], enabled: Boolean(activeProtocol) }
  );

  const recent = useApi(
    ({ signal }) => getRequests({ limit: 40 }, { signal }),
    { intervalMs: 10_000 }
  );

  const fallbackRequests = useMemo(
    () => (recent.data?.entries ?? []).filter((entry) => (entry.fallbackCount ?? 0) > 0),
    [recent.data]
  );

  const selected = useMemo(
    () => fallbackRequests.find((entry) => entry.seq === selectedId) ?? fallbackRequests[0] ?? null,
    [fallbackRequests, selectedId]
  );

  const chain = preview.data?.fallbackOrder ?? [];
  const unavailable = preview.data?.unavailable ?? [];

  const columns = useMemo(() => [
    {
      key: "time",
      header: "Time",
      get: (row) => row.receivedAt,
      render: (row) => <span className="dim tiny nowrap">{formatRelativeTime(row.receivedAt)}</span>
    },
    {
      key: "target",
      header: "Final target",
      get: (row) => `${row.finalProvider ?? ""}${row.finalModel ?? ""}`,
      render: (row) => (
        <span className="truncate">
          <span className="muted">{providerLabel(row.finalProvider)}</span> / {row.finalModel ?? EMPTY}
        </span>
      )
    },
    {
      key: "chain",
      header: "Sequence",
      get: (row) => row.fallbackCount,
      render: (row) => (
        <span className="mono tiny">
          {row.attempts.map((attempt) => (attempt.ok ? "ok" : `×${attempt.status ?? "err"}`)).join(" → ")}
        </span>
      )
    },
    {
      key: "hops",
      header: "Hops",
      align: "right",
      get: (row) => row.fallbackCount,
      render: (row) => <span className="mono">{row.fallbackCount}</span>
    },
    {
      key: "outcome",
      header: "Outcome",
      align: "right",
      get: (row) => row.outcome,
      render: (row) => (
        <StatusBadge tone={row.outcome === "success" ? "ok" : "danger"} dot={false}>{row.outcome}</StatusBadge>
      )
    }
  ], []);

  if (protocols.length === 0) {
    return (
      <div className="page">
        <PageHeader title="Fallback" description="The ordered chain the router walks when a target fails" />
        <div className="panel">
          <EmptyState title="No configured targets" icon="layers">
            A fallback chain exists only once at least one provider is fully configured.
          </EmptyState>
        </div>
      </div>
    );
  }

  return (
    <div className="page">
      <PageHeader
        title="Fallback"
        description="The ordered chain the router walks when a target fails"
        lastUpdatedAt={preview.lastUpdatedAt}
        refreshing={preview.refreshing}
        actions={
          <>
            <div className="field">
              <label className="sr-only" htmlFor="fallback-protocol">Client protocol</label>
              <select
                id="fallback-protocol"
                className="select"
                value={activeProtocol}
                onChange={(event) => setProtocol(event.target.value)}
              >
                {protocols.map((value) => (
                  <option key={value} value={value}>{protocolLabel(value)}</option>
                ))}
              </select>
            </div>
            <button type="button" className="btn" onClick={() => { preview.reload(); recent.reload(); }}>
              Refresh
            </button>
          </>
        }
      />

      <section className="section">
        <div className="metrics">
          <MetricCard label="In chain" value={chain.length} icon="layers" hint="eligible, ranked" />
          <MetricCard label="Skipped" value={unavailable.length} tone={unavailable.length > 0 ? "warn" : null} icon="clock" hint="in cooldown" />
          <MetricCard
            label="Recent fallbacks"
            value={recent.data ? fallbackRequests.length : null}
            icon="undo"
            hint="last 40 requests"
          />
        </div>
      </section>

      <div className="tabs" role="tablist" aria-label="Fallback view">
        <button
          type="button"
          role="tab"
          className="tab"
          aria-selected={tab === "planned"}
          onClick={() => setTab("planned")}
        >
          Planned order
        </button>
        <button
          type="button"
          role="tab"
          className="tab"
          aria-selected={tab === "traced"}
          onClick={() => setTab("traced")}
        >
          Observed activity {fallbackRequests.length > 0 ? `(${fallbackRequests.length})` : ""}
        </button>
      </div>

      {tab === "planned" ? (
        <div className="split split--sidebar">
          <div className="panel">
            <div className="panel__header">
              <span className="panel__title">
                Chain for {protocolLabel(activeProtocol)}
              </span>
              <div className="panel__actions">
                <span className="tiny dim">highest health score first</span>
              </div>
            </div>
            <div className="panel__body">
              {preview.error ? (
                <ErrorState error={preview.error} onRetry={preview.reload} compact />
              ) : preview.loading && !preview.data ? (
                <TableSkeleton rows={5} label="Resolving fallback chain" />
              ) : (
                <FallbackChain
                  targets={chain}
                  mode="planned"
                  emptyMessage={`No eligible target can serve ${protocolLabel(activeProtocol)} right now.`}
                />
              )}
            </div>
          </div>

          <div className="stack">
            <div className="panel">
              <div className="panel__header">
                <span className="panel__title">Skipped targets</span>
              </div>
              <div className="panel__body">
                {unavailable.length === 0 ? (
                  <span className="dim small">Every compatible target is eligible.</span>
                ) : (
                  <div className="stack stack--tight">
                    {unavailable.map((target) => (
                      <div key={target.id} className="row row--between">
                        <span className="truncate small">
                          {providerLabel(target.provider)} / <span className="mono">{target.model}</span> / key {target.keyIndex}
                        </span>
                        <StatusBadge tone="warn" dot={false}>cooldown</StatusBadge>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>

            <div className="panel">
              <div className="panel__header">
                <span className="panel__title">How fallback works</span>
              </div>
              <div className="panel__body">
                <ol className="small muted" style={{ margin: 0, paddingLeft: 18, lineHeight: 1.9 }}>
                  <li>Targets that cannot speak the client's protocol are removed.</li>
                  <li>Targets inside a cooldown window are removed.</li>
                  <li>The rest are ranked by health score, then provider, model and key index.</li>
                  <li>The session's sticky target, if still eligible, is tried first.</li>
                  <li>Each target is tried in order until one succeeds.</li>
                  <li>A retryable failure cools that exact target down and moves on.</li>
                </ol>
              </div>
            </div>
          </div>
        </div>
      ) : (
        <div className="split split--sidebar">
          <div className="panel">
            <div className="panel__header">
              <span className="panel__title">Requests that fell back</span>
            </div>
            {recent.error ? (
              <div className="panel__body"><ErrorState error={recent.error} onRetry={recent.reload} compact /></div>
            ) : recent.loading && !recent.data ? (
              <div className="panel__body"><TableSkeleton rows={5} label="Loading fallback activity" /></div>
            ) : (
              <DataTable
                columns={columns}
                rows={fallbackRequests}
                rowKey={(row) => row.seq}
                onRowClick={(row) => setSelectedId(row.seq)}
                isSelected={(row) => selected?.seq === row.seq}
                compact
                caption="Recent requests that used a fallback target"
                emptyState={
                  <EmptyState title="No fallback activity" icon="check">
                    No request in the last 40 needed a fallback — every one was served by its
                    first-choice target.
                  </EmptyState>
                }
              />
            )}
          </div>

          <div className="panel">
            <div className="panel__header">
              <span className="panel__title">Attempt sequence</span>
              {selected ? (
                <div className="panel__actions">
                  <span className="tiny dim mono">{formatRelativeTime(selected.receivedAt)}</span>
                </div>
              ) : null}
            </div>
            <div className="panel__body">
              {selected ? (
                <FallbackTraceAnimation attempts={selected.attempts} outcome={selected.outcome} />
              ) : (
                <span className="dim small">Select a request to see the order targets were tried.</span>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
