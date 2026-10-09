import { useEffect, useMemo, useState } from "react";
import { PageHeader } from "../components/layout/PageHeader.jsx";
import { SearchInput } from "../components/ui/SearchInput.jsx";
import { EmptyState } from "../components/ui/EmptyState.jsx";
import { ErrorState } from "../components/ui/ErrorState.jsx";
import { Icon } from "../components/ui/Icon.jsx";
import { useApi } from "../hooks/useApi.js";
import { getManualSelection, saveManualSelection, clearManualSelection } from "../api/manualSelection.js";
import { getRoutingPreview } from "../api/router.js";
import { providerLabel } from "../lib/format.js";
import { addEntry, entryId, filterAvailable, moveEntry, removeEntry, sameOrder } from "../lib/manualSelection.js";

/**
 * Model Manual Selection. Text and Vision lists are separate. Selected models
 * run first, in exactly this order (every key of a model before the next
 * model), then the priority and normal fallback systems. Empty = unchanged routing.
 */
const POOLS = [{ id: "text", label: "Text", icon: "terminal" }, { id: "vision", label: "Vision", icon: "image" }];
const PROTOCOLS = ["openai-chat", "anthropic", "openai-responses", "gemini"];

function ModelName({ entry }) {
  return (
    <span className="ms-name" title={entryId(entry)}>
      <span className="ms-provider">{providerLabel(entry.provider)}</span>
      <span className="ms-model">{entry.model}</span>
    </span>
  );
}

