# OpenCode + ApiRouter

## Install OpenCode

```powershell
npm install -g opencode-ai
```

## OpenCode config

### Windows

```powershell
notepad opencode.json
```

### Linux / macOS / Termux

```bash
nano opencode.json
```

### With ApiRouter API key

```json
{
  "$schema": "https://opencode.ai/config.json",
  "providers": {
    "apirouter": {
      "package": "@opencode/ai/providers/openai-compatible",
      "name": "ApiRouter",
      "settings": {
        "baseURL": "http://localhost:8788/v1",
        "apiKey": "{env:APIROUTER_API_KEY}"
      },
      "models": {
        "Router": {
          "name": "Router"
        }
      }
    }
  }
}
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

```json
{
  "$schema": "https://opencode.ai/config.json",
  "providers": {
    "apirouter": {
      "package": "@opencode/ai/providers/openai-compatible",
      "name": "ApiRouter",
      "settings": {
        "baseURL": "http://localhost:8788/v1"
      },
      "models": {
        "Router": {
          "name": "Router"
        }
      }
    }
  }
}
```

## Start OpenCode

```powershell
opencode
```