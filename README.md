# ApiRouter

**Multi-provider AI gateway with a UI-controlled fallback chain, health-aware routing, remembered successes, and a built-in control panel.**

ApiRouter gives OpenAI-compatible and native AI clients one local endpoint while handling provider selection, model routing, key rotation, cooldowns, retries, and observability.

## Features

- **Multi-provider routing** — route requests across configured AI providers and models.
- **UI-controlled fallback chain** — one ordered list, edited in the control panel, followed exactly.
- **Multi-key fallback** — every eligible API key of a model is tried before the next model.
- **Health-aware fallback** — cooling targets are skipped and reported, never hidden.
- **Automatic ordering** — with nothing selected, models are ordered by measured health and latency.
- **Remembered successes** — the provider, model and exact key that last answered are tried first on the next request (20-minute TTL), with no mode to set.
- **Key-aware routing** — keys are handled independently within each provider/model target.
- **Unified Model Configurator** — declare text, vision, tool, media and structured-output capabilities per model in one place, and switch a model off from the same page; a request only reaches a model that declares what it needs.
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

Routing is decided by the **Fallback Chain** — one ordered list, configured in the control panel under **Configure → Fallback Chain**.
It is the single source of truth: there is no separate priority list and no
separate normal-fallback path, and nothing re-sorts a chain you have configured.

