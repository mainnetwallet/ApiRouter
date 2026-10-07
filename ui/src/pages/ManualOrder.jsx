import { useEffect, useMemo, useRef, useState } from "react";
import { PageHeader } from "../components/layout/PageHeader.jsx";
import { Icon } from "../components/ui/Icon.jsx";
import { PoolBadge } from "../components/ui/PoolBadge.jsx";
import { SearchInput } from "../components/ui/SearchInput.jsx";
import { ErrorState } from "../components/ui/ErrorState.jsx";
import { useApi } from "../hooks/useApi.js";
import { useToast, toastApiError } from "../context/ToastContext.jsx";
import { getManualSelection, saveManualSelection } from "../api/manualSelection.js";
import { providerLabel } from "../lib/format.js";

/**
 * Manual model order.
 *
 * The operator picks provider/model entries per pool and numbers them by
 * position (1, 2, 3 ...). From then on every request of that pool tries them in
 * exactly that order, every key of an entry before the next entry. When all of
 * them fail the gateway continues with its normal plan (priority list, then the
 * Provider -> Key -> Models fallback). An empty list changes nothing.
 *
 * Text and vision are separate lists: a request never leaves its own pool.
 *
 * Every change (add, remove, move, clear) is saved to the gateway straight away;
 * there is no separate Save step to forget.
 */
const POOLS = [
  { key: "text", label: "Text", hint: "Chat, coding and reasoning requests" },
  { key: "vision", label: "Vision", hint: "Requests that carry an image" }
];

const EMPTY = { text: [], vision: [] };

