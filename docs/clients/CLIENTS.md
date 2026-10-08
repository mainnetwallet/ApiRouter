# Client Integrations

ApiRouter provides one gateway for different AI client protocols.

| Client | Endpoint | Protocol |
|---|---|---|
| Claude Code | `/v1/messages` | Anthropic Messages |
| Codex | `/v1/responses` | OpenAI Responses |
| OpenCode | `/v1/chat/completions` | OpenAI-compatible |
| Qwen Code | `/v1/chat/completions` | OpenAI-compatible |
| OpenAI SDKs | `/v1/chat/completions` | OpenAI-compatible |
| Gemini clients | `/v1beta/models/{model}:generateContent`, `:streamGenerateContent` | Gemini generateContent |

A client protocol and a provider protocol are separate things. A provider that
speaks a client's protocol natively is called directly; one that does not is
still reachable if a translation bridge exists for that direction.

| Client protocol | Chat-only provider | Gemini provider | AgentRouter |
|---|---|---|---|
| Anthropic Messages (`/v1/messages`) | bridged | bridged | native |
| OpenAI Responses (`/v1/responses`) | bridged | bridged | native |
| OpenAI Chat Completions (`/v1/chat/completions`) | native | bridged | native |
| Gemini generateContent (`/v1beta/models/{model}:generateContent`) | bridged | native | bridged |

- **native** — the request is forwarded unchanged.
- **bridged** — the router translates the request and the response, including
  streaming and tool calls.

Every client protocol can therefore reach every configured provider. The router
answers `503` with `no_route` only when no provider is configured at all.

On a bridged request some content is dropped rather than guessed at:

- hosted/built-in tools (web search, code execution, ...) — only declared
  functions are forwarded, and freeform tools are mapped to a function taking a
  single input string;
- reasoning items, which Responses and Anthropic clients may send but neither
  chat-completions nor `generateContent` can express;
- remote image URLs and Gemini `fileData` references — only inline base64 data
  is forwarded, so the router never fetches an attachment on the client's behalf;
- a Gemini `functionResponse` turn carries its tool results alone; any text sent
  alongside them in the same turn is preserved, but the empty user turn a Gemini
  client may imply is not invented.

## Gateway key

Optional:

```env
APIROUTER_API_KEYS=YOUR_LOCAL_GATEWAY_KEY
```

Use the value as the client's API key when gateway authentication is enabled.

## Provider keys

Provider API keys stay inside ApiRouter. Clients only need the router endpoint and, when enabled, the router key.

## Fallback

An exact match for the requested model is tried first. Health ranking and
session affinity order the targets *within* that group, so a higher-scored or
sticky sibling target can be tried ahead of another exact match — but a
different model is only reached once every exact-match target is unavailable or
has failed. A narrowed model match therefore stays served by the model the
client asked for as long as any configured target offers it.

Only when no exact match exists, or the exact-match targets have all failed or
are cooling down, does the router widen to the remaining compatible targets for
the protocol. Those fallbacks are health-ranked, and a retryable failure moves
the request to the next available target; for a bridged client protocol the
request may then be served by a different provider than the one its model name
suggested.

See the client-specific guides in this directory.