export default function ModelManualSelection() {
  const { data, error, loading, reload } = useApi((opts) => getManualSelection(opts));
  const [pool, setPool] = useState("text");
  const [drafts, setDrafts] = useState({ text: null, vision: null });
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState(null);
  const [dragFrom, setDragFrom] = useState(null);
  const [dragOver, setDragOver] = useState(null);
  const [protocol, setProtocol] = useState("openai-chat");

  const saved = data?.selection?.[pool] ?? [];
  const draft = drafts[pool] ?? saved;
  const dirty = !sameOrder(draft, saved);
  const available = data?.available?.[pool] ?? [];
  const chosen = useMemo(() => new Set(draft.map(entryId)), [draft]);
  const visible = useMemo(() => filterAvailable(available, query), [available, query]);
  const groups = useMemo(() => {
    const byProvider = new Map();
    for (const entry of visible) {
      if (!byProvider.has(entry.provider)) byProvider.set(entry.provider, []);
      byProvider.get(entry.provider).push(entry);
    }
    return [...byProvider.entries()];
  }, [visible]);
  const addable = visible.filter((entry) => !chosen.has(entryId(entry)));

  const setDraft = (next) => setDrafts((prev) => ({ ...prev, [pool]: next }));
  const countOf = (id) => (drafts[id] ?? data?.selection?.[id] ?? []).length;

  const preview = useApi((opts) => getRoutingPreview({ protocol, pool }, opts), { deps: [protocol, pool, data] });
  const order = preview.data?.fallbackOrder ?? [];

  useEffect(() => { setNotice(null); setQuery(""); }, [pool]);

  const run = async (action, success) => {
    setBusy(true);
    setNotice(null);
    try {
      await action();
      setDrafts((prev) => ({ ...prev, [pool]: null }));
      await reload();
      setNotice({ ok: true, text: success });
    } catch (failure) {
      setNotice({ ok: false, text: failure?.message || "Request failed" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page">
      <PageHeader
        title="Model Manual Selection"
        description="Choose the models the router tries first, in your order."
        actions={
          <>
            <button type="button" className="btn" disabled={busy || !dirty} onClick={() => setDrafts((p) => ({ ...p, [pool]: null }))}>
              <Icon name="undo" className="btn__icon" size={12} /><span className="btn__label">Reset</span>
            </button>
            <button type="button" className="btn btn--danger" disabled={busy || (saved.length === 0 && draft.length === 0)}
              onClick={() => run(() => clearManualSelection(pool), "Selection cleared")}>
              <Icon name="trash" className="btn__icon" size={12} /><span className="btn__label">Clear</span>
            </button>
            <button type="button" className="btn btn--primary" disabled={busy || !dirty}
              onClick={() => run(() => saveManualSelection(pool, draft), "Selection saved")}>
              <Icon name="check" className="btn__icon" size={12} /><span className="btn__label">Save</span>
            </button>
          </>
        }
      />

      <div className="ms-flow" aria-label="Routing order">
        <span className="badge badge--info">1 · Manual selection</span>
        <Icon name="route" size={12} className="dim" />
        <span className="badge badge--neutral">2 · Priority models</span>
        <Icon name="route" size={12} className="dim" />
        <span className="badge badge--neutral">3 · Normal fallback</span>
        <span className="tiny dim ms-flow__hint">All keys of a model are tried before the next model. Empty list = routing unchanged.</span>
      </div>

      <div className="tabs" role="tablist" aria-label="Pool">
        {POOLS.map((item) => (
          <button key={item.id} type="button" role="tab" className="tab" aria-selected={pool === item.id} onClick={() => setPool(item.id)}>
            <Icon name={item.icon} size={13} /> {item.label}
            <span className={`badge ${countOf(item.id) > 0 ? "badge--info" : "badge--neutral"} ms-count`}>{countOf(item.id)}</span>
          </button>
        ))}
      </div>

      {dirty || notice ? (
        <div className={`ms-banner ${dirty ? "ms-banner--warn" : notice?.ok ? "ms-banner--ok" : "ms-banner--danger"}`} role="status">
          <Icon name={dirty ? "alert" : notice?.ok ? "check" : "alert"} size={13} />
          {dirty ? "Unsaved changes. Press Save to apply this order." : notice.text}
        </div>
      ) : null}

      {error ? <ErrorState error={error} onRetry={reload} /> : null}
      {loading && !data ? <p className="dim">Loading…</p> : null}

      {data ? (
        <>
          <div className="ms-grid">
            <section className="panel" aria-label="Available models">
              <div className="panel__header">
                <span className="panel__title">Available models</span>
                <div className="panel__actions">
                  <span className="tiny dim">{visible.length} shown</span>
                  <button type="button" className="btn btn--sm" disabled={addable.length === 0}
                    onClick={() => setDraft(addable.reduce(addEntry, draft))}>Add all shown</button>
                </div>
              </div>
              <div className="panel__body">
                <SearchInput value={query} onChange={setQuery} placeholder="Search provider or model…" label="Search models" />
                <div className="ms-list scroll-list">
                  {groups.length === 0 ? (
                    <EmptyState title="No models">{available.length === 0 ? `No ${pool} models are configured.` : "Nothing matches this search."}</EmptyState>
                  ) : groups.map(([provider, entries]) => (
                    <div key={provider} className="ms-group">
                      <div className="ms-group__title">{providerLabel(provider)} <span className="dim">{entries.length}</span></div>
                      {entries.map((entry) => {
                        const added = chosen.has(entryId(entry));
                        return (
                          <div key={entryId(entry)} className={`ms-row ${added ? "ms-row--added" : ""}`}>
                            <span className="ms-model" title={entryId(entry)}>{entry.model}</span>
                            <button type="button" className={`btn btn--sm ${added ? "btn--ghost" : ""}`} disabled={added}
                              onClick={() => setDraft(addEntry(draft, entry))} aria-label={`Add ${entryId(entry)}`}>
                              {added ? <Icon name="check" size={12} /> : <Icon name="zap" size={12} />}
                              {added ? "Added" : "Add"}
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  ))}
                </div>
              </div>
            </section>

            <section className="panel" aria-label="Selected models">
              <div className="panel__header">
                <span className="panel__title">Selected order</span>
                <div className="panel__actions"><span className="badge badge--neutral">{draft.length}</span></div>
              </div>
              <div className="panel__body">
                {draft.length === 0 ? (
                  <EmptyState title="Nothing selected" icon="list">Add models from the left. Until then the existing routing is used unchanged.</EmptyState>
                ) : (
                  <ol className="ms-selected scroll-list">
                    {draft.map((entry, index) => (
                      <li key={entryId(entry)} draggable
                        className={`ms-item ${dragOver === index ? "ms-item--over" : ""}`}
                        onDragStart={() => setDragFrom(index)}
                        onDragOver={(event) => { event.preventDefault(); setDragOver(index); }}
                        onDragLeave={() => setDragOver(null)}
                        onDragEnd={() => { setDragFrom(null); setDragOver(null); }}
                        onDrop={() => { if (dragFrom !== null) setDraft(moveEntry(draft, dragFrom, index)); setDragFrom(null); setDragOver(null); }}>
                        <span className="ms-handle" aria-hidden="true">⋮⋮</span>
                        <span className="ms-num">{index + 1}</span>
                        <ModelName entry={entry} />
                        <span className="ms-actions">
                          <button type="button" className="btn btn--ghost btn--sm" disabled={index === 0}
                            onClick={() => setDraft(moveEntry(draft, index, index - 1))} aria-label={`Move ${entryId(entry)} up`}>↑</button>
                          <button type="button" className="btn btn--ghost btn--sm" disabled={index === draft.length - 1}
                            onClick={() => setDraft(moveEntry(draft, index, index + 1))} aria-label={`Move ${entryId(entry)} down`}>↓</button>
                          <button type="button" className="btn btn--ghost btn--sm"
                            onClick={() => setDraft(removeEntry(draft, index))} aria-label={`Remove ${entryId(entry)}`}>
                            <Icon name="close" size={12} />
                          </button>
                        </span>
                      </li>
                    ))}
                  </ol>
                )}
              </div>
            </section>
          </div>

          <section className="panel" aria-label="Routing preview">
            <div className="panel__header">
              <span className="panel__title">Execution order <span className="dim tiny">(saved selection)</span></span>
              <div className="panel__actions">
                <label className="sr-only" htmlFor="ms-protocol">Client protocol</label>
                <select id="ms-protocol" className="select" value={protocol} onChange={(event) => setProtocol(event.target.value)}>
                  {PROTOCOLS.map((item) => <option key={item} value={item}>{item}</option>)}
                </select>
              </div>
            </div>
            <div className="panel__body">
              {order.length === 0 ? (
                <p className="dim tiny">{preview.error ? "Preview unavailable for this protocol." : "No eligible targets right now."}</p>
              ) : (
                <ol className="ms-order scroll-list">
                  {order.map((item, index) => (
                    <li key={`${index}-${item.provider}-${item.model}-${item.keyIndex}`} className="ms-order__item">
                      <span className="ms-num ms-num--sm">{index + 1}</span>
                      <ModelName entry={item} />
                      <span className="tiny dim">key {item.keyIndex}</span>
                      {item.phase ? <span className={`badge ${item.phase === "manual" ? "badge--info" : "badge--neutral"}`}>{item.phase}</span> : null}
                    </li>
                  ))}
                </ol>
              )}
            </div>
          </section>
        </>
      ) : null}
    </div>
  );
}
