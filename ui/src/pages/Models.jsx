import { useMemo, useState } from "react";
import { PageHeader } from "../components/layout/PageHeader.jsx";
import { DataTable } from "../components/ui/DataTable.jsx";
import { FilterBar, FilterSelect } from "../components/ui/FilterBar.jsx";
import { SearchInput } from "../components/ui/SearchInput.jsx";
import { HealthBadge } from "../components/ui/HealthBadge.jsx";
import { LatencyBadge } from "../components/ui/LatencyBadge.jsx";
import { StatusBadge } from "../components/ui/StatusBadge.jsx";
import { MetricCard } from "../components/ui/MetricCard.jsx";
import { Drawer } from "../components/ui/Overlays.jsx";
import { EmptyState } from "../components/ui/EmptyState.jsx";
import { ErrorState } from "../components/ui/ErrorState.jsx";
import { MetricSkeleton, TableSkeleton } from "../components/ui/LoadingSkeleton.jsx";
import { useApi } from "../hooks/useApi.js";
import { useDebouncedValue } from "../hooks/useDebounce.js";
import { getModels } from "../api/models.js";
import { filterChoices, filterTargets, findTarget, isRoutable, normalizeModelPayload } from "../lib/targets.js";
import { sortRows } from "../lib/table.js";
import {
  formatDateTime, formatNumber, formatPercent,
  protocolLabel, providerLabel, EMPTY
} from "../lib/format.js";

/**
 * Model catalogue.
 *
 * Every row is one routing *target* — provider + model + key index — because
 * that is the unit the gateway tracks, cools down and ranks. Collapsing keys
 * into a single model row would hide exactly the failure mode this page exists
 * to reveal: one key exhausted while its siblings are fine.
 *
 * All data comes from `GET /api/models`. The raw `/v1/models` discovery
 * endpoint is a client-facing contract and is deliberately not consumed here.
 */
