import { useCallback, useMemo, useRef, useState } from "react";
import { PageHeader } from "../components/layout/PageHeader.jsx";
import { StatusBadge } from "../components/ui/StatusBadge.jsx";
import { EmptyState } from "../components/ui/EmptyState.jsx";
import { ErrorState } from "../components/ui/ErrorState.jsx";
import { Icon } from "../components/ui/Icon.jsx";
import { useApi } from "../hooks/useApi.js";
import { useToast } from "../context/ToastContext.jsx";
import { getModels } from "../api/models.js";
import {
  sendPlaygroundRequest, buildRequestBody, buildPinHeaders, parseMaxTokens, PROTOCOL_ENDPOINTS
} from "../api/playground.js";
import { formatLatency, formatTokens, protocolLabel, providerLabel, EMPTY } from "../lib/format.js";
import { sanitizeText } from "../lib/sanitize.js";

/**
 * Playground.
 *
 * Requests go to the gateway's public proxy endpoints, never to a provider
 * directly. With Auto Route on, the `model` field is omitted entirely, which is
 * what makes the gateway widen to every compatible target and choose — so the
 * router is never bypassed, and the playground exercises the same code path a
 * real client does, including cooldown and fallback.
 *
 * Choosing a provider, model or key switches Auto Route off and pins the
 * request: the provider (and key, when picked) travel as pin headers and the
 * gateway calls exactly that target. A model with no provider is still routed
 * by the gateway, which prefers that model and may fall back. The response
 * headers report which target actually answered.
 *
 * Every protocol can reach every configured model — the gateway translates —
 * so the lists are not narrowed by protocol.
 */
