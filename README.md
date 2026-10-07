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

```powershell
git clone https://github.com/mainnetwallet/MultiAI-Router.git
cd MultiAI-Router
npm install
Copy-Item .env.example .env
notepad .env
npm run ui:build     # build the control panel (optional — Router can build it automatically)
npm start
```

Default server:

```text
http://localhost:999
```

Open `http://localhost:999` for the control panel. The port comes from `PORT` in
`.env` (default `999`).

### Running again (second time onwards)

The clone, `npm install` and `.env` setup are one-time steps. Next time, just:

```powershell
cd MultiAI-Router
git pull origin main
npm start
```

After pulling updates (`git pull`), rebuild only what changed:

```powershell
cd MultiAI-Router
git pull origin main
npm run ui:build    
npm start
```

Do not run `Copy-Item .env.example .env` again — it would overwrite your keys.
Stop the router with `Ctrl + C`.

### Windows `Router` command

Install the repository launcher once from PowerShell:

```powershell
.\scripts\install-router.ps1
```

Open a new PowerShell window. From then on, run:

```powershell
Router
```

The launcher changes to the repository directory, installs dependencies if needed,
builds the control panel if `ui/dist/index.html` is missing, opens the control panel
in the browser, and starts the gateway on `localhost:999`. If the panel has not been
built, that address serves a short page explaining how to build it — the
gateway itself needs no build step and is unaffected.

## Configuration

A provider needs:

- API keys
- Models
- Base URL

Configure them in `.env`; `.env.example` lists every provider variable.

### LLM7

```env
LLM7_API_KEYS=
LLM7_MODELS=DeepSeek-V4-Flash-0731,GLM-5.3-Flash,minimax-m2.7,DeepSeek-V4.1-Flash
LLM7_BASE_URL=https://api.llm7.io/v1

LLM7_VISION_API_KEYS=
LLM7_VISION_MODELS=kimi-k3,llama-4-maverick,minimax-m3
LLM7_VISION_BASE_URL=https://api.llm7.io/v1
```

- Provider ID: `llm7` (shown as **LLM7**). OpenAI-compatible; the base URL already contains `/v1`
  (chat goes to `.../v1/chat/completions`, health probes to `.../v1/models`).
- LLM7 provides a **free-token quota**, not permanently free model pricing: the models themselves have
  model-level pricing. Quotas, limits and model availability can change, so check your account's current
  quota; nothing here promises unlimited usage.
- Text requests use `LLM7_MODELS` and `LLM7_API_KEYS`; image requests use only `LLM7_VISION_MODELS` and
  `LLM7_VISION_API_KEYS`. With no vision pool, images get `503 no_vision_route`.
- A model receives images only if it is listed in the vision pool; the router keeps no per-model capability data.
- Keys and models are comma-separated; every key x model pair is a target, in the configured order, and
  LLM7 joins the normal fallback chain like any other provider.

Retryable statuses:

```text
401,402,403,404,408,409,425,429,500,501,502,503,504,520,521,522,523,524,529
```

HTTP 400 from a provider also falls back to the next target. A generic 400
(unsupported parameter, schema quirk) does not cool the target down, and if
every target answers 400 the client receives the 400 instead of a 502.



## Priority Routing

```env
TEXT_PRIORITY_MODELS=gemini/G1,groq/GR2,gemini/G3
VISION_PRIORITY_MODELS=gemini/V1,groq/V2
```

Priority targets are tried first, in exactly this order (providers may be
interleaved), and the first success stops the request. Priority is
**model-centric**: each entry is one provider/model, and *every eligible key* of
it is tried in key order (`gemini/G1/key1, key2, key3`) before the walk moves to
the next entry (`groq/GR2` keys, then `gemini/G3` keys). Only when all entries
and all their keys have failed or cooled down does the normal fallback start. **Empty or unset means no
priority phase**: routing goes directly to the normal fallback. `TEXT_PRIORITY_MODELS` sets the text pool list and
`VISION_PRIORITY_MODELS` the vision pool list (**empty or unset inherits `TEXT_PRIORITY_MODELS`**, same models in the same order);
entries only match the pool being routed, so there is never text-to-vision or
vision-to-text fallback. Pinned requests ignore priority and sticky. A pinned success is not remembered as the session's sticky target. If a client names a model this pool serves, only priority entries of that model apply, so a priority entry of a different model never outranks the requested one.

A session's last successful target stays sticky for 20 minutes (refreshed by each success) and is tried before priority. If it fails, the **other keys of the same provider/model** are tried next (in key order); only when that model is exhausted does routing continue with the priority models listed **after** it (priority `A,B,C,D` with sticky on `B` continues `B keys → C keys → D keys`, then the normal fallback; `A` is not revisited in the priority phase). The normal fallback itself is unchanged: it is the full Provider → Key → Models list of every target not yet tried. A fallback success is remembered the same way (exact provider + model + key).

