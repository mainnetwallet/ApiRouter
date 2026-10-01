import { useMemo, useState } from "react";
import { PageHeader } from "../components/layout/PageHeader.jsx";
import { DataTable } from "../components/ui/DataTable.jsx";
import { FilterBar, FilterSelect } from "../components/ui/FilterBar.jsx";
import { SearchInput } from "../components/ui/SearchInput.jsx";
import { StatusBadge } from "../components/ui/StatusBadge.jsx";
import { EmptyState } from "../components/ui/EmptyState.jsx";
import { ErrorState } from "../components/ui/ErrorState.jsx";
import { TableSkeleton } from "../components/ui/LoadingSkeleton.jsx";
import { RequestDrawer } from "../components/domain/RequestDrawer.jsx";
import { useApi } from "../hooks/useApi.js";
import { useDebouncedValue } from "../hooks/useDebounce.js";
import { getRequest, getRequests } from "../api/requests.js";
import { matchesSearch, nextSort, sortRows } from "../lib/table.js";
import {
  formatDateTime, formatLatency, formatRelativeTime, formatTokens,
  protocolLabel, providerLabel, EMPTY
} from "../lib/format.js";

const PAGE_SIZE = 50;

/**
 * Live request log.
 *
 * Server-side pagination by cursor, so the page never has to load the whole
 * buffer, and a busy gateway cannot make the initial render slow. Filtering by
 * provider/outcome/status is pushed to the backend too; only free-text search
 * runs client-side, because it is the one filter that changes on every
 * keystroke and a round trip per character would be worse than a local scan of
 * the current page.
 */
export default function Requests() {
  const [outcome, setOutcome] = useState(null);
  const [provider, setProvider] = useState(null);
  const [protocol, setProtocol] = useState(null);
  const [status, setStatus] = useState(null);
  const [search, setSearch] = useState("");
  const [cursor, setCursor] = useState(null);
  const [cursors, setCursors] = useState([]);
  const [sort, setSort] = useState({ key: "receivedAt", direction: "desc" });
  const [selectedSeq, setSelectedSeq] = useState(null);

  const debouncedSearch = useDebouncedValue(search, 220);

  const query = useMemo(() => ({
    limit: PAGE_SIZE,
    cursor,
    outcome,
    provider,
    protocol,
    status
  }), [cursor, outcome, provider, protocol, status]);

  const log = useApi(({ signal }) => getRequests(query, { signal }), {
    intervalMs: cursor === null ? 5_000 : null,
    deps: [query]
  });

  const detail = useApi(
    ({ signal }) => getRequest(selectedSeq, { signal }),
    { deps: [selectedSeq], enabled: selectedSeq !== null }
  );

  const entries = log.data?.entries ?? [];

  const rows = useMemo(() => {
    const filtered = entries.filter((entry) => matchesSearch(entry, debouncedSearch, [
      (item) => item.id,
      (item) => item.finalModel ?? "",
      (item) => item.finalProvider ?? "",
      (item) => item.requestedModel ?? ""
    ]));
    return sortRows(filtered, COLUMN_ACCESSORS, sort);
  }, [entries, debouncedSearch, sort]);

  const providers = useMemo(
    () => [...new Set(entries.map((entry) => entry.finalProvider).filter(Boolean))].sort(),
    [entries]
  );

  const goNext = () => {
    if (!log.data?.nextCursor) return;
    setCursors((current) => [...current, cursor]);
    setCursor(log.data.nextCursor);
  };

  const goPrevious = () => {
    setCursors((current) => {
      if (current.length === 0) return current;
      setCursor(current.at(-1) ?? null);
      return current.slice(0, -1);
    });
  };

  /** Any filter change resets pagination — a cursor is only valid for its query. */
  const changeFilter = (setter) => (value) => {
    setter(value);
    setCursor(null);
    setCursors([]);
  };

  return (
    <div className="page">
      <PageHeader
        title="Requests"
        description="Live request log with full routing lifecycle"
        lastUpdatedAt={log.lastUpdatedAt}
        refreshing={log.refreshing}
        paused={log.paused}
        actions={
          <button type="button" className="btn" onClick={log.reload} disabled={log.refreshing}>
            Refresh
          </button>
        }
      />

      {log.error ? <ErrorState error={log.error} onRetry={log.reload} compact /> : null}

      <div className="panel">
        <FilterBar
          actions={
            <span className="tiny dim nowrap">
              {log.data ? `${rows.length} shown · ${log.data.total} in buffer` : ""}
            </span>
          }
        >
          <div className="field filter-bar__search">
            <label className="field__label" htmlFor="req-search">Search</label>
            <SearchInput
              id="req-search"
              value={search}
              onChange={setSearch}
              label="Search requests"
              placeholder="Request id, model or provider…"
            />
          </div>

          <FilterSelect label="Outcome" value={outcome} onChange={changeFilter(setOutcome)} options={["success", "failed"]} />
          <FilterSelect label="Provider" value={provider} onChange={changeFilter(setProvider)} options={providers} />
          <FilterSelect
            label="Protocol"
            value={protocol}
            onChange={changeFilter(setProtocol)}
            options={["anthropic", "openai-chat", "openai-responses", "gemini"].map((value) => ({
              value, label: protocolLabel(value)
            }))}
          />
          <FilterSelect
            label="HTTP status"
            value={status}
            onChange={changeFilter(setStatus)}
            options={["200", "400", "401", "402", "408", "429", "500", "502", "503", "504"]}
          />
        </FilterBar>

        {log.loading && !log.data ? (
          <div className="panel__body"><TableSkeleton rows={12} label="Loading request log" /></div>
        ) : (
          <DataTable
            columns={COLUMNS}
            rows={rows}
            sort={sort}
            onSortChange={(next) => setSort(next)}
            rowKey={(row) => row.seq}
            onRowClick={(row) => setSelectedSeq(row.seq)}
            compact
            caption="Requests recorded by this gateway process"
            emptyState={
              cursor !== null ? (
                <EmptyState title="No more requests" icon="inbox">
                  <button type="button" className="btn btn--sm" onClick={goPrevious}>Back to newest</button>
                </EmptyState>
              ) : (
                <EmptyState title="No requests recorded" icon="list">
                  The log is in-memory and starts empty when the gateway restarts. Send a request
                  from the <strong>Playground</strong> to see it appear here.
                </EmptyState>
              )
            }
            footer={
              <div className="panel__footer">
                <div className="pagination">
                  <button type="button" className="btn btn--sm" onClick={goPrevious} disabled={cursors.length === 0}>
                    Newer
                  </button>
                  <button type="button" className="btn btn--sm" onClick={goNext} disabled={!log.data?.nextCursor}>
                    Older
                  </button>
                  <span className="tiny dim">
                    {cursors.length === 0 ? "newest page" : `page ${cursors.length + 1}`}
                  </span>
                  <span className="pagination__spacer" />
                  <span className="tiny dim">
                    newest first · {log.data?.total ?? 0} requests retained
                  </span>
                </div>
              </div>
            }
          />
        )}
      </div>

      <RequestDrawer
        entry={detail.data?.request ?? entries.find((entry) => entry.seq === selectedSeq) ?? null}
        open={selectedSeq !== null}
        onClose={() => setSelectedSeq(null)}
        loading={detail.loading}
        error={detail.error}
      />
    </div>
  );
}

