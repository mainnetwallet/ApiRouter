# MultiAI Router — Full Architecture

## Overview

MultiAI Router is a protocol-aware multi-provider AI gateway.

```text
Client
  ↓
HTTP Gateway
  ↓
Authentication
  ↓
Protocol Detection
  ↓
Compatible Targets
  ↓
Health Ranking
  ↓
Sticky Session
  ↓
Fallback Router
  ↓
Provider Adapter
  ↓
AI Provider
```

## Core Flow

1. Client sends a request to one of the supported gateway endpoints.
2. The gateway optionally authenticates the client.
3. The request protocol is detected from the endpoint.
4. Configured provider/model/key combinations are expanded into independent targets.
5. Targets incompatible with the client protocol are excluded.
6. The request's pool (TEXT or VISION) is decided; only that pool's targets are used, never the other.
7. A route plan is built (see "Priority and Key-Scoped Fallback"): a valid sticky target, then optional priority targets, then Provider -> Key -> Models.
8. Targets cooling down in the health registry, and targets already attempted in this request, are skipped. 401/402/403 also cool the same key's sibling models (they describe the key, not the model); other keys and providers are unaffected.
9. The router calls targets sequentially.
10. Retryable failures put the exact target into cooldown and move routing forward.
11. A successful target becomes the session's sticky target.
12. The upstream response is streamed back to the client.

## Priority and Key-Scoped Fallback

Implemented in `src/routing-plan.js` (plan) and `withFallback` in
`src/router.js` (walker). The same code serves both pools; only the target list
differs.

```text
REQUEST -> TEXT pool | VISION pool (never mixed)
  STICKY phase     the session's last successful target, only while its 15-minute TTL is valid
  PRIORITY phase   PRIORITY_MODELS entries, exact env order (optional)
  NORMAL fallback  Provider -> Key -> Models -> next Key -> Models -> next Provider
```

Sticky is a separate leading phase. It never edits the normal fallback list.

- `PRIORITY_MODELS=gemini/G1,groq/GR2,gemini/G3` (or `TEXT_PRIORITY_MODELS` /
  `VISION_PRIORITY_MODELS`, which override it for their pool). Empty = no
  priority phase and no extra work. A priority entry is ONE attempt: that
  provider+model on its first eligible key (key order). Its other keys are tried
  later, at their normal place in the hierarchy.
- Normal fallback is **not** flattened. For every key, the provider's models run
  in configured order before the next key starts, and each key restarts at its
  first model (`K1: G1,G2,G3,G4` then `K2: G1,G2,G3,G4`). A requested model that
  the provider has leads that provider's per-key chain, and providers that serve
  it are tried first.
- A per-request `attempted` set keyed by the health id (pool + provider + model +
  keyIndex) means a target is never called twice in one request. Repeats are
  recorded as `skipped` rows (`already_attempted`), cooling targets as
  `skipped` (`cooldown`); neither counts as an upstream attempt.
- Health is the existing `HealthRegistry`: it only decides eligibility (cooldown,
  default 15 minutes) and no longer reorders the plan. Priority has no state of
  its own, so a failed priority target is tried again on the next request once
  its cooldown has elapsed.
- Precedence: pin (strict: no sticky, no priority) > sticky > priority > normal.
  Every success stores `provider + key + model` as the session's sticky target
  with `expiresAt = now + 15 min` (a timestamp checked at request time, no timer;
  `RouteSession.validTargetId`). Sticky is honoured only while valid, only for a
  target of the request's own pool and protocol, never over cooldown, and not
  over an explicit configured model the sticky target does not serve. If the
  sticky target fails, routing continues with priority, then normal; a target is
  never attempted twice in one request. The next success replaces the sticky and
  restarts the TTL. Text and vision (and each client protocol) keep separate
  sticky state. Health score and latency never reorder anything;
  `/health` and `/api/health` `ranked` list the real route order.
- Every real attempt is logged with its `phase` (`priority` | `fallback`); no
  keys, headers, prompts or bodies are stored.
- Fallback is strictly sequential, with no cap on the number of attempts other
  than the plan itself.

## Supported Endpoints

| Method | Endpoint | Protocol |
|---|---|---|
| GET | `/health` | Router health |
| GET | `/v1/models` | Model discovery |
| POST | `/v1/messages` | Anthropic |
| POST | `/v1/responses` | OpenAI Responses |
| POST | `/v1/chat/completions` | OpenAI Chat Completions |

## Provider Target Model

Every configured provider/model/key combination becomes an independent target:

```text
provider + model + keyIndex
```

