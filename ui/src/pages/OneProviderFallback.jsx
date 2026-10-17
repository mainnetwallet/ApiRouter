import { useEffect, useMemo, useState } from "react";
import { getOneProvider, setOneProvider, keyIdOf } from "../api/oneProvider.js";
import { useApi } from "../hooks/useApi.js";
import { useConnection } from "../context/ConnectionContext.jsx";
import { useToast } from "../context/ToastContext.jsx";
import { PageHeader } from "../components/layout/PageHeader.jsx";
import { DataTable } from "../components/ui/DataTable.jsx";
import { StatusBadge } from "../components/ui/StatusBadge.jsx";
import { HealthBadge } from "../components/ui/HealthBadge.jsx";
import { PoolBadge } from "../components/ui/PoolBadge.jsx";
import { LatencyBadge } from "../components/ui/LatencyBadge.jsx";
import { EmptyState } from "../components/ui/EmptyState.jsx";
import { ErrorState } from "../components/ui/ErrorState.jsx";
import { TableSkeleton } from "../components/ui/LoadingSkeleton.jsx";
import { formatCountdown, formatNumber, providerLabel, EMPTY } from "../lib/format.js";

/**
 * One Provider Fallback.
 *
 * Serves every request from ONE chosen provider and nothing else: no other
 * provider is ever used as a fallback. The operator lists any number of that
 * provider's models in order (model 1, 2, 3, ...), and each model has its own
 * keys:
 *
 *   - model 1's keys are tried first; when every one of them has failed or is
 *     cooling, model 2 is tried, then model 3, and so on
 *   - every request starts from model 1 again, so a key that is out of its
 *     cooldown is used again straight away
 *   - by default a key has no cooldown and nothing waits; a cooldown can be set
 *     per key, and it starts the moment a call is made with that key
 *   - when every key of every model has failed or is cooling, the request waits
 *     for the first cooldown to end and tries again
 *
 * The switch applies at once on the gateway and changes no saved chain, model
 * switch or health data, so turning it off restores the previous routing.
 */

const secondsOf = (ms) => (ms > 0 ? String(Math.round(ms / 1000)) : "");

/** "" -> null (no cooldown); a whole number of seconds -> ms; anything else -> undefined (invalid). */
export function parseCooldownSeconds(text) {
  const trimmed = String(text ?? "").trim();
  if (trimmed === "") return null;
  if (!/^\d+$/.test(trimmed)) return undefined;
  const seconds = Number(trimmed);
  if (seconds === 0) return null;
  return seconds <= 86_400 ? seconds * 1000 : undefined;
}

/**
 * One key's cooldown, in seconds. Empty means "no cooldown": the key is never
 * paced. Saved when the field loses focus or Enter is pressed.
 */
function CooldownInput({ keyRow, disabled, onCommit }) {
  const saved = secondsOf(keyRow.cooldownMs);
  const [text, setText] = useState(saved);
  const [editing, setEditing] = useState(false);
  const invalid = parseCooldownSeconds(text) === undefined;

  // Follow the gateway's value, but never while the operator is typing.
  useEffect(() => { if (!editing) setText(saved); }, [saved, editing]);

  const commit = () => {
    setEditing(false);
    const ms = parseCooldownSeconds(text);
    if (ms === undefined) { setText(saved); return; }
    if ((ms ?? 0) !== keyRow.cooldownMs) onCommit(keyRow, ms);
  };

  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: "var(--sp-1)", justifyContent: "flex-end" }}>
      <input
        type="text"
        inputMode="numeric"
        className="input mono"
        style={{ width: 84, textAlign: "right" }}
        placeholder="none"
        value={text}
        disabled={disabled}
        aria-label={`Cooldown in seconds for ${keyRow.model} key ${keyRow.keyIndex} (empty for none)`}
        aria-invalid={invalid || undefined}
        title="Seconds this key cools after each call. Empty = no cooldown. 60 = 1 minute."
        onFocus={() => setEditing(true)}
        onChange={(event) => setText(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }}
      />
      <span className="tiny dim">s</span>
    </span>
  );
}

const sameList = (a, b) => a.length === b.length && a.every((entry, index) => entry === b[index]);

