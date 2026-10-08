# Codex + MultiAI Router

Use the router as Codex's OpenAI Responses gateway.

## Start

```powershell
npm start
```

Gateway:

```text
http://localhost:9999/v1
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

### Without gateway authentication

If `MULTIAI_ROUTER_API_KEYS=` is empty in the router `.env`, **do not configure `env_key` in Codex**. Without `env_key`, Codex does not require an API key for this provider.

```toml
model_provider = "multi_ai_router"
model = "Router"

[model_providers.multi_ai_router]
name = "MultiAI Router"
base_url = "http://localhost:9999/v1"
wire_api = "responses"
```

### With gateway authentication

If `MULTIAI_ROUTER_API_KEYS` contains one or more keys, configure Codex with the matching environment variable:

```toml
model_provider = "multi_ai_router"
model = "Router"

[model_providers.multi_ai_router]
name = "MultiAI Router"
base_url = "http://localhost:9999/v1"
env_key = "MULTIAI_ROUTER_API_KEY"
wire_api = "responses"
```

Then set the same key in the environment:

```powershell
$env:MULTIAI_ROUTER_API_KEY="YOUR_LOCAL_ROUTER_KEY"
```

For a persistent Windows environment variable:

```powershell
setx MULTIAI_ROUTER_API_KEY "YOUR_LOCAL_ROUTER_KEY"
```

After using `setx`, open a new terminal before starting Codex.

Start:

```powershell
codex
```

Codex requests use:

```text
POST /v1/responses
```

Reference: https://developers.openai.com/docs/config-file/config-reference
