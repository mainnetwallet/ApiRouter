import { useMemo, useState } from "react";
import { PageHeader } from "../components/layout/PageHeader.jsx";
import { FallbackChain, FallbackTraceAnimation } from "../components/domain/FallbackChain.jsx";
import { DataTable } from "../components/ui/DataTable.jsx";
import { EmptyState } from "../components/ui/EmptyState.jsx";
import { ErrorState } from "../components/ui/ErrorState.jsx";
import { StatusBadge } from "../components/ui/StatusBadge.jsx";
import { PoolBadge } from "../components/ui/PoolBadge.jsx";
import { MetricCard } from "../components/ui/MetricCard.jsx";
import { TableSkeleton } from "../components/ui/LoadingSkeleton.jsx";
import { useApi } from "../hooks/useApi.js";
import { useHealth } from "../context/HealthContext.jsx";
import { getRoutingPreview } from "../api/router.js";
import { getRequests } from "../api/requests.js";
import { CROSS_POOL_FALLBACK, poolLabel } from "../lib/pools.js";
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
 *
 * The text and vision pools each have their own targets, health and fallback
 * chain, and a failed request never crosses from one to the other. So every
 * panel below is built per pool: its own protocol list, its own preview call
 * (`pool` is sent explicitly) and its own recorded requests. Nothing is a
 * combined chain.
 */
const POOL_ORDER = ["text", "vision"];

export default function Fallback() {
  const { targets } = useHealth();
  const [tab, setTab] = useState("planned");
  const [tick, setTick] = useState(0);

  const poolTargets = useMemo(() => ({
    text: targets.filter((target) => (target.pool ?? "text") === "text"),
    vision: targets.filter((target) => target.pool === "vision")
  }), [targets]);

  // One request log fetch per pool, so a busy text pool cannot push every
  // vision request out of a shared "last 40".
  const recentText = useApi(
    ({ signal }) => getRequests({ limit: 40, pool: "text" }, { signal }),
    { intervalMs: 10_000, deps: [tick] }
  );
  const recentVision = useApi(
    ({ signal }) => getRequests({ limit: 40, pool: "vision" }, { signal }),
    { intervalMs: 10_000, deps: [tick] }
  );
  const recent = { text: recentText, vision: recentVision };

  const fallbackRequests = useMemo(() => {
    const pick = (api) => (api.data?.entries ?? []).filter((entry) => (entry.fallbackCount ?? 0) > 0);
    return { text: pick(recentText), vision: pick(recentVision) };
  }, [recentText.data, recentVision.data]);

  const totalFallbacks = fallbackRequests.text.length + fallbackRequests.vision.length;

  if (targets.length === 0) {
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
        actions={
          <button type="button" className="btn" onClick={() => setTick((n) => n + 1)}>
            Refresh
          </button>
        }
      />

      <p className="tiny dim" style={{ marginBottom: "var(--sp-3)" }}>
        <strong>{CROSS_POOL_FALLBACK.label}.</strong> {CROSS_POOL_FALLBACK.detail}
      </p>

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
          Observed activity {totalFallbacks > 0 ? `(${totalFallbacks})` : ""}
        </button>
      </div>

      {/* Text on the left, Vision on the right; stacks on narrow screens. */}
      <div className="split split--2 fallback-pools">
        {POOL_ORDER.map((pool) => (
          <PoolFallbackSection
            key={pool}
            pool={pool}
            tab={tab}
            tick={tick}
            targets={poolTargets[pool]}
            recent={recent[pool]}
            fallbackRequests={fallbackRequests[pool]}
          />
        ))}
      </div>

      {tab === "planned" ? <HowFallbackWorks /> : null}
    </div>
  );
}

