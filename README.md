# MultiAI Router

Multi-provider AI gateway with priority routing, sticky sessions, automatic fallback, health tracking and a React control panel.

## CLI Guides

- [All client protocols](docs/clients/CLIENTS.md)
- [Claude Code](docs/clients/CLAUDE_CODE.md)
- [Codex](docs/clients/CODEX.md)
- [OpenCode](docs/clients/OPENCODE.md)
- [Qwen Code](docs/clients/QWEN_CODE.md)
- [OpenAI-compatible clients](docs/clients/GENERIC_OPENAI.md)
- [Other clients](docs/clients/OTHER_CLIENTS.md)

## Requirements

- Git
- Node.js 20+ (npm is included)
- Provider API keys and models in `.env`

Install Git and Node.js:

```powershell
# Windows
winget install Git.Git
winget install OpenJS.NodeJS.LTS
```

```bash
# macOS
brew install git node
```

```bash
# Ubuntu / Debian / VPS
sudo apt update && sudo apt install -y git
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
```

Check: `node -v` (v20 or higher), `npm -v`, `git --version`.

## Installation

> **First time only.** Run these steps once. Do not repeat them later: copying `.env.example` again overwrites your keys. See [Run](#run) for next time.

### Linux / macOS / VPS

```bash
git clone https://github.com/mainnetwallet/MultiAI-Router.git
cd MultiAI-Router
npm install
cp .env.example .env
nano .env
```

Add the providers, models, and API keys you want to use, then save (`Ctrl + O`, `Enter`, `Ctrl + X`).

### Windows

```powershell
git clone https://github.com/mainnetwallet/MultiAI-Router.git
cd MultiAI-Router
npm install
Copy-Item .env.example .env
notepad .env
```

Add the providers, models, and API keys you want to use, then save and close.

> Do not commit `.env` or real API keys.

## Run

### Production

```bash
cd ~/MultiAI-Router
git pull origin main
npm start
```

`git pull` gets the latest updates (safe to run every time). `npm start` builds the control panel and starts the production gateway. The default address is:

```text
http://localhost:9999
```

Set `PORT` in `.env` to use another port.

### Router command

The `Router` command is the convenient cross-platform production launcher.

Windows:

```powershell
.\scripts\install-router.ps1
```

Linux / macOS / VPS:

```bash
./scripts/install-router.sh
```

After installation:

```text
Router
```

It finds the checkout, installs missing dependencies when needed, builds the UI once, starts the gateway, waits for health, and prints the URL.

Full guide: [docs/ROUTER_COMMAND.md](docs/ROUTER_COMMAND.md)

### Development

```bash
npm run dev
```

Development mode runs the gateway and Vite with hot reload. Open:

```text
http://localhost:9999
```

## Configuration

All configuration is loaded from `.env`. See [.env.example](.env.example) for the complete list.

### Gateway

```env
PORT=9999
HOST=
MULTIAI_ROUTER_API_KEYS=
```

- `PORT` — gateway/control-panel port.
- `HOST` — bind address.
- `MULTIAI_ROUTER_API_KEYS` — optional keys used to authenticate gateway clients.

### Providers

Each provider follows the same basic pattern:

```env
GEMINI_API_KEYS=
GEMINI_MODELS=
GEMINI_BASE_URL=https://generativelanguage.googleapis.com/
```

The repository includes configuration for multiple providers. Add only the providers you want to use.

### Vision

Vision routing uses separate `*_VISION_*` configuration. A provider is available to the vision pool only when its required vision configuration is present.

For example:

```env
GEMINI_VISION_API_KEYS=
GEMINI_VISION_MODELS=
GEMINI_VISION_BASE_URL=https://generativelanguage.googleapis.com/
```

Vision requests are routed through the vision pool and are not silently sent to the text-only pool.

### Priority models

Optional:

```env
TEXT_PRIORITY_MODELS=gemini/model-a,groq/model-b
VISION_PRIORITY_MODELS=gemini/vision-model
```

Entries are attempted in the configured order before normal fallback.

### Retry and limits

The router supports configurable retry status codes and request/stream resource limits. The main settings include:

```env
RETRY_STATUS_CODES=
REQUEST_TIMEOUT_MS=
STREAM_CONNECT_TIMEOUT_MS=
STREAM_IDLE_TIMEOUT_MS=
STREAM_TOTAL_TIMEOUT_MS=
MAX_UPSTREAM_BODY_BYTES=
MAX_SSE_EVENT_BYTES=
MAX_REQUEST_BODY_BYTES=
```

Use [.env.example](.env.example) as the source of truth for defaults and descriptions.

## Routing

The request flow is:

```text
Request
  ↓
TEXT / VISION pool
  ↓
Sticky target
  ↓
Priority models
  ↓
Normal fallback
  ↓
Provider / model / key
```

### Sticky

The last successful target can be preferred for the session for 20 minutes.

Clients can provide:

```text
X-Multi-AI-Session-ID
```

Clients without this header use the router's default session behavior for their protocol.

### Priority

`TEXT_PRIORITY_MODELS` and `VISION_PRIORITY_MODELS` define preferred models. All eligible keys for a priority model are considered before moving to the next priority entry.

### Fallback

If a target fails with a retryable failure, the router moves to the next eligible target. A target is not called twice during the same request.

HTTP 400 can also move to the next target, but does not put the target into cooldown.

For the complete routing and health design, see [Architecture.md](Architecture.md).

## Gateway API

| Method | Endpoint | Purpose |
|---|---|---|
| GET | `/health` | Gateway health |
| GET | `/v1/models` | Model discovery |
| POST | `/v1/messages` | Anthropic Messages |
| POST | `/v1/responses` | OpenAI Responses |
| POST | `/v1/chat/completions` | OpenAI Chat Completions |
| POST | `/v1beta/models/{model}:generateContent` | Gemini generateContent |

### Control panel API

The React control panel uses the read-only `/api/*` API for health, providers, models, requests, routing preview, analytics, configuration, and system information.

The control-panel API is authenticated with `MULTIAI_ROUTER_API_KEYS` when gateway authentication is enabled.

## Client Integrations

| Client | Gateway endpoint |
|---|---|
| Claude Code | `/v1/messages` |
| Codex | `/v1/responses` |
| OpenCode | `/v1/chat/completions` |
| Qwen Code | `/v1/chat/completions` |
| OpenAI SDK / compatible clients | `/v1/chat/completions` |
| Gemini clients | `/v1beta/models/{model}:generateContent` |

## Control Panel

The control panel is built from `ui/` and served by the production gateway.

It includes:

- Dashboard
- Providers
- Models
- Health Monitor
- Router
- Fallback
- Playground
- Requests
- Live Logs
- Analytics
- Configuration
- System

For a local UI preview without real provider calls:

```bash
npm run ui:build
npm run demo:live-logs
```

## Health

Health is tracked independently for each provider, model, and API key.

A failed target can enter cooldown while other keys or models remain available. Provider-aware health probes are used when a safe probe is supported.

The `/health` endpoint exposes health information but never returns provider API keys or upstream response bodies.

## Development Commands

| Command | Purpose |
|---|---|
| `npm start` | Build the UI and start the production gateway |
| `npm run dev` | Gateway + Vite development mode |
| `npm run dev:server` | Gateway only with restart on source changes |
| `npm run ui:dev` | Vite frontend development server |
| `npm run ui:build` | Build `ui/dist` |
| `npm run ui:preview` | Preview the built UI |
| `npm test` | Backend tests |
| `npm run test:ui` | UI tests |
| `npm run test:all` | Backend + UI tests |

## Security

- Keep real provider credentials in `.env`.
- Never commit API keys or other secrets.
- Set `MULTIAI_ROUTER_API_KEYS` before exposing the gateway to remote clients.
- Use `HOST=127.0.0.1` when the gateway should remain local.
- For public/VPS deployments, use authentication and preferably a TLS reverse proxy.
- Provider credentials stay on the server and are not exposed to clients.

## Troubleshooting

### No route

Check that the requested provider/model is configured and that the model supports the requested protocol and pool (text or vision).

### Provider is failing

Check:

1. API key
2. Model name
3. Base URL
4. Provider configuration
5. `/health`

### Remote access

For a VPS, prefer an SSH tunnel for private access. For direct remote access, configure `HOST`, set `MULTIAI_ROUTER_API_KEYS`, and protect the exposed port.

See [docs/ROUTER_COMMAND.md](docs/ROUTER_COMMAND.md) for platform-specific instructions.

## Features

- Multi-provider text and vision routing
- Anthropic Messages, OpenAI Responses, OpenAI Chat, and Gemini gateway protocols
- Sticky sessions and configurable priority models
- Automatic fallback across providers, models, and keys
- Per-provider/model/key health tracking and cooldown
- React + Vite control panel
- Cross-platform `Router` launcher for Windows, Linux, VPS, and macOS
- OpenAI-compatible provider support

## Documentation

| Document | Purpose |
|---|---|
| [Architecture.md](Architecture.md) | Detailed routing, health, protocol, and system architecture |
| [Router Command](docs/ROUTER_COMMAND.md) | Windows, Linux, VPS, and macOS launcher |
| [Client protocols](docs/clients/CLIENTS.md) | Client protocol overview |
| [Client guides](docs/clients/) | Client-specific setup |

## License

See the repository for licensing information.