export default function Models() {
  const models = useApi(getModels, { intervalMs: 15_000 });

  const [search, setSearch] = useState("");
  const [provider, setProvider] = useState(null);
  const [protocol, setProtocol] = useState(null);
  const [status, setStatus] = useState(null);
  const [sort, setSort] = useState({ key: "provider", direction: "asc" });
  const [selectedId, setSelectedId] = useState(null);

  const debouncedSearch = useDebouncedValue(search, 220);

  // Narrowed once, so a partial or malformed response cannot reach the table.
  const view = useMemo(() => normalizeModelPayload(models.data), [models.data]);
  const { rows, summary } = view;

  // The endpoint advertises its own filter vocabulary; the fallback recount
  // lives in the view model so both pages share one implementation.
  const choices = useMemo(() => filterChoices(view), [view]);

  const filtered = useMemo(
    () => sortRows(
      filterTargets(rows, { provider, protocol, status, search: debouncedSearch }),
      COLUMN_ACCESSORS,
      sort
    ),
    [rows, provider, protocol, status, debouncedSearch, sort]
  );

  const selected = useMemo(() => findTarget(rows, selectedId), [rows, selectedId]);

  const activeFilterCount = [provider, protocol, status, debouncedSearch].filter(Boolean).length;

  if (models.loading && !models.data) {
    return (
      <div className="page">
        <PageHeader title="Models" description="Model catalogue with health, protocol and usage" />
        <MetricSkeleton count={5} />
        <div className="panel"><div className="panel__body"><TableSkeleton rows={10} label="Loading models" /></div></div>
      </div>
    );
  }

  return (
    <div className="page">
      <PageHeader
        title="Models"
        description="Model catalogue with health, protocol and usage"
        lastUpdatedAt={models.lastUpdatedAt}
        refreshing={models.refreshing}
        paused={models.paused}
        actions={
          <button type="button" className="btn" onClick={models.reload} disabled={models.refreshing}>
            Refresh
          </button>
        }
      />

      {models.error ? <ErrorState error={models.error} onRetry={models.reload} compact /> : null}

      <section className="section">
        <div className="metrics">
          <MetricCard
            label="Total models"
            value={formatNumber(summary.total)}
            icon="box"
            hint="provider + model + key targets"
          />
          <MetricCard
            label="Healthy"
            value={formatNumber(summary.healthy)}
            tone={summary.healthy > 0 ? "ok" : null}
            icon="check"
          />
          <MetricCard
            label="Failed"
            value={formatNumber(summary.failed)}
            tone={summary.failed > 0 ? "danger" : null}
            icon="alert"
          />
          <MetricCard
            label="Providers"
            value={formatNumber(summary.providers)}
            icon="server"
            hint="serving at least one model"
          />
          <MetricCard
            label="Available targets"
            value={formatNumber(summary.available)}
            tone={summary.total > 0 && summary.available === 0 ? "danger" : null}
            icon="route"
            hint="not cooling down"
            title="Targets the router can currently route to"
          />
        </div>
      </section>

      <div className="panel section">
        <FilterBar
          actions={
            <span className="tiny dim nowrap">
              {filtered.length} of {rows.length} targets
              {activeFilterCount > 0 ? ` · ${activeFilterCount} filter${activeFilterCount === 1 ? "" : "s"}` : ""}
            </span>
          }
        >
          <div className="field filter-bar__search">
            <label className="field__label" htmlFor="model-search">Search</label>
            <SearchInput
              id="model-search"
              value={search}
              onChange={setSearch}
              label="Search models"
              placeholder="Model, provider or reason…"
            />
          </div>

          <FilterSelect label="Provider" value={provider} onChange={setProvider} options={choices.providers} />
          <FilterSelect
            label="Protocol"
            value={protocol}
            onChange={setProtocol}
            options={choices.protocols.map((value) => ({ value, label: protocolLabel(value) }))}
          />
          <FilterSelect label="Health" value={status} onChange={setStatus} options={choices.statuses} />
        </FilterBar>

        <DataTable
          columns={COLUMNS}
          rows={filtered}
          sort={sort}
          onSortChange={(next) => setSort(next)}
          rowKey={(row) => row.id}
          onRowClick={(row) => setSelectedId(row.id)}
          caption="Model targets with health and usage"
          emptyState={
            rows.length === 0 ? (
              <EmptyState title="No models configured" icon="box">
                Configure <code>PROVIDER_MODELS</code> for at least one provider to populate the catalogue.
              </EmptyState>
            ) : (
              <EmptyState title="No models match these filters" icon="filter">
                <button
                  type="button"
                  className="btn btn--sm"
                  onClick={() => { setSearch(""); setProvider(null); setProtocol(null); setStatus(null); }}
                >
                  Clear filters
                </button>
              </EmptyState>
            )
          }
        />
      </div>

      <ModelDrawer model={selected} onClose={() => setSelectedId(null)} />
    </div>
  );
}

const COLUMN_ACCESSORS = {
  provider: (row) => row.provider,
  model: (row) => row.model,
  protocol: (row) => row.protocols[0] ?? "",
  status: (row) => row.status,
  latency: (row) => row.latencyMs,
  success: (row) => row.successRate,
  failures: (row) => row.failures,
  updated: (row) => row.updatedAt
};

const COLUMNS = [
  {
    key: "provider",
    header: "Provider",
    sortable: true,
    get: (row) => row.provider,
    render: (row) => <span className="nowrap">{providerLabel(row.provider)}</span>
  },
  {
    key: "model",
    header: "Model",
    sortable: true,
    get: (row) => row.model,
    render: (row) => (
      <span className="mono truncate table__truncate" title={row.model}>{row.model}</span>
    )
  },
  {
    key: "protocol",
    header: "Protocol",
    sortable: true,
    get: (row) => row.protocols[0] ?? "",
    render: (row) => (
      <span className="tiny dim nowrap">
        {row.protocols.map(protocolLabel).join(", ") || EMPTY}
      </span>
    )
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
    sortable: true,
    get: (row) => row.status,
    render: (row) => <HealthBadge status={row.status} title={row.lastReason ?? undefined} />
  },
  {
    key: "latency",
    header: "Latency",
    align: "right",
    sortable: true,
    get: (row) => row.latencyMs,
    render: (row) => <LatencyBadge ms={row.latencyMs} />
  },
  {
    key: "success",
    header: "Success rate",
    align: "right",
    sortable: true,
    get: (row) => row.successRate,
    render: (row) => row.successRate === null
      ? <span className="dim">—</span>
      : <span className="mono tabular">{formatPercent(row.successRate)}</span>
  },
  {
    key: "failures",
    header: "Failures",
    align: "right",
    sortable: true,
    get: (row) => row.failures,
    render: (row) => (
      <span className="mono" style={{ color: row.failures > 0 ? "var(--danger)" : undefined }}>
        {row.failures}
      </span>
    )
  },
  {
    key: "updated",
    header: "Last check",
    align: "right",
    sortable: true,
    get: (row) => row.updatedAt,
    render: (row) => <span className="dim tiny nowrap">{shortTime(row.updatedAt)}</span>
  }
];

