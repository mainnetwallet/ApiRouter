/** Display formatting. Every function tolerates null — the UI shows an
 *  explicit placeholder rather than "NaN" or a misleading zero. */

export const EMPTY = "—";

const isNum = (value) => typeof value === "number" && Number.isFinite(value);

export function formatNumber(value) {
  if (!isNum(value)) return EMPTY;
  return new Intl.NumberFormat(undefined).format(value);
}

export function formatPercent(value, digits = 1) {
  if (!isNum(value)) return EMPTY;
  return `${(value * 100).toFixed(digits)}%`;
}

/** Latency in milliseconds, switching to seconds when that reads better. */
export function formatLatency(ms) {
  if (!isNum(ms)) return EMPTY;
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(2)} s`;
  return `${(ms / 60_000).toFixed(1)} min`;
}

/** A duration expressed in the largest sensible unit. */
export function formatDuration(ms) {
  if (!isNum(ms)) return EMPTY;
  if (ms < 1000) return `${Math.round(ms)} ms`;

  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;

  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}

/** Countdown to a future timestamp; `null` when already elapsed. */
export function formatCountdown(targetMs, now = Date.now()) {
  if (!isNum(targetMs)) return null;
  const remaining = targetMs - now;
  if (remaining <= 0) return null;
  return formatDuration(remaining);
}

export function formatDateTime(value) {
  const ms = toMs(value);
  if (ms === null) return EMPTY;
  return new Date(ms).toLocaleString(undefined, {
    year: "numeric", month: "short", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit"
  });
}

export function formatTime(value) {
  const ms = toMs(value);
  if (ms === null) return EMPTY;
  return new Date(ms).toLocaleTimeString(undefined, {
    hour: "2-digit", minute: "2-digit", second: "2-digit"
  });
}

export function formatRelativeTime(value, now = Date.now()) {
  const ms = toMs(value);
  if (ms === null) return EMPTY;

  const delta = now - ms;
  if (delta < 0) return `in ${formatDuration(-delta)}`;
  if (delta < 1000) return "just now";
  if (delta < 60_000) return `${Math.floor(delta / 1000)}s ago`;
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m ago`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}h ago`;
  return `${Math.floor(delta / 86_400_000)}d ago`;
}

export function formatBytes(value) {
  if (!isNum(value)) return EMPTY;
  if (value < 1024) return `${value} B`;
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 ** 2).toFixed(1)} MB`;
}

/** Compact token counts, so a table column stays narrow. */
export function formatTokens(value) {
  if (!isNum(value)) return "not reported";
  if (value < 1000) return String(value);
  if (value < 1_000_000) return `${(value / 1000).toFixed(1)}k`;
  return `${(value / 1_000_000).toFixed(2)}M`;
}

/** Accepts an ISO string or epoch millis. */
export function toMs(value) {
  if (value === null || value === undefined || value === "") return null;
  if (isNum(value)) return value;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function truncate(value, max = 60) {
  const text = String(value ?? "");
  return text.length > max ? text.slice(0, max - 1) + "…" : text;
}

/** Human name for a protocol identifier straight from the backend. */
export function protocolLabel(protocol) {
  switch (protocol) {
    case "anthropic": return "Anthropic Messages";
    case "openai-chat": return "OpenAI Chat";
    case "openai-responses": return "OpenAI Responses";
    case "gemini": return "Gemini generateContent";
    default: return protocol ?? EMPTY;
  }
}

export function providerLabel(provider) {
  if (!provider) return EMPTY;
  const special = { zai: "Z.ai", huggingface: "Hugging Face", vercel: "Vercel AI Gateway", opencode: "OpenCode Zen" };
  return special[provider] ?? provider.charAt(0).toUpperCase() + provider.slice(1);
}
