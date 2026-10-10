# ApiRouter

**Multi-provider AI gateway with a UI-controlled fallback chain, health-aware routing, remembered successes, and a built-in control panel.**

ApiRouter gives OpenAI-compatible and native AI clients one local endpoint while handling provider selection, model routing, key rotation, cooldowns, retries, and observability.

## Features

- **Multi-provider routing** — route requests across configured AI providers and models.
- **UI-controlled fallback chain** — one ordered list per pool, edited in the control panel, followed exactly.
- **Multi-key fallback** — every eligible API key of a model is tried before the next model.
- **Health-aware fallback** — cooling targets are skipped and reported, never hidden.
- **Automatic ordering** — with no chain configured, models are ordered by measured health and latency.
- **Remember Last Successful** — optionally start from the model and key that last answered (20-minute TTL).
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
git pull origin main
npm install
```

### 2. Start

**Recommended — Router**

```bash
cd ApiRouter
git pull origin main
Router
```

**Development mode**

```bash
cd ApiRouter
git pull origin main
npm run dev:all
```

**Production mode**

```bash
cd ApiRouter
git pull origin main
npm run start:all
```

### 3. Configure

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

Routing is decided by the **Fallback Chain** — one ordered list per pool (Text and
Vision), configured in the control panel under **Configure → Fallback Chain**.
It is the single source of truth: there is no separate priority list and no
separate normal-fallback path, and nothing re-sorts a chain you have configured.

```text
Configured chain, for the request's own pool:

  Gemini — Model 2
    key 1 -> fail
    key 2 -> success            (stop: the request is served)
  Groq — Model 3                 (only reached if every key of Model 2 failed)
    ...