Example:

```text
Groq / model-a / key-0
Groq / model-a / key-1
Groq / model-b / key-0
Groq / model-b / key-1
```

This allows one failed API key to enter cooldown while sibling keys remain available.

## Protocol Mapping

```text
AgentRouter → Anthropic Messages, OpenAI Chat, OpenAI Responses
Gemini      → Gemini generateContent
Other       → OpenAI Chat Completions
```

Client protocol capabilities are matched explicitly. OpenAI Chat and OpenAI Responses are separate capabilities, so a chat-only provider cannot receive a Responses request.

Gemini uses the native `generateContent` protocol and standard model path.

The adapter converts the common gateway request into the provider request format.

## Health System

Each target tracks:

```text
status
score
successes
failures
consecutiveFailures
latencyMs
lastStatus
lastReason
cooldownUntil
updatedAt
```

States:

```text
unknown    no health claim has been established yet
healthy    the latest accepted observation succeeded
failed     the latest accepted observation failed
cooldown   a failed target that is still inside its cooldown window
```

`status` stores the outcome of the last accepted observation. `cooldown` is derived from `cooldownUntil` when health is reported, so routing never depends on it. Health is tracked per `provider + model + key`: a failed key or model never changes the state of a sibling target.

### Provider-aware probing

A generic `GET <baseUrl>` cannot establish that a provider is healthy, and it never exercises the API key. Each protocol capability therefore gets an explicit, quota-free probe against the provider's own model-listing endpoint:

| Capability | Probe | Credential |
|---|---|---|
| Gemini | `GET {base}/v1beta/models` | `x-goog-api-key` |
| OpenAI Chat / Responses | `GET {base}/v1/models` | `Authorization: Bearer` |
| Anthropic only | none | passive |

Probes list models, so they never send a prompt and never consume generation quota. Probe URLs never carry a credential in the query string.

Probe results are normalized to `{ ok, status, latencyMs, reason }`:

```text
ok: true   2xx — reachable and the credential was accepted
ok: false  401, 402, 403, 408, 429, 5xx, timeout, unreachable
ok: null   passive — the endpoint is missing (404/405/501), or the provider
           has no safe probe. The previous state is preserved untouched, so
           the router never fabricates a health claim.
```

Authentication failures are never reported as healthy.

### Observation ordering

Every observation carries the timestamp at which it was taken. An observation is only applied when it is at least as new as the newest one already recorded. A slow health probe that started before a routing failure therefore cannot overwrite that failure or clear the cooldown it established, while a newer successful probe can still recover a cooled-down target.

Default failed-target cooldown:

```text
15 minutes
```

Default health refresh interval:

```text
15 minutes
```

The server starts the health monitor at startup and stops it cleanly on SIGINT/SIGTERM. Refresh cycles never overlap, run with bounded concurrency (4 probes at a time) so one slow provider cannot stall the cycle, and a failing provider never prevents the others from being checked.

Retryable status codes:

```text
401, 402, 403, 404, 408, 409, 425, 429, 500, 501, 502, 503, 504, 520, 521, 522, 523, 524, 529
```

HTTP 400 from a provider also falls back to the next target. A generic 400
(unsupported parameter, schema quirk) does not cool the target down, and if
every target answers 400 the client receives the 400 instead of a 502.

## Pinned Requests

`x-multi-ai-pin-provider` (and optionally `x-multi-ai-pin-key-index`) narrow the
candidate targets before selection (`pinTargets` in
`src/observability/route-select.js`). Pinned requests are strict: no fallback to
another provider, key or model, and cooldown is bypassed so a specific key can
be tested. Outcomes still update the shared health registry. A pin matching no
target returns `404 no_route`.

## Sticky Sessions

The client may send:

```http
X-Multi-AI-Session-ID: <session-id>
```

If absent, the router creates a UUID and returns:

```http
x-multi-ai-session-id: <session-id>
```

A successful target becomes the session's sticky target for 15 minutes (refreshed by each success). It is tried first while valid; if it fails or cools down, routing continues with priority, then the normal fallback. See "Priority and Key-Scoped Fallback".

## Security

Router authentication is optional:

```env
MULTIAI_ROUTER_API_KEYS=
```

Provider API keys remain server-side and are never returned in routing metadata.

Real credentials must stay in `.env` and must not be committed.

## Runtime

```text
Node.js >= 20
npm start
npm test
```

## Source Architecture

