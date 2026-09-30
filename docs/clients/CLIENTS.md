# MultiAI Router Client Integrations

MultiAI Router is designed as a client-facing gateway rather than a Claude-only integration.

## Supported client protocols

| Client | Gateway endpoint | Protocol |
|---|---|---|
| Claude Code | /v1/messages | Anthropic Messages |
| Codex | /v1/responses | OpenAI Responses |
| OpenCode | /v1/chat/completions | OpenAI-compatible |
| OpenAI-compatible SDKs | /v1/chat/completions | OpenAI-compatible |

## Common gateway

    Claude Code ---- /v1/messages -------+
                                          |
    Codex ---------- /v1/responses ------+--> MultiAI Router
                                          |
    OpenCode ------- /v1/chat/completions+
                                          |
                                          v
                                  provider/model/key

## Gateway authentication

Set:

    MULTIAI_ROUTER_API_KEYS=YOUR_LOCAL_GATEWAY_KEY

Multiple gateway keys are comma-separated.

If empty, the gateway does not require client authentication. For a remote deployment, configure authentication and place the gateway behind HTTPS.

## Provider credentials

Provider credentials remain inside MultiAI Router. Clients should not receive upstream provider API keys.

That separation is the main purpose of the gateway:

    Client credential
          |
          v
    MultiAI Router
          |
          +--> Provider key 1
          +--> Provider key 2
          +--> Provider key 3

## Universal fallback

All compatible provider/model/key targets participate in health-aware routing. A retryable failure can move the request to the next available target.

See:

- CLAUDE_CODE.md
- CODEX.md
- OPENCODE.md