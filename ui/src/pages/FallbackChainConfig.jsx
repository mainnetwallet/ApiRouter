import { useEffect, useMemo, useState } from "react";
import { PageHeader } from "../components/layout/PageHeader.jsx";
import { SearchInput } from "../components/ui/SearchInput.jsx";
import { EmptyState } from "../components/ui/EmptyState.jsx";
import { ErrorState } from "../components/ui/ErrorState.jsx";
import { HealthBadge } from "../components/ui/HealthBadge.jsx";
import { LatencyBadge } from "../components/ui/LatencyBadge.jsx";
import { Icon } from "../components/ui/Icon.jsx";
import { useApi } from "../hooks/useApi.js";
import { useToast } from "../context/ToastContext.jsx";
import { getFallback, saveChain, saveMode, resetFallback } from "../api/fallback.js";
import { getRoutingPreview } from "../api/router.js";
import { providerLabel, formatRelativeTime } from "../lib/format.js";
import {
  addEntry, chainSummary, entryId, entryState, filterCatalogue, indexCatalogue,
  keysLabel, latencyOf, moveEntry, phaseLabel, removeEntry, sameChain, setKeys, toggleEnabled
} from "../lib/fallbackChain.js";

/**
 * Fallback Chain configuration — the single place routing order is decided.
 *
 * One chain per pool, in the operator's exact order. Every eligible key of a
 * model is tried before the next model; a custom order always wins, and the
 * automatic health-based order only applies when the chain is empty or the
 * operator selects that mode. Nothing on this page invents a route: the order
 * shown is what the gateway will walk.
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

/** Key chips for one entry. An empty selection means every configured key. */
function KeyPicker({ entry, group, disabled, onChange }) {
  const available = group?.keyStates ?? [];
  if (available.length <= 1) return null;
  const chosen = Array.isArray(entry.keys) ? entry.keys : available.map((key) => key.keyIndex);
  return (
    <span className="fc-keys" role="group" aria-label={`Keys for ${entryId(entry)}`}>
      {available.map((key) => {
        const on = chosen.includes(key.keyIndex);
        return (
          <button
            key={key.keyIndex}
            type="button"
            className={`fc-key ${on ? "fc-key--on" : ""}`}
            disabled={disabled}
            aria-pressed={on}
            title={`Key ${key.keyIndex} — ${key.status}${key.available ? "" : " (cooling down)"}`}
            onClick={() => onChange(
              on ? chosen.filter((index) => index !== key.keyIndex) : [...chosen, key.keyIndex]
            )}
          >
            {key.keyIndex}
          </button>
        );
      })}
    </span>
  );
}