```text
Configured chain:

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
the router does not have. The panel shows this as **Automatic Health-Based Fallback**.

### How routing works

There is no mode switch. The routing mode is derived from the saved
**Manual Model Selection**, and a successful provider, model and key is always
remembered either way:

| Selection | Behaviour |
|---|---|
| **Nothing selected** | Automatic health-based routing: healthy models with lower measured latency first, unmeasured models after them in a stable configured order. The provider, model and key that last answered are remembered and tried first on the next request. |
| **Models selected** | Two batches that alternate in one request. **Manual:** your selected models, in exactly the saved order (interleaved providers stay interleaved), every eligible key of a model before the next — led by the remembered target when it is one of the selected models. **Health:** if all of them fail, every model you did *not* select, ordered by measured health and latency. Then Manual → Health again, for as long as a target is permitted another attempt. See below. |

#### Manual Model Selection in detail

- **Exclusion is by model, not provider.** With Gemini A, Groq B, Gemini C selected, an unselected Gemini B is still a phase-2 fallback. Parked (disabled) entries and models narrowed to no keys are *not* used as fallbacks.
- **Manual → Health → Manual → Health.** A success in any batch ends the request. Every batch after the first only holds targets a retry is *permitted* for; a new round never authorises a retry by itself, and a round with nothing permitted calls nothing.
- **Retries are per target.** Each target is retried at most once, and only after a transient failure (timeout, 429, 5xx, transport error) that *this request* caused. A target that was already cooling down, or was cooled by a credential-level or non-transient failure (400/401/402/403/404/413/422), or refused the request without a cooldown, is never retried. The only cooldown a retry looks past is the one this request itself set through a transient failure, and only while it is still exactly that cooldown — otherwise every target that failed in the first batch would be sitting in the cooldown that failure just created and nothing could be retried. A health check never clears a cooldown.
- **Stable order, bounded work.** Both batches are ordered once, when the request starts; a health refresh can only change the next request's Health order. Calls are bounded by (1 + the per-target retry allowance) × the number of distinct targets, so routing always ends.
- **Fails closed.** If none of the selected models can serve the request (wrong protocol, no matching key), the request fails rather than substituting other models. Pinned requests never use any of this.
- Live Logs / request timelines label each attempt `manual-selection`, `health-fallback`, `manual-retry` or `health-retry`.

**Reset Fallback** clears the remembered model/key preferences immediately, with
no restart. It never deletes the saved selection, the providers,
the API keys, the configured models, valid health measurements or a genuine
cooldown.

### Disabling a model (Model Switch)

The **Switch** column on the Models page turns one provider/model off or on
(`PUT /api/models/switch` with `{ "provider", "model", "disabled" }`). It works
in the automatic order and in Manual Model Selection alike:

- A disabled model is removed before any plan is built, so it is not tried as a
  selected model, as a health-batch fallback, or as a last resort.
- A request that is still **waiting for a response** from that model is aborted
  and falls through to the next model right away.
- Disabling is not a failure: nothing is put in cooldown and no health figure
  changes, so enabling the model restores it exactly as it was.
- A response that has already started streaming to the client is left to finish;
  it cannot be handed to another model mid-stream.
- Pinned requests (the Playground testing a specific key) ignore the switch.

State is stored in `DISABLED_MODELS_FILE` (default `data/disabled-models.json`).

### Model Configurator (capabilities and eligibility)

The **Model Configurator** (Configure -> Model Configurator, `/model-config`) is one
unified page for every model the gateway knows. Each row
shows the provider/model, its protocols, how many keys it has, whether it
is enabled, and one checkbox per capability. A model is declared once instead of
being configured separately for text and vision.

The capability vocabulary is intentionally broader than what any one adapter can do:

```text
text_input   text_output   tool_calling   image_input   image_output
video_input  video_output  audio_input    audio_output  file_input
structured_output  streaming  reasoning   embeddings    web_search
code_execution
```

- A model that comes only from `.env` (or a saved custom endpoint) is **inferred**:
  its capabilities default to `text_input` and `text_output` only. Any other
  capability (`image_input`, `tool_calling`, `streaming`, `structured_output`, …)
  must be declared on the Model Configurator before it can be used. The page marks
  these rows as environment-provided.
- Saving the row makes it **configured**, and its checkboxes become authoritative for
  that exact `provider/model`. Deleting the declaration returns the model to the
  inferred defaults. Provider, model and credentials still come from the environment
  or the Custom Endpoints page; the configurator never stores a key or a base URL.
- `enabled` is one decision, shared with the Models page **Switch**: changing either
  surface updates the other, so the two can never contradict each other. A disabled
  model is removed before any plan is built, is not a failure, and does not cool down.
- `reasoning` is a preference, not a hard requirement. It never filters out a model
  that can otherwise serve the request.
- An optional **protocol hint** narrows a model to one wire format when its provider
  offers more than one. A hint the provider does not offer is ignored and reported as
  a warning, never forced onto the upstream.
- `image_output`, `audio_output`, `video_output` and `embeddings` can be declared, but
  no adapter in this build executes them. The page reports those checkboxes as
  declared-but-not-executable rather than pretending the route will work.

#### How a request uses capabilities

Requirements come from the **endpoint and payload**, never from the model name:

1. Detect what the request needs: media parts (`image`, `audio`, `video`, `file`),
   tools, a structured response format, an explicit output modality, and streaming.
2. Remove models switched off in the configurator or on the Models page.
3. Keep only targets that declare every required capability *and* whose adapter can
   actually execute it. A declared capability the adapter cannot execute is not
   eligible.
4. Walk the remaining candidates in the normal order: **Manual Model Selection first,
   in its saved order**, then **Automatic Health-Based Fallback** for the rest. Key
   rotation, cooldowns, remembered successes and retries behave exactly as described
   above.
5. A failure never ends the walk while another eligible target remains.

The capability filter is applied once, before the first upstream attempt. If a stream
has already started, it is never handed to another model. When nothing can serve the
request the gateway fails closed with a reason instead of substituting a model:

| Situation | Response |
|---|---|
| Every model is switched off | `503`, `error.type: "models_disabled"` |
| Targets exist, but none can declare and execute the required capabilities | `503`, `error.type: "no_capable_route"`, with `required_capabilities` and the first `excluded_candidates` |
| The client names a configured model that cannot serve this request | `400`, `error.type: "model_capability_mismatch"` |

The required capabilities and excluded candidates are also recorded on the request
timeline, so Live Logs and the request detail can explain a route that was never taken.

#### Persistence

Model configuration is non-secret JSON: ids, enabled flags, capabilities and optional
display metadata. It is stored in `data/model-config.json` (`MODEL_CONFIG_FILE`), and
can be persisted to a GitHub branch so it survives a redeploy:

- Set `MODEL_CONFIG_GITHUB_REPO` and `MODEL_CONFIG_GITHUB_TOKEN`, optionally
  `MODEL_CONFIG_GITHUB_BRANCH` (default `main`) and `MODEL_CONFIG_GITHUB_PATH`
  (default `model-config.json`). Any `MODEL_CONFIG_GITHUB_*` value that is not set
  falls back to the matching `CUSTOM_ENDPOINTS_GITHUB_*` value, so one repository and
  token can serve both stores. No encryption secret is needed because no credential is
  written there.
- On startup GitHub is the source of truth and the document is restored before the
  first request is routed. If GitHub holds nothing yet, the local file is uploaded once.
  If GitHub cannot be reached, the last local configuration stays usable, the retry
  loop keeps trying, and **writes are refused with `503`** so a stale copy can never
  overwrite a newer remote one.
- The GitHub Contents API `sha` is the revision. A save sends the revision it read; if
  the remote document changed in the meantime, GitHub refuses the write and the change
  is rejected with `409 conflict`. Nothing is retried over it automatically: refresh
  (`POST /api/model-config/refresh`) re-reads the document first.
- The schema is versioned (`version: 1`). A document written by a newer build is
  refused and is never overwritten. Credential-shaped fields and token-shaped values
  are rejected at validation time.

The page and API expose `GET /api/model-config`, `POST /api/model-config`,
`PUT`/`PATCH`/`DELETE /api/model-config/:id` and `POST /api/model-config/refresh`.
The payload contains effective rows, storage state (`file` or `github`, ready or with
its error), warnings, the capability schema and the adapter matrix; it never contains
a key, a base URL or any other credential.

### Sticky sessions

The remembered target is scoped per session and protocol, and lasts
**20 minutes** after its last success. Sessions are identified with:

```text
X-Multi-AI-Session-ID
```

The response also returns the session ID so clients can reuse it. Requests
without a session header share one default session per protocol.

### Capabilities

Routing is capability-based: a request's required capabilities (detected from its
content, such as image parts) decide which models are eligible. A model that
declares `image_input` and whose adapter can execute it can serve image requests;
one that does not cannot. Every model shares one chain, one health registry,
one set of cooldowns, one set of latency measurements and one remembered target.

### Failures and cooldowns

A failure cools down what it actually describes:

| Failure | Cools down |
|---|---|
| Key/account rejection (`401`, `402`, `403`) | Only that key + model — the key's other models are still tried, each on its own |
| Request or model problem (`400`, `404`, `413`, `422`) | Only that target — never a sibling that shares the key |
| Rate limit (`429`) | Only that key + model, for the upstream `Retry-After` (5s–12min), or 60s without one |
| Other client errors (`405`, `410`, `415`, `451` ...) | Only that key + model, for 1 minute |
| Anything else (`5xx`, timeouts) | Only that target |

A target is one provider + model + key. When one key of a model fails, the model's
other keys are tried next; the model only cools down as a whole once every one of
its keys has failed.

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
| GET | `/api/fallback` | The saved selection, the derived mode and the model catalogue with health and latency |
| PUT | `/api/fallback` | Save the Manual Model Selection |
| POST | `/api/fallback/reset` | Clear remembered model/key preferences (Reset Fallback) |
| GET / POST | `/api/model-config` | Effective model declarations (capabilities, enabled, storage state) / create one declaration; never returns a credential |
| PUT / PATCH / DELETE | `/api/model-config/:id` | Change or remove one declaration (`enabled` stays in step with the Models page Switch) |
| POST | `/api/model-config/refresh` | Re-read the persisted document (for example after a `409 conflict`) |
| GET | `/api/router/preview` | Preview routing decisions |
| GET | `/api/analytics` | Usage and performance analytics |
| GET | `/api/config` | Effective configuration without secrets |
| GET | `/api/system` | Runtime and health-monitor state (includes the gateway on/off state) |
| GET | `/api/gateway` | Gateway on/off state (`running` or `paused`) |
| POST | `/api/gateway/shutdown` | Shut the gateway down: no proxy request or health probe reaches an upstream |
| POST | `/api/gateway/resume` | Turn the gateway back on |
| GET / POST | `/api/custom-endpoints` | List / create a saved custom endpoint (see [Saved custom endpoints](#saved-custom-endpoints)); keys are accepted but never returned |
| PUT / DELETE | `/api/custom-endpoints/:id` | Change (name, base URL, API style, models, `addApiKeys` / `apiKeys`) or remove a saved custom endpoint |
| POST | `/api/playground/custom` | Forward ONE request to a base URL, API key and model typed in the Playground (see [Custom endpoint playground](#custom-endpoint-playground)) |

### Shutdown and resume

The Control Panel header has a **Shutdown** button (it becomes **Resume** while the gateway is shut down). Shutting down *pauses* the gateway rather than exiting the process:

- every proxy request (`/v1/...`, `/v1beta/...`, including `count_tokens`) is refused with `503` and `error.type: "gateway_paused"`;
- a request already walking its fallback chain makes no further upstream attempt (an attempt already in flight is allowed to finish);
- the health monitor stops probing and a manual health refresh returns `409`;
- the Control Panel, `/api/*`, `/health` and the keep-alive ping stay up, so the panel can resume the gateway.

The state is saved to `data/gateway-state.json` (`GATEWAY_STATE_FILE`), so a shutdown survives a restart or crash: the gateway boots paused and stays that way until you press Resume. A missing or unreadable file means running. On a host with an ephemeral disk (Render without a persistent disk) a redeploy wipes the file, which turns the gateway back on.

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
- Model Configurator
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

### Saved custom endpoints

A Playground test forgets everything. To keep a custom endpoint, add it on the **Custom Endpoints** page of the control panel (`/custom-endpoints`, under Configure). A saved endpoint becomes a provider named `custom-<name>` and behaves like any provider configured through the environment: it appears in the Fallback Chain, is health-checked, cools down on failures, supports sticky routing, and can be switched off.

- **One base URL, one API style** (OpenAI Chat, OpenAI Responses, Anthropic Messages or Gemini) per endpoint.
- **Any number of models** (one per line) and **any number of keys** (one per line). Every model is tried with every key, in the order you set in the Fallback Chain.
- The Playground never saves anything: use it to test an endpoint first, then add it on the Custom Endpoints page.
- Changes take effect immediately, with no restart. Removing an endpoint removes it from routing at once.
- Keys are stored in `data/custom-endpoints.json` (override with `CUSTOM_ENDPOINTS_FILE`), like the other `data/` state. They are sent to the gateway but never returned: the control panel only shows how many keys an endpoint has, and the keys are redacted from any error text.
- **Models and keys.** Any number of models (one per line) and any number of keys (one per line). Every model is tried with every key, in the order you set in the Fallback Chain. Image-capable models serve image requests through capability-based routing: declare `image_input` on the model in the Model Configurator.
- The same address rules as the Playground apply: private, loopback and metadata addresses are refused (hostnames are resolved when you save) unless `PLAYGROUND_ALLOW_PRIVATE_HOSTS=1`. A local model with no key needs a placeholder key such as `none`.
- **Surviving a redeploy.** By default the data file lives on the server's disk. On a host that wipes its disk on every redeploy or wake-up (a free Render web service) that would lose your saved endpoints, so they can be kept in a GitHub branch instead. Set `CUSTOM_ENDPOINTS_GITHUB_REPO` (`owner/name`), `CUSTOM_ENDPOINTS_GITHUB_TOKEN` (a fine-grained token with Contents: read and write on that repo) and `CUSTOM_ENDPOINTS_SECRET` (any passphrase of 12+ characters). Everything is encrypted with AES-256-GCM before it is uploaded, so the repository only ever holds ciphertext, but keep the secret safe: with a different secret the saved data cannot be read, and it is never overwritten. It is written to the branch `main` by default (`CUSTOM_ENDPOINTS_GITHUB_BRANCH`; saves commit straight to it with no PR, and on `main` each save redeploys the service, so set it to e.g. `apirouter-data` to avoid that), in `custom-endpoints.enc.json` (`CUSTOM_ENDPOINTS_GITHUB_PATH`). On startup GitHub is the source of truth; if it is unreachable, changes are refused (so a stale list can never overwrite the saved one) and the endpoints load as soon as it answers. Endpoints that already exist on the disk are uploaded the first time.

### Custom endpoint playground

The Playground has two modes, switched at the top of the page:

- **Router** sends a request through the gateway's own routing, with the providers and keys you configured.
- **Custom endpoint** tests any platform without configuring it: type a **base URL**, an **API key** and a **model**, pick the API style (OpenAI Chat, OpenAI Responses, Anthropic Messages or Gemini) and send a prompt. It answers "does this key, endpoint and model work?" and nothing more. The request bypasses routing, health, cooldown and fallback, and is not added to the request log. With no providers configured the Playground opens on this mode.

The base URL is the API root (`https://api.openai.com/v1`); the endpoint path is added the same way the router adds it for a configured provider. The API key can be left blank for local models.

The call is made by the gateway, not the browser, because most provider APIs send no CORS headers. The key travels in the request body to your own gateway, is held in memory for that one call, and is never stored or logged; the browser keeps only the base URL, model and API style (in local storage) between visits, never the key. Any upstream error text is scrubbed of the key before it is returned.

Because the gateway fetches a URL chosen by the caller, this endpoint is restricted:

- only `http://` and `https://` base URLs, with no embedded credentials, query string or fragment;
- private, loopback, link-local, CGNAT and cloud-metadata addresses are refused, checked on the address the connection really uses, so a hostname that resolves to a private address is refused too;
- redirects are reported, never followed;
- it follows the same token rule as every other `/api/*` route, and the gateway shutdown switch.

To test a model on the same machine or LAN (Ollama, LM Studio, another gateway), start the gateway with `PLAYGROUND_ALLOW_PRIVATE_HOSTS=1`. Leave it off on any gateway reachable by people you do not trust, and set `APIROUTER_API_KEYS` there: with no token set, anyone who can reach `/api/*` can use this endpoint.

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
| `GET/POST /api/*` (control panel, including `POST /api/playground/custom`) | yes |

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
