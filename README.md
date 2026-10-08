# ApiRouter

Multi-provider AI routing gateway with health-based fallback.

## Client Integration Guides

- [Claude Code](docs/clients/CLAUDE_CODE.md)
- [Codex](docs/clients/CODEX.md)
- [Qwen Code](docs/clients/QWEN_CODE.md)
- [OpenCode](docs/clients/OPENCODE.md)
- [Generic OpenAI-compatible Clients](docs/clients/GENERIC_OPENAI.md)
- [Other AI Clients](docs/clients/OTHER_CLIENTS.md)
- [All Client Protocols](docs/clients/CLIENTS.md)


## One-Command Startup (Recommended)

### Development Mode (
pm run dev:all)
Runs both the backend API router (http://localhost:8788) and the frontend Vite dev server (http://localhost:5173) with live proxying in a single cross-platform command:

`ash
npm run dev:all
`
- Works identically on **Windows (CMD / PowerShell)**, **Linux**, and **macOS**.
- Detects port conflicts before starting.
- Press Ctrl+C to cleanly terminate both processes and their child trees.

### Production / VPS Mode (
pm run start:all)
Builds the production control panel and starts the backend serving everything from port 8788:

`ash
npm run start:all
`

---

## Quick Start

```powershell
git clone https://github.com/mainnetwallet/ApiRouter.git
cd ApiRouter
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

### Running again (second time onwards)

The clone, `npm install` and `.env` setup are one-time steps. Next time, just:

```powershell
cd ApiRouter
git pull origin main
npm start
```

After pulling updates (`git pull`), rebuild only what changed:

```powershell
cd ApiRouter
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
in the browser, and starts the gateway on `localhost:8788`. If the panel has not been
built, that address serves a short page explaining how to build it — the
gateway itself needs no build step and is unaffected.

## Configuration

A provider needs:

- API keys
- Models
- Base URL

Configure them in `.env`.



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

Served under `/api`. Requires `APIROUTER_API_KEYS` when that is set; open
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

The control panel never receives provider credentials. `/api/config` reports a
key *count* per provider and the *names* of the environment variables to edit;
it renders as `Configured` / `Not configured` and never as a value.

The one secret the browser holds is the gateway's own client token
(`APIROUTER_API_KEYS`), entered in the panel's connection dialog. It is
stored in `sessionStorage` — never `localStorage`, never a URL, never a log —
and shown masked, with no reveal or copy control.

Every error message that crosses into the UI is scrubbed of credential-shaped
text on the server (`src/observability/sanitize.js`) and again in the browser
(`ui/src/lib/sanitize.js`), so a provider error cannot echo a key into a table,
a toast or the console.
