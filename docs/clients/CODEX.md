# Codex + ApiRouter

## Install Codex

### Windows

```powershell
npm install -g @openai/codex
```

### Linux / macOS / Termux

```bash
npm install -g @openai/codex
```

## Update Codex

```powershell
npm install -g @openai/codex@latest
```

## Codex config

### Windows

```powershell
notepad $HOME\.codex\config.toml
```

### Linux / macOS / Termux

```bash
nano ~/.codex/config.toml
```

### With ApiRouter API key

```toml
model_provider = "multi_ai_router"

[model_providers.multi_ai_router]
name = "ApiRouter"
base_url = "http://localhost:8788/v1"
env_key = "APIROUTER_API_KEY"
wire_api = "responses"
```

Windows:

```powershell
$env:APIROUTER_API_KEY="YOUR_APIROUTER_KEY"
```

Linux / macOS / Termux:

```bash
export APIROUTER_API_KEY="YOUR_APIROUTER_KEY"
```

### Without ApiRouter API key

```toml
model_provider = "multi_ai_router"

[model_providers.multi_ai_router]
name = "ApiRouter"
base_url = "http://localhost:8788/v1"
wire_api = "responses"
```

## Start Codex

```powershell
codex
```

## Select model

```powershell
codex --model YOUR_MODEL
```
