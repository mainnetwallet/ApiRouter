# Codex + MultiAI Router

Use the router as Codex's OpenAI Responses gateway.

## Start

```powershell
npm start
```

Gateway:

```text
http://127.0.0.1:8788/v1
```

## Configure provider

Codex speaks the OpenAI Responses protocol, so you need a provider whose
capability includes OpenAI Responses. AgentRouter does; ordinary
OpenAI-chat-only providers (Groq, Mistral, Cerebras, ...) do not and will be
rejected with `503 no_route`.

```env
AGENTROUTER_API_KEYS=YOUR_PROVIDER_KEY
AGENTROUTER_MODELS=YOUR_MODEL
AGENTROUTER_BASE_URL=https://agentrouter.org/
```

## Configure Codex

Edit:

```powershell
notepad $HOME\.codex\config.toml
```

Example:

```toml
model_provider = "multi_ai_router"

[model_providers.multi_ai_router]
name = "MultiAI Router"
base_url = "http://127.0.0.1:8788/v1"
env_key = "MULTIAI_ROUTER_API_KEY"
wire_api = "responses"
```

Then, if gateway authentication is enabled:

```powershell
$env:MULTIAI_ROUTER_API_KEY="YOUR_LOCAL_ROUTER_KEY"
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
