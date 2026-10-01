# Other AI Clients

## OpenAI-compatible

Use:

```text
http://127.0.0.1:8788/v1
```

This pattern can work with clients that support a custom OpenAI-compatible provider, including:

- Cursor
- Cline
- Roo Code
- Continue
- Qwen Code
- Crush
- custom Node.js/Python apps
- cURL/API clients

Set the custom base URL and use the MultiAI Router gateway key if authentication is enabled.

Chat completions reach any provider configured with a chat-completions endpoint
directly, and a Gemini provider through the router's translation bridge.

## Anthropic-compatible

Clients using the Anthropic Messages protocol should use:

```text
http://127.0.0.1:8788
```

## Fallback

Requests are health-ranked, an exact match for the requested model is tried
first, and a retryable failure moves the request to the next reachable target.

Falling back is no longer limited to targets that speak the client's own
protocol. Every client protocol the gateway accepts can fall back to **any**
configured provider — Claude Code (`/v1/messages`), Codex (`/v1/responses`) and
Gemini clients all reach chat-only and Gemini providers through a translation
bridge, and a chat client reaches a Gemini provider the same way. See
[CLIENTS.md](CLIENTS.md) for the protocol-by-provider matrix and the content a
bridged request drops.

For exact client configuration, use the client's own documentation.