/** Everything for ONE pool: its protocol, planned chain, skipped targets and observed fallbacks. */
function PoolFallbackSection({ pool, tab, tick, targets, recent, fallbackRequests }) {
  const [protocol, setProtocol] = useState("");
  const [selectedId, setSelectedId] = useState(null);

  // Only the protocols this pool serves: a protocol that only the other pool
  // speaks would make the preview fail rather than show a chain.
  const protocols = useMemo(() => {
    const set = new Set();
    for (const target of targets) for (const value of target.protocols ?? []) set.add(value);
    return [...set].sort();
  }, [targets]);

  const activeProtocol = protocols.includes(protocol) ? protocol : (protocols[0] ?? "");

  const preview = useApi(
    ({ signal }) => getRoutingPreview({ protocol: activeProtocol, pool }, { signal }),
    { deps: [activeProtocol, pool, tick], enabled: Boolean(activeProtocol) }
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

  const heading = (
    <div className="section__header">
      <h2 className="section__title row" style={{ gap: 8 }}>
        <PoolBadge pool={pool} />
        {poolLabel(pool)} pool
      </h2>
      {tab === "planned" && protocols.length > 0 ? (
        <div className="section__actions">
          <label className="sr-only" htmlFor={`fallback-protocol-${pool}`}>{poolLabel(pool)} client protocol</label>
          <select
            id={`fallback-protocol-${pool}`}
            className="select"
            value={activeProtocol}
            onChange={(event) => setProtocol(event.target.value)}
          >
            {protocols.map((value) => (
              <option key={value} value={value}>{protocolLabel(value)}</option>
            ))}
          </select>
        </div>
      ) : null}
    </div>
  );

  if (targets.length === 0 || protocols.length === 0) {
    return (
      <section className="section">
        {heading}
        <div className="panel">
          <EmptyState title={`No ${pool} targets`} icon="layers">
            {pool === "vision"
              ? "No vision provider is configured, so there is no vision fallback chain. Image requests will fail until one is set up."
              : "A fallback chain exists only once at least one provider is fully configured."}
          </EmptyState>
        </div>
      </section>
    );
  }

  return (
    <section className="section">
      {heading}

      <div className="metrics section">
        <MetricCard label="In chain" value={chain.length} icon="layers" hint="eligible, in route order" />
        <MetricCard label="Skipped" value={unavailable.length} tone={unavailable.length > 0 ? "warn" : null} icon="clock" hint="in cooldown" />
        <MetricCard
          label="Recent fallbacks"
          value={recent.data ? fallbackRequests.length : null}
          icon="undo"
          hint={`last 40 ${pool} requests`}
        />
      </div>

      {tab === "planned" ? (
        <div className="split split--sidebar">
          <div className="panel">
            <div className="panel__header">
              <span className="panel__title">
                {poolLabel(pool)} chain for {protocolLabel(activeProtocol)}
              </span>
              <div className="panel__actions">
                <span className="tiny dim">fixed route order</span>
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
                  emptyMessage={`No eligible ${pool} target can serve ${protocolLabel(activeProtocol)} right now.`}
                />
              )}
            </div>
          </div>

          <div className="panel">
            <div className="panel__header">
              <span className="panel__title">Skipped {pool} targets</span>
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
        </div>
      ) : (
        <div className="split split--sidebar">
          <div className="panel">
            <div className="panel__header">
              <span className="panel__title">{poolLabel(pool)} requests that fell back</span>
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
                caption={`Recent ${pool} requests that used a fallback target`}
                emptyState={
                  <EmptyState title="No fallback activity" icon="check">
                    No {pool} request in the last 40 needed a fallback — every one was served by its
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
    </section>
  );
}

function HowFallbackWorks() {
  return (
    <div className="panel section">
      <div className="panel__header">
        <span className="panel__title">How fallback works</span>
      </div>
      <div className="panel__body">
        <ol className="small muted" style={{ margin: 0, paddingLeft: 18, lineHeight: 1.9 }}>
          <li>The request enters exactly one pool: text, or vision for image requests.</li>
          <li>Targets that cannot speak the client's protocol are removed.</li>
          <li>Targets inside a cooldown window are removed.</li>
          <li>The session's sticky target (last success, valid for 20 minutes) is tried first, if it is eligible.</li>
          <li>Then priority targets (TEXT_PRIORITY_MODELS / VISION_PRIORITY_MODELS), in their configured order; every eligible key of an entry is tried before the next entry.</li>
          <li>The rest follow Provider → Key → Models: every model of a key runs in order before the next key, and each key restarts at its first model.</li>
          <li>Sticky is a separate first step and never reorders the chain; health only skips cooling targets.</li>
          <li>Each target is tried at most once per request, in order, until one succeeds.</li>
          <li>A retryable failure cools that exact target down and moves on — only within the same pool.</li>
        </ol>
      </div>
    </div>
  );
}
