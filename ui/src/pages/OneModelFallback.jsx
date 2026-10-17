import { useEffect, useMemo, useState } from "react";
import { getOneModel, setOneModel, keyIdOf } from "../api/oneModel.js";
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
 * One Model Fallback.
 *
 * Serves every request from ONE chosen provider/model and nothing else: no other
 * provider or model is ever used as a fallback. Within that model the keys work
 * like this:
 *
 *   - by default a key has no cooldown and nothing waits: the key that answered
 *     is called again for the next request, and if a call fails the next key is
 *     tried
 *   - a cooldown can be set per key: that key then cools for that long the
 *     moment a call is made with it, whether the call succeeds or fails
 *   - only when every key that is left is cooling does a request wait
 *
 * The switch applies at once on the gateway and changes no saved chain, model
 * switch or health data, so turning it off restores the previous routing.
 */

const idOf = (provider, model) => `${provider}/${model}`;

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
        aria-label={`Cooldown in seconds for key ${keyRow.keyIndex} (empty for none)`}
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

export default function OneModelFallback() {
  const { generation } = useConnection();
  const toast = useToast();
  const state = useApi(getOneModel, { intervalMs: 5_000, deps: [generation] });
  const data = state.data;

  // The model picked in the list but not applied yet. `null` means "whatever the
  // gateway has", so a poll never overwrites what the operator is choosing.
  const [draft, setDraft] = useState(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState(null);
  const [sort, setSort] = useState({ key: "key", direction: "asc" });
  const [allText, setAllText] = useState("");

  // One tick a second so every cooldown counts down between polls.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const candidates = data?.candidates ?? [];
  const savedId = data?.provider && data?.model ? idOf(data.provider, data.model) : "";
  const chosenId = draft ?? savedId;
  const chosen = candidates.find((candidate) => idOf(candidate.provider, candidate.model) === chosenId) ?? null;
  const enabled = data?.enabled === true;
  const changedSelection = enabled && chosenId !== "" && chosenId !== savedId;

  const apply = async (payload, successMessage) => {
    setBusy(true);
    setActionError(null);
    try {
      await setOneModel(payload);
      setDraft(null);
      state.reload();
      toast.success(successMessage);
    } catch (error) {
      setActionError(error);
    } finally {
      setBusy(false);
    }
  };

  const turnOn = () => chosen && apply(
    { enabled: true, provider: chosen.provider, model: chosen.model },
    `One Model Fallback is on: ${chosen.provider} / ${chosen.model}`
  );
  const switchModel = () => chosen && apply(
    { enabled: true, provider: chosen.provider, model: chosen.model },
    `Now using only ${chosen.provider} / ${chosen.model}`
  );
  const turnOff = () => apply({ enabled: false }, "One Model Fallback is off — normal fallback restored");

  // Cooldowns belong to the keys of the model the gateway is using, so they can
  // only be edited for the saved model, not for one that is merely picked.
  const keys = data?.keys ?? [];
  const canEditKeys = chosenId === savedId && savedId !== "" && keys.length > 0;

  const setKeyCooldown = (keyRow, ms) => apply(
    { cooldowns: { [keyIdOf(keyRow)]: ms } },
    ms === null ? `Key #${keyRow.keyIndex}: no cooldown` : `Key #${keyRow.keyIndex}: ${Math.round(ms / 1000)}s cooldown`
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
        <PageHeader title="One Model Fallback" description="Serve every request from one model and nothing else" />
        <div className="panel"><div className="panel__body"><TableSkeleton rows={4} label="Loading One Model Fallback" /></div></div>
      </div>
    );
  }

  return (
    <div className="page">
      <PageHeader
        title="One Model Fallback"
        description="Serve every request from one model and nothing else"
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
                  ? <>Every request uses only <strong>{providerLabel(data.provider)} / <span className="mono">{data.model}</span></strong>. No other provider or model is used as a fallback.</>
                  : "Normal fallback is in use. Turn this on to serve every request from a single model."}
              </span>
            </div>

            {data?.switchedOff ? (
              <p className="tiny" style={{ color: "var(--warn)", marginTop: "var(--sp-2)" }}>
                The selected model is switched off in the Control Panel, so requests fail until it is switched on again.
              </p>
            ) : null}

            <div style={{ display: "flex", alignItems: "flex-end", gap: "var(--sp-3)", flexWrap: "wrap", marginTop: "var(--sp-3)" }}>
              <label style={{ display: "flex", flexDirection: "column", gap: "var(--sp-1)", minWidth: 280 }}>
                <span className="tiny dim">Model to use</span>
                <select
                  className="select"
                  value={chosenId}
                  disabled={busy || candidates.length === 0}
                  onChange={(event) => setDraft(event.target.value)}
                  aria-label="Model to use"
                >
                  <option value="" disabled>Choose a model…</option>
                  {candidates.map((candidate) => (
                    <option key={idOf(candidate.provider, candidate.model)} value={idOf(candidate.provider, candidate.model)}>
                      {providerLabel(candidate.provider)} / {candidate.model} — {candidate.keyCount} key{candidate.keyCount === 1 ? "" : "s"} · {candidate.pools.join("+")}
                      {candidate.disabled ? " (switched off)" : ""}
                    </option>
                  ))}
                </select>
              </label>

              {enabled ? (
                <>
                  {changedSelection ? (
                    <button type="button" className="btn btn--primary" onClick={switchModel} disabled={busy}>
                      {busy ? "…" : "Switch to this model"}
                    </button>
                  ) : null}
                  <button type="button" className="btn" onClick={turnOff} disabled={busy}>
                    {busy ? "…" : "Turn off"}
                  </button>
                </>
              ) : (
                <button type="button" className="btn btn--primary" onClick={turnOn} disabled={busy || !chosen}>
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
              <li>Only the chosen model is called. No other provider or model is ever tried, even when it fails.</li>
              <li><strong>No cooldown by default:</strong> nothing waits. The key that answered is called again for the next request, and if a call fails the next key is tried.</li>
              <li><strong>Cooldown per key (optional):</strong> set seconds on a key below and, the moment one call is made with it, that key cools for that long — success or failure — then is called again. Keys with no cooldown are never paced.</li>
              <li>Only if every key that is left is cooling does a request wait for the first one to be ready (up to {Math.round((data?.maxWaitMs ?? 120_000) / 1000)}s), then it fails with a 503 that says when a key is ready.</li>
              <li>An image request needs this model to have a key in the vision pool; otherwise it fails instead of falling back to another model.</li>
            </ul>
          </div>
        </div>
      </section>

      <section className="section">
        <div className="section__title" style={{ marginBottom: "var(--sp-2)" }}>
          Keys
          <span className="tiny dim" style={{ marginLeft: "var(--sp-2)", fontWeight: 400 }}>
            {chosen ? `${providerLabel(chosen.provider)} / ${chosen.model}` : "Choose a model to see its keys"}
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
            rowKey={(row) => `${row.pool}:${row.keyIndex}`}
            caption="Keys of the selected model and their cooldown"
            emptyState={(
              <EmptyState title="No keys to show" icon="key">
                {savedId ? "The selected model has no configured key." : "No model is selected yet."}
              </EmptyState>
            )}
          />
        </div>
      </section>
    </div>
  );
}
