# Codex + ApiRouter

Use the router as Codex's OpenAI Responses gateway.

## Start

```powershell
npm start
```

Gateway:

```text
http://localhost:8788/v1
```

## Configure provider

Codex speaks the OpenAI Responses protocol. The router handles this in two ways:

- **Native:** providers that support OpenAI Responses (for example AgentRouter)
  are passed through untouched and preferred.
- **Bridged:** providers that only speak OpenAI chat-completions (Groq, Mistral,
  Cerebras, ...) or Gemini `generateContent` are reached through a built-in
  translation layer, so a Codex request can fall back to any configured
  provider. Streaming and function/custom tool calls are translated too.

Targets whose model matches the requested model are tried first; the rest
follow as fallback. A request only returns `503 no_route` when no configured
provider can be reached natively or through translation.

```env
AGENTROUTER_API_KEYS=YOUR_PROVIDER_KEY
AGENTROUTER_MODELS=YOUR_MODEL
AGENTROUTER_BASE_URL=https://agentrouter.org/
```

### Bridge limitations

Hosted/built-in tools (such as `web_search`, `local_shell`, `image_generation`)
and reasoning items have no chat-completions equivalent, so they are dropped
from bridged requests. Native Responses providers are unaffected.

## Configure Codex

Edit:

```powershell
notepad $HOME\.codex\config.toml
```

Example:

```toml
model_provider = "multi_ai_router"

[model_providers.multi_ai_router]
name = "ApiRouter"
base_url = "http://localhost:8788/v1"
env_key = "APIROUTER_API_KEY"
wire_api = "responses"
```

Then, if gateway authentication is enabled:

```powershell
$env:APIROUTER_API_KEY="YOUR_LOCAL_ROUTER_KEY"
```

Start:

```powershell
codex
```

Codex requests use:

```text
POST /v1/responses
```

Reference: https://developers.openai.com/docs/config-file/config-reference