export default function ManualOrder() {
  const toast = useToast();
  const api = useApi(({ signal }) => getManualSelection({ signal }));
  const [payload, setPayload] = useState(null);
  const [draft, setDraft] = useState(EMPTY);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState(null);
  const [activePool, setActivePool] = useState("text");

  // draftRef is what the next save sends; pending holds the newest unsent state
  // while a save is in flight, so rapid clicks are sent in order and the last
  // one always wins. confirmed is the last state the gateway accepted.
  const draftRef = useRef(EMPTY);
  const pending = useRef(null);
  const confirmed = useRef(EMPTY);
  const busy = useRef(false);

  useEffect(() => {
    if (api.data && payload === null) {
      const first = { text: [...api.data.text], vision: [...api.data.vision] };
      setPayload(api.data);
      setDraft(first);
      draftRef.current = first;
      confirmed.current = first;
    }
  }, [api.data, payload]);

  // Only while a save is still on its way: closing the tab now could lose it.
  useEffect(() => {
    if (!saving) return undefined;
    const warn = (event) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [saving]);

  async function flush() {
    if (busy.current) return;
    busy.current = true;
    setSaving(true);
    try {
      while (pending.current) {
        const body = pending.current;
        pending.current = null;
        try {
          const next = await saveManualSelection({ text: body.text, vision: body.vision });
          confirmed.current = { text: [...next.text], vision: [...next.vision] };
          setPayload(next);
          setSavedAt(Date.now());
        } catch (error) {
          // The gateway did not take it: show what it actually has.
          pending.current = null;
          draftRef.current = confirmed.current;
          setDraft(confirmed.current);
          toastApiError(toast, error, "Could not save the manual order");
        }
      }
    } finally {
      busy.current = false;
      setSaving(false);
    }
  }

  function setPool(pool, list) {
    const next = { ...draftRef.current, [pool]: list };
    draftRef.current = next;
    pending.current = next;
    setDraft(next);
    flush();
  }

  const status = saving ? "Saving…" : savedAt ? "All changes saved" : "Changes save automatically";

  return (
    <div className="page">
      <PageHeader
        title="Model Manual Order"
        description="Choose the models a request tries first, in your own order"
        actions={<span className="mo-status" role="status" aria-live="polite">{status}</span>}
      />

      {payload?.persisted === false ? (
        <div className="notice notice--warn section">
          <span>The order is active, but it could not be written to disk, so it will be lost when the router restarts.</span>
        </div>
      ) : null}

      {api.error && !payload ? (
        <ErrorState error={api.error} onRetry={api.reload} />
      ) : !payload ? (
        <p className="dim">Loading…</p>
      ) : (
        <>
          <div className="mo-tabs" role="tablist" aria-label="Pool">
            {POOLS.map((pool) => (
              <button
                key={pool.key}
                type="button"
                role="tab"
                id={`mo-tab-${pool.key}`}
                aria-selected={activePool === pool.key}
                aria-controls={`mo-pool-${pool.key}`}
                className="mo-tab"
                onClick={() => setActivePool(pool.key)}
              >
                {pool.label}
                <span className="mo-tab__count">{draft[pool.key].length}</span>
              </button>
            ))}
          </div>

          <div className="mo-pools">
            {POOLS.map((pool) => (
              <PoolEditor
                key={pool.key}
                pool={pool}
                active={activePool === pool.key}
                list={draft[pool.key]}
                available={payload.available?.[pool.key] ?? []}
                onChange={(list) => setPool(pool.key, list)}
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function PoolEditor({ pool, active, list, available, onChange }) {
  const [search, setSearch] = useState("");
  const byId = useMemo(() => new Map(available.map((row) => [row.id, row])), [available]);

  const choices = useMemo(() => {
    const taken = new Set(list);
    const query = search.trim().toLowerCase();
    return available.filter((row) => !taken.has(row.id) && (!query || row.id.toLowerCase().includes(query)));
  }, [available, list, search]);

  const move = (index, delta) => {
    const target = index + delta;
    if (target < 0 || target >= list.length) return;
    const next = [...list];
    [next[index], next[target]] = [next[target], next[index]];
    onChange(next);
  };

  return (
    <section
      id={`mo-pool-${pool.key}`}
      className={`panel mo-pool${active ? " mo-pool--active" : ""}`}
      aria-label={`${pool.label} manual order`}
    >
      <div className="panel__header">
        <h2 className="panel__title">
          <PoolBadge pool={pool.key} /> <span className="dim tiny">{pool.hint}</span>
        </h2>
        <div className="panel__actions">
          <button type="button" className="btn btn--sm btn--ghost" onClick={() => onChange([])} disabled={list.length === 0}>
            Clear
          </button>
        </div>
      </div>

      <div className="panel__body">
        <h3 className="mo-subtitle">Your order ({list.length})</h3>
        {list.length === 0 ? (
          <p className="mo-empty">
            Nothing selected. {pool.label} requests use the normal priority and fallback list.
          </p>
        ) : (
          <ol className="mo-list">
            {list.map((id, index) => {
              const row = byId.get(id);
              const [provider, ...rest] = id.split("/");
              return (
                <li key={id} className={`mo-item${row ? "" : " mo-item--missing"}`}>
                  <span className="mo-item__rank" aria-label={`Position ${index + 1}`}>{index + 1}</span>
                  <div className="mo-item__info">
                    <div className="mo-item__model">{rest.join("/")}</div>
                    <div className="mo-item__meta">
                      {providerLabel(provider)}
                      {row ? (
                        <> · {row.keys} key{row.keys === 1 ? "" : "s"}
                          {row.available < row.keys ? `, ${row.keys - row.available} cooling down` : ""}
                        </>
                      ) : (
                        <span className="badge badge--warn" style={{ marginLeft: 6 }}>not configured</span>
                      )}
                    </div>
                  </div>
                  <div className="mo-item__actions">
                    <button type="button" className="mo-btn" onClick={() => move(index, -1)}
                      disabled={index === 0} aria-label={`Move ${id} up`}>
                      <Icon name="arrowUp" size={14} /><span className="mo-btn__label">Up</span>
                    </button>
                    <button type="button" className="mo-btn" onClick={() => move(index, 1)}
                      disabled={index === list.length - 1} aria-label={`Move ${id} down`}>
                      <Icon name="arrowDown" size={14} /><span className="mo-btn__label">Down</span>
                    </button>
                    <button type="button" className="mo-btn mo-btn--danger" onClick={() => onChange(list.filter((item) => item !== id))}
                      aria-label={`Remove ${id}`}>
                      <Icon name="close" size={14} /><span className="mo-btn__label">Remove</span>
                    </button>
                  </div>
                </li>
              );
            })}
          </ol>
        )}
      </div>

      <div className="panel__body" style={{ borderTop: "1px solid var(--border)" }}>
        <h3 className="mo-subtitle">Add a model ({choices.length})</h3>
        <SearchInput value={search} onChange={setSearch} placeholder={`Search ${pool.label.toLowerCase()} models…`}
          label={`Search ${pool.label} models`} />
        <ul className="mo-choices">
          {choices.length === 0 ? (
            <li className="mo-empty">{available.length === 0 ? `No ${pool.label.toLowerCase()} models are configured.` : "No more models match."}</li>
          ) : choices.map((row) => (
            <li key={row.id}>
              <button type="button" className="mo-choice" onClick={() => onChange([...list, row.id])}
                aria-label={`Add ${row.id}`}>
                <span className="mo-choice__text">
                  <span className="mo-choice__model">{row.model}</span>
                  <span className="mo-choice__meta" style={{ display: "block" }}>
                    {providerLabel(row.provider)} · {row.keys} key{row.keys === 1 ? "" : "s"}
                  </span>
                </span>
                <span className="mo-choice__add" aria-hidden="true"><Icon name="plus" size={16} /></span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
