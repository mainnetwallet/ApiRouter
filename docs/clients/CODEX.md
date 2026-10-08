# Codex + ApiRouter Setup

## 1. ApiRouter folder

PowerShell:

```powershell
cd ApiRouter
git pull origin main
npm install
```

Linux / macOS / Termux:

```bash
cd ApiRouter
git pull origin main
npm install
```

## 2. Open ApiRouter .env

Windows PowerShell:

```powershell
notepad .env
```

If `.env` does not exist:

```powershell
Copy-Item .env.example .env
notepad .env
```

Linux / macOS / Termux:

```bash
nano .env
```

If `.env` does not exist:

```bash
cp .env.example .env
nano .env
```

## 3. ApiRouter with API key

Put the router client key in `.env`:

```env
APIROUTER_API_KEYS=YOUR_APIROUTER_KEY
```

Add the provider key and model you want to use. Example:

```env
GEMINI_API_KEYS=YOUR_GEMINI_KEY
GEMINI_MODELS=gemini-3.8-flash
```

You can add other providers from `.env.example` in the same way.

## 4. ApiRouter without API key

For local use without client authentication:

```env
APIROUTER_API_KEYS=
```

Keep the provider API keys in `.env` as normal.

Example:

```env
APIROUTER_API_KEYS=

GEMINI_API_KEYS=YOUR_GEMINI_KEY
GEMINI_MODELS=gemini-3.8-flash
```

## 5. Start ApiRouter

Development:

```powershell
npm run dev:all
```

Production:

```powershell
npm run start:all
```

Router:

```text
http://localhost:8788
```

Codex endpoint:

```text
http://localhost:8788/v1
```

## 6. Open Codex config

Windows PowerShell:

```powershell
notepad $HOME\.codex\config.toml
```

Linux / macOS / Termux:

```bash
nano ~/.codex/config.toml
```

## 7. Codex config — ApiRouter API key enabled

If `APIROUTER_API_KEYS` is set in ApiRouter, use:

```toml
model_provider = "multi_ai_router"

[model_providers.multi_ai_router]
name = "ApiRouter"
base_url = "http://localhost:8788/v1"
env_key = "APIROUTER_API_KEY"
wire_api = "responses"
```

Set the same key for Codex.

PowerShell:

```powershell
$env:APIROUTER_API_KEY="YOUR_APIROUTER_KEY"
```

Linux / macOS / Termux:

```bash
export APIROUTER_API_KEY="YOUR_APIROUTER_KEY"
```

## 8. Codex config — no ApiRouter API key

If ApiRouter has:

```env
APIROUTER_API_KEYS=
```

use:

```toml
model_provider = "multi_ai_router"

[model_providers.multi_ai_router]
name = "ApiRouter"
base_url = "http://localhost:8788/v1"
wire_api = "responses"
```

No `APIROUTER_API_KEY` is required.

## 9. Start Codex

```powershell
codex
```

Linux / macOS / Termux:

```bash
codex
```

## 10. Select a model

Use a model configured in ApiRouter:

```powershell
codex --model YOUR_MODEL
```

Example:

```powershell
codex --model gemini-3.8-flash
```

## 11. Check ApiRouter

Health:

```powershell
curl http://localhost:8788/health
```

Models:

```powershell
curl http://localhost:8788/v1/models
```

## 12. Quick setup — API key

```powershell
cd ApiRouter
git pull origin main
npm install
notepad .env
npm run start:all
```

Set in `.env`:

```env
APIROUTER_API_KEYS=YOUR_APIROUTER_KEY
GEMINI_API_KEYS=YOUR_GEMINI_KEY
GEMINI_MODELS=gemini-3.8-flash
```

Open Codex config:

```powershell
notepad $HOME\.codex\config.toml
```

Use:

```toml
model_provider = "multi_ai_router"

[model_providers.multi_ai_router]
name = "ApiRouter"
base_url = "http://localhost:8788/v1"
env_key = "APIROUTER_API_KEY"
wire_api = "responses"
```

Then:

```powershell
$env:APIROUTER_API_KEY="YOUR_APIROUTER_KEY"
codex
```

## 13. Quick setup — no API key

Set in `.env`:

```env
APIROUTER_API_KEYS=
GEMINI_API_KEYS=YOUR_GEMINI_KEY
GEMINI_MODELS=gemini-3.8-flash
```

Open:

```powershell
notepad $HOME\.codex\config.toml
```

Use:

```toml
model_provider = "multi_ai_router"

[model_providers.multi_ai_router]
name = "ApiRouter"
base_url = "http://localhost:8788/v1"
wire_api = "responses"
```

Then:

```powershell
codex
```
