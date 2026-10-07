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
          <div className="row" style={{ gap: "var(--sp-2)" }}>
            <button type="button" className="btn" onClick={discard} disabled={!dirty || saving}>
              Discard
            </button>
            <button type="button" className="btn btn--primary" onClick={save} disabled={!dirty || saving}>
              {saving ? "Saving…" : "Save order"}
            </button>
          </div>
        }
      />

      <div className="notice notice--info section">
        <span>
          Requests try your list in order: 1 first, and if it fails, 2, then 3 and so on. Every key of an entry
          is tried before the next entry. If all of them fail, the router continues with its normal priority and
          fallback list. Leave a pool empty to keep the default behaviour. Text and vision are separate.
          A request that names one specific model still uses that model.
        </span>
      </div>

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
        POOLS.map((pool) => (
          <PoolEditor
            key={pool.key}
            pool={pool}
            list={draft[pool.key]}
            available={payload.available?.[pool.key] ?? []}
            onChange={(list) => setPool(pool.key, list)}
          />
        ))
      )}
    </div>
  );
}

function PoolEditor({ pool, list, available, onChange }) {
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
    <section className="panel section" aria-label={`${pool.label} manual order`}>
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
        <h3 className="tiny dim" style={{ margin: "0 0 var(--sp-2)" }}>Your order ({list.length})</h3>
        {list.length === 0 ? (
          <p className="dim tiny">
            Nothing selected. {pool.label} requests use the normal priority and fallback list.
          </p>
        ) : (
          <ol className="stack" style={{ listStyle: "none", margin: 0, padding: 0 }}>
            {list.map((id, index) => {
              const row = byId.get(id);
              const [provider, ...rest] = id.split("/");
              return (
                <li key={id} className="row" style={{ gap: "var(--sp-2)", flexWrap: "nowrap" }}>
                  <span className="chain__rank" style={{ minWidth: 28 }} aria-label={`Position ${index + 1}`}>
                    {index + 1}
                  </span>
                  <span className="grow" style={{ minWidth: 0 }}>
                    <span className="mono" style={{ wordBreak: "break-all" }}>{rest.join("/")}</span>
                    <span className="dim tiny"> · {providerLabel(provider)}</span>
                    {row ? (
                      <span className="dim tiny"> · {row.keys} key{row.keys === 1 ? "" : "s"}
                        {row.available < row.keys ? `, ${row.keys - row.available} cooling down` : ""}
                      </span>
                    ) : (
                      <span className="badge badge--warn" style={{ marginLeft: 6 }}>not configured</span>
                    )}
                  </span>
                  <button type="button" className="btn btn--sm btn--icon" onClick={() => move(index, -1)}
                    disabled={index === 0} aria-label={`Move ${id} up`}>↑</button>
                  <button type="button" className="btn btn--sm btn--icon" onClick={() => move(index, 1)}
                    disabled={index === list.length - 1} aria-label={`Move ${id} down`}>↓</button>
                  <button type="button" className="btn btn--sm btn--icon" onClick={() => onChange(list.filter((item) => item !== id))}
                    aria-label={`Remove ${id}`}><Icon name="close" size={12} /></button>
                </li>
              );
            })}
          </ol>
        )}
      </div>

      <div className="panel__body" style={{ borderTop: "1px solid var(--border)" }}>
        <h3 className="tiny dim" style={{ margin: "0 0 var(--sp-2)" }}>Add a model ({choices.length})</h3>
        <SearchInput value={search} onChange={setSearch} placeholder={`Search ${pool.label.toLowerCase()} models…`}
          label={`Search ${pool.label} models`} />
        <ul className="stack" style={{ listStyle: "none", margin: "var(--sp-2) 0 0", padding: 0, maxHeight: 320, overflowY: "auto" }}>
          {choices.length === 0 ? (
            <li className="dim tiny">{available.length === 0 ? `No ${pool.label.toLowerCase()} models are configured.` : "No more models match."}</li>
          ) : choices.map((row) => (
            <li key={row.id} className="row" style={{ gap: "var(--sp-2)", flexWrap: "nowrap" }}>
              <span className="grow" style={{ minWidth: 0 }}>
                <span className="mono" style={{ wordBreak: "break-all" }}>{row.model}</span>
                <span className="dim tiny"> · {providerLabel(row.provider)} · {row.keys} key{row.keys === 1 ? "" : "s"}</span>
              </span>
              <button type="button" className="btn btn--sm" onClick={() => onChange([...list, row.id])}
                aria-label={`Add ${row.id}`}>Add</button>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
