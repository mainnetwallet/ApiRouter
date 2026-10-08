# ApiRouter

**Multi-provider AI gateway with intelligent routing, health-aware fallback, sticky sessions, and a built-in control panel.**

ApiRouter gives OpenAI-compatible and native AI clients one local endpoint while handling provider selection, model routing, key rotation, cooldowns, retries, and observability.

## Features

- **Multi-provider routing** — route requests across configured AI providers and models.
- **Priority routing** — define ordered text and vision targets.
- **Health-aware fallback** — unhealthy or cooled-down targets are skipped automatically.
- **Sticky sessions** — successful targets can remain sticky for 20 minutes per session.
- **Key-aware routing** — keys are handled independently within each provider/model target.
- **Text + vision separation** — vision requests stay in the vision pool; they do not silently fall back to text-only targets.
- **Multiple client protocols** — Claude Messages, OpenAI Responses, OpenAI Chat Completions, Gemini, and generic OpenAI-compatible clients.
- **Control Panel** — inspect providers, models, health, routing, requests, live logs, analytics, configuration, and system state.
- **Live Logs** — follow request and per-target lifecycle events in real time.
- **Cross-platform launcher** — Windows, Linux, and macOS startup support.
- **Security-focused configuration** — provider credentials stay server-side and are never exposed through the control panel.

## Quick Start

### 1. Clone

```bash
git clone https://github.com/mainnetwallet/ApiRouter.git
cd ApiRouter
npm install
```

### 2. Configure

Copy the example environment file and add your provider credentials:

**PowerShell**
```powershell
Copy-Item .env.example .env
notepad .env
```

**Linux / macOS**
```bash
cp .env.example .env
nano .env
```

### 3. Start

For development:

```bash
npm run dev:all
```

For production:

```bash
npm run start:all
```

The gateway runs on:

```text
http://localhost:8788
```

The development control panel runs on:

```text
http://localhost:5173
```

## One-Command Router

ApiRouter includes a cross-platform `Router` launcher.

### Windows

From PowerShell:

```powershell
.\scripts\install-router.ps1
```

Open a new terminal and run:

```powershell
Router
```

### Linux / macOS

```bash
./bin/Router
```

The launcher:

1. Checks the required ports.
2. Installs dependencies when needed.
3. Starts the development or production stack.
4. Opens the local control panel.
5. Delegates process lifecycle management to the existing startup scripts.

Use `Router --prod` for production mode.

## Client Integrations

| Client | Guide |
|---|---|
| Claude Code | [docs/clients/CLAUDE_CODE.md](docs/clients/CLAUDE_CODE.md) |
| Codex | [docs/clients/CODEX.md](docs/clients/CODEX.md) |
| Qwen Code | [docs/clients/QWEN_CODE.md](docs/clients/QWEN_CODE.md) |
| OpenCode | [docs/clients/OPENCODE.md](docs/clients/OPENCODE.md) |
| Generic OpenAI-compatible | [docs/clients/GENERIC_OPENAI.md](docs/clients/GENERIC_OPENAI.md) |
| Other clients | [docs/clients/OTHER_CLIENTS.md](docs/clients/OTHER_CLIENTS.md) |
| Protocol reference | [docs/clients/CLIENTS.md](docs/clients/CLIENTS.md) |

## Routing

Priority routing can be configured independently for text and vision:

```env
TEXT_PRIORITY_MODELS=gemini/G1,groq/GR2,openrouter/G3
VISION_PRIORITY_MODELS=gemini/V1,openrouter/V2
```

Targets are attempted in the configured order. Once a target succeeds, the request ends.

If priority targets are exhausted, ApiRouter enters normal fallback routing.

### Sticky sessions

A successful target can remain sticky for **20 minutes** for the same session.

Sessions are identified with:

```text
X-Multi-AI-Session-ID
```

The response also returns the session ID so clients can reuse it.

Sticky routing is isolated by protocol/pool and remembers the exact provider, key, and model.

### Fallback

Normal fallback is key-scoped:

```text
Provider → Key → Models → next Key → Models → next Provider
```

Targets already attempted during the request are not retried later in the same request.

## API Endpoints

### Gateway

| Method | Endpoint |
|---|---|
| GET | `/health` |
| GET | `/v1/models` |
| POST | `/v1/messages` |
| POST | `/v1/responses` |
| POST | `/v1/chat/completions` |
| POST | `/v1beta/models/{model}:generateContent` |

### Control Panel API

| Method | Endpoint | Purpose |
|---|---|---|
| GET | `/api/health` | Provider and target health |
| POST | `/api/health/refresh` | Run a health cycle |
| GET | `/api/providers` | Provider status and safe configuration |
| GET | `/api/models` | Model catalogue and health |
| GET | `/api/requests` | Request history |
| GET | `/api/requests/stream` | Live request events |
| GET | `/api/requests/:id` | Request lifecycle |
| GET | `/api/router/preview` | Preview routing decisions |
| GET | `/api/analytics` | Usage and performance analytics |
| GET | `/api/config` | Effective configuration without secrets |
| GET | `/api/system` | Runtime and health-monitor state |

## Control Panel

The React + Vite control panel is served by the gateway.

Run it independently during development:

```bash
npm run ui:dev
```

Build it for production:

```bash
npm run ui:build
```

Useful areas include:

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

Live Logs receives request lifecycle events through Server-Sent Events and shows the individual upstream attempts, failures, fallbacks, and final outcomes.

For local demo traffic:

```bash
npm run demo:live-logs
```

## Health Monitoring

ApiRouter monitors targets at the **provider + model + key** level.

Targets can report:

```text
unknown
healthy
failed
cooldown
```

Failed targets enter cooldown without disabling their sibling keys or models.

Health probes are provider-aware and designed to avoid consuming generation quota where a safe model-list endpoint is available.

The `/health` endpoint exposes target status, score, latency, success/failure counters, and cooldown information without returning API keys or upstream response bodies.

## Security

- Keep provider API keys in `.env`.
- Never commit credentials.
- Provider credentials are not sent to the browser.
- `/api/config` exposes configuration metadata and key counts, not key values.
- UI-facing errors are sanitized to prevent credential-shaped data from reaching logs or UI components.
- The gateway client token is stored in session storage rather than local storage or URLs.

## Development

Install dependencies:

```bash
npm install
```

Run backend tests:

```bash
npm test
```

Run frontend tests:

```bash
npm run test:ui
```

Run the complete test suite:

```bash
npm run test:all
```

Build the UI:

```bash
npm run ui:build
```

## Project Structure

```text
ApiRouter/
├── bin/                 # Cross-platform Router launchers
├── docs/                # Client integration guides
├── scripts/             # Development, production and launcher scripts
├── src/                 # Gateway and backend
├── test/                # Backend tests
├── ui/                  # React + Vite control panel
├── .env.example         # Configuration template
└── package.json
```

## License

See the repository license for usage and distribution terms.