export default function Playground() {
  const catalog = useApi(getModels, { intervalMs: 30_000 });
  const toast = useToast();

  const models = catalog.data?.models ?? [];

  // Every configured target is reachable from every client protocol through the
  // gateway's bridges, so the protocol list is fixed rather than derived.
  const protocols = useMemo(
    () => (models.length > 0 ? Object.keys(PROTOCOL_ENDPOINTS) : []),
    [models.length]
  );

  const [protocol, setProtocol] = useState("");
  const [provider, setProvider] = useState("");
  const [model, setModel] = useState("");
  const [customModel, setCustomModel] = useState("");
  const [keyIndex, setKeyIndex] = useState("");
  const [autoRoute, setAutoRoute] = useState(true);
  const [temperature, setTemperature] = useState(0.7);
  const [maxTokens, setMaxTokens] = useState("");
  const [systemPrompt, setSystemPrompt] = useState("");
  const [prompt, setPrompt] = useState("");

  const activeProtocol = protocol || protocols[0] || "";

  const providerOptions = useMemo(
    () => [...new Set(models.map((entry) => entry.provider))].sort(),
    [models]
  );

  const modelOptions = useMemo(() => {
    const scoped = provider ? models.filter((entry) => entry.provider === provider) : models;
    return [...new Set(scoped.map((entry) => entry.model))].sort();
  }, [models, provider]);

  // With a provider chosen the model is always concrete: the first of that
  // provider's models until the operator picks another.
  // A hand-typed model id wins over the dropdown. It needs a provider, because a
  // custom id can only be called through a pinned provider's own credentials.
  const customId = provider ? customModel.trim() : "";

  const selectedModel = customId || (model && modelOptions.includes(model)
    ? model
    : provider ? modelOptions[0] ?? "" : "");

  // Keys of the chosen provider that serve the chosen model, with their health.
  const keyOptions = useMemo(() => {
    if (!provider) return [];
    const byIndex = new Map();
    for (const entry of models) {
      if (entry.provider !== provider) continue;
      if (selectedModel && !customId && entry.model !== selectedModel) continue;
      if (!Number.isInteger(entry.keyIndex) || byIndex.has(entry.keyIndex)) continue;
      byIndex.set(entry.keyIndex, entry.status);
    }
    return [...byIndex.entries()].sort((a, b) => a[0] - b[0]).map(([index, status]) => ({ index, status }));
  }, [models, provider, selectedModel, customId]);

  const pinnedKey = keyIndex !== "" && keyOptions.some((option) => option.index === Number(keyIndex))
    ? Number(keyIndex)
    : null;

  const pickProvider = (value) => {
    setProvider(value);
    setModel("");
    setCustomModel("");
    setKeyIndex("");
    if (value) setAutoRoute(false);
  };

  const pickModel = (value) => {
    setModel(value);
    setCustomModel("");
    setKeyIndex("");
    if (value) setAutoRoute(false);
  };

  const pickKey = (value) => {
    setKeyIndex(value);
    if (value !== "") setAutoRoute(false);
  };

  const toggleAutoRoute = (checked) => {
    setAutoRoute(checked);
    if (checked) {
      setProvider("");
      setModel("");
      setCustomModel("");
      setKeyIndex("");
    }
  };

  const [messages, setMessages] = useState([]);
  const [busy, setBusy] = useState(false);
  const [meta, setMeta] = useState(null);
  const abortRef = useRef(null);

  const send = useCallback(async () => {
    const text = prompt.trim();
    if (!text) return;

    const startedAt = Date.now();
    setBusy(true);
    setMeta(null);

    const userMessage = { id: `u-${Date.now()}`, role: "user", text };
    const assistantId = `a-${Date.now()}`;
    setMessages((current) => [
      ...current,
      userMessage,
      { id: assistantId, role: "assistant", text: "", pending: true }
    ]);
    setPrompt("");

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const body = buildRequestBody({
        protocol: activeProtocol,
        model: selectedModel,
        autoRoute,
        prompt: text,
        system: systemPrompt.trim() || null,
        temperature: Number(temperature),
        maxTokens: parseMaxTokens(maxTokens),
        stream: true
      });

      const result = await sendPlaygroundRequest({
        protocol: activeProtocol,
        body,
        headers: buildPinHeaders({ autoRoute, provider, keyIndex: pinnedKey, customModel: customId !== "" }),
        signal: controller.signal,
        onDelta: (delta) => {
          setMessages((current) =>
            current.map((message) =>
              message.id === assistantId
                ? { ...message, text: message.text + delta, pending: true }
                : message
            )
          );
        }
      });

      setMessages((current) =>
        current.map((message) =>
          message.id === assistantId
            ? { ...message, text: result.text || message.text, pending: false }
            : message
        )
      );

      setMeta({
        ...result.routed,
        latencyMs: Date.now() - startedAt,
        tokens: result.tokens ?? null,
        finishReason: result.finishReason ?? null,
        requestedModel: autoRoute ? null : selectedModel || null,
        pinnedProvider: !autoRoute && provider ? provider : null,
        pinnedKey: !autoRoute && provider ? pinnedKey : null,
        autoRouted: autoRoute
      });
    } catch (error) {
      const cancelled = error?.kind === "abort";

      setMessages((current) =>
        current.map((message) =>
          message.id === assistantId
            ? { ...message, pending: false, error: cancelled ? null : error, text: message.text }
            : message
        )
      );

      if (!cancelled) {
        toast.error(error?.label ?? "Request failed", { detail: error?.hint ?? error?.message });
        setMeta((current) => ({ ...(current ?? {}), error: { label: error?.label, hint: error?.hint, message: error?.message, status: error?.status } }));
      }
    } finally {
      setBusy(false);
      abortRef.current = null;
    }
  }, [prompt, activeProtocol, selectedModel, customId, provider, pinnedKey, autoRoute, systemPrompt, temperature, maxTokens, toast]);

  const cancel = () => abortRef.current?.abort();

  if (catalog.loading && models.length === 0) {
    return (
      <div className="page">
        <PageHeader title="Playground" description="Send a real request through the gateway router" />
        <div className="panel"><div className="panel__body"><div className="skeleton skeleton--title" /></div></div>
      </div>
    );
  }

  if (protocols.length === 0) {
    return (
      <div className="page">
        <PageHeader title="Playground" description="Send a real request through the gateway router" />
        <div className="panel">
          <EmptyState title="No routable targets" icon="terminal">
            Configure at least one provider with an API key, models and a base URL before sending
            requests.
          </EmptyState>
        </div>
      </div>
    );
  }

  return (
    <div className="page">
      <PageHeader
        title="Playground"
        description="Send a real request through the gateway router"
        lastUpdatedAt={catalog.lastUpdatedAt}
        refreshing={catalog.refreshing}
        actions={
          <button
            type="button"
            className="btn"
            onClick={() => { setMessages([]); setMeta(null); }}
            disabled={busy || messages.length === 0}
          >
            <Icon name="trash" className="btn__icon" size={12} />
            Clear transcript
          </button>
        }
      />

      <div className="playground">
        <div className="panel">
          <div className="panel__header">
            <span className="panel__title">Request</span>
          </div>
          <div className="panel__body">
            <div className="stack">
              <label className="checkbox">
                <input type="checkbox" checked={autoRoute} onChange={(event) => toggleAutoRoute(event.target.checked)} />
                Auto Route — let the gateway pick the target
              </label>

              <div className="field">
                <label className="field__label" htmlFor="pg-protocol">Protocol</label>
                <select
                  id="pg-protocol"
                  className="select"
                  value={activeProtocol}
                  onChange={(event) => setProtocol(event.target.value)}
                >
                  {protocols.map((value) => <option key={value} value={value}>{protocolLabel(value)}</option>)}
                </select>
              </div>

              <div className="field">
                <label className="field__label" htmlFor="pg-provider">Provider</label>
                <select
                  id="pg-provider"
                  className="select"
                  value={provider}
                  onChange={(event) => pickProvider(event.target.value)}
                >
                  <option value="">Any provider</option>
                  {providerOptions.map((value) => <option key={value} value={value}>{providerLabel(value)}</option>)}
                </select>
                <span className="field__hint">
                  {provider
                    ? `Only ${providerLabel(provider)} is called — no fallback to other providers.`
                    : "Pick a provider to call it directly."}
                </span>
              </div>

              <div className="field">
                <label className="field__label" htmlFor="pg-model">Model</label>
                <select
                  id="pg-model"
                  className="select"
                  value={customId ? "" : selectedModel}
                  onChange={(event) => pickModel(event.target.value)}
                >
                  {customId ? <option value="">Custom model in use</option> : null}
                  {provider ? null : <option value="">First available</option>}
                  {modelOptions.map((value) => <option key={value} value={value}>{value}</option>)}
                </select>
                <input
                  id="pg-custom-model"
                  className="input mono"
                  type="text"
                  value={customModel}
                  disabled={!provider}
                  placeholder={provider ? "Custom model id (optional)" : "Pick a provider to use a custom model"}
                  autoCapitalize="off"
                  autoCorrect="off"
                  spellCheck={false}
                  aria-label="Custom model id"
                  onChange={(event) => {
                    setCustomModel(event.target.value);
                    setKeyIndex("");
                    if (event.target.value.trim()) setAutoRoute(false);
                  }}
                  style={{ marginTop: "var(--sp-2)" }}
                />
                <span className="field__hint">
                  {customId
                    ? `Trying "${customId}" on ${providerLabel(provider)} with its own key and base URL. Clear the box to use the list.`
                    : provider
                    ? `Models served by ${providerLabel(provider)}. Or type any new model id above to try it.`
                    : autoRoute
                      ? "Auto Route is on — no model is sent. Pick one to switch it off."
                      : "The gateway prefers this model on any provider and may fall back."}
                </span>
              </div>

              {provider && keyOptions.length > 1 ? (
                <div className="field">
                  <label className="field__label" htmlFor="pg-key">API key</label>
                  <select
                    id="pg-key"
                    className="select"
                    value={pinnedKey ?? ""}
                    onChange={(event) => pickKey(event.target.value)}
                  >
                    <option value="">Any key (gateway picks)</option>
                    {keyOptions.map((option) => (
                      <option key={option.index} value={option.index}>
                        {`Key ${option.index + 1}${option.status ? ` — ${option.status}` : ""}`}
                      </option>
                    ))}
                  </select>
                  <span className="field__hint">
                    {pinnedKey === null
                      ? `${providerLabel(provider)} keys are tried in health order.`
                      : `Only key ${pinnedKey + 1} is used, even if it is cooling down.`}
                  </span>
                </div>
              ) : null}

              <div className="row" style={{ gap: "var(--sp-3)" }}>
                <div className="field grow">
                  <label className="field__label" htmlFor="pg-temperature">
                    Temperature <span className="mono">{Number(temperature).toFixed(2)}</span>
                  </label>
                  <input
                    id="pg-temperature"
                    type="range"
                    min="0"
                    max="2"
                    step="0.05"
                    value={temperature}
                    onChange={(event) => setTemperature(event.target.value)}
                  />
                </div>

                <div className="field" style={{ width: 110 }}>
                  <label className="field__label" htmlFor="pg-max-tokens">Max tokens</label>
                  <input
                    id="pg-max-tokens"
                    className="input mono"
                    type="number"
                    min="1"
                    placeholder="No limit"
                    value={maxTokens}
                    onChange={(event) => setMaxTokens(event.target.value)}
                  />
                </div>
              </div>

              <div className="field">
                <label className="field__label" htmlFor="pg-system">System prompt</label>
                <textarea
                  id="pg-system"
                  className="textarea"
                  rows={3}
                  placeholder="Optional system instruction…"
                  value={systemPrompt}
                  onChange={(event) => setSystemPrompt(event.target.value)}
                />
              </div>
            </div>
          </div>
        </div>

        <div className="stack">
          <div className="panel">
            <div className="panel__header">
              <span className="panel__title">Transcript</span>
              {busy ? (
                <div className="panel__actions">
                  <span className="row tiny dim" style={{ gap: 6 }}>
                    <span className="spinner" aria-hidden="true" /> streaming
                  </span>
                </div>
              ) : null}
            </div>

            <div className="panel__body">
              {messages.length === 0 ? (
                <EmptyState title="Nothing sent yet" icon="terminal">
                  Write a prompt below and send it. The request travels through the gateway's own
                  router, so health ranking, cooldown and fallback all apply.
                </EmptyState>
              ) : (
                <div className="transcript">
                  {messages.map((message) => (
                    <article
                      key={message.id}
                      className={`msg msg--${message.role}${message.error ? " msg--error" : ""}`}
                    >
                      <header className="msg__head">
                        <Icon name={message.role === "user" ? "arrowRight" : "zap"} size={11} />
                        {message.role === "user" ? "Prompt" : "Response"}
                        {message.error ? <span style={{ marginLeft: "auto", color: "var(--danger)" }}>{message.error.label}</span> : null}
                      </header>
                      <div className="msg__body">
                        {message.text}
                        {message.pending ? <span className="stream-cursor" aria-label="streaming" /> : null}
                        {!message.text && !message.pending && !message.error ? (
                          <span className="dim">Provider returned an empty response.</span>
                        ) : null}
                      </div>
                      {message.error ? (
                        <div style={{ padding: "0 var(--sp-3) var(--sp-3)" }}>
                          <ErrorState error={message.error} compact />
                        </div>
                      ) : null}
                    </article>
                  ))}
                </div>
              )}
            </div>

            <div className="panel__footer">
              <div className="composer grow">
                <label className="sr-only" htmlFor="pg-prompt">Prompt</label>
                <textarea
                  id="pg-prompt"
                  className="textarea"
                  rows={3}
                  placeholder="Ask something…  (Ctrl+Enter to send)"
                  value={prompt}
                  onChange={(event) => setPrompt(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
                      event.preventDefault();
                      void send();
                    }
                  }}
                />
                <div className="row">
                  <button
                    type="button"
                    className="btn btn--primary"
                    onClick={send}
                    disabled={busy || prompt.trim().length === 0}
                  >
                    <Icon name="play" className="btn__icon" size={12} />
                    Send
                  </button>
                  {busy ? (
                    <button type="button" className="btn btn--danger" onClick={cancel}>
                      <Icon name="stop" className="btn__icon" size={12} />
                      Cancel
                    </button>
                  ) : null}
                  <span className="tiny dim grow right">
                    {autoRoute
                      ? "auto route"
                      : provider
                        ? `pinned: ${providerLabel(provider)}${pinnedKey !== null ? ` · key ${pinnedKey + 1}` : ""} · ${selectedModel}`
                        : selectedModel ? `prefers: ${selectedModel}` : "first available target"}
                  </span>
                </div>
              </div>
            </div>
          </div>

          <div className="panel">
            <div className="panel__header">
              <span className="panel__title">Result metadata</span>
            </div>
            <div className="panel__body">
              {!meta ? (
                <span className="dim small">Metadata appears here after the first request.</span>
              ) : (
                <dl className="dl dl--tight">
                  <dt className="dl__term">Selected provider</dt>
                  <dd className="dl__desc">
                    {meta.provider ? providerLabel(meta.provider) : <span className="dim">{EMPTY}</span>}
                  </dd>

                  <dt className="dl__term">Selected model</dt>
                  <dd className="dl__desc mono">{meta.model ?? EMPTY}</dd>

                  <dt className="dl__term">Key index</dt>
                  <dd className="dl__desc mono">{Number.isInteger(meta.keyIndex) ? meta.keyIndex : EMPTY}</dd>

                  <dt className="dl__term">Request ID</dt>
                  <dd className="dl__desc mono tiny">{meta.sessionId ?? EMPTY}</dd>

                  <dt className="dl__term">HTTP status</dt>
                  <dd className="dl__desc">
                    {meta.status
                      ? <StatusBadge tone={meta.status < 400 ? "ok" : "danger"} dot={false}>{meta.status}</StatusBadge>
                      : EMPTY}
                  </dd>

                  <dt className="dl__term">Latency</dt>
                  <dd className="dl__desc">{formatLatency(meta.latencyMs)}</dd>

                  <dt className="dl__term">Token usage</dt>
                  <dd className="dl__desc">
                    {Number.isFinite(meta.tokens)
                      ? formatTokens(meta.tokens)
                      : <span className="dim" title="The provider's response did not report usage">not reported by provider</span>}
                  </dd>

                  <dt className="dl__term">Finish reason</dt>
                  <dd className="dl__desc">
                    {meta.finishReason ?? <span className="dim" title="The provider's response did not report a finish reason">not reported by provider</span>}
                  </dd>

                  <dt className="dl__term">Routing</dt>
                  <dd className="dl__desc">
                    {meta.autoRouted
                      ? "auto — the gateway selected the target"
                      : meta.pinnedProvider
                        ? `pinned to ${providerLabel(meta.pinnedProvider)}${Number.isInteger(meta.pinnedKey) ? ` · key ${meta.pinnedKey + 1}` : ""} · ${meta.requestedModel ?? EMPTY}`
                        : `prefers ${meta.requestedModel ?? "first available"} — the gateway chose the provider`}
                  </dd>

                  {meta.error ? (
                    <>
                      <dt className="dl__term">Error</dt>
                      <dd className="dl__desc">
                        <ErrorState
                          error={{ label: meta.error.label, hint: meta.error.hint, message: meta.error.message }}
                          compact
                        />
                      </dd>
                    </>
                  ) : null}
                </dl>
              )}
            </div>
          </div>

          <div className="notice">
            <span>
              Responses stream when the selected protocol supports it. Token usage and finish reason
              are shown only when the provider reports them — the gateway does not estimate.
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