Stickiness is **per session** (`X-Multi-AI-Session-ID`; reuse the `x-multi-ai-session-id` response header) and remembers the exact `provider + key + model`, not just the model name. Requests that send **no** session header (Claude Code, Codex, OpenAI SDKs…) share one default session per protocol and pool, so they get the sticky behaviour automatically. A different explicit session id never inherits it, text and vision keep separate sticky targets, and a success never reorders the priority list: a new session always starts at the first configured priority entry. A sticky success ends the request (no priority/fallback call), and a target is never called twice in one request. Example with `TEXT_PRIORITY_MODELS=groq/A1,openrouter/B1`: request #1 runs `priority groq/A1/key1 → 200`, so request #2 of the same session runs `sticky groq/A1/key1 → 200` and stops; if the sticky call fails, request #2 continues `priority groq/A1 (its other keys) → priority openrouter/B1 → fallback`, never repeating the sticky target.

The same session boundary scopes Gemini thought signatures: a `thoughtSignature`
received for one session is only echoed back inside that session, and a tool call
whose arguments are not valid JSON is refused for a Gemini target (`400
invalid_tool_arguments`) instead of silently becoming `{}`, so another target
can still carry it. See `Architecture.md` -> *Tool calls and thought signatures*.

After priority, the normal fallback is key-scoped: **Provider -> Key -> Models ->
next Key -> Models -> next Provider**. Each key restarts at its provider's first
model, and a target already tried in the same request is skipped. See
`Architecture.md` for details.

## Endpoints

### Gateway (public)

| Method | Endpoint |
|---|---|
| GET | /health |
| GET | /v1/models |
| POST | /v1/messages |
| POST | /v1/responses |
| POST | /v1/chat/completions |
| POST | /v1beta/models/{model}:generateContent |

Optional pin headers (same auth as the other gateway endpoints) call one exact
target instead of letting the router choose — the Playground uses them:

| Header | Meaning |
|---|---|
| `x-multi-ai-pin-provider` | Only this provider's targets are eligible. With a request `model`, only that model on that provider. |
| `x-multi-ai-pin-key-index` | With a provider pin, only that 0-based key. Ignored without one. |

A pinned request never falls back to another provider, key or model, and it
ignores cooldown so a rate-limited key can still be tested. A pin that matches
no configured target returns `404 no_route`.

### Control panel (read-only)

Served under `/api`. Requires the client token when `MULTIAI_ROUTER_API_KEYS` is
set. With no keys configured it answers loopback callers only, so an
unauthenticated gateway cannot be driven from another host. None of these can
change routing, health or provider behaviour.

| Method | Endpoint | Purpose |
|---|---|---|
| GET | /api/health | Health with provider rollups and monitor state |
| POST | /api/health/refresh | Run one health cycle now |
| GET | /api/providers | Provider rollup joined with safe config |
| GET | /api/models | Model catalogue with health and usage |
| GET | /api/requests | Request log (`limit`, `cursor`, `outcome`, `provider`, `protocol`, `status`, `session`), plus `pending`: calls still running. `session=<id>` is the explicit sticky-session lookup |
| GET | /api/requests/stream | Server-sent events for Live Logs: a `snapshot`, then a `pending` / `entry` event per change |
| GET | /api/requests/:id | One request's full lifecycle, by its `x-multi-ai-request-id` (or internal sequence) — never a session id, which names many requests |
| GET | /api/router/preview | The routing decision for a protocol/model |
| GET | /api/analytics | Series and breakdowns (`range=5m\|15m\|1h\|6h\|24h\|7d`) |
| GET | /api/config | Effective configuration, secrets as counts only |
| GET | /api/system | Runtime, uptime and health-monitor scheduling |

`/api/config` reports key **counts** and env var **names**; it has no code path
that reads key material, so credentials cannot leak through it.

## Control Panel

A React + Vite single-page app in `ui/`, served by the gateway itself.

### Development (one command)

```powershell
npm install
npm run dev
```

Then open **http://localhost:999**. That is the only URL you need.

`npm run dev` starts everything in one terminal:

- the gateway (`node --watch src/server.js`) on `PORT` (default `999`), and
- the Vite dev server for the React panel on a private loopback port.

The gateway stays the single browser-facing origin. In development it forwards
panel requests (the page, modules and the HMR WebSocket) to Vite, and keeps
handling `/api/*`, `/v1/*`, `/v1beta/*` and `/health` itself, so the panel uses
the same relative URLs as in production, with no CORS setup. The Vite port is
chosen automatically and is an implementation detail; you never open it.

