/**
 * Provider-reported token usage, normalised to `{ inputTokens, outputTokens }`.
 *
 * Only what the provider itself reports is ever returned; nothing is estimated
 * or reconstructed. Understands the usage shapes of every protocol the gateway
 * speaks: OpenAI chat (`prompt_tokens` / `completion_tokens`), OpenAI Responses
 * and Anthropic (`input_tokens` / `output_tokens`, where Anthropic's cache
 * read/creation tokens are part of the prompt and are added to the input) and
 * Gemini (`usageMetadata`).
 */

const isCount = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0;
const count = (value) => (isCount(value) ? Math.round(value) : null);

function fromUsageObject(u) {
  if (!u || typeof u !== "object") return null;
  let input = null;
  let output = null;

  if (isCount(u.prompt_tokens) || isCount(u.completion_tokens)) {
    input = count(u.prompt_tokens);
    output = count(u.completion_tokens);
  } else if (isCount(u.input_tokens) || isCount(u.output_tokens)) {
    input = count(u.input_tokens);
    output = count(u.output_tokens);
    const cache = (count(u.cache_creation_input_tokens) ?? 0) + (count(u.cache_read_input_tokens) ?? 0);
    if (input !== null && cache > 0) input += cache;
  } else if (isCount(u.promptTokenCount) || isCount(u.candidatesTokenCount) || isCount(u.totalTokenCount)) {
    input = count(u.promptTokenCount);
    const total = count(u.totalTokenCount);
    // total - prompt also covers a thinking model's reasoning tokens.
    output = input !== null && total !== null && total >= input ? total - input : count(u.candidatesTokenCount);
  } else if (isCount(u.inputTokens) || isCount(u.outputTokens)) {
    input = count(u.inputTokens);
    output = count(u.outputTokens);
  }

  if (input === null && output === null) return null;
  return { inputTokens: input, outputTokens: output };
}

const larger = (a, b) => (a === null ? b : b === null ? a : Math.max(a, b));

/** Usage reported more than once (a stream) is cumulative, so the largest figure wins. */
export function mergeUsage(a, b) {
  if (!a) return b ?? null;
  if (!b) return a;
  return { inputTokens: larger(a.inputTokens, b.inputTokens), outputTokens: larger(a.outputTokens, b.outputTokens) };
}

/** Usage from a whole response body or one stream event, wherever the protocol puts it. */
export function usageFrom(body) {
  if (!body || typeof body !== "object") return null;
  let found = null;
  for (const candidate of [body.usage, body.usageMetadata, body.response?.usage, body.response?.usageMetadata, body.message?.usage]) {
    found = mergeUsage(found, fromUsageObject(candidate));
  }
  return found;
}

/** Input + output, or null when the provider reported neither. */
export function totalOf(usage) {
  if (!usage || (usage.inputTokens === null && usage.outputTokens === null)) return null;
  return (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
}

const MAX_PENDING_LINE = 1 << 20;

/**
 * Watches an SSE stream for usage without touching it. Feed it the raw bytes
 * (`pushChunk`) or already-split `data:` payloads (`pushData`); read `usage`
 * once the stream has ended. A malformed event is ignored.
 */
export function createUsageTap() {
  let usage = null;
  let carry = "";
  const decoder = new TextDecoder();

  const pushData = (data) => {
    if (typeof data !== "string" || !data.includes("usage")) return;
    try { usage = mergeUsage(usage, usageFrom(JSON.parse(data))); } catch { /* not JSON, or no usage */ }
  };

  const pushChunk = (chunk) => {
    carry += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
    let newline;
    while ((newline = carry.indexOf("\n")) !== -1) {
      const line = carry.slice(0, newline).replace(/\r$/, "");
      carry = carry.slice(newline + 1);
      if (line.startsWith("data:")) pushData(line.slice(5).trim());
    }
    if (carry.length > MAX_PENDING_LINE) carry = "";
  };

  return { pushData, pushChunk, get usage() { return usage; } };
}

/** Pass every byte chunk through unchanged while the tap watches it. */
export async function* tapBytes(source, tap) {
  for await (const chunk of source) {
    try { tap.pushChunk(chunk); } catch { /* observability only */ }
    yield chunk;
  }
}

/** Pass every SSE `data:` payload through unchanged while the tap watches it. */
export async function* tapEvents(source, tap) {
  for await (const data of source) {
    try { tap.pushData(data); } catch { /* observability only */ }
    yield data;
  }
}
