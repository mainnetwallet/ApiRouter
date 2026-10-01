# Client Integrations

MultiAI Router provides one gateway for different AI client protocols.

| Client | Endpoint | Protocol |
|---|---|---|
| Claude Code | `/v1/messages` | Anthropic Messages |
| Codex | `/v1/responses` | OpenAI Responses |
| OpenCode | `/v1/chat/completions` | OpenAI-compatible |
| Qwen Code | `/v1/chat/completions` | OpenAI-compatible |
| OpenAI SDKs | `/v1/chat/completions` | OpenAI-compatible |
| Gemini clients | `/v1beta/models/{model}:generateContent` | Gemini generateContent |

A client protocol and a provider protocol are separate things. A provider that
speaks a client's protocol natively is called directly; one that does not is
still reachable if a translation bridge exists for that direction.

| Client protocol | Chat-only provider | Gemini provider | AgentRouter |
|---|---|---|---|
| Anthropic Messages (`/v1/messages`) | bridged | bridged | native |
| OpenAI Responses (`/v1/responses`) | bridged | bridged | native |
| OpenAI Chat Completions (`/v1/chat/completions`) | native | bridged | native |
| Gemini generateContent (`/v1beta/models/{model}:generateContent`) | not supported | native | not supported |

- **native** — the request is forwarded unchanged.
- **bridged** — the router translates the request and the response, including
  streaming and tool calls.
- **not supported** — no bridge exists for this direction. If nothing else can
  serve the request the router answers `503` with `no_route`.

On a bridged request some content is dropped rather than guessed at:

- hosted/built-in tools (web search, code execution, ...) — a chat request
  forwards only `type: "function"` tools, and freeform tools are mapped to a
  function taking a single input string;
- reasoning items, which Responses and Anthropic clients may send but neither
  chat-completions nor `generateContent` can express;
- remote image URLs — only base64 `data:` URLs can be forwarded.

## Gateway key

Optional:

```env
MULTIAI_ROUTER_API_KEYS=YOUR_LOCAL_GATEWAY_KEY
```

Use the value as the client's API key when gateway authentication is enabled.

## Provider keys

Provider API keys stay inside MultiAI Router. Clients only need the router endpoint and, when enabled, the router key.

## Fallback

Reachable provider/model/key targets are health-ranked. An exact match for the
requested model is tried first and the remaining reachable targets follow, so a
retryable failure moves the request to the next available target. For a bridged
client protocol the request may therefore end up served by a different provider
than the one its model name suggested.

See the client-specific guides in this directory.
