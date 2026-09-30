# Claude Code + MultiAI Router

Use the router as Claude Code's Anthropic-compatible gateway.

## Start

```powershell
npm start
```

Default:

```text
http://127.0.0.1:8788
```

## Configure provider

Example:

```env
AGENTROUTER_API_KEYS=YOUR_PROVIDER_KEY
AGENTROUTER_MODELS=claude-opus-5,claude-opus-4-8
AGENTROUTER_BASE_URL=https://agentrouter.org/
```

## Configure Claude Code

PowerShell:

```powershell
$env:ANTHROPIC_BASE_URL="http://127.0.0.1:8788"
$env:ANTHROPIC_AUTH_TOKEN="YOUR_LOCAL_ROUTER_KEY"
$env:ANTHROPIC_API_KEY=$null
claude
```

If `MULTIAI_ROUTER_API_KEYS` is empty, local gateway authentication is not required.

Claude Code uses:

```text
POST /v1/messages
```

The router selects only compatible Anthropic targets.

## Check

```powershell
Invoke-RestMethod http://127.0.0.1:8788/health
```

Keep real keys in `.env`.

Reference: https://docs.anthropic.com/en/docs/claude-code/llm-gateway
