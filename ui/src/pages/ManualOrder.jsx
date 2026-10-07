import { useEffect, useMemo, useState } from "react";
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
 */
const POOLS = [
  { key: "text", label: "Text", hint: "Chat, coding and reasoning requests" },
  { key: "vision", label: "Vision", hint: "Requests that carry an image" }
];

const EMPTY = { text: [], vision: [] };
const sameList = (a, b) => a.length === b.length && a.every((item, index) => item === b[index]);

export default function ManualOrder() {
  const toast = useToast();
  const api = useApi(({ signal }) => getManualSelection({ signal }));
  const [payload, setPayload] = useState(null);
  const [draft, setDraft] = useState(EMPTY);
  const [saving, setSaving] = useState(false);
  const [activePool, setActivePool] = useState("text");

  // The first load fills the editor; after that the editor owns the draft and
  // only a successful save replaces the saved copy.
  useEffect(() => {
    if (api.data && payload === null) {
      setPayload(api.data);
      setDraft({ text: [...api.data.text], vision: [...api.data.vision] });
    }
  }, [api.data, payload]);

  const saved = payload ? { text: payload.text, vision: payload.vision } : EMPTY;
  const dirty = !sameList(draft.text, saved.text) || !sameList(draft.vision, saved.vision);

  // "Add" only edits the draft; nothing reaches the router until "Save order".
  // Warn before a refresh or tab close would silently throw the draft away.
  useEffect(() => {
    if (!dirty) return undefined;
    const warn = (event) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const setPool = (pool, list) => setDraft((current) => ({ ...current, [pool]: list }));

  async function save() {
    setSaving(true);
    try {
      const next = await saveManualSelection({ text: draft.text, vision: draft.vision });
      setPayload(next);
      setDraft({ text: [...next.text], vision: [...next.vision] });
      toast.success(
        next.text.length + next.vision.length === 0
          ? "Manual order cleared"
          : "Manual order saved. New requests use it now"
      );
    } catch (error) {
      toastApiError(toast, error, "Could not save the manual order");
    } finally {
      setSaving(false);
    }
  }

  function discard() {
    setDraft({ text: [...saved.text], vision: [...saved.vision] });
  }

  return (
    <div className="page">
      <PageHeader
        title="Model Manual Order"
        description="Choose the models a request tries first, in your own order"
        actions={
          <div className="row mo-header-actions" style={{ gap: "var(--sp-2)" }}>
            <button type="button" className="btn" onClick={discard} disabled={!dirty || saving}>
              Discard
            </button>
            <button type="button" className="btn btn--primary" onClick={save} disabled={!dirty || saving}>
              {saving ? "Saving…" : "Save order"}
            </button>
          </div>
        }
      />

      {dirty ? (
        <div className="notice notice--warn section mo-dirty-notice">
          <span>
            You have unsaved changes. Press <strong>Save order</strong> to apply them; if you refresh now they are lost.
          </span>
        </div>
      ) : null}

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
            {POOLS.map((pool) => {
              const changed = !sameList(draft[pool.key], saved[pool.key]);
              return (
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
                  {changed ? <span className="mo-tab__dot" title="Unsaved changes" /> : null}
                </button>
              );
            })}
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

          {dirty ? (
            <div className="mo-savebar" role="region" aria-label="Unsaved changes">
              <span className="mo-savebar__text">Unsaved changes</span>
              <button type="button" className="btn" onClick={discard} disabled={saving}>Discard</button>
              <button type="button" className="btn btn--primary" onClick={save} disabled={saving}>
                {saving ? "Saving…" : "Save order"}
              </button>
            </div>
          ) : null}
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
