# Claude Code + ApiRouter

## Install Claude Code

```powershell
npm install -g @anthropic-ai/claude-code
```

## Claude Code config

### Windows

```powershell
notepad $HOME\.claude\settings.json
```

### Linux / macOS / Termux

```bash
nano ~/.claude/settings.json
```

### With ApiRouter API key

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://localhost:8788",
    "ANTHROPIC_AUTH_TOKEN": "YOUR_APIROUTER_KEY",
    "ANTHROPIC_MODEL": "router"
  }
}
```

### Without ApiRouter API key

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://localhost:8788",
    "ANTHROPIC_AUTH_TOKEN": "any-key",
    "ANTHROPIC_MODEL": "router"
  }
}
```

## Start Claude Code

```powershell
claude
```