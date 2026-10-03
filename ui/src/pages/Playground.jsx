import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PageHeader } from "../components/layout/PageHeader.jsx";
import { StatusBadge } from "../components/ui/StatusBadge.jsx";
import { PoolBadge } from "../components/ui/PoolBadge.jsx";
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
import { MAX_IMAGES, ACCEPTED_IMAGE_TYPES, imageProblem, readImageFile } from "../lib/images.js";

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
const POOL_MODES = Object.freeze([
  { key: "auto", label: "Auto" },
  { key: "text", label: "Text" },
  { key: "vision", label: "Vision" }
]);

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
  const [poolMode, setPoolMode] = useState("auto");
  const [providerPick, setProvider] = useState("");
  const [model, setModel] = useState("");
  const [customModel, setCustomModel] = useState("");
  const [keyIndex, setKeyIndex] = useState("");
  const [autoRoute, setAutoRoute] = useState(true);
  const [temperature, setTemperature] = useState(0.7);
  const [maxTokens, setMaxTokens] = useState("");
  const [systemPrompt, setSystemPrompt] = useState("");
  const [prompt, setPrompt] = useState("");
  const [images, setImages] = useState([]);
  const fileInputRef = useRef(null);

  const activeProtocol = protocol || protocols[0] || "";

  const hasImages = images.length > 0;

  // The gateway chooses the pool from the request itself: a body carrying an
  // image goes to the vision pool, anything else to the text pool. "Auto"
  // mirrors that; Text and Vision make the operator's intent explicit, and the
  // provider / model / key lists below only ever offer that pool's targets.
  const effectivePool = poolMode === "auto" ? (hasImages ? "vision" : "text") : poolMode;

  const poolCounts = useMemo(() => {
    const counts = { text: 0, vision: 0 };
    for (const entry of models) counts[entry.pool === "vision" ? "vision" : "text"] += 1;
    return counts;
  }, [models]);

  const poolModels = useMemo(
    () => models.filter((entry) => (entry.pool === "vision" ? "vision" : "text") === effectivePool),
    [models, effectivePool]
  );

  const providerOptions = useMemo(
    () => [...new Set(poolModels.map((entry) => entry.provider))].sort(),
    [poolModels]
  );

  // A provider picked for one pool may not exist in the other; fall back to
  // "any" instead of pinning a provider the active pool cannot reach.
  const provider = providerOptions.includes(providerPick) ? providerPick : "";

  const modelOptions = useMemo(() => {
    const scoped = provider ? poolModels.filter((entry) => entry.provider === provider) : poolModels;
    return [...new Set(scoped.map((entry) => entry.model))].sort();
  }, [poolModels, provider]);

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
    for (const entry of poolModels) {
      if (entry.provider !== provider) continue;
      if (selectedModel && !customId && entry.model !== selectedModel) continue;
      if (!Number.isInteger(entry.keyIndex) || byIndex.has(entry.keyIndex)) continue;
      byIndex.set(entry.keyIndex, entry.status);
    }
    return [...byIndex.entries()].sort((a, b) => a[0] - b[0]).map(([index, status]) => ({ index, status }));
  }, [poolModels, provider, selectedModel, customId]);

  const pinnedKey = keyIndex !== "" && keyOptions.some((option) => option.index === Number(keyIndex))
    ? Number(keyIndex)
    : null;

  // Explicit pool choices must be honoured, and the gateway routes by image
  // presence — so a request that would land in the other pool is blocked here
  // rather than silently sent there.
  const poolProblem =
    poolMode === "text" && hasImages
      ? "Remove the attached image to use the Text pool, or switch to Auto or Vision."
      : poolMode === "vision" && !hasImages
        ? "Attach an image to use the Vision pool — the gateway sends only image requests there."
        : poolCounts[effectivePool] === 0
          ? `No ${effectivePool} targets are configured${effectivePool === "vision" ? "; image requests will fail with 503" : ""}.`
          : null;
  const sendBlocked = poolMode !== "auto" && poolProblem !== null;

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

  // Phone layout: the request settings live in a bottom sheet. On a wide
  // screen the same markup is a fixed side rail and this flag does nothing.
  const [settingsOpen, setSettingsOpen] = useState(false);
  const transcriptRef = useRef(null);
  const promptRef = useRef(null);

  // Keep the newest message in view as the response streams in.
  useEffect(() => {
    const el = transcriptRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, meta]);

  // The prompt box grows with its content, up to a cap, instead of showing a
  // fixed three-row block that eats the phone screen.
  useEffect(() => {
    const el = promptRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [prompt]);

  useEffect(() => {
    if (!settingsOpen) return undefined;
    const onKey = (event) => { if (event.key === "Escape") setSettingsOpen(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [settingsOpen]);

  const addImages = useCallback(async (fileList) => {
    if (poolMode === "text") {
      toast.error("Image not attached", { detail: "The Text pool takes no images. Switch to Auto or Vision." });
      return;
    }
    const files = Array.from(fileList ?? []);
    let count = images.length;
    const added = [];
    for (const file of files) {
      const problem = imageProblem(file, count);
      if (problem) {
        toast.error("Image not attached", { detail: problem });
        continue;
      }
      try {
        added.push(await readImageFile(file));
        count += 1;
      } catch (error) {
        toast.error("Image not attached", { detail: error?.message });
      }
    }
    if (added.length > 0) setImages((current) => [...current, ...added].slice(0, MAX_IMAGES));
  }, [images.length, poolMode, toast]);

  const removeImage = (id) => setImages((current) => current.filter((image) => image.id !== id));

  const onPaste = (event) => {
    const files = Array.from(event.clipboardData?.files ?? []).filter((file) => file.type.startsWith("image/"));
    if (files.length === 0) return;
    event.preventDefault();
    void addImages(files);
  };

  const onDrop = (event) => {
    const files = Array.from(event.dataTransfer?.files ?? []).filter((file) => file.type.startsWith("image/"));
    if (files.length === 0) return;
    event.preventDefault();
    void addImages(files);
  };

  const send = useCallback(async () => {
    const text = prompt.trim();
    if (!text && images.length === 0) return;
    if (sendBlocked) return;
    const attached = images;

    const startedAt = Date.now();
    setBusy(true);
    setMeta(null);

    const userMessage = { id: `u-${Date.now()}`, role: "user", text, images: attached };
    const assistantId = `a-${Date.now()}`;
    setMessages((current) => [
      ...current,
      userMessage,
      { id: assistantId, role: "assistant", text: "", pending: true }
    ]);
    setPrompt("");
    setImages([]);

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const body = buildRequestBody({
        protocol: activeProtocol,
        model: selectedModel,
        autoRoute,
        prompt: text,
        images: attached,
        system: systemPrompt.trim() || null,
        temperature: Number(temperature),
        maxTokens: parseMaxTokens(maxTokens),
        stream: true
      });

      const result = await sendPlaygroundRequest({
        protocol: activeProtocol,
        // Gemini carries the model in the URL, not the body, so it is passed
        // explicitly; otherwise a pinned or custom model would never be sent.
        model: !autoRoute && selectedModel ? selectedModel : undefined,
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
        autoRouted: autoRoute,
        pool: effectivePool
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
  }, [prompt, images, activeProtocol, selectedModel, customId, provider, pinnedKey, autoRoute, systemPrompt, temperature, maxTokens, sendBlocked, effectivePool, toast]);

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

  const routeSummary = autoRoute
    ? "Auto route"
    : provider
      ? `${providerLabel(provider)}${pinnedKey !== null ? ` · key ${pinnedKey + 1}` : ""} · ${selectedModel}`
      : selectedModel ? `Prefers ${selectedModel}` : "First available target";

  return (
    <div className="page page--playground">
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
            aria-label="Clear transcript"
          >
            <Icon name="trash" className="btn__icon" size={12} />
            <span className="btn__label">Clear transcript</span>
          </button>
        }
      />

      <div className="playground">
        <section className="panel pg-chat" aria-label="Conversation">
          <div className="pg-transcript" ref={transcriptRef} role="log" aria-live="polite">
            {messages.length === 0 ? (
              <EmptyState title="Nothing sent yet" icon="terminal">
                Write a prompt below and send it. The request travels through the gateway&apos;s own
                router, so health ranking, cooldown and fallback all apply.
              </EmptyState>
            ) : (
              <div className="transcript">
                {messages.map((message) => (
                  <article
                    key={message.id}
                    className={`msg msg--${message.role}${message.error ? " msg--error" : ""}`}
                  >
                    {message.images?.length ? (
                      <div className="msg__images">
                        {message.images.map((image) => (
                          <img key={image.id} className="msg__image" src={image.dataUrl} alt={image.name} />
                        ))}
                      </div>
                    ) : null}
                    {message.text || message.pending || (!message.error && !message.images?.length) ? (
                      <div className="msg__body">
                        {message.text}
                        {message.pending ? <span className="stream-cursor" aria-label="streaming" /> : null}
                        {!message.text && !message.pending && !message.error && !message.images?.length ? (
                          <span className="dim">Provider returned an empty response.</span>
                        ) : null}
                      </div>
                    ) : null}
                    {message.error ? <ErrorState error={message.error} compact /> : null}
                  </article>
                ))}
              </div>
            )}

            {meta && !busy ? (
              <div className="pg-meta">
                {meta.error ? (
                  <StatusBadge tone="danger" dot={false}>{meta.error.label ?? "Request failed"}</StatusBadge>
                ) : (
                  <>
                    {meta.pool ? <PoolBadge pool={meta.pool} /> : null}
                    <span className="mono pg-meta__target">
                      {meta.provider ? providerLabel(meta.provider) : EMPTY} · {meta.model ?? EMPTY}
                    </span>
                    {meta.status ? (
                      <StatusBadge tone={meta.status < 400 ? "ok" : "danger"} dot={false}>{meta.status}</StatusBadge>
                    ) : null}
                    <span>{formatLatency(meta.latencyMs)}</span>
                    {Number.isFinite(meta.tokens) ? <span>{formatTokens(meta.tokens)}</span> : null}
                  </>
                )}
              </div>
            ) : null}
          </div>

          <div className="pg-composer" onDrop={onDrop} onDragOver={(event) => event.preventDefault()}>
            {hasImages ? (
              <div className="attachments">
                {images.map((image) => (
                  <div key={image.id} className="attachment">
                    <img className="attachment__thumb" src={image.dataUrl} alt={image.name} />
                    <button
                      type="button"
                      className="attachment__remove"
                      aria-label={`Remove ${image.name}`}
                      onClick={() => removeImage(image.id)}
                      disabled={busy}
                    >×</button>
                  </div>
                ))}
              </div>
            ) : null}
            {poolMode !== "auto" && poolProblem ? (
              <span className="tiny" style={{ color: "var(--warn)" }}>{poolProblem}</span>
            ) : null}
            {hasImages && autoRoute && poolMode === "auto" ? (
              <span className="tiny dim">
                Image attached: Auto Route only uses the vision providers ({'<PROVIDER>_VISION_*'} settings).
              </span>
            ) : null}

            <div className="pg-route">
              <PoolBadge pool={effectivePool} />
              <span className="pg-route__text" title={routeSummary}>{routeSummary}</span>
              <button
                type="button"
                className="btn btn--ghost btn--sm pg-route__edit"
                onClick={() => setSettingsOpen(true)}
                aria-haspopup="dialog"
              >
                <Icon name="sliders" className="btn__icon" size={12} />
                Settings
              </button>
            </div>

            <div className="pg-input">
              <input
                ref={fileInputRef}
                type="file"
                accept={ACCEPTED_IMAGE_TYPES.join(",")}
                multiple
                hidden
                onChange={(event) => {
                  void addImages(event.target.files);
                  event.target.value = "";
                }}
              />
              <button
                type="button"
                className="btn pg-icon-btn"
                onClick={() => fileInputRef.current?.click()}
                disabled={busy || poolMode === "text" || images.length >= MAX_IMAGES}
                aria-label={`Attach image (up to ${MAX_IMAGES})`}
                title={`Attach up to ${MAX_IMAGES} images`}
              >
                <Icon name="image" size={16} />
              </button>
              <label className="sr-only" htmlFor="pg-prompt">Prompt</label>
              <textarea
                id="pg-prompt"
                ref={promptRef}
                className="textarea"
                rows={1}
                placeholder="Ask something…"
                value={prompt}
                onChange={(event) => setPrompt(event.target.value)}
                onPaste={onPaste}
                onKeyDown={(event) => {
                  if (event.key !== "Enter") return;
                  // Enter sends; Shift+Enter keeps its newline. Ctrl/Cmd+Enter
                  // still sends too. An Enter that confirms an IME candidate
                  // (Bengali, Japanese, ...) is composition, not a send.
                  if (event.nativeEvent?.isComposing || event.keyCode === 229) return;
                  if (event.shiftKey && !(event.ctrlKey || event.metaKey)) return;
                  event.preventDefault();
                  if (!busy) void send();
                }}
              />
              {busy ? (
                <button type="button" className="btn btn--danger pg-icon-btn" onClick={cancel} aria-label="Cancel request">
                  <Icon name="stop" size={14} />
                </button>
              ) : (
                <button
                  type="button"
                  className="btn btn--primary pg-icon-btn"
                  onClick={send}
                  disabled={sendBlocked || (prompt.trim().length === 0 && !hasImages)}
                  aria-label="Send"
                >
                  <Icon name="play" size={14} />
                </button>
              )}
            </div>
          </div>
        </section>

        <aside className="pg-rail" data-open={settingsOpen} aria-label="Request settings">
          <button type="button" className="pg-rail__scrim" aria-label="Close settings" onClick={() => setSettingsOpen(false)} />
          <div className="pg-rail__sheet">
            <div className="pg-rail__head">
              <span className="panel__title">Request settings</span>
              <button type="button" className="btn btn--sm" onClick={() => setSettingsOpen(false)}>Done</button>
            </div>
            <div className="panel pg-settings">
          <div className="panel__header"><span className="panel__title">Routing</span></div>
          <div className="panel__body">
            <div className="stack">
              <label className="checkbox">
                <input type="checkbox" checked={autoRoute} onChange={(event) => toggleAutoRoute(event.target.checked)} />
                Auto Route — let the gateway pick the target
              </label>

              <div className="field">
                <span className="field__label" id="pg-pool-label">Pool</span>
                <div className="chips chips--segmented" role="group" aria-labelledby="pg-pool-label">
                  {POOL_MODES.map((mode) => (
                    <button
                      key={mode.key}
                      type="button"
                      className={`chip${poolMode === mode.key ? " is-active" : ""}${mode.key === "vision" ? " chip--vision" : mode.key === "text" ? " chip--text" : ""}`}
                      aria-pressed={poolMode === mode.key}
                      onClick={() => setPoolMode(mode.key)}
                      disabled={busy}
                    >
                      {mode.label}{mode.key === "auto" ? "" : ` · ${poolCounts[mode.key]}`}
                    </button>
                  ))}
                </div>
                <span className="field__hint">
                  {poolMode === "auto"
                    ? `Auto — images go to the vision pool, everything else to text. Now: ${effectivePool}.`
                    : poolMode === "text"
                      ? "Text pool only. Image attachments are off."
                      : "Vision pool only. Attach an image to send."}
                </span>
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
                  placeholder="Custom model id (optional)"
                  autoCapitalize="off"
                  autoCorrect="off"
                  spellCheck={false}
                  aria-label="Custom model id"
                  onChange={(event) => {
                    const value = event.target.value;
                    // A custom id can only be called through one provider's own
                    // credentials, so typing one with no provider picks the first.
                    if (value.trim() && !provider && providerOptions.length > 0) setProvider(providerOptions[0]);
                    setCustomModel(value);
                    setKeyIndex("");
                    if (value.trim()) setAutoRoute(false);
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

              <details className="pg-advanced">
                <summary>Advanced: protocol, temperature, system prompt</summary>
                <div className="stack">
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
              </details>
            </div>
          </div>
        </div>

          <div className="panel">
            <div className="panel__header">
              <span className="panel__title">Last request</span>
            </div>
            <div className="panel__body">
              {!meta ? (
                <span className="dim small">Metadata appears here after the first request.</span>
              ) : (
                <dl className="dl dl--tight">
                  <dt className="dl__term">Pool</dt>
                  <dd className="dl__desc">{meta.pool ? <PoolBadge pool={meta.pool} /> : <span className="dim">{EMPTY}</span>}</dd>

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
        </aside>
      </div>
    </div>
  );
}