function shortTime(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? EMPTY : date.toLocaleTimeString();
}

function ModelDrawer({ model, onClose }) {
  const routable = model ? isRoutable(model) : false;

  return (
    <Drawer
      open={Boolean(model)}
      onClose={onClose}
      title={model?.model ?? ""}
      subtitle={model ? `${providerLabel(model.provider)} · key ${model.keyIndex}` : null}
    >
      {model ? (
        <div className="stack" style={{ gap: "var(--sp-4)" }}>
          <div className="row row--wrap">
            <HealthBadge status={model.status} />
            <StatusBadge tone="neutral" dot={false}>
              {model.protocols.map(protocolLabel).join(", ") || "no protocol"}
            </StatusBadge>
          </div>

          <dl className="dl">
            <dt className="dl__term">Provider</dt>
            <dd className="dl__desc">{providerLabel(model.provider)}</dd>

            <dt className="dl__term">Model ID</dt>
            <dd className="dl__desc mono">{model.model}</dd>

            <dt className="dl__term">Target ID</dt>
            <dd className="dl__desc mono tiny">{model.id}</dd>

            <dt className="dl__term">Key index</dt>
            <dd className="dl__desc mono">{model.keyIndex}</dd>

            <dt className="dl__term">Protocols</dt>
            <dd className="dl__desc">{model.protocols.map(protocolLabel).join(", ") || EMPTY}</dd>

            <dt className="dl__term">Health</dt>
            <dd className="dl__desc"><HealthBadge status={model.status} /></dd>

            <dt className="dl__term">Score</dt>
            <dd className="dl__desc mono">
              {Number.isFinite(model.score) ? `${Math.round(model.score)} / 100` : EMPTY}
            </dd>

            <dt className="dl__term">Latency</dt>
            <dd className="dl__desc"><LatencyBadge ms={model.latencyMs} /></dd>

            <dt className="dl__term">Successes</dt>
            <dd className="dl__desc mono">{formatNumber(model.successes)}</dd>

            <dt className="dl__term">Failures</dt>
            <dd className="dl__desc mono">{formatNumber(model.failures)}</dd>

            <dt className="dl__term">Consecutive failures</dt>
            <dd className="dl__desc mono">{model.consecutiveFailures}</dd>

            <dt className="dl__term">Last HTTP status</dt>
            <dd className="dl__desc mono">{model.lastStatus ?? EMPTY}</dd>

            <dt className="dl__term">Last reason</dt>
            <dd className="dl__desc">{model.lastReason || <span className="dim">none recorded</span>}</dd>

            <dt className="dl__term">Routing availability</dt>
            <dd className="dl__desc">
              {routable ? (
                <span className="row" style={{ gap: 6 }}>
                  <StatusBadge tone="ok">routable</StatusBadge>
                  <span className="tiny dim">the router may select this target</span>
                </span>
              ) : (
                <span className="row" style={{ gap: 6 }}>
                  <StatusBadge tone="warn">cooling down</StatusBadge>
                  <span className="tiny dim">
                    excluded from routing until {formatDateTime(model.cooldownUntil)}
                  </span>
                </span>
              )}
            </dd>

            <dt className="dl__term">Updated</dt>
            <dd className="dl__desc">{formatDateTime(model.updatedAt)}</dd>

            <dt className="dl__term">Requests seen</dt>
            <dd className="dl__desc mono">
              {formatNumber(model.requests)} ({formatNumber(model.requestFailures)} failed)
              <div className="tiny dim">Since this process started; the log is in-memory.</div>
            </dd>
          </dl>
        </div>
      ) : null}
    </Drawer>
  );
}
