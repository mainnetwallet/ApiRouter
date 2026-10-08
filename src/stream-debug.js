/**
 * Stream lifecycle diagnostics (MULTIAI_DEBUG_INGRESS=1 only).
 *
 * Purpose: when a client (e.g. Codex) sits on "Working..." the log has to say
 * whether the PROVIDER went quiet or whether the provider kept sending bytes
 * that the router never turned into a client-visible event. The two look
 * identical from the client, and the idle timeout cannot tell them apart
 * because it counts upstream bytes.
 *
 * Disabled, every method returns its input untouched, so there is no behaviour
 * change and no cost. Enabled, nothing is ever buffered or altered: bytes and
 * events pass through as-is. Secrets are redacted and values truncated before
 * anything is logged.
 */

const REDACTIONS = [
  [/gh[pousr]_[A-Za-z0-9]{16,}/g, "gh***"],
  [/github_pat_[A-Za-z0-9_]{16,}/g, "gh***"],
  [/\bsk-[A-Za-z0-9_-]{12,}/g, "sk-***"],
  [/AIza[0-9A-Za-z_-]{20,}/g, "AIza***"],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer ***"],
  [/:\/\/[^/\s:@"']+:[^/\s@"']+@/g, "://***@"],
  [/:\/\/[A-Za-z0-9_.~-]{16,}@/g, "://***@"],
  [/((?:api[_-]?key|token|secret|password|authorization)["']?\s*[:=]\s*["']?)[^\s"',}&]+/gi, "$1***"]
];

/** Redacts well-known credential shapes and truncates. Never throws. */
export function redactForLog(value, max = 200) {
  let text;
  try { text = typeof value === "string" ? value : JSON.stringify(value); } catch { text = String(value); }
  text = String(text ?? "");
  for (const [pattern, replacement] of REDACTIONS) text = text.replace(pattern, replacement);
  text = text.replace(/\s+/g, " ");
  return text.length > max ? text.slice(0, max) + `...(+${text.length - max})` : text;
}

const QUIET_AFTER_MS = 10_000;

/**
 * @param {object} options
 * @param {boolean} options.enabled
 * @param {(line: string) => void} options.log
 * @param {{provider?: string, model?: string}} [options.target]
 * @param {number|string|null} [options.status]   upstream HTTP status
 * @param {string} [options.protocol]             upstream protocol
 * @param {number} [options.quietMs]              silence threshold for [STREAM_QUIET]
 */
export function createStreamDebug({ enabled, log, target = {}, status = null, protocol = "", quietMs = QUIET_AFTER_MS } = {}) {
  if (!enabled) {
    const same = (source) => source;
    return { upstream: same, client: same, passthrough: same, end() {} };
  }

  const startedAt = Date.now();
  const since = () => `+${Date.now() - startedAt}ms`;
  const tag = `provider=${target.provider ?? "-"} model=${target.model ?? "-"} protocol=${protocol || "-"}`;
  const stats = {
    upstreamChunks: 0, upstreamBytes: 0, firstUpstreamAt: null, lastUpstreamAt: null,
    clientEvents: 0, firstClientEventAt: null, lastClientEventAt: null,
    terminal: null, textDeltas: 0, argDeltas: 0
  };
  let watchdog = null;
  let sseBuffer = "";

  log(`[STREAM_OPEN] ${tag} upstream_status=${status ?? "-"}`);

  const startWatchdog = () => {
    if (watchdog) return;
    watchdog = setInterval(() => {
      const now = Date.now();
      const sinceClient = now - (stats.lastClientEventAt ?? startedAt);
      if (sinceClient < quietMs) return;
      const sinceUpstream = stats.lastUpstreamAt === null ? "never" : `${now - stats.lastUpstreamAt}ms`;
      log(`[STREAM_QUIET] ${tag} no_client_event_for=${sinceClient}ms last_upstream_byte_ago=${sinceUpstream} upstream_chunks=${stats.upstreamChunks} upstream_bytes=${stats.upstreamBytes} client_events=${stats.clientEvents}`);
    }, quietMs);
    watchdog.unref?.();
  };

  const noteUpstream = (chunk) => {
    const now = Date.now();
    stats.upstreamChunks += 1;
    stats.upstreamBytes += chunk?.byteLength ?? chunk?.length ?? 0;
    stats.lastUpstreamAt = now;
    if (stats.firstUpstreamAt === null) {
      stats.firstUpstreamAt = now;
      log(`[STREAM_UPSTREAM_FIRST_BYTE] ${tag} ${since()}`);
    }
  };

  const describe = (type, data) => {
    const item = data?.item;
    switch (type) {
      case "response.output_item.added":
      case "response.output_item.done": {
        const parts = [`output_index=${data.output_index}`, `item=${item?.type ?? "?"}`];
        if (item?.call_id) parts.push(`call_id=${item.call_id}`);
        if (item?.name) parts.push(`name=${item.name}`);
        if (type.endsWith(".done") && item?.arguments !== undefined) parts.push(`arguments=${redactForLog(item.arguments)}`);
        if (type.endsWith(".done") && item?.input !== undefined) parts.push(`input=${redactForLog(item.input)}`);
        return parts.join(" ");
      }
      case "response.function_call_arguments.done":
        return `output_index=${data.output_index} arguments=${redactForLog(data.arguments)}`;
      case "response.created":
      case "response.in_progress":
      case "response.completed":
      case "response.incomplete":
      case "response.failed": {
        const r = data?.response || {};
        const parts = [`status=${r.status ?? "-"}`];
        if (Array.isArray(r.output)) parts.push(`output_items=${r.output.length}`);
        if (r.error) parts.push(`error=${redactForLog(r.error.message ?? r.error)}`);
        if (r.incomplete_details) parts.push(`incomplete=${redactForLog(r.incomplete_details)}`);
        return parts.join(" ");
      }
      default:
        return "";
    }
  };

  const LIFECYCLE = new Set([
    "response.created", "response.in_progress", "response.output_item.added", "response.output_item.done",
    "response.function_call_arguments.done", "response.completed", "response.incomplete", "response.failed", "error"
  ]);

  const noteClientEvent = (type, data) => {
    const now = Date.now();
    stats.clientEvents += 1;
    stats.lastClientEventAt = now;
    if (stats.firstClientEventAt === null) {
      stats.firstClientEventAt = now;
      log(`[STREAM_FIRST_CLIENT_EVENT] ${tag} type=${type} ${since()}`);
    }
    if (type === "response.output_text.delta") {
      stats.textDeltas += 1;
      if (stats.textDeltas === 1) log(`[STREAM_EVENT] type=${type} (first of text; later deltas counted) ${since()}`);
      return;
    }
    if (type === "response.function_call_arguments.delta") { stats.argDeltas += 1; return; }
    if (LIFECYCLE.has(type)) {
      log(`[STREAM_EVENT] type=${type} ${describe(type, data)} ${since()}`.replace(/\s+/g, " "));
    }
    if (type === "response.completed" || type === "response.incomplete" || type === "response.failed") stats.terminal = type;
  };

  /** Feeds raw SSE text, extracts `event:`/`data:` pairs, never throws. */
  const feedSse = (text) => {
    sseBuffer += text;
    let idx;
    while ((idx = sseBuffer.search(/\r?\n\r?\n/)) !== -1) {
      const raw = sseBuffer.slice(0, idx);
      sseBuffer = sseBuffer.slice(idx).replace(/^\r?\n\r?\n/, "");
      try {
        const type = /^event:\s*(.+)$/m.exec(raw)?.[1]?.trim();
        const dataLine = /^data:\s*(.*)$/m.exec(raw)?.[1];
        let data = null;
        try { data = dataLine ? JSON.parse(dataLine) : null; } catch { /* non-JSON data */ }
        const kind = type || data?.type;
        if (kind) noteClientEvent(kind, data);
      } catch { /* diagnostics must never break the stream */ }
    }
  };

  return {
    /** Wraps the upstream byte stream (before SSE parsing). */
    upstream(source) {
      startWatchdog();
      return (async function* tapUpstream() {
        for await (const chunk of source) {
          try { noteUpstream(chunk); } catch { /* diagnostics only */ }
          yield chunk;
        }
      })();
    },
    /** Wraps the client-bound SSE strings produced by a bridge. */
    client(source) {
      startWatchdog();
      return (async function* tapClient() {
        for await (const piece of source) {
          try { feedSse(typeof piece === "string" ? piece : Buffer.from(piece).toString("utf8")); } catch { /* diagnostics only */ }
          yield piece;
        }
      })();
    },
    /** Native pass-through: the same bytes are both upstream and client. */
    passthrough(source) {
      startWatchdog();
      return (async function* tapPassthrough() {
        const decoder = new TextDecoder();
        for await (const chunk of source) {
          try { noteUpstream(chunk); feedSse(decoder.decode(chunk, { stream: true })); } catch { /* diagnostics only */ }
          yield chunk;
        }
      })();
    },
    /** Terminal line. `outcome` is the router's own verdict for the stream. */
    end(outcome, error = null) {
      if (watchdog) { clearInterval(watchdog); watchdog = null; }
      const now = Date.now();
      const lastUp = stats.lastUpstreamAt === null ? "never" : `${now - stats.lastUpstreamAt}ms`;
      const why = error ? ` error=${redactForLog(error?.code || error?.name || "")}:${redactForLog(error?.message ?? error, 160)}` : "";
      log(`[STREAM_END] ${tag} outcome=${outcome} client_terminal=${stats.terminal ?? "NONE"} duration=${now - startedAt}ms upstream_chunks=${stats.upstreamChunks} upstream_bytes=${stats.upstreamBytes} client_events=${stats.clientEvents} text_deltas=${stats.textDeltas} arg_deltas=${stats.argDeltas} last_upstream_byte_ago=${lastUp}${why}`);
    }
  };
}