```text
src/
├── server.js              HTTP gateway
├── api.js                 read-only control-panel API (/api/*)
├── static-files.js        static handler for the built control panel
├── config.js              environment + target construction
├── router.js              fallback + sticky routing
├── health.js              health + ranking + cooldown
├── health-checks.js       provider-aware health probes
├── adapters.js            protocol + upstream request adapter
├── providers/
│   └── catalog.js         provider catalog
└── observability/
    ├── request-log.js     bounded in-memory request log
    ├── metrics.js         pure aggregation over health + requests
    ├── config-view.js     safe configuration projection
    ├── router-preview.js  faithful rendering of the routing decision
    ├── route-select.js    shared target-selection rule
    ├── monitor-state.js   health-cycle observation
    ├── system-info.js     runtime facts
    └── sanitize.js        credential scrubbing

ui/                        React + Vite control panel (built into ui/dist)
```

## Control Panel

The gateway is self-describing. `/api/*` exposes the state a browser needs, and
the panel is served from the same origin — no separate service, no CORS shim.

The API layer is strictly read-only apart from `POST /api/health/refresh`, which
does nothing the 15-minute timer would not do anyway. It cannot alter routing,
health, provider configuration or the proxy path.

### Representing the routing decision

The panel must not invent routing logic, so there is exactly one copy of it.
`selectRouteTargets` (`src/observability/route-select.js`) is called by both
`proxy()` and `/api/router/preview`, and ranking is delegated to
`healthRegistry.rank`. The Router page therefore renders the decision the
gateway will actually make, and cannot drift from it: any divergence is a
compile-time-visible change to a shared function, not two implementations.

### Request log

`proxy()` records one entry per request — the protocol, the requested model,
every upstream attempt in order, the final target, latency, tokens and outcome.
It is bounded (500 entries, oldest evicted) because an unbounded log would
eventually take the process down.

The stored shape is an allow-list. Request bodies, prompts, response bodies and
headers are never copied in, so they cannot leak later even if an upstream error
contained them. Error text is additionally passed through `sanitizeMessage`.

Because the attempt list is recorded by the same closure `withFallback` calls,
the fallback chain the UI shows is observed rather than reconstructed.

### In-flight requests

`RequestLog.begin()` registers a request when routing starts and `progress()`
records each attempt as it goes on the wire and finishes; `record()` retires it
into the completed log. Pending entries live in their own map, so metrics, the
model catalogue and the Requests page never see an unfinished request. They are
exposed as `pending` on `GET /api/requests`, and both forms share a `startSeq`,
which lets Live Logs show one card per call and update it in place, with one
box per attempt (`CALLING` / `FAILED` / `SUCCESS`) and a `FALLBACK` line between
a failed box and the next. A request
that never reports back is dropped after 10 minutes and the set is capped.

### Real-time

Most pages poll, with conditional requests. Live Logs is the exception: it is
pushed to over server-sent events (`GET /api/requests/stream`). `RequestLog`
has `subscribe()`, called synchronously on `begin()`, `progress()` and
`record()`; the endpoint sends a `snapshot` (same payload as `GET
/api/requests`) and then one `pending` / `entry` event per change, in the same
tick the change happens. The panel reads it with `fetch` rather than
`EventSource` because it authenticates with a Bearer header. A dropped stream
reconnects with backoff and starts over with a fresh snapshot, polling runs
only while the stream is not open, and a stale snapshot can never move a call
backwards (`mergeRows`). Open streams are capped and closed on shutdown. For
polled pages, `/api/*` returns an `ETag` over a
stable projection of the payload (volatile fields such as `generatedAt` are
excluded from the hash), so an unchanged poll returns `304` and the client
returns the previous object by identity — which lets React skip the re-render
entirely.

Health and system status live in separate React contexts so a health tick
re-renders only the components that display health.

## Architecture Notes

The core implementation is separated by responsibility:

- `src/server.js` — HTTP gateway, endpoints, authentication, sessions and proxy execution.
- `src/api.js` — the read-only control-panel API and its safe projections.
- `src/static-files.js` — static serving for `ui/dist`, with traversal protection.
- `src/config.js` — environment parsing and routing-target construction.
- `src/router.js` — health-ranked fallback and sticky routing.
- `src/health.js` — target health, scoring, cooldown and health-refresh infrastructure.
- `src/health-checks.js` — provider-aware, quota-free health probes and status classification.
- `src/adapters.js` — client protocol detection and upstream request construction.
- `src/providers/catalog.js` — provider catalog.
- `src/observability/` — request log, metrics, safe config view, routing preview and sanitization.

The architecture document describes the runtime design; implementation details remain in the source files.
