# Claude Code + MultiAI Router

Use the router as Claude Code's Anthropic-compatible gateway.

## Start

```powershell
npm start
```

Default:

```text
http://localhost:8788
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
$env:ANTHROPIC_BASE_URL="http://localhost:8788"
$env:ANTHROPIC_AUTH_TOKEN="YOUR_LOCAL_ROUTER_KEY"
$env:ANTHROPIC_API_KEY=$null
claude
```

Bash / Termux (permanent, `~/.claude/settings.json`):

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://localhost:8788",
    "ANTHROPIC_AUTH_TOKEN": "any-key",
    "ANTHROPIC_MODEL": "router",
    "DISABLE_AUTOUPDATER": "1"
  }
}
```

Bash (current session only):

```bash
export ANTHROPIC_BASE_URL="http://localhost:8788"
export ANTHROPIC_AUTH_TOKEN="any-key"
unset ANTHROPIC_API_KEY
claude
```

No trailing path on the base URL; Claude Code calls `/v1/messages` itself.

If `MULTIAI_ROUTER_API_KEYS` is empty, local gateway authentication is not required
(any token value works). If it is set, `ANTHROPIC_AUTH_TOKEN` must match one key.

Claude Code uses:

```text
POST /v1/messages
```

The router selects only compatible Anthropic targets.

## Check

```powershell
Invoke-RestMethod http://localhost:8788/health
```

```bash
curl http://localhost:8788/health
curl http://localhost:8788/v1/models
```

## Optional: permanent config (`~/.claude/settings.json`)

Set once and Claude Code picks it up every run, with no shell `export` needed.
`NO_PROXY` keeps localhost traffic away from any system proxy / VPN.

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://localhost:8788",
    "ANTHROPIC_AUTH_TOKEN": "any-key",
    "ANTHROPIC_MODEL": "router",
    "DISABLE_AUTOUPDATER": "1",
    "NO_PROXY": "127.0.0.1,localhost",
    "no_proxy": "127.0.0.1,localhost"
  }
}
```

## Troubleshooting

### `API Error: 405 status code (no body)`

Cause: a system proxy (`HTTP_PROXY` / `HTTPS_PROXY`, VPN or corporate proxy) is
intercepting Claude Code's request to `localhost:8788`. The proxy never reaches the
router, so nothing shows in the router log. The router itself never returns an
empty-body 405.

Fix: make localhost bypass the proxy.

Bash / Termux:

```bash
env | grep -i proxy
export NO_PROXY=127.0.0.1,localhost
export no_proxy=127.0.0.1,localhost
```

Permanent: add the two `export` lines to `~/.bashrc`, or add `NO_PROXY` and `no_proxy`
to the `env` block in `~/.claude/settings.json`.

PowerShell (Windows):

```powershell
Get-ChildItem Env: | Where-Object Name -match "proxy"
$env:NO_PROXY="127.0.0.1,localhost"
$env:no_proxy="127.0.0.1,localhost"
setx NO_PROXY "127.0.0.1,localhost"
setx no_proxy "127.0.0.1,localhost"
```

Open a new terminal after `setx`.

If the 405 persists with `NO_PROXY` set, check the provider `*_BASE_URL` for extra
path segments and the model name in `ANTHROPIC_MODEL`.

Keep real keys in `.env`.

Reference: https://docs.anthropic.com/en/docs/claude-code/llm-gateway
