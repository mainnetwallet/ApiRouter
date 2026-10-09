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
 * Manual model selection. Text and Vision lists are separate. Selected models
 * run first, in exactly this order (every key of a model before the next
 * model), then the normal priority and fallback systems. Empty = unchanged routing.
 */
const POOLS = [{ id: "text", label: "Text" }, { id: "vision", label: "Vision" }];
const PROTOCOLS = ["openai-chat", "anthropic", "openai-responses", "gemini"];

export default function ManualSelection() {
  const { data, error, loading, reload: refresh } = useApi((opts) => getManualSelection(opts));
  const [pool, setPool] = useState("text");
  const [drafts, setDrafts] = useState({ text: null, vision: null });
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState(null);
  const [dragFrom, setDragFrom] = useState(null);
  const [protocol, setProtocol] = useState("openai-chat");

  const saved = data?.selection?.[pool] ?? [];
  const draft = drafts[pool] ?? saved;
  const dirty = !sameOrder(draft, saved);
  const available = data?.available?.[pool] ?? [];
  const chosen = useMemo(() => new Set(draft.map(entryId)), [draft]);
  const visible = useMemo(() => filterAvailable(available, query), [available, query]);

  const setDraft = (next) => setDrafts((prev) => ({ ...prev, [pool]: next }));

  const preview = useApi((opts) => getRoutingPreview({ protocol, pool }, opts), { deps: [protocol, pool, data] });
  const order = preview.data?.fallbackOrder ?? [];

  useEffect(() => { setNotice(null); }, [pool]);

  const run = async (action, success) => {
    setBusy(true);
    setNotice(null);
    try {
      await action();
      setDrafts((prev) => ({ ...prev, [pool]: null }));
      await refresh();
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
        title="Manual Selection"
        description="Selected models run first, in this exact order (all keys of a model before the next model). Then the priority and normal fallback systems continue as usual."
        actions={
          <>
            <button type="button" className="btn btn--primary" disabled={busy || !dirty}
              onClick={() => run(() => saveManualSelection(pool, draft), "Saved")}>
              <Icon name="check" className="btn__icon" size={12} /><span className="btn__label">Save</span>
            </button>
            <button type="button" className="btn btn--danger" disabled={busy || (saved.length === 0 && draft.length === 0)}
              onClick={() => run(() => clearManualSelection(pool), "Cleared")}>
              <Icon name="trash" className="btn__icon" size={12} /><span className="btn__label">Clear</span>
            </button>
          </>
        }
      />

      <div className="row" role="tablist" style={{ gap: "var(--sp-2)", marginBottom: "var(--sp-3)" }}>
        {POOLS.map((item) => (
          <button key={item.id} type="button" role="tab" aria-selected={pool === item.id}
            className={`btn ${pool === item.id ? "btn--primary" : ""}`} onClick={() => setPool(item.id)}>
            {item.label} ({(drafts[item.id] ?? data?.selection?.[item.id] ?? []).length})
          </button>
        ))}
        {dirty ? <span className="tiny dim">Unsaved changes</span> : null}
        {notice ? <span className={`tiny ${notice.ok ? "dim" : ""}`} role="status">{notice.text}</span> : null}
      </div>

      {error ? <ErrorState error={error} onRetry={refresh} /> : null}
      {loading && !data ? <p className="dim">Loading…</p> : null}

      {data ? (
        <div className="grid" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))", gap: "var(--sp-4)" }}>
          <section className="card" aria-label="Available models">
            <h2 className="card__title">Available models</h2>
            <SearchInput value={query} onChange={setQuery} placeholder="Search provider or model…" label="Search models" />
            {visible.length === 0 ? (
              <EmptyState title="No models">{available.length === 0 ? `No ${pool} models are configured.` : "Nothing matches this search."}</EmptyState>
            ) : (
              <ul style={{ listStyle: "none", padding: 0, margin: "var(--sp-2) 0 0", maxHeight: 420, overflow: "auto" }}>
                {visible.map((entry) => (
                  <li key={entryId(entry)} className="row" style={{ justifyContent: "space-between", gap: "var(--sp-2)", padding: "3px 0" }}>
                    <span className="mono" title={entryId(entry)}>{providerLabel(entry.provider)} / {entry.model}</span>
                    <button type="button" className="btn btn--sm" disabled={chosen.has(entryId(entry))}
                      onClick={() => setDraft(addEntry(draft, entry))} aria-label={`Add ${entryId(entry)}`}>
                      {chosen.has(entryId(entry)) ? "Added" : "Add"}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="card" aria-label="Selected models">
            <h2 className="card__title">Selected order ({draft.length})</h2>
            {draft.length === 0 ? (
              <EmptyState title="Nothing selected">Existing routing is used unchanged.</EmptyState>
            ) : (
              <ol style={{ margin: 0, paddingLeft: "var(--sp-5)" }}>
                {draft.map((entry, index) => (
                  <li key={entryId(entry)} draggable
                    onDragStart={() => setDragFrom(index)}
                    onDragOver={(event) => event.preventDefault()}
                    onDrop={() => { if (dragFrom !== null) setDraft(moveEntry(draft, dragFrom, index)); setDragFrom(null); }}
                    style={{ padding: "3px 0" }}>
                    <span className="row" style={{ justifyContent: "space-between", gap: "var(--sp-2)" }}>
                      <span className="mono" title={entryId(entry)}>{providerLabel(entry.provider)} / {entry.model}</span>
                      <span className="row" style={{ gap: 4 }}>
                        <button type="button" className="btn btn--ghost btn--sm" disabled={index === 0}
                          onClick={() => setDraft(moveEntry(draft, index, index - 1))} aria-label={`Move ${entryId(entry)} up`}>↑</button>
                        <button type="button" className="btn btn--ghost btn--sm" disabled={index === draft.length - 1}
                          onClick={() => setDraft(moveEntry(draft, index, index + 1))} aria-label={`Move ${entryId(entry)} down`}>↓</button>
                        <button type="button" className="btn btn--ghost btn--sm"
                          onClick={() => setDraft(removeEntry(draft, index))} aria-label={`Remove ${entryId(entry)}`}>
                          <Icon name="close" size={12} />
                        </button>
                      </span>
                    </span>
                  </li>
                ))}
              </ol>
            )}
          </section>

          <section className="card" aria-label="Routing preview">
            <h2 className="card__title">Execution order (saved)</h2>
            <label className="tiny dim">Protocol{" "}
              <select className="input" value={protocol} onChange={(event) => setProtocol(event.target.value)}>
                {PROTOCOLS.map((item) => <option key={item} value={item}>{item}</option>)}
              </select>
            </label>
            {order.length === 0 ? (
              <p className="dim tiny">{preview.error ? "Preview unavailable for this protocol." : "No eligible targets."}</p>
            ) : (
              <ol style={{ margin: "var(--sp-2) 0 0", paddingLeft: "var(--sp-5)", maxHeight: 420, overflow: "auto" }}>
                {order.map((item, index) => (
                  <li key={`${index}-${item.provider}-${item.model}-${item.keyIndex}`} className="mono tiny">
                    {providerLabel(item.provider)} / {item.model} · key {item.keyIndex}
                    {item.phase ? <span className="dim"> · {item.phase}</span> : null}
                  </li>
                ))}
              </ol>
            )}
          </section>
        </div>
      ) : null}
    </div>
  );
}
