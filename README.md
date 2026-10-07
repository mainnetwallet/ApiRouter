# MultiAI Router

Multi-provider AI routing gateway with health-based fallback.

## Client Integration Guides

- [Claude Code](docs/clients/CLAUDE_CODE.md)
- [Codex](docs/clients/CODEX.md)
- [Qwen Code](docs/clients/QWEN_CODE.md)
- [OpenCode](docs/clients/OPENCODE.md)
- [Generic OpenAI-compatible Clients](docs/clients/GENERIC_OPENAI.md)
- [Other AI Clients](docs/clients/OTHER_CLIENTS.md)
- [All Client Protocols](docs/clients/CLIENTS.md)

## Quick Start

One-time setup:

```powershell
git clone https://github.com/mainnetwallet/MultiAI-Router.git
cd MultiAI-Router
npm install
Copy-Item .env.example .env   # then edit .env (never repeat this: it overwrites your keys)
npm start                     # builds the control panel, then starts the gateway
```

Open `http://localhost:999` (port = `PORT` in `.env`, default `999`). Stop with `Ctrl + C`.

Next runs: `git pull origin main` then `npm start`.

### `Router` command (Windows, Linux, VPS, macOS)

A cross-platform launcher: checks Node/npm, installs missing dependencies, builds the panel once, starts the gateway and prints the URL. Same as `npm start`; never starts Vite.

```powershell
.\scripts\install-router.ps1   # Windows (then open a new terminal)
```
```bash
./scripts/install-router.sh    # Linux/VPS/macOS: installs ~/.local/bin/Router (no root)
```

Then run `Router` from any directory. `PORT`/`HOST` come from `.env`; `--no-open` skips opening the browser. On a headless VPS it only prints the URL: use an SSH tunnel, or set `HOST` and `MULTIAI_ROUTER_API_KEYS` and open `http://SERVER_IP:PORT`. Details: [docs/ROUTER_COMMAND.md](docs/ROUTER_COMMAND.md).

| Command | Purpose |
| --- | --- |
| `npm start` | Production: `npm run ui:build && node src/server.js` |
| `Router` | Same, as a launcher |
| `npm run dev` | Development with hot reload |

## Configuration

Each provider needs API keys, models and a base URL, all set in `.env` (`.env.example` lists every variable).

Retryable statuses (fall back to the next target):

```text
401,402,403,404,408,409,425,429,500,501,502,503,504,520,521,522,523,524,529
```

HTTP `400` also falls back, but a generic 400 (unsupported parameter, schema quirk) does not cool the target down. If every target returns 400, the client gets the 400 instead of a 502.

## Routing

### Priority

```env
TEXT_PRIORITY_MODELS=gemini/G1,groq/GR2,gemini/G3
VISION_PRIORITY_MODELS=gemini/V1,groq/V2
```

- Entries are tried in exactly this order; the first success ends the request.
- Priority is **model-centric**: all eligible keys of an entry are tried in key order before moving to the next entry.
- When every entry and key has failed or cooled down, normal fallback starts.
- Empty/unset means no priority phase. An empty `VISION_PRIORITY_MODELS` inherits `TEXT_PRIORITY_MODELS`.
- Entries only match their own pool: no text-to-vision or vision-to-text fallback.
- Pinned requests ignore priority and sticky, and a pinned success is not remembered. If the client names a model, only priority entries of that model apply.

### Sticky session

- A session's last successful target (exact provider + key + model) is tried first, for 20 minutes, refreshed on each success.
- If it fails, the other keys of the same provider/model are tried, then the priority entries **after** it (priority `A,B,C,D` with sticky on `B` → `B keys → C → D`, then fallback; `A` is not revisited).
- Sessions are identified by `X-Multi-AI-Session-ID` (reuse the `x-multi-ai-session-id` response header). Clients that send none (Claude Code, Codex, OpenAI SDKs) share one default session per protocol and pool.
- Text and vision keep separate sticky targets; a new session always starts at the first priority entry; a target is never called twice in one request.
- Gemini thought signatures are scoped to the same session. A tool call with invalid JSON arguments is refused for a Gemini target (`400 invalid_tool_arguments`) so another target can carry it. See `Architecture.md` → *Tool calls and thought signatures*.

### Normal fallback

Key-scoped: **Provider → Key → Models → next Key → next Provider**. Each key restarts at its provider's first model; targets already tried are skipped. See `Architecture.md`.

## Endpoints

### Gateway

| Method | Endpoint |
|---|---|
| GET | `/health` |
| GET | `/v1/models` |
| POST | `/v1/messages` |
| POST | `/v1/responses` |
| POST | `/v1/chat/completions` |
| POST | `/v1beta/models/{model}:generateContent` |

Pin headers call one exact target (used by the Playground):