```

- Every eligible API key of a model is tried, in key order, before the walk
  moves on to the next model.
- A model can be narrowed to specific keys, and can be disabled without losing
  its position in the list.
- Targets already attempted in the request are never attempted twice.
- Cooling targets are skipped, and reported as skipped rather than hidden.

### When no chain is configured

With an empty chain the router builds the order itself, from measured health and
latency: healthy models with lower measured latency first, models with no
measurement at all after those, in a stable configured order. Latency comes from
real request timings first and health-probe timings second — never from a value
the router does not have. The panel shows this as **Automatic Health-Based
Fallback**. Text and Vision are ordered separately, from their own measurements.

### Fallback modes

| Mode | Behaviour |
|---|---|
| **Fixed Order** (default) | The chain is always walked in its saved order, and every eligible key of a model is tried before the next model. The key that last answered is tried first within its own model, but a success never moves a model ahead of an earlier one. |
| **Remember Last Successful** | The model and key that last answered are tried first. If they fail or are cooling down, the chain continues in its saved order. The saved order is never modified. |
| **Automatic Health-Based Fallback** | The chain is re-ordered from measured health and latency on each cycle. Selecting this mode is what allows re-sorting. |
| **Manual Model Selection** | Two batches that alternate in one request. **Manual:** your selected models, in exactly the saved order (interleaved providers stay interleaved), every eligible key of a model before the next. **Health:** if all of them fail, every model you did *not* select, ordered by measured health and latency. Then Manual → Health again, for as long as a target is permitted another attempt. See below. |

#### Manual Model Selection in detail

- **Exclusion is by model, not provider.** With Gemini A, Groq B, Gemini C selected, an unselected Gemini B is still a phase-2 fallback. Parked (disabled) entries and models narrowed to no keys are *not* used as fallbacks.
- **Manual → Health → Manual → Health.** A success in any batch ends the request. Every batch after the first only holds targets a retry is *permitted* for; a new round never authorises a retry by itself, and a round with nothing permitted calls nothing.
- **Retries are per target.** Each target is retried at most once, and only after a transient failure (timeout, 429, 5xx, transport error) that *this request* caused. A target that was already cooling down, or was cooled by a credential-level or non-transient failure (400/401/402/403/404/413/422), or refused the request without a cooldown, is never retried. The only cooldown a retry looks past is the one this request itself set through a transient failure, and only while it is still exactly that cooldown — otherwise every target that failed in the first batch would be sitting in the cooldown that failure just created and nothing could be retried. A health check never clears a cooldown.
- **Stable order, bounded work.** Both batches are ordered once, when the request starts; a health refresh can only change the next request's Health order. Calls are bounded by (1 + the per-target retry allowance) × the number of distinct targets, so routing always ends.
- **Fails closed.** If none of the selected models can serve the request (wrong protocol, no matching key), the request fails rather than substituting other models. Pinned requests never use any of this.
- Live Logs / request timelines label each attempt `manual-selection`, `health-fallback`, `manual-retry` or `health-retry`.

**Reset Fallback** clears the remembered model/key preferences immediately, with
no restart. It never deletes the saved chain, the selected mode, the providers,
the API keys, the configured models, valid health measurements or a genuine
cooldown.

### Sticky sessions

The remembered target is scoped per session, protocol and pool, and lasts
**20 minutes** after its last success. Sessions are identified with:

```text
X-Multi-AI-Session-ID
```

The response also returns the session ID so clients can reuse it. A Text success
never becomes a Vision preference.

### Text and Vision

Text and Vision share one algorithm and one set of rules, but never share
targets. Each has its own chain, its own health, its own cooldowns, its own
latency measurements and its own remembered target. A vision request can never
reach a model that does not support vision, and the two pools never cross over.

### Failures and cooldowns

A failure cools down what it actually describes:

| Failure | Cools down |
|---|---|
| Key/account rejection (`401`, `402`, `403`) | Every model of that provider using that key |
| Request or model problem (`400`, `404`, `413`, `422`) | Only that target — never a sibling that shares the key |
| Anything else (`429`, `5xx`, timeouts) | Only that target |

A provider adapter that can read the upstream error body may state the scope
outright, and that wins over the status code.

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
| GET | `/api/fallback` | The Fallback Chain, the mode and the model catalogue with health and latency |
| PUT | `/api/fallback` | Save one pool's chain, or select the operating mode |
| POST | `/api/fallback/reset` | Clear remembered model/key preferences (Reset Fallback) |
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

Health probes are provider-aware and never generate text, so they do not consume generation quota: they probe a model-list endpoint, or for Cohere (whose compatibility surface has no model list) its native "Get a Model" call, `GET /v1/models/{model}`.

Health reports the key and the endpoint. Whether the configured model is actually offered is reported separately, as `modelListed`, because a valid key and a reachable provider do not prove the model is usable. That signal is tri-state — `true` listed, `false` absent from a catalogue read to the end, `null` could not be verified — and it is reported alongside the last confirmed value and its timestamp, so an unreadable catalogue is never shown as a fresh result. A paginated catalogue is walked before absence is claimed; if it cannot be read to the end, the answer is "not verified" rather than "missing".

The `/health` endpoint exposes target status, score, latency, success/failure counters, and cooldown information without returning API keys or upstream response bodies.

## Security

- Keep provider API keys in `.env`.
- Never commit credentials.
- Provider credentials are not sent to the browser.
- `/api/config` exposes configuration metadata and key counts, not key values.
- UI-facing errors are sanitized to prevent credential-shaped data from reaching logs or UI components.
- The gateway client token is stored in session storage rather than local storage or URLs.

### Which endpoints require a token

`APIROUTER_API_KEYS` is optional ("leave empty for local trusted use"), but when it is set it does not protect every route. The split is deliberate:

| Endpoint | Token required |
|---|---|
| `GET /health` | no |
| `GET /v1/models` | no |
| `POST /v1/messages`, `/v1/responses`, `/v1/chat/completions` | yes |
| `POST /v1beta/models/{model}:generateContent` | yes |
| `POST /v1/messages/count_tokens` | yes |
| `GET/POST /api/*` (control panel) | yes |

`/health` and `/v1/models` are open on purpose: the first is a liveness/readiness probe meant for load balancers and container orchestrators, and the second is model discovery, which a client needs *before* it can name a model. Both are documented to exclude credentials — `/health` reports target status, scores and cooldowns, never API keys or upstream response bodies.

They are not anonymous by accident, and they are not free of information: `/health` does reveal the configured provider, model, key-index inventory and its recent health, and `/v1/models` reveals the configured model ids. If that inventory is sensitive in your deployment, restrict both at the network layer (bind the gateway to a private interface, or put an authenticating reverse proxy in front of it) rather than assuming `APIROUTER_API_KEYS` covers them.

## Development

Install dependencies:

```bash
npm install
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
├── ui/                  # React + Vite control panel
├── .env.example         # Configuration template
└── package.json
```

## License

See the repository license for usage and distribution terms.
