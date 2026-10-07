# OpenCode + MultiAI Router

OpenCode can use the router as an OpenAI-compatible provider.

## Gateway

```text
http://localhost:999/v1
```

## Configure

Use OpenCode's custom OpenAI-compatible provider configuration.

Example:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "providers": {
    "multi-ai-router": {
      "package": "@opencode/ai/providers/openai-compatible",
      "name": "MultiAI Router",
      "settings": {
        "baseURL": "http://localhost:999/v1",
        "apiKey": "{env:MULTIAI_ROUTER_API_KEY}"
      },
      "models": {
        "your-model": {
          "name": "Router Model"
        }
      }
    }
  }
}
```

Set the gateway key when authentication is enabled:

```powershell
$env:MULTIAI_ROUTER_API_KEY="YOUR_LOCAL_ROUTER_KEY"
```

OpenCode uses:

```text
POST /v1/chat/completions
```

## Fallback

Targets are tried in their configured order (sticky, then priority, then the
normal fallback list), so a request moves to the next available target on a
retryable failure. A chat-completions provider is called directly; a Gemini
provider is reached through the router's translation bridge, so a Gemini-only
setup still works.

Two limits apply to bridged (Gemini) targets:

- tools are forwarded only when they are `type: "function"`; hosted/built-in
  tools have no `generateContent` equivalent and are dropped;
- remote image URLs are dropped; only base64 `data:` URLs are forwarded.

## Security

Keep provider keys inside the router.

Reference: https://opencode.ai/docs/providers