export default function FallbackChainConfig() {
  const { data, error, loading, reload } = useApi((opts) => getFallback(opts));
  const toast = useToast();
  const [pool, setPool] = useState("text");
  const [draft, setDraft] = useState(null);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [dragFrom, setDragFrom] = useState(null);
  const [dragOver, setDragOver] = useState(null);
  const [protocol, setProtocol] = useState("openai-chat");

  const saved = data?.chain?.[pool] ?? [];
  const chain = draft ?? saved;
  const dirty = draft !== null && !sameChain(chain, saved);
  const catalogue = data?.catalogue?.[pool] ?? [];
  const index = useMemo(() => indexCatalogue(catalogue), [catalogue]);
  const lastSeenAt = useMemo(() => {
    const stamps = catalogue.flatMap((group) => group.keyStates ?? [])
      .map((key) => key.updatedAt).filter(Boolean).sort();
    return stamps.at(-1) ?? null;
  }, [catalogue]);

  const chosen = useMemo(() => new Set(chain.map(entryId)), [chain]);
  const visible = useMemo(() => filterCatalogue(catalogue, query), [catalogue, query]);
  const groups = useMemo(() => {
    const byProvider = new Map();
    for (const group of visible) {
      if (!byProvider.has(group.provider)) byProvider.set(group.provider, []);
      byProvider.get(group.provider).push(group);
    }
    return [...byProvider.entries()];
  }, [visible]);
  const addable = visible.filter((group) => !chosen.has(entryId(group)));

  const preview = useApi((opts) => getRoutingPreview({ protocol, pool }, opts), { deps: [protocol, pool, data] });
  const order = preview.data?.fallbackOrder ?? [];
  const summary = chainSummary(chain, catalogue, data?.mode);

  useEffect(() => { setQuery(""); setDraft(null); }, [pool]);

  const run = async (action, success) => {
    setBusy(true);
    try {
      await action();
      setDraft(null);
      await reload();
      toast.success(success);
    } catch (failure) {
      toast.error(failure?.message || "Request failed");
    } finally {
      setBusy(false);
    }
  };

  const modeOf = (id) => data?.modes?.find((mode) => mode.id === id);
  const remembered = data?.remembered?.remembered?.[pool] ?? [];

  return (
    <div className="page">
      <PageHeader
        title="Fallback Chain"
        description="The router's order for Text and Vision. Every eligible key of a model is tried before the next model."
        actions={
          <>
            <button type="button" className="btn" disabled={busy || draft === null}
              onClick={() => setDraft(null)}>
              <Icon name="undo" className="btn__icon" size={12} /><span className="btn__label">Discard</span>
            </button>
            <button
              type="button"
              className="btn"
              disabled={busy || (saved.length === 0 && chain.length === 0)}
              onClick={() => run(() => saveChain(pool, []), `${pool} chain cleared`)}
            >
              <Icon name="trash" className="btn__icon" size={12} /><span className="btn__label">Clear {pool}</span>
            </button>
            <button type="button" className="btn btn--primary" disabled={busy || !dirty}
              onClick={() => run(() => saveChain(pool, chain), `${pool} chain saved`)}>
              <Icon name="check" className="btn__icon" size={12} /><span className="btn__label">Save</span>
            </button>
          </>
        }
      />

      {error ? <ErrorState error={error} onRetry={reload} /> : null}
      {loading && !data ? <p className="dim">Loading…</p> : null}

      {data ? (
        <>
          {/* Operating mode: the one switch that decides what leads a request. */}
          <section className="panel" aria-label="Fallback operating mode">
            <div className="panel__header">
              <span className="panel__title">Fallback mode</span>
              <div className="panel__actions">
                <span className="tiny dim">
                  {data.mode === "fixed"
                    ? "Every request starts at the first model of the chain."
                    : data.mode === "manual"
                      ? "Your selection first, then every other model by health, then one final pass over your selection."
                      : "A success is remembered and tried first on the next request."}
                </span>
              </div>
            </div>
            <div className="panel__body">
              <div className="fc-modes" role="radiogroup" aria-label="Fallback mode">
                {(data.modes ?? []).map((mode) => (
                  <button
                    key={mode.id}
                    type="button"
                    role="radio"
                    aria-checked={data.mode === mode.id}
                    className={`fc-mode ${data.mode === mode.id ? "fc-mode--on" : ""}`}
                    disabled={busy}
                    onClick={() => data.mode === mode.id
                      ? undefined
                      : run(() => saveMode(mode.id), `Mode set to ${mode.label}`)}
                  >
                    <span className="fc-mode__head">
                      <Icon name={data.mode === mode.id ? "check" : "route"} size={13} />
                      {mode.label}
                    </span>
                    <span className="fc-mode__detail">{mode.detail}</span>
                  </button>
                ))}
              </div>

              <div className="fc-remembered">
                <div>
                  <span className="tiny dim">
                    Remembered right now for the {pool} pool:{" "}
                    {remembered.length === 0
                      ? "nothing — the next request starts at the first target of the active chain."
                      : `${remembered.length} session(s).`}
                  </span>
                  {remembered.length > 0 ? (
                    <ul className="fc-remembered__list">
                      {remembered.slice(0, 5).map((item) => (
                        <li key={`${item.protocol}-${item.sessionId}`} className="mono tiny">
                          {item.targetId} <span className="dim">· {item.protocol} · session {item.sessionId}</span>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </div>
                <button
                  type="button"
                  className="btn btn--danger"
                  disabled={busy}
                  onClick={() => run(() => resetFallback(), "Remembered targets cleared")}
                >
                  <Icon name="refresh" className="btn__icon" size={12} />
                  <span className="btn__label">Reset Fallback</span>
                </button>
              </div>
              <p className="tiny dim fc-note">
                Reset Fallback clears remembered model/key preferences only. It never deletes the chain, the mode,
                the providers, the API keys, the configured models, valid health measurements or a genuine cooldown.
              </p>
            </div>
          </section>

          <div className="fc-flow" aria-label="Ordering in force">
            <span className={`badge ${summary.failClosed ? "badge--danger" : summary.source === "chain" ? "badge--info" : "badge--warn"}`}>
              {summary.label}
            </span>
            <span className="tiny dim">
              {summary.failClosed
                ? `Every entry in this chain is disabled or names a model the ${pool} pool no longer has. Clear the chain to hand routing back to the automatic order.`
                : chain.length === 0
                  ? "No chain is configured, so the automatic health-based order is used."
                  : "A configured chain is followed exactly; health only skips models that are cooling down."}
            </span>
          </div>

          <div className="tabs" role="tablist" aria-label="Pool">
            {POOLS.map((item) => (
              <button key={item.id} type="button" role="tab" className="tab" aria-selected={pool === item.id} onClick={() => setPool(item.id)}>
                <Icon name={item.icon} size={13} /> {item.label}
                <span className={`badge ${(data.chain?.[item.id]?.length ?? 0) > 0 ? "badge--info" : "badge--neutral"} ms-count`}>
                  {data.chain?.[item.id]?.length ?? 0}
                </span>
              </button>
            ))}
          </div>

          {dirty ? (
            <div className="ms-banner ms-banner--warn" role="status">
              <Icon name="alert" size={13} />
              Unsaved changes. Press Save to apply this order.
            </div>
          ) : null}

          <div className="ms-grid">
            <section className="panel" aria-label="Available models">
              <div className="panel__header">
                <span className="panel__title">Available models</span>
                <div className="panel__actions">
                  {lastSeenAt ? <span className="tiny dim">health updated {formatRelativeTime(lastSeenAt)}</span> : null}
                  <button type="button" className="btn btn--sm" disabled={addable.length === 0}
                    onClick={() => setDraft(addable.reduce(addEntry, chain))}>Add all shown</button>
                </div>
              </div>
              <div className="panel__body">
                <SearchInput value={query} onChange={setQuery} placeholder="Search provider or model…" label="Search models" />
                <div className="ms-list scroll-list">
                  {groups.length === 0 ? (
                    <EmptyState title="No models">
                      {catalogue.length === 0 ? `No ${pool} models are configured.` : "Nothing matches this search."}
                    </EmptyState>
                  ) : groups.map(([provider, models]) => (
                    <div key={provider} className="ms-group">
                      <div className="ms-group__title">{providerLabel(provider)} <span className="dim">{models.length}</span></div>
                      {models.map((group) => {
                        const added = chosen.has(entryId(group));
                        const latency = latencyOf(group);
                        return (
                          <div key={group.id} className={`ms-row ${added ? "ms-row--added" : ""}`}>
                            <span className="ms-model" title={group.id}>{group.model}</span>
                            <span className="fc-metrics">
                              <HealthBadge status={group.status} title={`${group.keyStates.length} key(s)`} />
                              <LatencyBadge ms={latency.ms} />
                            </span>
                            <button type="button" className={`btn btn--sm ${added ? "btn--ghost" : ""}`} disabled={added}
                              onClick={() => setDraft(addEntry(chain, group))} aria-label={`Add ${group.id}`}>
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

            <section className="panel" aria-label="Fallback chain">
              <div className="panel__header">
                <span className="panel__title">{POOLS.find((item) => item.id === pool)?.label} chain</span>
                <div className="panel__actions">
                  <span className="badge badge--neutral">{chain.length}</span>
                </div>
              </div>
              <div className="panel__body">
                {chain.length === 0 ? (
                  <EmptyState title="Empty chain" icon="list">
                    Add models from the left. While this chain is empty the router uses the
                    automatic health-based order over every configured {pool} model.
                  </EmptyState>
                ) : (
                  <ol className="ms-selected scroll-list">
                    {chain.map((entry, i) => {
                      const group = index.get(entryId(entry));
                      const state = entryState(entry, group);
                      const latency = latencyOf(group);
                      return (
                        <li key={entryId(entry)} draggable
                          className={`ms-item fc-item ${dragOver === i ? "ms-item--over" : ""} ${entry.enabled === false ? "fc-item--off" : ""}`}
                          onDragStart={() => setDragFrom(i)}
                          onDragOver={(event) => { event.preventDefault(); setDragOver(i); }}
                          onDragLeave={() => setDragOver(null)}
                          onDragEnd={() => { setDragFrom(null); setDragOver(null); }}
                          onDrop={() => { if (dragFrom !== null) setDraft(moveEntry(chain, dragFrom, i)); setDragFrom(null); setDragOver(null); }}>
                          <span className="ms-handle" aria-hidden="true">⋮⋮</span>
                          <span className="ms-num">{i + 1}</span>
                          <span className="fc-item__main">
                            <ModelName entry={entry} />
                            <span className="fc-item__meta">
                              <HealthBadge status={group?.status ?? "unknown"} title={state.label} />
                              <LatencyBadge ms={latency.ms} />
                              <span className="tiny dim" title={latency.label}>{latency.label}</span>
                              <span className="tiny dim">{keysLabel(entry, group)}</span>
                              {state.tone === "danger" || state.tone === "warn" ? (
                                <span className={`badge badge--${state.tone === "danger" ? "danger" : "warn"}`}>{state.label}</span>
                              ) : null}
                            </span>
                            <KeyPicker
                              entry={entry}
                              group={group}
                              disabled={busy}
                              onChange={(keys) => setDraft(setKeys(chain, i, keys))}
                            />
                          </span>
                          <span className="ms-actions">
                            <button type="button" className="btn btn--ghost btn--sm"
                              aria-pressed={entry.enabled !== false}
                              title={entry.enabled === false ? "Enable this model" : "Disable this model (keeps its place)"}
                              onClick={() => setDraft(toggleEnabled(chain, i))}>
                              <Icon name={entry.enabled === false ? "offline" : "check"} size={12} />
                            </button>
                            <button type="button" className="btn btn--ghost btn--sm" disabled={i === 0}
                              onClick={() => setDraft(moveEntry(chain, i, i - 1))} aria-label={`Move ${entryId(entry)} up`}>↑</button>
                            <button type="button" className="btn btn--ghost btn--sm" disabled={i === chain.length - 1}
                              onClick={() => setDraft(moveEntry(chain, i, i + 1))} aria-label={`Move ${entryId(entry)} down`}>↓</button>
                            <button type="button" className="btn btn--ghost btn--sm"
                              onClick={() => setDraft(removeEntry(chain, i))} aria-label={`Remove ${entryId(entry)}`}>
                              <Icon name="close" size={12} />
                            </button>
                          </span>
                        </li>
                      );
                    })}
                  </ol>
                )}
              </div>
            </section>
          </div>

          <section className="panel" aria-label="Route order">
            <div className="panel__header">
              <span className="panel__title">
                Route order <span className="dim tiny">({chain.length === 0 ? "automatic" : "saved chain"})</span>
              </span>
              <div className="panel__actions">
                <label className="sr-only" htmlFor="fc-protocol">Client protocol</label>
                <select id="fc-protocol" className="select" value={protocol} onChange={(event) => setProtocol(event.target.value)}>
                  {PROTOCOLS.map((item) => <option key={item} value={item}>{item}</option>)}
                </select>
              </div>
            </div>
            <div className="panel__body">
              {order.length === 0 ? (
                <p className="dim tiny">{preview.error ? "Preview unavailable for this protocol." : "No eligible targets right now."}</p>
              ) : (
                <ol className="ms-order scroll-list">
                  {order.map((item, i) => (
                    <li key={`${i}-${item.provider}-${item.model}-${item.keyIndex}`} className="ms-order__item">
                      <span className="ms-num ms-num--sm">{i + 1}</span>
                      <ModelName entry={item} />
                      <span className="tiny dim">key {item.keyIndex}</span>
                      <LatencyBadge ms={item.latencyMs} />
                      {item.phase ? (
                        <span className={`badge ${item.phase === "sticky" ? "badge--info" : "badge--neutral"}`}>
                          {phaseLabel(item.phase) ?? item.phase}
                        </span>
                      ) : null}
                    </li>
                  ))}
                </ol>
              )}
              <p className="tiny dim fc-note">
                This is the order the gateway will walk for a new {pool} request over {protocol}.
              </p>
            </div>
          </section>
        </>
      ) : null}
    </div>
  );
}