- **Frontend changes** (`ui/src`) hot-reload in the browser through Vite HMR.
- **Backend changes** (`src/`) restart the gateway automatically.
- **Ctrl+C** stops both processes. If either one exits, the other is stopped too.
- **Loopback by default.** When `HOST` is unset, `npm run dev` listens on
  `127.0.0.1` only, because the dev server exposes your project's source files.
  Set `HOST` explicitly (for example `HOST=0.0.0.0` to try the panel from a
  phone) to listen elsewhere; remote clients are then still refused Vite's
  filesystem endpoints (`/@fs`, `/__open-in-editor`) apart from the panel's own
  prebundled dependencies. `npm start` is unaffected and keeps its own `HOST` rules.

Production does not use any of this: `npm run ui:build` writes `ui/dist` and
`npm start` serves it with no Vite involved.

```powershell
npm run dev         # gateway + Vite, open http://localhost:999
npm run dev:server  # gateway only, with restart on change (no hot-reloading UI)
npm run ui:dev      # optional: Vite on its own, frontend-only work (see below)
npm run ui:build    # production build into ui/dist
npm start           # production: gateway serving ui/dist
npm run test:ui     # frontend unit tests
npm run test:all    # backend + frontend
```

`npm run ui:dev` is only for advanced frontend-only work against a gateway you
started separately: Vite prints its own URL (default `:5173`) and proxies `/api`,
`/v1`, `/v1beta` and `/health` to `http://localhost:999` (override with
`MULTIAI_ROUTER_ORIGIN`). Normal development does not need it.

If `npm run dev` reports that the gateway is not listening, the port is usually
taken or, on Linux, below 1024 without root. Set `PORT` in `.env` to a free port.

Twelve pages: Dashboard, Providers, Models, Health Monitor, Router, Fallback,
Playground, Requests, Live Logs, Analytics, Configuration, System.

Live Logs shows one card per API call and updates it in place while the call
runs. The card header carries the call as a whole (`ROUTING` → `RUNNING` →
`RETRYING` → `SUCCESS` / `FAILED`). Inside it, every model the router tries gets
its own box: `CALLING` (on the wire, with a live timer), `FAILED` (status and
reason) or `SUCCESS`. When a box fails, a `FALLBACK` line follows and the next
model's box appears below it. Every change is pushed over a server-sent event
stream, so boxes appear with no polling delay; the page polls only while that
stream is not connected. The page keeps the last 50 calls; when a newer one
arrives past that, the oldest is dropped.

To see the Live Logs page populated without real provider keys, run
`npm run ui:build` then `npm run demo:live-logs`. It starts the router against
scripted mock providers and prints a `/live-logs` URL; the traffic includes
`429` key 0 -> key 1 fallbacks and a request that exhausts its targets.

Real-time data uses polling with conditional `ETag` requests — the gateway has
no push channel and no fake one is invented. Polling pauses while the tab is
hidden and backs off when the gateway is failing.

## Health

Each `provider + model + key` target is ranked independently and probed in the
background every 15 minutes. A failed target is cooled down for 20 minutes
without affecting its sibling keys or models.

Probes are provider-aware and quota-free: they list the provider's models
rather than generating anything.

```text
Gemini             GET {base}/v1beta/models   (x-goog-api-key)
OpenAI-compatible  GET {base}/v1/models        (Bearer)
```

Probe outcomes that cannot establish health — a missing `/models` endpoint, or
a provider with no safe probe — leave the target `unknown`. The router reports
`unknown` rather than claiming a provider is healthy.

`GET /health` reports per-target `status` (`unknown`, `healthy`, `failed`,
`cooldown`), `score`, `lastStatus`, `lastReason`, latency, success/failure
counts and `cooldownUntil`. It never returns API keys or upstream bodies.

## Test

```powershell
npm test           # backend: 191 tests
npm run test:ui    # frontend: 47 tests
npm run test:all   # both
```

## Security

Keep real API keys in `.env`. Never commit credentials.

Client authentication is optional. With `MULTIAI_ROUTER_API_KEYS` unset, only
loopback callers (`127.0.0.1`, `::1`) may use the proxy or the read-only `/api`
surface; requests from any other host are refused with `401`. Set
`MULTIAI_ROUTER_API_KEYS` to serve remote clients, and set `HOST=127.0.0.1` to
keep the listener itself on loopback. `/health` and `/v1/models` stay public
readiness metadata and never carry credentials.

The control panel never receives provider credentials. `/api/config` reports a
key *count* per provider and the *names* of the environment variables to edit;
it renders as `Configured` / `Not configured` and never as a value.

The one secret the browser holds is the gateway's own client token
(`MULTIAI_ROUTER_API_KEYS`), entered in the panel's connection dialog. It is
stored in `sessionStorage` — never `localStorage`, never a URL, never a log —
and shown masked, with no reveal or copy control.

Every error message that crosses into the UI is scrubbed of credential-shaped
text on the server (`src/observability/sanitize.js`) and again in the browser
(`ui/src/lib/sanitize.js`), so a provider error cannot echo a key into a table,
a toast or the console.
