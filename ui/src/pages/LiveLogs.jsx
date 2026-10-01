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
import { filterRows, ingestPayload, isLive, isNearBottom, mergeRows } from "../lib/liveLogs.js";
import { providerLabel } from "../lib/format.js";

const POLL_MS = 1_000;
/** How often the elapsed time of a running call ticks on screen. */
const TICK_MS = 250;
const PAGE_LIMIT = 200;

/**
 * Live execution log.
 *
 * One row per API call. Reuses the existing request log (`GET /api/requests`)
 * and the panel's polling hook — the gateway has no push channel, so this polls
 * rather than pretending otherwise. The payload lists calls that are still
 * running as well as finished ones, so a row appears the moment a call starts
 * and changes state as it moves on (see `lib/liveLogs.js`); nothing is
 * predicted or reconstructed.
 *
 * Pause stops polling and freezes the view; resuming catches up. Clear empties
 * the view and remembers the high-water mark, so cleared calls do not reappear
 * on the next poll.
 */
export default function LiveLogs() {
  const [rows, setRows] = useState([]);
  const [paused, setPaused] = useState(false);
  const [provider, setProvider] = useState(null);
  const [status, setStatus] = useState(null);
  const [search, setSearch] = useState("");
  const [requestId, setRequestId] = useState("");
  const [stuck, setStuck] = useState(true);

  const debouncedSearch = useDebouncedValue(search, 150);
  const debouncedRequestId = useDebouncedValue(requestId, 150);

  const maxSeq = useRef(0);
  const floor = useRef(0);
  const [now, setNow] = useState(() => Date.now());
  const scroller = useRef(null);

  const log = useApi(({ signal }) => getRequests({ limit: PAGE_LIMIT }, { signal }), {
    intervalMs: POLL_MS,
    enabled: !paused
  });

  // Every poll upserts its rows by call, so a running row is replaced by its
  // next state rather than duplicated.
  useEffect(() => {
    if (!log.data) return;
    const { rows: fresh, maxSeq: next, restarted } = ingestPayload(log.data, {
      floor: floor.current,
      maxSeq: maxSeq.current
    });
    maxSeq.current = next;
    if (restarted) {
      floor.current = 0;
      setRows(fresh);
    } else if (fresh.length > 0) {
      setRows((current) => mergeRows(current, fresh));
    }
  }, [log.data]);

  const filters = useMemo(() => ({
    provider, status, search: debouncedSearch, requestId: debouncedRequestId
  }), [provider, status, debouncedSearch, debouncedRequestId]);

  const visible = useMemo(() => filterRows(rows, filters), [rows, filters]);

  // Tick the clock only while something is running, so an idle page is idle.
  const anyRunning = useMemo(() => visible.some(isLive), [visible]);
  useEffect(() => {
    if (!anyRunning || paused) return undefined;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(timer);
  }, [anyRunning, paused]);

  const providers = useMemo(
    () => [...new Set(rows.map((row) => row.provider).filter(Boolean))].sort()
      .map((value) => ({ value, label: providerLabel(value) })),
    [rows]
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

  const clear = () => {
    // Everything seen so far is cleared; only calls that start later come back.
    floor.current = maxSeq.current;
    setRows([]);
  };

  const filtering = Boolean(provider || status || debouncedSearch.trim() || debouncedRequestId.trim());
  const initialLoading = log.loading && !log.data && rows.length === 0;
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
        description="One row per API call, updating live as the router works through it"
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
            <button type="button" className="btn" onClick={clear} disabled={rows.length === 0}>
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
              {filtering ? `${visible.length} of ${rows.length} calls` : `${rows.length} calls`}
            </span>
          }
        >
          <div className="field filter-bar__search">
            <label className="field__label" htmlFor="livelog-search">Search</label>
            <SearchInput
              id="livelog-search"
              value={search}
              onChange={setSearch}
              label="Search calls"
              placeholder="Provider, model, status, reason…"
            />
          </div>
          <FilterSelect label="Provider" value={provider} onChange={setProvider} options={providers} />
          <FilterSelect
            label="Status"
            value={status}
            onChange={setStatus}
            options={[
              { value: "running", label: "Running" },
              { value: "success", label: "Success" },
              { value: "failed", label: "Failed" }
            ]}
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
              <div className="panel__body"><TableSkeleton rows={10} label="Loading API calls" /></div>
            ) : visible.length === 0 ? (
              filtering ? (
                <EmptyState title="No calls match these filters" icon="filter">
                  <button
                    type="button"
                    className="btn btn--sm"
                    onClick={() => { setProvider(null); setStatus(null); setSearch(""); setRequestId(""); }}
                  >
                    Clear filters
                  </button>
                </EmptyState>
              ) : (
                <EmptyState title="No API calls yet" icon="list">
                  Calls appear the moment they start. The log is in-memory and starts empty when
                  the gateway restarts — send a request from the <strong>Playground</strong> to see
                  one.
                </EmptyState>
              )
            ) : (
              <LiveLogList rows={visible} now={now} onSelectRequest={setRequestId} />
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
