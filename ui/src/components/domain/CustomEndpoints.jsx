import { useState } from "react";
import { useApi } from "../../hooks/useApi.js";
import { useToast } from "../../context/ToastContext.jsx";
import { useConnection } from "../../context/ConnectionContext.jsx";
import { ConfirmDialog } from "../ui/ConfirmDialog.jsx";
import { ErrorState } from "../ui/ErrorState.jsx";
import {
  listCustomEndpoints, createCustomEndpoint, updateCustomEndpoint, deleteCustomEndpoint, splitList
} from "../../api/customEndpoints.js";
import { protocolLabel } from "../../lib/format.js";
import { EMPTY_FORM, formFromEndpoint, formProblem, createBody, updateBody } from "../../lib/customEndpointForm.js";

const PROTOCOLS = ["openai-chat", "openai-responses", "anthropic", "gemini"];

/**
 * Custom endpoints the operator keeps permanently. Each one is a provider in
 * the Fallback Chain with its own base URL, one API style, ANY number of models
 * (comma separated or one per line) and ANY number of keys (same). Keys are only ever sent
 * to the gateway; the list shows how many each endpoint has, never the keys.
 */
export function CustomEndpoints({ onChanged, showHeading = true }) {
  const toast = useToast();
  const { generation } = useConnection();
  const { data, error, loading, reload } = useApi(listCustomEndpoints, { deps: [generation] });
  const endpoints = data?.endpoints ?? [];
  const storage = data?.storage ?? null;

  // `editing` is null (closed), "new", or the id of the endpoint being edited.
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [pendingDelete, setPendingDelete] = useState(null);
  const set = (patch) => setForm((current) => ({ ...current, ...patch }));

  const open = (endpoint) => {
    setEditing(endpoint ? endpoint.id : "new");
    setForm(formFromEndpoint(endpoint));
  };
  const close = () => { setEditing(null); setForm(EMPTY_FORM); };
  const changed = () => { reload(); onChanged?.(); };

  const current = editing && editing !== "new" ? endpoints.find((endpoint) => endpoint.id === editing) : null;
  const models = splitList(form.models);
  const keys = splitList(form.keys);
  const problem = formProblem(form, editing === "new");

  const save = async () => {
    if (problem || saving) return;
    setSaving(true);
    try {
      if (editing === "new") {
        await createCustomEndpoint(createBody(form));
        toast.success("Custom endpoint saved", { detail: "It is now a provider in the fallback chain." });
      } else {
        await updateCustomEndpoint(editing, updateBody(form));
        toast.success("Custom endpoint updated");
      }
      close();
      changed();
    } catch (failure) {
      toast.error(failure?.message || "Could not save the endpoint");
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    await deleteCustomEndpoint(pendingDelete.id);
    toast.success("Custom endpoint removed");
    changed();
  };

  return (
    <section className="section" id="custom-endpoints">
      {showHeading ? (
        <div className="section__title" style={{ marginBottom: "var(--sp-2)" }}>
          Custom endpoints
          <span className="tiny dim" style={{ marginLeft: "var(--sp-2)", fontWeight: 400 }}>
            Your own base URL, saved permanently. Works in the fallback chain like any other provider.
          </span>
        </div>
      ) : null}

      {error ? <ErrorState error={error} onRetry={reload} compact /> : null}

      {storage ? (
        <div className="tiny" role="status" style={{ marginBottom: "var(--sp-2)", color: storage.mode === "file" || !storage.ready ? "var(--warn)" : "var(--text-dim)" }}>
          {storage.mode === "file"
            ? "Saved on this server's disk only. On a host that wipes its disk on redeploy (free Render) these endpoints are lost; set CUSTOM_ENDPOINTS_GITHUB_REPO to keep them (see README)."
            : storage.ready
              ? "Saved encrypted in GitHub, so a redeploy keeps them."
              : `GitHub storage is not reachable${storage.error ? ` (${storage.error})` : ""}. Saved endpoints load as soon as it is, and changes are refused until then.`}
        </div>
      ) : null}

      <div className="panel">
        <div className="panel__body">
          <div className="stack">
            {loading ? <span className="dim tiny">Loading…</span> : null}
            {!loading && endpoints.length === 0 && editing !== "new" ? (
              <span className="dim tiny">
                No custom endpoints yet. Add one here. To try an endpoint first without saving it, use the Playground.
              </span>
            ) : null}

            {endpoints.map((endpoint) => (
              <div key={endpoint.id} className="row" style={{ gap: "var(--sp-3)", alignItems: "flex-start", flexWrap: "wrap" }}>
                <div className="grow" style={{ minWidth: 220 }}>
                  <div><strong>{endpoint.name}</strong> <span className="tiny dim mono">{endpoint.id}</span></div>
                  <div className="tiny mono dim" style={{ overflowWrap: "anywhere" }}>{endpoint.baseUrl}</div>
                  <div className="tiny dim">
                    {protocolLabel(endpoint.protocol)} · {endpoint.models.length} model{endpoint.models.length === 1 ? "" : "s"} · {endpoint.keyCount} key{endpoint.keyCount === 1 ? "" : "s"}
                  </div>
                  {endpoint.models.length > 0 ? (
                    <div className="tiny mono" style={{ overflowWrap: "anywhere" }}>{endpoint.models.join(", ")}</div>
                  ) : null}
                </div>
                <div className="row" style={{ gap: "var(--sp-2)" }}>
                  <button type="button" className="btn btn--sm" onClick={() => open(endpoint)} disabled={saving}>Edit</button>
                  <button type="button" className="btn btn--sm btn--ghost" onClick={() => setPendingDelete(endpoint)} disabled={saving}>Remove</button>
                </div>
              </div>
            ))}

            {editing ? (
              <div className="stack" style={{ borderTop: endpoints.length ? "1px solid var(--border)" : "none", paddingTop: endpoints.length ? "var(--sp-3)" : 0 }}>
                <strong>{editing === "new" ? "Add custom endpoint" : `Edit ${current?.name ?? editing}`}</strong>

                <div className="field">
                  <label className="field__label" htmlFor="ce-name">Name</label>
                  <input id="ce-name" className="input" type="text" value={form.name} placeholder="My gateway" onChange={(event) => set({ name: event.target.value })} />
                </div>

                <div className="field">
                  <label className="field__label" htmlFor="ce-base">Base URL</label>
                  <input
                    id="ce-base" className="input mono" type="url" inputMode="url" value={form.baseUrl}
                    placeholder="https://api.example.com/v1" autoCapitalize="off" autoCorrect="off" spellCheck={false}
                    onChange={(event) => set({ baseUrl: event.target.value })}
                  />
                  <span className="field__hint">The API root. The endpoint path is added for you.</span>
                </div>

                <div className="field">
                  <label className="field__label" htmlFor="ce-protocol">API style</label>
                  <select id="ce-protocol" className="select" value={form.protocol} onChange={(event) => set({ protocol: event.target.value })}>
                    {PROTOCOLS.map((value) => <option key={value} value={value}>{protocolLabel(value)}</option>)}
                  </select>
                </div>

                <div className="field">
                  <label className="field__label" htmlFor="ce-models">Text models</label>
                  <textarea
                    id="ce-models" className="textarea mono" rows={4} value={form.models}
                    placeholder={"model-a, model-b"} autoCapitalize="off" autoCorrect="off" spellCheck={false}
                    onChange={(event) => set({ models: event.target.value })}
                  />
                  <span className="field__hint">Separate with commas or put one per line. {models.length} entered.</span>
                </div>

                <div className="field">
                  <label className="field__label" htmlFor="ce-keys">{editing === "new" ? "API keys" : "Add API keys"}</label>
                  <textarea
                    id="ce-keys" className="textarea mono" rows={3} value={form.keys}
                    placeholder={"sk-key1, sk-key2"} autoComplete="off" autoCapitalize="off" autoCorrect="off" spellCheck={false}
                    onChange={(event) => set({ keys: event.target.value })}
                  />
                  <span className="field__hint">
                    Separate with commas (sk-key1,sk-key2) or put one per line. {keys.length} entered. Every key is tried like any provider&apos;s keys. For a local model with no key, enter any placeholder such as &quot;none&quot;.
                    {editing !== "new" ? ` The ${current?.keyCount ?? 0} saved key(s) are kept and never shown.` : ""}
                  </span>
                  {editing !== "new" ? (
                    <label className="checkbox">
                      <input type="checkbox" checked={form.replaceKeys} onChange={(event) => set({ replaceKeys: event.target.checked })} />
                      Replace all saved keys with the ones above
                    </label>
                  ) : null}
                </div>

                <div className="row" style={{ gap: "var(--sp-2)", alignItems: "center", flexWrap: "wrap" }}>
                  <button type="button" className="btn btn--primary" onClick={save} disabled={Boolean(problem) || saving}>
                    {saving ? "Saving…" : editing === "new" ? "Save endpoint" : "Save changes"}
                  </button>
                  <button type="button" className="btn" onClick={close} disabled={saving}>Cancel</button>
                  {problem ? <span className="tiny" style={{ color: "var(--warn)" }}>{problem}</span> : null}
                </div>
              </div>
            ) : (
              <div>
                <button type="button" className="btn" onClick={() => open(null)}>Add custom endpoint</button>
              </div>
            )}
          </div>
        </div>
      </div>

      <ConfirmDialog
        open={Boolean(pendingDelete)}
        onClose={() => setPendingDelete(null)}
        onConfirm={remove}
        destructive
        title="Remove custom endpoint"
        confirmLabel="Remove"
        body={<>Remove <strong>{pendingDelete?.name}</strong>? Its models and keys leave routing and the fallback chain at once.</>}
      />
    </section>
  );
}
