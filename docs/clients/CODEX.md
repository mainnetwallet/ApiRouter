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

Use an OpenAI-compatible provider configured in `.env`, for example:

```env
GROQ_API_KEYS=YOUR_PROVIDER_KEY
GROQ_MODELS=YOUR_MODEL
GROQ_BASE_URL=https://api.groq.com/openai/v1
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