| Header | Meaning |
|---|---|
| `x-multi-ai-pin-provider` | Only this provider's targets (with a request `model`, only that model). |
| `x-multi-ai-pin-key-index` | With a provider pin, only that 0-based key. |

A pinned request never falls back and ignores cooldown. No matching target returns `404 no_route`.

### Control panel API (read-only, under `/api`)

Needs the client token when `MULTIAI_ROUTER_API_KEYS` is set; without keys it answers loopback callers only. None of these change routing or health.

| Method | Endpoint | Purpose |
|---|---|---|
| GET | `/api/health` | Provider rollups and monitor state |
| POST | `/api/health/refresh` | Run one health cycle now |
| GET | `/api/providers` | Providers with safe config |
| GET | `/api/models` | Models with health and usage |
| GET | `/api/requests` | Request log (`limit`, `cursor`, `outcome`, `provider`, `protocol`, `status`, `session`) plus running calls |
| GET | `/api/requests/stream` | Server-sent events for Live Logs |
| GET | `/api/requests/:id` | One request's lifecycle, by `x-multi-ai-request-id` (not a session id) |
| GET | `/api/router/preview` | Routing decision for a protocol/model |
| GET | `/api/analytics` | Series and breakdowns (`range=5m\|15m\|1h\|6h\|24h\|7d`) |
| GET | `/api/config` | Effective config; secrets as counts only |
| GET | `/api/system` | Runtime, uptime, monitor scheduling |

## Control Panel

React + Vite app in `ui/`, served by the gateway. Pages: Dashboard, Providers, Models, Health Monitor, Router, Fallback, Playground, Requests, Live Logs, Analytics, Configuration, System.

**Live Logs** shows one card per API call, updated live over SSE (polling only while the stream is down): `ROUTING → RUNNING → RETRYING → SUCCESS/FAILED`. Each tried model gets a box (`CALLING`, `FAILED`, `SUCCESS`) with a `FALLBACK` line between failures. It keeps the last 50 calls. To preview it without real keys: `npm run ui:build` then `npm run demo:live-logs`.

### Development

```powershell
npm install
npm run dev   # gateway + Vite in one terminal; open http://localhost:999
```

- The gateway is the only browser-facing origin; it forwards panel requests to Vite and handles `/api/*`, `/v1/*`, `/v1beta/*`, `/health` itself (no CORS setup).
- `ui/src` changes hot-reload; `src/` changes restart the gateway; `Ctrl+C` stops both.
- With `HOST` unset, dev listens on `127.0.0.1` only (Vite exposes source files). Set `HOST` (e.g. `0.0.0.0`) to reach it from a phone; remote clients are still refused Vite's filesystem endpoints.
- If the gateway is not listening, the port is taken (or below 1024 without root on Linux): set another `PORT`.

```powershell
npm run dev:server   # gateway only, restart on change
npm run ui:dev       # Vite alone (:5173) for frontend-only work; proxies to http://localhost:999 (override: MULTIAI_ROUTER_ORIGIN)
npm run ui:build     # standalone UI build into ui/dist
npm run test:ui      # frontend tests
npm run test:all     # backend + frontend
```

## Health

Every `provider + model + key` target is ranked independently and probed every 15 minutes. A failed target cools down for 20 minutes without affecting sibling keys or models.

Probes are quota-free (they list models, never generate):

```text
Gemini             GET {base}/v1beta/models   (x-goog-api-key)
OpenAI-compatible  GET {base}/v1/models        (Bearer)
```

If no probe can establish health (missing `/models`, no safe probe), the target stays `unknown`, never assumed healthy.

`GET /health` returns per-target `status` (`unknown`, `healthy`, `failed`, `cooldown`), `score`, `lastStatus`, `lastReason`, latency, counts and `cooldownUntil`. It never returns keys or upstream bodies.

## Test

```powershell
npm test           # backend
npm run test:ui    # frontend
npm run test:all   # both
```

## Security

- Keep real API keys in `.env`; never commit credentials.
- Client auth is optional. With `MULTIAI_ROUTER_API_KEYS` unset, only loopback callers (`127.0.0.1`, `::1`) can use the proxy or `/api`; others get `401`. To serve remote clients, set `MULTIAI_ROUTER_API_KEYS` (and `HOST=127.0.0.1` to keep the listener on loopback). `/health` and `/v1/models` stay public and carry no credentials.
- The panel never receives provider credentials: `/api/config` shows key counts and env var names only.
- The only secret the browser holds is the gateway client token, kept in `sessionStorage` (never `localStorage`, URLs or logs) and shown masked.
- Error messages are scrubbed of credential-shaped text on the server (`src/observability/sanitize.js`) and in the browser (`ui/src/lib/sanitize.js`).