const COLUMN_ACCESSORS = {
  receivedAt: (row) => row.receivedAt,
  id: (row) => row.id ?? "",
  provider: (row) => row.finalProvider ?? "",
  model: (row) => row.finalModel ?? "",
  protocol: (row) => row.protocol ?? "",
  status: (row) => row.httpStatus,
  latency: (row) => row.latencyMs,
  tokens: (row) => row.tokens,
  fallbacks: (row) => row.fallbackCount
};

const COLUMNS = [
  {
    key: "receivedAt",
    header: "Time",
    sortable: true,
    get: (row) => row.receivedAt,
    render: (row) => (
      <span className="dim tiny nowrap" title={formatDateTime(row.receivedAt)}>
        {formatRelativeTime(row.receivedAt)}
      </span>
    )
  },
  {
    key: "id",
    header: "Request ID",
    sortable: true,
    get: (row) => row.id ?? "",
    render: (row) => <span className="mono tiny">{shortId(row.id)}</span>
  },
  {
    key: "provider",
    header: "Provider",
    sortable: true,
    get: (row) => row.finalProvider ?? "",
    render: (row) => <span className="nowrap">{providerLabel(row.finalProvider)}</span>
  },
  {
    key: "model",
    header: "Model",
    sortable: true,
    get: (row) => row.finalModel ?? "",
    render: (row) => (
      <span className="mono truncate table__truncate" title={row.finalModel ?? undefined}>
        {row.finalModel ?? EMPTY}
      </span>
    )
  },
  {
    key: "protocol",
    header: "Protocol",
    sortable: true,
    get: (row) => row.protocol ?? "",
    render: (row) => <span className="tiny dim nowrap">{protocolLabel(row.protocol)}</span>
  },
  {
    key: "status",
    header: "Status",
    align: "right",
    sortable: true,
    get: (row) => row.httpStatus,
    render: (row) => (
      <StatusBadge tone={row.outcome === "success" ? "ok" : "danger"} dot={false}>
        {row.httpStatus ?? EMPTY}
      </StatusBadge>
    )
  },
  {
    key: "latency",
    header: "Latency",
    align: "right",
    sortable: true,
    get: (row) => row.latencyMs,
    render: (row) => <span className="mono tabular">{formatLatency(row.latencyMs)}</span>
  },
  {
    key: "tokens",
    header: "Tokens",
    align: "right",
    sortable: true,
    get: (row) => row.tokens,
    render: (row) => (
      <span className="mono tabular dim" title={Number.isFinite(row.tokens) ? undefined : "Not reported by the provider"}>
        {Number.isFinite(row.tokens) ? formatTokens(row.tokens) : EMPTY}
      </span>
    )
  },
  {
    key: "fallbacks",
    header: "Fallbacks",
    align: "right",
    sortable: true,
    get: (row) => row.fallbackCount,
    render: (row) => (
      <span className="mono" style={{ color: row.fallbackCount > 0 ? "var(--warn)" : undefined }}>
        {row.fallbackCount}
      </span>
    )
  }
];

function shortId(id) {
  return id ? `${String(id).slice(0, 8)}…` : EMPTY;
}
