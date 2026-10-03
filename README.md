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
http://localhost:8788
```

Open `http://localhost:8788` for the control panel.

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
in the browser, and starts the gateway on `localhost:8788`. If the panel has not been
built, that address serves a short page explaining how to build it — the
gateway itself needs no build step and is unaffected.

## Configuration

A provider needs:

- API keys
- Models
- Base URL

Configure them in `.env`.

### Images (separate vision providers)

Many models are text-only and answer HTTP 400 to a request that carries an image,
so image requests use a pool of their own. Every provider can be given a separate
vision key, base URL and model list:

```env
GEMINI_VISION_API_KEYS=key1,key2
GEMINI_VISION_BASE_URL=https://generativelanguage.googleapis.com/
GEMINI_VISION_MODELS=gemini-3.7-flash
```

The same three variables exist for every provider (`GROQ_VISION_*`,
`MISTRAL_VISION_*`, ...); Cloudflare takes `CLOUDFLARE_VISION_ACCOUNT_IDS` instead
of a base URL. Nothing is shared with the normal `<PROVIDER>_API_KEYS` /
`_BASE_URL` / `_MODELS`.

- A request containing an image, in any client protocol, goes **only** to the vision
  targets, with the usual fallback between them.
- A text request never reaches a vision target.
- A vision provider is active once it has keys, models and a base URL.
- While no vision provider is active, an image request fails with `503` and
  `{"error":{"message":"No vision provider is configured","type":"no_vision_route"}}`.
  It is never sent to the normal text pool, for any provider.
- Requests pinned with the `x-multi-ai-pin-*` headers are matched inside the pool
  the request belongs to (vision pool for images, normal pool otherwise).

### Vercel AI Gateway

- Provider ID: `vercel`, OpenAI-compatible (`https://ai-gateway.vercel.sh/v1`).
- Text pool: `VERCEL_API_KEYS`, `VERCEL_BASE_URL`, `VERCEL_MODELS`.
- Separate vision pool: `VERCEL_VISION_API_KEYS`, `VERCEL_VISION_BASE_URL`, `VERCEL_VISION_MODELS`.
- Several keys (`key1,key2`) each become their own routable target.
- Goes through the normal fallback, health monitoring, streaming and pin headers
  (`x-multi-ai-pin-provider: vercel`). Model ids are sent exactly as configured.
- The model list is what you configure; the router does not discover models.

Free-model availability and quotas are controlled by Vercel and can change.

### OpenCode Zen

- Provider ID: `opencode`, OpenAI-compatible (`https://opencode.ai/zen/v1`; the base URL already
  contains `/v1`, so requests go to `.../zen/v1/chat/completions` and health probes to `.../zen/v1/models`).
- Text pool: `OPENCODE_API_KEYS`, `OPENCODE_BASE_URL`, `OPENCODE_MODELS` (order is the priority order).
- Separate vision pool: `OPENCODE_VISION_API_KEYS`, `OPENCODE_VISION_BASE_URL`, `OPENCODE_VISION_MODELS`.
  Without it, image requests fail with `503 no_vision_route`.
- Several keys each become their own target; fallback, health, streaming and pin headers work as for every provider.

Free-model availability is controlled by OpenCode and can change.

### NVIDIA Build

```env
NVIDIA_API_KEYS=
NVIDIA_MODELS=
NVIDIA_BASE_URL=https://integrate.api.nvidia.com/v1

NVIDIA_VISION_API_KEYS=
NVIDIA_VISION_MODELS=
NVIDIA_VISION_BASE_URL=https://integrate.api.nvidia.com/v1
```

- Provider ID: `nvidia`. NVIDIA Build is OpenAI-compatible; the base URL already contains `/v1`
  (chat goes to `.../v1/chat/completions`, health probes to `.../v1/models`).
- Text/coding requests use `NVIDIA_MODELS`; image requests use `NVIDIA_VISION_MODELS`.
  Vision never falls back to NVIDIA text models: with no vision pool, images get `503 no_vision_route`.
- Keys and models are comma-separated; every key x model pair is a target, in the configured order.
- Free endpoint availability and limits may change, and real access needs a valid NVIDIA API key.

### Nous Portal

```env
NOUS_API_KEYS=
NOUS_BASE_URL=https://inference-api.nousresearch.com/v1
NOUS_MODELS=poolside/laguna-s-2.1:free,stepfun/step-3.7-flash:free,meituan/longcat-2.5-preview:free,inclusionai/ling-3.0-flash-fin:free,meituan/longcat-2.0:free,poolside/laguna-xs-2.1:free,inclusionai/ling-3.0-flash-sante:free,upstage/solar-pro4:free

NOUS_VISION_API_KEYS=
NOUS_VISION_BASE_URL=https://inference-api.nousresearch.com/v1
NOUS_VISION_MODELS=stepfun/step-3.7-flash:free
```

- Provider ID: `nous`. Nous Portal is OpenAI-compatible at `https://inference-api.nousresearch.com/v1`.
- The text pool is ordered for coding/agent fallback: Laguna S 2.1 → Step 3.7 Flash → LongCat 2.5 Preview → Ling 3.0 Flash Fin → LongCat 2.0 → Laguna XS 2.1 → Ling 3.0 Flash Sante → Solar Pro 4.
- The vision pool is separate and currently uses **Step 3.7 Flash**, which supports native image input as well as coding/agent workflows.
- Free routes use the `:free` model IDs. Nous says the Free plan provides free models only, with standard rate limits and $0 monthly credits; availability can change.
- Several keys are comma-separated and become independent fallback targets.
- Vision requests never fall back to the Nous text pool; if `NOUS_VISION_API_KEYS` is empty, image requests return `503 no_vision_route`.

Retryable statuses:

```text
401,402,403,404,408,409,425,429,500,501,502,503,504,520,521,522,523,524,529
```

HTTP 400 from a provider also falls back to the next target. A generic 400
(unsupported parameter, schema quirk) does not cool the target down, and if
every target answers 400 the client receives the 400 instead of a 502.

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

Served under `/api`. Requires `MULTIAI_ROUTER_API_KEYS` when that is set; open
otherwise. None of these can change routing, health or provider behaviour.

| Method | Endpoint | Purpose |
|---|---|---|
| GET | /api/health | Health with provider rollups and monitor state |
| POST | /api/health/refresh | Run one health cycle now |
| GET | /api/providers | Provider rollup joined with safe config |
| GET | /api/models | Model catalogue with health and usage |
| GET | /api/requests | Request log (`limit`, `cursor`, `outcome`, `provider`, `protocol`, `status`), plus `pending`: calls still running |
| GET | /api/requests/stream | Server-sent events for Live Logs: a `snapshot`, then a `pending` / `entry` event per change |
| GET | /api/requests/:id | One request's full lifecycle |
| GET | /api/router/preview | The routing decision for a protocol/model |
| GET | /api/analytics | Series and breakdowns (`range=5m\|15m\|1h\|6h\|24h\|7d`) |
| GET | /api/config | Effective configuration, secrets as counts only |
| GET | /api/system | Runtime, uptime and health-monitor scheduling |

`/api/config` reports key **counts** and env var **names**; it has no code path
that reads key material, so credentials cannot leak through it.

## Control Panel

A React + Vite single-page app in `ui/`, served by the gateway itself.

```powershell
npm run ui:dev      # dev server on :5173, proxying /api and /v1 to :8788
npm run ui:build    # production build into ui/dist
npm run test:ui     # frontend unit tests
npm run test:all    # backend + frontend
```

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
background every 15 minutes. A failed target is cooled down for 15 minutes
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
