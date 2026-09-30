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

## Anthropic-compatible

Clients using the Anthropic Messages protocol should use:

```text
http://127.0.0.1:8788
```

The router only falls back between targets compatible with the requested protocol.

For exact client configuration, use the client's own documentation.