export default function OneProviderFallback() {
  const { generation } = useConnection();
  const toast = useToast();
  const state = useApi(getOneProvider, { intervalMs: 5_000, deps: [generation] });
  const data = state.data;

  // The provider and model list being edited but not applied yet. `null` means
  // "whatever the gateway has", so a poll never overwrites what the operator is
  // choosing.
  const [draft, setDraft] = useState(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState(null);
  const [sort, setSort] = useState({ key: "model", direction: "asc" });
  const [allText, setAllText] = useState("");
  const [query, setQuery] = useState("");

  // One tick a second so every cooldown counts down between polls.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const candidates = data?.candidates ?? [];
  const providers = useMemo(() => [...new Set(candidates.map((candidate) => candidate.provider))].sort(), [candidates]);
  const savedProvider = data?.provider ?? "";
  const savedModels = data?.models ?? [];
  const chosenProvider = draft?.provider ?? savedProvider;
  const chosenModels = draft?.models ?? savedModels;
  const enabled = data?.enabled === true;
  const dirty = chosenProvider !== savedProvider || !sameList(chosenModels, savedModels);
  const changedSelection = enabled && chosenProvider !== "" && chosenModels.length > 0 && dirty;

  // One card per provider: how many models and keys it has to offer.
  const providerCards = useMemo(() => providers.map((provider) => {
    const own = candidates.filter((candidate) => candidate.provider === provider);
    return { provider, models: own.length, keys: own.reduce((sum, candidate) => sum + candidate.keyCount, 0) };
  }), [providers, candidates]);

  const providerModels = candidates.filter((candidate) => candidate.provider === chosenProvider);
  const needle = query.trim().toLowerCase();
  const visibleModels = needle
    ? providerModels.filter((candidate) => candidate.model.toLowerCase().includes(needle))
    : providerModels;
  const modelInfo = (model) => providerModels.find((candidate) => candidate.model === model) ?? null;
  const addable = providerModels.filter((candidate) => !chosenModels.includes(candidate.model));

  const edit = (provider, models) => setDraft({ provider, models });
  const pickProvider = (provider) => {
    if (provider === chosenProvider) return;
    setQuery("");
    edit(provider, provider === savedProvider ? savedModels : []);
  };
  const addModel = (model) => model && !chosenModels.includes(model) && edit(chosenProvider, [...chosenModels, model]);
  const toggleModel = (model) => (chosenModels.includes(model)
    ? edit(chosenProvider, chosenModels.filter((entry) => entry !== model))
    : addModel(model));
  const addAll = () => edit(chosenProvider, [...chosenModels, ...visibleModels.map((candidate) => candidate.model).filter((model) => !chosenModels.includes(model))]);
  const removeModel = (index) => edit(chosenProvider, chosenModels.filter((_, at) => at !== index));
  const moveModel = (index, delta) => {
    const to = index + delta;
    if (to < 0 || to >= chosenModels.length) return;
    const next = [...chosenModels];
    [next[index], next[to]] = [next[to], next[index]];
    edit(chosenProvider, next);
  };

  const apply = async (payload, successMessage) => {
    setBusy(true);
    setActionError(null);
    try {
      await setOneProvider(payload);
      setDraft(null);
      state.reload();
      toast.success(successMessage);
    } catch (error) {
      setActionError(error);
    } finally {
      setBusy(false);
    }
  };

  const canApply = chosenProvider !== "" && chosenModels.length > 0;
  const turnOn = () => canApply && apply(
    { enabled: true, provider: chosenProvider, models: chosenModels },
    `One Provider Fallback is on: ${chosenProvider} (${chosenModels.length} model${chosenModels.length === 1 ? "" : "s"})`
  );
  const saveChanges = () => canApply && apply(
    { enabled: true, provider: chosenProvider, models: chosenModels },
    `Now using only ${chosenProvider}: ${chosenModels.join(" → ")}`
  );
  const turnOff = () => apply({ enabled: false }, "One Provider Fallback is off — normal fallback restored");

  // Cooldowns belong to the keys of the models the gateway is using, so they can
  // only be edited for the saved selection, not for one that is merely picked.
  const keys = data?.keys ?? [];
  const canEditKeys = !dirty && savedProvider !== "" && keys.length > 0;

  const setKeyCooldown = (keyRow, ms) => apply(
    { cooldowns: { [keyIdOf(keyRow)]: ms } },
    ms === null
      ? `${keyRow.model} key #${keyRow.keyIndex}: no cooldown`
      : `${keyRow.model} key #${keyRow.keyIndex}: ${Math.round(ms / 1000)}s cooldown`
  );

  const allMs = parseCooldownSeconds(allText);
  const applyToAll = () => {
    if (allMs === undefined) return;
    apply(
      { cooldowns: Object.fromEntries(keys.map((keyRow) => [keyIdOf(keyRow), allMs])) },
      allMs === null ? "No cooldown on any key" : `Every key: ${Math.round(allMs / 1000)}s cooldown`
    );
  };

  const columns = useMemo(() => [
    {
      key: "model", header: "Model", sortable: true,
      get: (row) => row.rank,
      render: (row) => (
        <span>
          <span className="tiny dim">#{row.rank}</span>{" "}
          <span className="mono">{row.model}</span>
        </span>
      )
    },
    {
      key: "pool", header: "Pool", sortable: true,
      get: (row) => row.pool,
      render: (row) => <PoolBadge pool={row.pool} />
    },
    {
      key: "key", header: "Key", sortable: true, align: "right",
      get: (row) => row.keyIndex,
      render: (row) => <span className="mono">#{row.keyIndex}</span>
    },
    {
      key: "state", header: "State", sortable: true,
      get: (row) => (row.cooldownUntil > now ? row.cooldownUntil : 0),
      render: (row) => {
        const left = row.cooldownUntil > now ? formatCountdown(row.cooldownUntil, now) : null;
        return left
          ? <StatusBadge tone="warn" title="Called less than a cooldown ago; ready again after the countdown">cooling · {left}</StatusBadge>
          : <StatusBadge tone="ok">ready</StatusBadge>;
      }
    },
    {
      key: "cooldown", header: "Cooldown per call", sortable: true, align: "right",
      get: (row) => row.cooldownMs,
      render: (row) => (
        <CooldownInput keyRow={row} disabled={busy || !canEditKeys} onCommit={setKeyCooldown} />
      )
    },
    {
      key: "health", header: "Health", sortable: true,
      get: (row) => row.status,
      render: (row) => <HealthBadge status={row.status} />
    },
    {
      key: "successes", header: "Successes", sortable: true, align: "right",
      get: (row) => row.successes,
      render: (row) => <span className="mono">{formatNumber(row.successes)}</span>
    },
    {
      key: "failures", header: "Failures", sortable: true, align: "right",
      get: (row) => row.failures,
      render: (row) => (
        <span className="mono" style={{ color: row.failures > 0 ? "var(--danger)" : undefined }}>{formatNumber(row.failures)}</span>
      )
    },
    {
      key: "last", header: "Last status", sortable: true, align: "right",
      get: (row) => row.lastStatus ?? 0,
      render: (row) => <span className="mono">{row.lastStatus ?? EMPTY}</span>
    },
    {
      key: "latency", header: "Latency", sortable: true, align: "right",
      get: (row) => row.latencyMs,
      render: (row) => <LatencyBadge ms={row.latencyMs} />
    }
  ], [now, busy, canEditKeys]);

  if (state.loading && !data) {
    return (
      <div className="page">
        <PageHeader title="One Provider Fallback" description="Serve every request from one provider and nothing else" />
        <div className="panel"><div className="panel__body"><TableSkeleton rows={4} label="Loading One Provider Fallback" /></div></div>
      </div>
    );
  }

  return (
    <div className="page">
      <PageHeader
        title="One Provider Fallback"
        description="Serve every request from one provider and nothing else"
        lastUpdatedAt={state.lastUpdatedAt}
        refreshing={state.refreshing}
        actions={<button type="button" className="btn" onClick={state.reload} disabled={state.refreshing}>Refresh</button>}
      />

      {state.error ? <ErrorState error={state.error} onRetry={state.reload} compact /> : null}
      {actionError ? <ErrorState error={actionError} compact /> : null}

      <section className="section">
        <div className="panel">
          <div className="panel__body">
            <div style={{ display: "flex", alignItems: "center", gap: "var(--sp-3)", flexWrap: "wrap" }}>
              <StatusBadge tone={data?.active ? "ok" : "neutral"} pulse={data?.active === true}>
                {data?.active ? "On" : "Off"}
              </StatusBadge>
              <span>
                {data?.active
                  ? <>Every request uses only <strong>{providerLabel(data.provider)}</strong>, trying its models in the order below. No other provider is used as a fallback.</>
                  : "Normal fallback is in use. Turn this on to serve every request from a single provider."}
              </span>
            </div>

            {data?.switchedOff ? (
              <p className="tiny" style={{ color: "var(--warn)", marginTop: "var(--sp-2)" }}>
                Every chosen model is switched off in the Control Panel, so requests fail until one is switched on again.
              </p>
            ) : null}

            <div className="op-step">
              <div className="op-step__title"><span className="op-step__num">1</span>Provider to use</div>
              {providerCards.length === 0 ? (
                <p className="tiny dim" style={{ margin: 0 }}>No provider is configured.</p>
              ) : (
                <div className="op-providers" role="radiogroup" aria-label="Provider to use">
                  {providerCards.map((card) => {
                    const active = card.provider === chosenProvider;
                    return (
                      <button
                        key={card.provider}
                        type="button"
                        role="radio"
                        aria-checked={active}
                        className={`op-provider${active ? " is-active" : ""}`}
                        disabled={busy}
                        onClick={() => pickProvider(card.provider)}
                      >
                        <span className="op-provider__name">{providerLabel(card.provider)}</span>
                        <span className="op-provider__meta">
                          {card.models} model{card.models === 1 ? "" : "s"} · {card.keys} key{card.keys === 1 ? "" : "s"}
                        </span>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>

            <div className="op-step">
              <div className="op-step__title"><span className="op-step__num">2</span>Models — add as many as you like</div>
              {chosenProvider === "" ? (
                <p className="tiny dim" style={{ margin: 0 }}>Choose a provider first.</p>
              ) : (
                <div className="op-picker">
                  <div className="op-col">
                    <div className="op-col__head">
                      <span className="tiny dim">Available · tap to add</span>
                      <button type="button" className="btn btn--sm" disabled={busy || visibleModels.every((candidate) => chosenModels.includes(candidate.model))} onClick={addAll}>
                        Add all{needle ? " shown" : ""}
                      </button>
                    </div>
                    {providerModels.length > 6 ? (
                      <input
                        type="search"
                        className="input op-search"
                        placeholder="Search models…"
                        value={query}
                        aria-label="Search models"
                        onChange={(event) => setQuery(event.target.value)}
                      />
                    ) : null}
                    <ul className="op-list op-list--scroll" aria-label="Available models">
                      {visibleModels.map((candidate) => {
                        const added = chosenModels.includes(candidate.model);
                        return (
                          <li key={candidate.model}>
                            <button
                              type="button"
                              className={`op-row op-row--button${added ? " op-row--added" : ""}`}
                              disabled={busy}
                              aria-pressed={added}
                              aria-label={added ? `Remove ${candidate.model} from the list` : `Add ${candidate.model}`}
                              onClick={() => toggleModel(candidate.model)}
                            >
                              <span className="op-row__main">
                                <span className="op-row__name">{candidate.model}</span>
                                <span className="op-row__meta">
                                  {candidate.keyCount} key{candidate.keyCount === 1 ? "" : "s"} · {candidate.pools.join("+")}
                                  {candidate.disabled ? " · switched off" : ""}
                                </span>
                              </span>
                              <span className={`op-tag${added ? " op-tag--on" : ""}`}>{added ? "✓ Added" : "+ Add"}</span>
                            </button>
                          </li>
                        );
                      })}
                      {visibleModels.length === 0 ? (
                        <li className="tiny dim" style={{ padding: "var(--sp-2)" }}>No model matches “{query}”.</li>
                      ) : null}
                    </ul>
                  </div>

                  <div className="op-col op-col--order">
                    <div className="op-col__head">
                      <span className="tiny dim">Your order · #1 leads, the next is used when all keys before it fail or cool</span>
                    </div>
                    {chosenModels.length === 0 ? (
                      <p className="tiny dim op-empty">No model added yet.</p>
                    ) : (
                      <ol className="op-list" aria-label="Models in order">
                        {chosenModels.map((model, index) => {
                          const info = modelInfo(model);
                          return (
                            <li key={model} className="op-row">
                              <span className="op-rank">{index + 1}</span>
                              <span className="op-row__main">
                                <span className="op-row__name">{model}</span>
                                <span className="op-row__meta">
                                  {info ? `${info.keyCount} key${info.keyCount === 1 ? "" : "s"} · ${info.pools.join("+")}${info.disabled ? " · switched off" : ""}` : "not configured"}
                                </span>
                              </span>
                              <span className="op-actions">
                                <button type="button" className="btn op-iconbtn" disabled={busy || index === 0}
                                  aria-label={`Move ${model} up`} onClick={() => moveModel(index, -1)}>↑</button>
                                <button type="button" className="btn op-iconbtn" disabled={busy || index === chosenModels.length - 1}
                                  aria-label={`Move ${model} down`} onClick={() => moveModel(index, 1)}>↓</button>
                                <button type="button" className="btn op-iconbtn" disabled={busy}
                                  aria-label={`Remove ${model}`} onClick={() => removeModel(index)}>✕</button>
                              </span>
                            </li>
                          );
                        })}
                      </ol>
                    )}
                  </div>
                </div>
              )}
            </div>

            <div className="op-bar">
              {dirty ? <span className="tiny" style={{ color: "var(--warn)" }}>Unsaved changes</span> : null}
              <span className="grow" />
              {enabled ? (
                <>
                  {dirty ? (
                    <button type="button" className="btn" onClick={() => setDraft(null)} disabled={busy}>Undo changes</button>
                  ) : null}
                  {changedSelection ? (
                    <button type="button" className="btn btn--primary" onClick={saveChanges} disabled={busy}>
                      {busy ? "…" : "Save changes"}
                    </button>
                  ) : null}
                  <button type="button" className="btn" onClick={turnOff} disabled={busy}>
                    {busy ? "…" : "Turn off"}
                  </button>
                </>
              ) : (
                <button type="button" className="btn btn--primary" onClick={turnOn} disabled={busy || !canApply}>
                  {busy ? "…" : "Turn on"}
                </button>
              )}
            </div>
          </div>
        </div>
      </section>

      <section className="section">
        <div className="section__title" style={{ marginBottom: "var(--sp-2)" }}>How it works</div>
        <div className="panel">
          <div className="panel__body">
            <ul className="tiny" style={{ margin: 0, paddingLeft: "var(--sp-4)", display: "grid", gap: "var(--sp-1)" }}>
              <li>Only the chosen provider is called. No other provider is ever tried, even when all of its models fail.</li>
              <li><strong>Models in order:</strong> model 1's keys are tried first. When every key of model 1 has failed or is cooling, model 2 is tried, then model 3, and so on.</li>
              <li><strong>Back to model 1:</strong> every request starts from model 1 again, so a key that is out of its cooldown is used again at once.</li>
              <li><strong>No pacing cooldown by default:</strong> a key that answers is called again for the next request.</li>
              <li><strong>Failed keys cool down:</strong> a key whose call fails (429, 503, timeout, any error) goes into cooldown and is not called again until it ends. The next key or model is used meanwhile.</li>
              <li><strong>Cooldown per key (optional):</strong> set seconds on a key below and, the moment one call is made with it, that key cools for that long — success or failure — then is called again. Keys with no cooldown are never paced.</li>
              <li>If every key of every model has failed or is cooling, the request waits for the first cooldown to end and tries again, and keeps going until a key answers.</li>
              <li>An image request needs a model of this provider with a key in the vision pool; otherwise it fails instead of falling back to another provider.</li>
            </ul>
          </div>
        </div>
      </section>

      <section className="section">
        <div className="section__title" style={{ marginBottom: "var(--sp-2)" }}>
          Keys
          <span className="tiny dim" style={{ marginLeft: "var(--sp-2)", fontWeight: 400 }}>
            {savedProvider ? `${providerLabel(savedProvider)} · ${savedModels.length} model${savedModels.length === 1 ? "" : "s"}` : "Turn on a provider to see its keys"}
          </span>
        </div>
        {canEditKeys ? (
          <div style={{ display: "flex", alignItems: "center", gap: "var(--sp-2)", flexWrap: "wrap", marginBottom: "var(--sp-2)" }}>
            <span className="tiny dim">Same cooldown for every key:</span>
            <input
              type="text"
              inputMode="numeric"
              className="input mono"
              style={{ width: 84, textAlign: "right" }}
              placeholder="none"
              value={allText}
              disabled={busy}
              aria-label="Cooldown in seconds for every key (empty for none)"
              aria-invalid={allMs === undefined || undefined}
              onChange={(event) => setAllText(event.target.value)}
              onKeyDown={(event) => { if (event.key === "Enter") applyToAll(); }}
            />
            <span className="tiny dim">s</span>
            <button type="button" className="btn btn--sm" onClick={applyToAll} disabled={busy || allMs === undefined}>
              Apply to all
            </button>
            <span className="tiny dim">60 = 1 minute · empty = no cooldown</span>
          </div>
        ) : null}
        <div className="panel">
          <DataTable
            columns={columns}
            rows={keys}
            sort={sort}
            onSortChange={setSort}
            rowKey={(row) => `${row.model}::${row.pool}:${row.keyIndex}`}
            caption="Keys of the chosen models and their cooldown"
            emptyState={(
              <EmptyState title="No keys to show" icon="key">
                {savedProvider ? "The chosen models have no configured key." : "No provider is selected yet."}
              </EmptyState>
            )}
          />
        </div>
      </section>
    </div>
  );
}
