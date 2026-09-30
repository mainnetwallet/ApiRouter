# Client Integrations

MultiAI Router provides one gateway for different AI client protocols.

| Client | Endpoint | Protocol |
|---|---|---|
| Claude Code | `/v1/messages` | Anthropic Messages |
| Codex | `/v1/responses` | OpenAI Responses |
| OpenCode | `/v1/chat/completions` | OpenAI-compatible |
| Qwen Code | `/v1/chat/completions` | OpenAI-compatible |
| OpenAI SDKs | `/v1/chat/completions` | OpenAI-compatible |

## Gateway key

Optional:

```env
MULTIAI_ROUTER_API_KEYS=YOUR_LOCAL_GATEWAY_KEY
```

Use the value as the client's API key when gateway authentication is enabled.

## Provider keys

Provider API keys stay inside MultiAI Router. Clients only need the router endpoint and, when enabled, the router key.

## Fallback

Compatible provider/model/key targets are health-ranked. Retryable failures can move a request to the next available target.

See the client-specific guides in this directory.
