# OpenCode + MultiAI Router

OpenCode can use the router as an OpenAI-compatible provider.

## Gateway

```text
http://127.0.0.1:8788/v1
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
        "baseURL": "http://127.0.0.1:8788/v1",
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

Keep provider keys inside the router.

Reference: https://opencode.ai/docs/providers
