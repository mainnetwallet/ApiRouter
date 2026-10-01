import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { PageHeader } from "../components/layout/PageHeader.jsx";
import { FilterBar, FilterSelect } from "../components/ui/FilterBar.jsx";
import { SearchInput } from "../components/ui/SearchInput.jsx";
import { StatusBadge } from "../components/ui/StatusBadge.jsx";
import { EmptyState } from "../components/ui/EmptyState.jsx";
import { ErrorState } from "../components/ui/ErrorState.jsx";
import { TableSkeleton } from "../components/ui/LoadingSkeleton.jsx";
import { Icon } from "../components/ui/Icon.jsx";
import { LiveLogList } from "../components/domain/LiveLogList.jsx";
import { useApi } from "../hooks/useApi.js";
import { useDebouncedValue } from "../hooks/useDebounce.js";
import { getRequests } from "../api/requests.js";
import { filterEvents, ingestEntries, isNearBottom, mergeEvents } from "../lib/liveLogs.js";
import { providerLabel } from "../lib/format.js";

const POLL_MS = 2_000;
const PAGE_LIMIT = 200;

/**
 * Live execution log.
 *
 * Reuses the existing request log (`GET /api/requests`) and the panel's polling
 * hook — the gateway has no push channel, so this polls rather than pretending
 * otherwise. Each completed request is expanded into the real attempts it made
 * (see `lib/liveLogs.js`); nothing is predicted or reconstructed.
 *
 * Pause stops polling and freezes the view; resuming catches up from the last
 * ingested sequence number. Clear empties the view and remembers the high-water
 * mark, so cleared events do not reappear on the next poll.
 */
export default function LiveLogs() {
  const [events, setEvents] = useState([]);
  const [paused, setPaused] = useState(false);
  const [provider, setProvider] = useState(null);
  const [status, setStatus] = useState(null);
  const [search, setSearch] = useState("");
  const [requestId, setRequestId] = useState("");
  const [stuck, setStuck] = useState(true);

  const debouncedSearch = useDebouncedValue(search, 150);
  const debouncedRequestId = useDebouncedValue(requestId, 150);

  const maxSeq = useRef(0);
  const scroller = useRef(null);

  const log = useApi(({ signal }) => getRequests({ limit: PAGE_LIMIT }, { signal }), {
    intervalMs: POLL_MS,
    enabled: !paused
  });

  // Ingest each new page exactly once; the sequence high-water mark makes a
  // repeated poll of the same entries a no-op.
  useEffect(() => {
    if (!log.data) return;
    const { events: fresh, maxSeq: next, restarted } = ingestEntries(log.data.entries, maxSeq.current);
    maxSeq.current = next;
    if (restarted) setEvents(fresh);
    else if (fresh.length > 0) setEvents((current) => mergeEvents(current, fresh));
  }, [log.data]);

  const filters = useMemo(() => ({
    provider, status, search: debouncedSearch, requestId: debouncedRequestId
  }), [provider, status, debouncedSearch, debouncedRequestId]);

  const visible = useMemo(() => filterEvents(events, filters), [events, filters]);

  const providers = useMemo(
    () => [...new Set(events.map((event) => event.provider).filter(Boolean))].sort()
      .map((value) => ({ value, label: providerLabel(value) })),
    [events]
  );

  // Follow the newest event, but only while the operator is at the bottom.
  useLayoutEffect(() => {
    const node = scroller.current;
    if (node && stuck) node.scrollTop = node.scrollHeight;
  }, [visible, stuck]);

  const onScroll = useCallback((event) => {
    setStuck(isNearBottom(event.currentTarget));
  }, []);

  const jumpToLatest = () => {
    const node = scroller.current;
    if (node) node.scrollTop = node.scrollHeight;
    setStuck(true);
  };

  const clear = () => setEvents([]);

  const filtering = Boolean(provider || status || debouncedSearch.trim() || debouncedRequestId.trim());
  const initialLoading = log.loading && !log.data && events.length === 0;
  const disconnected = Boolean(log.error) && !paused;

  const state = paused
    ? { tone: "warn", label: "Paused" }
    : disconnected
      ? { tone: "danger", label: "Disconnected" }
      : log.data
        ? { tone: "ok", label: "Live" }
        : { tone: "neutral", label: "Connecting" };

  return (
    <div className="page page--livelog">
      <PageHeader
        title="Live Logs"
        description="Every upstream attempt, in the order the router made it"
        lastUpdatedAt={log.lastUpdatedAt}
        refreshing={log.refreshing}
        paused={log.paused}
        actions={
          <>
            <StatusBadge tone={state.tone} pulse={state.label === "Live"} title="Connection state">
              {state.label}
            </StatusBadge>
            <button
              type="button"
              className="btn"
              onClick={() => setPaused((current) => !current)}
              aria-pressed={paused}
            >
              <Icon name={paused ? "play" : "stop"} className="btn__icon" size={12} />
              {paused ? "Resume" : "Pause"}
            </button>
            <button type="button" className="btn" onClick={clear} disabled={events.length === 0}>
              <Icon name="trash" className="btn__icon" size={12} />
              Clear
            </button>
          </>
        }
      />

      {disconnected ? <ErrorState error={log.error} onRetry={log.reload} compact /> : null}

      <div className="panel livelog">
        <FilterBar
          actions={
            <span className="tiny dim nowrap">
              {filtering ? `${visible.length} of ${events.length} events` : `${events.length} events`}
            </span>
          }
        >
          <div className="field filter-bar__search">
            <label className="field__label" htmlFor="livelog-search">Search</label>
            <SearchInput
              id="livelog-search"
              value={search}
              onChange={setSearch}
              label="Search events"
              placeholder="Provider, model, status, reason…"
            />
          </div>
          <FilterSelect label="Provider" value={provider} onChange={setProvider} options={providers} />
          <FilterSelect
            label="Status"
            value={status}
            onChange={setStatus}
            options={[{ value: "success", label: "Success" }, { value: "failed", label: "Failed" }]}
          />
          <div className="field">
            <label className="field__label" htmlFor="livelog-request">Request ID</label>
            <SearchInput
              id="livelog-request"
              value={requestId}
              onChange={setRequestId}
              label="Filter by request ID"
              placeholder="Request ID…"
            />
          </div>
        </FilterBar>

        <div className="livelog__viewport">
          <div className="livelog__scroll" ref={scroller} onScroll={onScroll} tabIndex={0}>
            {initialLoading ? (
              <div className="panel__body"><TableSkeleton rows={10} label="Loading execution events" /></div>
            ) : visible.length === 0 ? (
              filtering ? (
                <EmptyState title="No events match these filters" icon="filter">
                  <button
                    type="button"
                    className="btn btn--sm"
                    onClick={() => { setProvider(null); setStatus(null); setSearch(""); setRequestId(""); }}
                  >
                    Clear filters
                  </button>
                </EmptyState>
              ) : (
                <EmptyState title="No execution events yet" icon="list">
                  Events appear as requests are routed. The log is in-memory and starts empty when
                  the gateway restarts — send a request from the <strong>Playground</strong> to see
                  one.
                </EmptyState>
              )
            ) : (
              <LiveLogList events={visible} onSelectRequest={setRequestId} />
            )}
          </div>

          {!stuck && visible.length > 0 ? (
            <button type="button" className="btn btn--primary btn--sm livelog__jump" onClick={jumpToLatest}>
              <Icon name="arrowDown" className="btn__icon" size={12} />
              Latest
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
