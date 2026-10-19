import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PageHeader } from "../components/layout/PageHeader.jsx";
import { StatusBadge } from "../components/ui/StatusBadge.jsx";
import { PoolBadge } from "../components/ui/PoolBadge.jsx";
import { EmptyState } from "../components/ui/EmptyState.jsx";
import { ErrorState } from "../components/ui/ErrorState.jsx";
import { Icon } from "../components/ui/Icon.jsx";
import { writeClipboard } from "../components/ui/CopyButton.jsx";
import { Markdown } from "../lib/markdown.jsx";
import { useApi } from "../hooks/useApi.js";
import { useToast } from "../context/ToastContext.jsx";
import { getModels } from "../api/models.js";
import {
  sendPlaygroundRequest, sendCustomRequest, buildRequestBody, buildPinHeaders, parseMaxTokens,
  customProblem, customMaxTokens, PROTOCOL_ENDPOINTS
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
const PROTOCOLS = Object.keys(PROTOCOL_ENDPOINTS);

// Custom-endpoint form values that are worth keeping between visits. The API key
// is deliberately NOT among them: it lives in component state only.
const SAVED_KEY = "apirouter.playground.custom";

function readSaved(field) {
  try {
    const raw = window.localStorage.getItem(SAVED_KEY);
    const value = raw ? JSON.parse(raw)?.[field] : "";
    return typeof value === "string" ? value : "";
  } catch {
    return "";
  }
}

function writeSaved(values) {
  try {
    window.localStorage.setItem(SAVED_KEY, JSON.stringify(values));
  } catch {
    // Private mode or a full quota: the form just starts empty next time.
  }
}

function hostOf(baseUrl) {
  try {
    return new URL(String(baseUrl ?? "").trim()).host;
  } catch {
    return "";
  }
}

const SUGGESTIONS = Object.freeze([
  "Explain how this router picks a provider",
  "Write a haiku about retries and fallbacks",
  "Summarize the pros and cons of streaming APIs",
  "Say hello in five languages"
]);

function MessageAction({ label, icon, onClick, disabled = false }) {
  return (
    <button type="button" className="msg-act" onClick={onClick} disabled={disabled} aria-label={label} title={label}>
      <Icon name={icon} size={14} />
    </button>
  );
}

function CopyAction({ text }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef(null);
  useEffect(() => () => clearTimeout(timer.current), []);
  const copy = async () => {
    if (!(await writeClipboard(text))) return;
    setCopied(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 1500);
  };
  return <MessageAction label={copied ? "Copied" : "Copy reply"} icon={copied ? "check" : "copy"} onClick={copy} />;
}

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
  // gateway's bridges, so the protocol list is fixed rather than derived. A
  // custom endpoint speaks exactly one of them, so it needs the list even when
  // nothing is configured.
  const protocols = PROTOCOLS;

  const [protocol, setProtocol] = useState(() => readSaved("protocol"));
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

  const activeProtocol = protocols.includes(protocol) ? protocol : protocols[0];

  // "Router" sends through the gateway's own routing. "Custom" sends one request
  // to a base URL / key / model typed in here. With nothing configured there is
  // nothing to route, so the page opens on Custom instead of an empty state.
  const [sourcePick, setSourcePick] = useState(null);
  const source = sourcePick ?? (!catalog.loading && models.length === 0 ? "custom" : "gateway");
  const custom = source === "custom";
  const [customBase, setCustomBase] = useState(() => readSaved("baseUrl"));
  const [customModelName, setCustomModelName] = useState(() => readSaved("model"));
  const [customKey, setCustomKey] = useState("");
  const [showKey, setShowKey] = useState(false);

  useEffect(() => {
    writeSaved({ baseUrl: customBase, model: customModelName, protocol: activeProtocol });
  }, [customBase, customModelName, activeProtocol]);

  const customHost = hostOf(customBase);
  const customBlock = custom ? customProblem({ baseUrl: customBase, model: customModelName }) : null;

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
  const sendBlocked = custom ? customBlock !== null : poolMode !== "auto" && poolProblem !== null;

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

  // Landing on Custom endpoint with nothing filled in (including the automatic
  // switch when no provider is configured) opens the settings sheet straight
  // away, so the operator is not left staring at a disabled Send button.
  const autoOpenedRef = useRef(false);
  useEffect(() => {
    if (autoOpenedRef.current || !custom || !customBlock) return;
    autoOpenedRef.current = true;
    setSettingsOpen(true);
  }, [custom, customBlock]);

  // Follow the reply as it streams in, but only while the reader is at the
  // bottom: scrolling up to re-read must not be yanked back down.
  const stickRef = useRef(true);
  const [atBottom, setAtBottom] = useState(true);

  useEffect(() => {
    const el = transcriptRef.current;
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
  }, [messages, meta]);

  const onTranscriptScroll = () => {
    const el = transcriptRef.current;
    if (!el) return;
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    stickRef.current = near;
    setAtBottom(near);
  };

  const jumpToBottom = () => {
    const el = transcriptRef.current;
    if (!el) return;
    stickRef.current = true;
    setAtBottom(true);
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  };

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
    if (!custom && poolMode === "text") {
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
  }, [images.length, poolMode, custom, toast]);

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

  const send = useCallback(async (override) => {
    const text = (override?.text ?? prompt).trim();
    const attached = override?.images ?? images;
    if (!text && attached.length === 0) return;
    if (sendBlocked) return;
    stickRef.current = true;

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
    if (!override) {
      setPrompt("");
      setImages([]);
    }

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const body = buildRequestBody({
        protocol: activeProtocol,
        model: custom ? customModelName.trim() : selectedModel,
        autoRoute: custom ? false : autoRoute,
        prompt: text,
        images: attached,
        system: systemPrompt.trim() || null,
        temperature: Number(temperature),
        maxTokens: custom ? customMaxTokens(activeProtocol, maxTokens) : parseMaxTokens(maxTokens),
        stream: true
      });

      const onDelta = (delta) => {
        setMessages((current) =>
          current.map((message) =>
            message.id === assistantId
              ? { ...message, text: message.text + delta, pending: true }
              : message
          )
        );
      };

      const result = custom
        ? await sendCustomRequest({
          protocol: activeProtocol,
          baseUrl: customBase,
          apiKey: customKey,
          model: customModelName,
          body,
          signal: controller.signal,
          onDelta
        })
        : await sendPlaygroundRequest({
          protocol: activeProtocol,
          // Gemini carries the model in the URL, not the body, so it is passed
          // explicitly; otherwise a pinned or custom model would never be sent.
          model: !autoRoute && selectedModel ? selectedModel : undefined,
          body,
          headers: buildPinHeaders({ autoRoute, provider, keyIndex: pinnedKey, customModel: customId !== "" }),
          signal: controller.signal,
          onDelta
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
        requestedModel: custom ? customModelName.trim() : autoRoute ? null : selectedModel || null,
        pinnedProvider: !custom && !autoRoute && provider ? provider : null,
        pinnedKey: !custom && !autoRoute && provider ? pinnedKey : null,
        autoRouted: !custom && autoRoute,
        pool: custom ? null : effectivePool,
        custom
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
  }, [prompt, images, activeProtocol, selectedModel, customId, provider, pinnedKey, autoRoute, systemPrompt, temperature, maxTokens, sendBlocked, effectivePool, custom, customBase, customKey, customModelName, toast]);

  const cancel = () => abortRef.current?.abort();

  const newChat = () => {
    setMessages([]);
    setMeta(null);
    stickRef.current = true;
    setAtBottom(true);
  };

  // Regenerate re-sends the last prompt and replaces its reply.
  const regenerate = () => {
    if (busy) return;
    const lastUser = [...messages].reverse().find((message) => message.role === "user");
    if (!lastUser) return;
    const cut = messages.lastIndexOf(lastUser);
    setMessages((current) => current.slice(0, cut));
    void send({ text: lastUser.text, images: lastUser.images ?? [] });
  };

  const pickSuggestion = (text) => {
    setPrompt(text);
    promptRef.current?.focus();
  };

  const sourceToggle = (
    <div className="chips chips--segmented chips--source" role="group" aria-label="Where to send the request">
      <button type="button" className={`chip${!custom ? " is-active" : ""}`} aria-pressed={!custom} onClick={() => setSourcePick("gateway")} disabled={busy}>Router</button>
      <button type="button" className={`chip${custom ? " is-active" : ""}`} aria-pressed={custom} onClick={() => { setSourcePick("custom"); if (customProblem({ baseUrl: customBase, model: customModelName })) setSettingsOpen(true); }} disabled={busy}>Custom endpoint</button>
    </div>
  );

  if (!custom && catalog.loading && models.length === 0) {
    return (
      <div className="page">
        <PageHeader title="Playground" description="Send a real request through the gateway router" actions={sourceToggle} />
        <div className="panel"><div className="panel__body"><div className="skeleton skeleton--title" /></div></div>
      </div>
    );
  }

  if (!custom && models.length === 0) {
    return (
      <div className="page">
        <PageHeader title="Playground" description="Send a real request through the gateway router" actions={sourceToggle} />
        <div className="panel">
          <EmptyState title="No routable targets" icon="terminal">
            Configure at least one provider with an API key, models and a base URL before sending
            requests, or switch to Custom endpoint to test any base URL, key and model directly.
          </EmptyState>
        </div>
      </div>
    );
  }

  const routeSummary = custom
    ? `${customHost || "No base URL"} · ${customModelName.trim() || "no model"}`
    : autoRoute
    ? "Auto route"
    : provider
      ? `${providerLabel(provider)}${pinnedKey !== null ? ` · key ${pinnedKey + 1}` : ""} · ${selectedModel}`
      : selectedModel ? `Prefers ${selectedModel}` : "First available target";

  return (
    <div className="page page--playground">
      <PageHeader
        title="Playground"
        description={custom ? "Test any API key, base URL and model" : "Send a real request through the gateway router"}
        lastUpdatedAt={catalog.lastUpdatedAt}
        refreshing={catalog.refreshing}
        actions={
          <>
          {sourceToggle}
          <button
            type="button"
            className="btn"
            onClick={newChat}
            disabled={busy || messages.length === 0}
            aria-label="New chat"
          >
            <Icon name="plus" className="btn__icon" size={12} />
            <span className="btn__label">New chat</span>
          </button>
          </>
        }
      />

      <div className="playground">
        <section className="panel pg-chat" aria-label="Conversation">
          <div className="pg-scroll">
          <div className="pg-transcript" ref={transcriptRef} onScroll={onTranscriptScroll} role="log" aria-live="polite">
            {messages.length === 0 ? (
              <div className="pg-hero">
                <div className="pg-hero__mark"><Icon name="sparkles" size={22} /></div>
                <h2 className="pg-hero__title">What can I help with?</h2>
                <p className="pg-hero__hint">
                  {custom
                    ? "Fill in the base URL, API key and model in Settings, then send a prompt. One request goes straight to that endpoint — no routing, no fallback."
                    : "Write a prompt below and send it. The request travels through the gateway's own router, so health ranking, cooldown and fallback all apply."}
                </p>
                <div className="pg-suggest">
                  {SUGGESTIONS.map((suggestion) => (
                    <button key={suggestion} type="button" className="pg-suggest__btn" onClick={() => pickSuggestion(suggestion)}>
                      {suggestion}
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              <div className="transcript">
                {messages.map((message, index) => {
                  const isLast = index === messages.length - 1;

                  if (message.role === "user") {
                    return (
                      <article key={message.id} className="msg msg--user">
                        {message.images?.length ? (
                          <div className="msg__images">
                            {message.images.map((image) => (
                              <img key={image.id} className="msg__image" src={image.dataUrl} alt={image.name} />
                            ))}
                          </div>
                        ) : null}
                        {message.text ? <div className="msg__body">{message.text}</div> : null}
                      </article>
                    );
                  }

                  return (
                    <article key={message.id} className={`msg msg--assistant${message.error ? " msg--error" : ""}`}>
                      <div className="msg__avatar" aria-hidden="true"><Icon name="sparkles" size={14} /></div>
                      <div className="msg__content">
                        {message.text ? (
                          <Markdown
                            text={message.text}
                            trailing={message.pending ? <span className="stream-cursor" aria-label="streaming" /> : null}
                          />
                        ) : message.pending ? (
                          <span className="typing" role="status" aria-label="Thinking"><i /><i /><i /></span>
                        ) : !message.error ? (
                          <span className="dim">Provider returned an empty response.</span>
                        ) : null}
                        {message.error ? <ErrorState error={message.error} compact /> : null}
                        {!message.pending && !message.error && message.text ? (
                          <div className="msg__actions">
                            <CopyAction text={message.text} />
                            {isLast ? <MessageAction label="Regenerate" icon="refresh" onClick={regenerate} disabled={busy} /> : null}
                          </div>
                        ) : null}
                      </div>
                    </article>
                  );
                })}

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
            )}
          </div>
          {!atBottom && messages.length > 0 ? (
            <button type="button" className="pg-jump" onClick={jumpToBottom} aria-label="Jump to latest message">
              <Icon name="arrowDown" size={16} />
            </button>
          ) : null}
          </div>

          <div className="pg-composer" onDrop={onDrop} onDragOver={(event) => event.preventDefault()}>
            <div className="pg-composer__inner">
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
            {custom && customBlock ? (
              <span className="tiny" style={{ color: "var(--warn)" }}>{customBlock}</span>
            ) : null}
            {!custom && poolMode !== "auto" && poolProblem ? (
              <span className="tiny" style={{ color: "var(--warn)" }}>{poolProblem}</span>
            ) : null}
            {!custom && hasImages && autoRoute && poolMode === "auto" ? (
              <span className="tiny dim">
                Image attached: Auto Route only uses the vision providers ({'<PROVIDER>_VISION_*'} settings).
              </span>
            ) : null}

            <div className="pg-box">
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
                className="pg-circle"
                onClick={() => fileInputRef.current?.click()}
                disabled={busy || (!custom && poolMode === "text") || images.length >= MAX_IMAGES}
                aria-label={`Attach image (up to ${MAX_IMAGES})`}
                title={`Attach up to ${MAX_IMAGES} images`}
              >
                <Icon name="plus" size={18} />
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
                <button type="button" className="pg-circle pg-circle--send" onClick={cancel} aria-label="Cancel request">
                  <Icon name="stop" size={14} />
                </button>
              ) : (
                <button
                  type="button"
                  className="pg-circle pg-circle--send"
                  onClick={() => void send()}
                  disabled={sendBlocked || (prompt.trim().length === 0 && !hasImages)}
                  aria-label="Send"
                >
                  <Icon name="arrowUp" size={18} />
                </button>
              )}
            </div>

            <div className="pg-route">
              {custom ? <StatusBadge tone="info" dot={false}>Custom</StatusBadge> : <PoolBadge pool={effectivePool} />}
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
          <div className="panel__header"><span className="panel__title">{custom ? "Custom endpoint" : "Routing"}</span></div>
          <div className="panel__body">
            <div className="stack">
              {custom ? (
                <>
                  <div className="field">
                    <label className="field__label" htmlFor="pg-c-base">Base URL</label>
                    <input
                      id="pg-c-base"
                      className="input mono"
                      type="url"
                      inputMode="url"
                      value={customBase}
                      placeholder="https://api.openai.com/v1"
                      autoCapitalize="off"
                      autoCorrect="off"
                      spellCheck={false}
                      onChange={(event) => setCustomBase(event.target.value)}
                    />
                    <span className="field__hint">
                      The platform&apos;s API root. The endpoint path (/chat/completions, /messages …) is added for you.
                    </span>
                  </div>

                  <div className="field">
                    <label className="field__label" htmlFor="pg-c-key">API key</label>
                    <div className="row" style={{ gap: "var(--sp-2)" }}>
                      <input
                        id="pg-c-key"
                        className="input mono grow"
                        type={showKey ? "text" : "password"}
                        value={customKey}
                        placeholder="sk-… (leave blank for a local model)"
                        autoComplete="new-password"
                        autoCapitalize="off"
                        autoCorrect="off"
                        spellCheck={false}
                        onChange={(event) => setCustomKey(event.target.value)}
                      />
                      <button
                        type="button"
                        className="btn btn--sm"
                        aria-pressed={showKey}
                        onClick={() => setShowKey((current) => !current)}
                      >
                        {showKey ? "Hide" : "Show"}
                      </button>
                    </div>
                    <span className="field__hint">
                      A test sends it once to your gateway for that call and never saves or logs it. To keep an endpoint, add it on the Custom Endpoints page.
                    </span>
                  </div>

                  <div className="field">
                    <label className="field__label" htmlFor="pg-c-model">Model</label>
                    <input
                      id="pg-c-model"
                      className="input mono"
                      type="text"
                      value={customModelName}
                      placeholder="gpt-4o-mini"
                      autoCapitalize="off"
                      autoCorrect="off"
                      spellCheck={false}
                      onChange={(event) => setCustomModelName(event.target.value)}
                    />
                  </div>

                  <div className="field">
                    <label className="field__label" htmlFor="pg-c-protocol">API style</label>
                    <select
                      id="pg-c-protocol"
                      className="select"
                      value={activeProtocol}
                      onChange={(event) => setProtocol(event.target.value)}
                    >
                      {protocols.map((value) => <option key={value} value={value}>{protocolLabel(value)}</option>)}
                    </select>
                    <span className="field__hint">
                      OpenAI Chat fits most platforms (OpenAI, OpenRouter, Groq, Together, DeepSeek, Ollama …).
                    </span>
                  </div>

                </>
              ) : (
              <>
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
              </>
              )}

              <details className="pg-advanced">
                <summary>{custom ? "Advanced: temperature, max tokens, system prompt" : "Advanced: protocol, temperature, system prompt"}</summary>
                <div className="stack">
              {custom ? null : (
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
              )}

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
                    placeholder={custom && activeProtocol === "anthropic" ? "1024" : "No limit"}
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
                  {meta.custom ? null : (
                    <>
                      <dt className="dl__term">Pool</dt>
                      <dd className="dl__desc">{meta.pool ? <PoolBadge pool={meta.pool} /> : <span className="dim">{EMPTY}</span>}</dd>
                    </>
                  )}

                  <dt className="dl__term">{meta.custom ? "Endpoint" : "Selected provider"}</dt>
                  <dd className="dl__desc">
                    {meta.custom
                      ? <span className="mono">{meta.upstreamHost ?? customHost ?? EMPTY}</span>
                      : meta.provider ? providerLabel(meta.provider) : <span className="dim">{EMPTY}</span>}
                  </dd>

                  <dt className="dl__term">Selected model</dt>
                  <dd className="dl__desc mono">{meta.model ?? EMPTY}</dd>

                  {meta.custom ? null : (
                    <>
                      <dt className="dl__term">Key index</dt>
                      <dd className="dl__desc mono">{Number.isInteger(meta.keyIndex) ? meta.keyIndex : EMPTY}</dd>

                      <dt className="dl__term">Request ID</dt>
                      <dd className="dl__desc mono tiny">{meta.sessionId ?? EMPTY}</dd>
                    </>
                  )}

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
                    {meta.custom
                      ? "custom endpoint — sent directly, no routing or fallback"
                      : meta.autoRouted
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
              {custom ? "The call is made by your gateway, not the browser, and is not added to the request log. " : ""}
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
