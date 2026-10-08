# Codex Setup with ApiRouter

## 1. Start ApiRouter

From the ApiRouter directory:

```powershell
npm run start:all
```

For development:

```powershell
npm run dev:all
```

ApiRouter runs on:

```text
http://localhost:8788
```

Codex uses:

```text
http://localhost:8788/v1
```

## 2. Set the ApiRouter API key

If `APIROUTER_API_KEYS` is configured in ApiRouter, set the same client key for Codex.

PowerShell:

```powershell
$env:APIROUTER_API_KEY="YOUR_APIROUTER_KEY"
```

To save it permanently:

```powershell
setx APIROUTER_API_KEY "YOUR_APIROUTER_KEY"
```

After using `setx`, open a new terminal.

If ApiRouter does not require authentication, this step is not required.

## 3. Configure Codex

Open the Codex configuration file:

```powershell
notepad $HOME\.codex\config.toml
```

Add:

```toml
model_provider = "multi_ai_router"

[model_providers.multi_ai_router]
name = "ApiRouter"
base_url = "http://localhost:8788/v1"
env_key = "APIROUTER_API_KEY"
wire_api = "responses"
```

Save the file.

## 4. Start Codex

Run:

```powershell
codex
```

Codex will send Responses API requests through ApiRouter.

## 5. Select a model

You can specify a model when starting Codex:

```powershell
codex --model YOUR_MODEL
```

Use a model configured in ApiRouter.

## 6. Check ApiRouter

Check the router health:

```powershell
curl http://localhost:8788/health
```

Check available models:

```powershell
curl http://localhost:8788/v1/models
```

## 7. Linux / macOS / Termux

Set the client key:

```bash
export APIROUTER_API_KEY="YOUR_APIROUTER_KEY"
```

Open Codex config:

```bash
nano ~/.codex/config.toml
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

Then run:

```bash
codex
```

## 8. Project-level configuration

To configure Codex for a single project, create or edit:

```text
.codex/config.toml
```

Use the same provider configuration:

```toml
model_provider = "multi_ai_router"

[model_providers.multi_ai_router]
name = "ApiRouter"
base_url = "http://localhost:8788/v1"
env_key = "APIROUTER_API_KEY"
wire_api = "responses"
```

## 9. Reset Codex configuration

Remove the ApiRouter provider configuration from:

```text
~/.codex/config.toml
```

On Windows:

```powershell
notepad $HOME\.codex\config.toml
```

## 10. Quick setup

Windows PowerShell:

```powershell
cd ApiRouter
npm run start:all
```

In another terminal:

```powershell
$env:APIROUTER_API_KEY="YOUR_APIROUTER_KEY"
codex
```
