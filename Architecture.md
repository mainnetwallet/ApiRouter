# ApiRouter — Full Architecture

## Overview

ApiRouter is a protocol-aware multi-provider AI gateway.

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
7. A route plan is built (see "The Fallback Chain"): the remembered target when the mode keeps one, then the operator's configured chain for that pool, or the automatic health-and-latency order when no chain is configured.
8. Targets cooling down in the health registry, and targets already attempted in this request, are skipped. A failure cools down what it describes: 401/402/403 also cool the same key's sibling models, while a model-specific error (400/404/413/422) never does.
9. The router calls targets sequentially.
10. Retryable failures put the exact target into cooldown and move routing forward.
11. A successful target becomes the session's remembered target — in the modes that remember one.
12. The upstream response is streamed back to the client.

## The Fallback Chain

Implemented in `src/fallback-chain.js` (the persisted configuration),
`src/fallback-plan.js` (the planner) and `withFallback` in `src/router.js` (the
walker). One code path serves both pools; only the target list and the chain
differ.

```text
REQUEST -> TEXT pool | VISION pool (never mixed)
  REMEMBERED  the session's last successful target, only in the modes that
              remember one, and only while its 20-minute TTL is valid
  CHAIN       the operator's saved order, entry by entry
  AUTO        the same entries (or every configured target, when the chain is
              empty) ordered by measured health and latency
```

A configured chain is the order, and it is the whole order: a model the operator
left out of the chain is not routed to, because routing to it would be a routing
path overriding the configured order. Health never re-sorts a chain; it only
decides eligibility while the plan is walked. The automatic order is used when
the chain is empty, or when the operator has explicitly selected the automatic
mode.

### Entries

An entry is one provider/model GROUP with an optional key subset and an enabled
flag:

```text
{ provider, model, keys: null | [0, 2], enabled: true }
```

- `keys: null` means every key the provider has for that model, tried in key
  order. It is the only form that means "unrestricted", and it is what an absent
  field normalizes to.
- An explicitly supplied key list is read as a restriction, so one that cannot
  be read is treated as permitting **nothing** rather than everything: a
  persisted or hand-edited `keys: [true]`, `keys: ["1"]`, `keys: []` or a
  non-array `keys` normalizes to `[]`, which resolves to zero eligible keys. The
  entry keeps its place, is walked as unusable, and the pool fails closed.
  Reading it as `null` would grant every key — the opposite of what the file
  asked for. A partly readable list keeps exactly the indexes it could read.
- Every eligible key of an entry is attempted, in key order, before the walk
  advances to the next entry.
- A disabled entry keeps its position and is simply not routed to. Disabling
  every entry is the same position as having no chain at all, so the automatic
  order takes over rather than the router having nothing to do.

The file holds ids, key indexes and flags — never credentials.

### Operating modes

| Mode | Remembered target | Order |
|---|---|---|
| `fixed` | none | the saved chain |
| `last-success` | leads the next request | the saved chain |
| `auto` | leads the next request | health and latency |

In `fixed`, the walker does not record a success at all, which is what makes the
mode — and Reset — mean what they say. In the other modes the success is stored
on the session (`RouteSession`), keyed by protocol + pool + session id, so a
text success can never become a vision preference.

Reset Fallback clears those session records and the automatic-order cache. It
touches nothing else: not the chain, the mode, the providers, the keys, the
configured models, valid health measurements or any cooldown.

### Automatic ordering

`orderGroupsByHealth` sorts model groups by:

1. a group with an available key, before one whose every key is cooling down;
2. lower measured latency first;
3. higher health score first;
4. the order the group appears in the target list — the deterministic tiebreak
   that makes an unmeasured router stable rather than arbitrary.

A group with no measurement sorts after every measured one. Latency is
`requestLatencyMs` (a real generation, timed end to end) when there is one, else
`probeLatencyMs` (a health probe), else nothing at all — the order never invents
a number. The result is cached against the health registry's version counter and
a 30-second time bucket, so a real health change takes effect immediately, a
lapsed cooldown is picked up within the bucket, and a request never recomputes
the order for no reason.

### Precedence

```text
pin (strict: no chain, no automatic order, no memory)  >  remembered  >  chain  >  automatic
```

### Failure scope

A failure cools down what it actually describes. `classifyFailure` reads an
explicit `error.scope` when a provider adapter could determine one from the
upstream error body, and otherwise decides from the status code:

| Scope | Status codes | Effect |
|---|---|---|
| `key` | 401, 402, 403 | every model of that provider using that key |
| `target` | 400, 404, 413, 422 | only that target |
| `target` (default) | everything else | only that target |

A 404 means "this model is gone", not "this key is bad", so it must never reach
a sibling on the same key. Anything unrecognised is treated as `target`-scoped —
the narrow answer, which can cost a retry but never a needlessly disabled model.
`provider` scope exists in the vocabulary and is applied only when an adapter
states it outright.

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

### Image content across protocols

A bridge either carries an image or refuses the request. It never replaces one with text.

Each protocol has its own spelling for image content — `{type:"image_url"}` (Chat Completions), `{type:"input_image"}` (Responses), `{type:"image"}` with a `base64` or `url` source (Anthropic), `inlineData` / `fileData` (Gemini) — and they do not overlap completely:

| From | To | Carried | Refused |
|---|---|---|---|
| Chat / Responses | Gemini | inline base64 (`inlineData`) | remote `https:` URLs, an `input_image` with no URL |
| Gemini | OpenAI-compatible | `inlineData` / `inline_data` | `fileData` / `file_data` (a provider-private Files API URI), `inlineData` with no payload |
| Anthropic | Gemini | `source.type === "base64"` | `source.type === "url"` |
| Anthropic | OpenAI Chat | both source forms | — |

Three positions hold only text — a **system prompt**, an **assistant turn** and a **tool result**. An image there has no representation in any of these protocols, so the request is refused rather than sent with the literal string `"[image]"` standing in for it. A marker would be content the model never received, presented as though it had.

A refusal is a `400` `UnsupportedMediaError` carrying `retryable` and `skipCooldown`. That combination is deliberate: the fallback walk records the attempt, moves on to a target that *can* carry the image, and does not cool the refusing provider down, because the limitation belongs to the request rather than the provider. Only when no target can carry the image does the client see the error.

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

A generic `GET <baseUrl>` cannot establish that a provider is healthy, and it never exercises the API key. Each protocol capability therefore gets an explicit probe against the provider's own model-listing endpoint:

| Capability | Probe | Credential | Generation quota |
|---|---|---|---|
| Gemini | `GET {base}/v1beta/models` | `x-goog-api-key` | not consumed |
| OpenAI Chat / Responses | `GET {base}/v1/models` | `Authorization: Bearer` | not consumed |
| Cloudflare Workers AI | `GET {base}/models/search?per_page=1` | `Authorization: Bearer` | not consumed |
| Cohere | `POST {base}/chat/completions` (1 token) | `Authorization: Bearer` | **consumed** |
| Anthropic only | none | passive | not consumed |

Probes never send a credential in the query string.

Cohere is the one exception. Its OpenAI Compatibility surface is chat-first: the base is guaranteed for chat completions, while `GET /models` there is not a reliable health signal, so the probe is the exact route the Playground uses with the smallest useful generation request (`max_tokens: 1`). **That probe consumes generation quota**, unlike every other provider's. It is the only probe in the system that does, so the README's "avoids consuming generation quota" applies to every provider except Cohere. Reducing it further would mean dropping to a model-list probe that does not dependably answer.

The models endpoint is also read, not just called: the probe looks for the target's configured model id in the listing to report `modelListed` (see below). A single-page catalogue therefore costs no extra request; a paginated one is walked within a strict budget, using the probe's own timeout.

Probe results are normalized to `{ ok, status, latencyMs, reason, modelListed }`:

```text
ok: true   2xx — reachable and the credential was accepted
ok: false  401, 402, 403, 408, 429, 5xx, timeout, unreachable
ok: null   passive — the endpoint is missing (404/405/501), or the provider
           has no safe probe. The previous state is preserved untouched, so
           the router never fabricates a health claim.
```

Authentication failures are never reported as healthy.

#### Connectivity and model availability are separate

`status` describes the **key and the endpoint**: was the credential accepted, was the provider reachable. It does not describe the configured **model**. A valid key against a reachable `/models` endpoint is reported `healthy` even when the configured model does not exist, was withdrawn, or is not entitled to the account — and the request only finds out at routing time.

`modelListed` is the separate, additive signal: whether the provider's own model catalogue named this target's model. The catalogue the probe already fetches is read for the model id, so this costs no extra request, and it is deliberately tri-state:

```text
true    a complete catalogue was read and it named the model
false   a complete catalogue was read and the model was not in it
null    the catalogue could not be inspected to the end — "not verified",
        never "missing"
```

`false` is a claim about a **complete** catalogue. A catalogue that was not read to the end never produces it: an unrecognized shape, a body past the byte limit, a non-200 response, an unreadable or unreachable page, or a page budget that ran out while the provider still advertised more pages all yield `null`. This matters because the catalogues are paginated — Gemini's `models.list` serves 50 models per page — so reading only the first page would report a real model as missing on any sizeable account.

The walk is bounded by `MAX_MODEL_LIST_PAGES` pages, `MAX_MODEL_LIST_BYTES` total bytes and the probe timeout. The byte limit is enforced **while the body is consumed**, not after it has been buffered, because a provider may omit or understate `Content-Length`; a body that crosses the limit is abandoned and its reader cancelled. Follow-up pages use the probe's own `fetch` signal, so the timeout bounds the whole walk, and any failure to finish it is `null` rather than a false negative.

##### Latest observation vs last confirmation

Because `null` is a real answer, the signal is reported as two separate facts rather than one:

```text
modelListed              what the MOST RECENT probe observed (tri-state)
modelListedAt            when that observation was taken
modelListedConfirmed     the last DEFINITE value seen, kept across
                         indeterminate probes
modelListedConfirmedAt   when that definite value was observed
```

Retaining the last confirmation is useful — "absent yesterday, unreadable today" is worth knowing — but it must never be presented as the latest result. `modelListed` is therefore *replaced* by `null` when a probe cannot inspect the catalogue, including when the probe throws or the provider has no probe at all, so a stale `false` can never appear freshly confirmed. The panel renders the two separately and dates both.

Only `false` is evidence. It is surfaced in the health payload and the panel, and neither field **ever changes `status`, the score or a cooldown**, so routing behaves exactly as before. Catalogue observations are also recorded while a target is cooling down, and carry their own ordering guard so a slow probe cannot overwrite a newer catalogue fact.

### Observation ordering

Every observation carries the timestamp at which it was taken. An observation is only applied when it is at least as new as the newest one already recorded. A slow health probe that started before a routing failure therefore cannot overwrite that failure or clear the cooldown it established, while a newer successful probe can still recover a cooled-down target.

Default failed-target cooldown:

```text
12 minutes
```

Default health refresh interval:

```text
12 minutes
```

The two are independent. The cooldown is how long a *failed* target is skipped by routing; the interval is how often probes run. Status-specific cooldowns are unchanged: HTTP 400 puts a target on an 8-minute cooldown, an HTTP 408 timeout on a 1-minute cooldown, and a 413 on 5 minutes. The remembered-session TTL (20 minutes) is a separate setting and is not affected.

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

## Remember Last Successful

The client may send:

```http
X-Multi-AI-Session-ID: <session-id>
```

If absent, the router creates a UUID and returns:

```http
x-multi-ai-session-id: <session-id>
```

In the `last-success` and `auto` modes, a successful target is remembered for
that session for 20 minutes (refreshed by each success) and is tried first on the
next request. When it fails or is cooling down, the walk continues from the chain
in its saved order; the remembered target is never retried twice in one request,
and the chain itself is never modified by a success.

The record is scoped by protocol, pool and session id: text and vision keep
separate remembered targets, and so does each client protocol. Requests without
the header share one default session per protocol and pool.

In the `fixed` mode nothing is remembered at all: every request starts at the
first model of the chain and its first eligible key.


### Manual Model Selection (three phases)

`manual` is a fourth fallback mode. It is the only mode whose plan has more than
one source, and it is built by `buildManualPlan` in `fallback-plan.js`:

1. **`manual-selection`** — the saved entries in exactly the saved order. Groups
   are keyed by provider/model, so an interleaved selection (provider P model A,
   provider Q model B, provider P model C) stays interleaved; nothing groups or
   sorts by provider. Every eligible key of a model is tried before the next.
2. **`health-fallback`** — every reachable model that is *not* a saved entry,
   ordered by the existing health/latency ordering. Exclusion is by model, so an
   unselected model of a provider that appears in the selection stays eligible.
   Parked (disabled) entries and entries narrowed to no keys are excluded too,
   so a restriction can never leak a model's other keys into this phase.
3. **`manual-retry`** — the same entries and keys as phase 1, in the same order,
   flagged `retry`. This is one pass; the plan has no fourth phase.

The per-request "a target is invoked at most once" rule is unchanged for every
other step. A `retry` step is the one bounded exception (`withFallback` in
`router.js`): each target is retried at most once; a cooldown that existed when
the request reached the target is never overridden; a credential-level or
non-transient failure (400/401/402/403/404/413/422) is never retried; and the one
cooldown the pass looks past is the one *this request* set through a transient,
target-scoped failure (timeout, 429, 5xx, transport error), and only while it is
still exactly that cooldown. Without that, every target that failed in phase 1
would already be cooling down from that failure and phase 3 could retry nothing.

If the selection itself has nothing walkable for a request, the plan is empty and
the request fails closed (`fallback_chain_unusable`): phase 2 catches failures of
the operator's order, it does not stand in for an order that cannot be honoured.
Manual mode remembers nothing. A pinned request never uses any of this.

## Security

Router authentication is optional:

```env
APIROUTER_API_KEYS=
```

When it is set, every `/api/*` route and every proxy route (`POST /v1/messages`, `/v1/responses`, `/v1/chat/completions`, `/v1beta/models/{model}:generateContent`, `/v1/messages/count_tokens`) requires the token. `GET /health` and `GET /v1/models` do not, and this is intentional rather than an oversight: a liveness probe has to answer before a credential is available, and model discovery happens before a client can name a model. Neither returns credentials, and the README documents the inventory they do reveal so an operator can decide whether to restrict them at the network layer.

Provider API keys remain server-side and are never returned in routing metadata.

Real credentials must stay in `.env` and must not be committed.

## Runtime

```text
Node.js >= 20
npm start
```

## Source Architecture

```text
src/
├── server.js              HTTP gateway
├── api.js                 read-only control-panel API (/api/*)
├── static-files.js        static handler for the built control panel
├── config.js              environment + target construction
├── router.js              the plan walker, failure scope and session memory
├── fallback-chain.js      the persisted Fallback Chain and its mode
├── fallback-plan.js       the one routing planner (chain / automatic)
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
does nothing the 12-minute timer would not do anyway. It cannot alter routing,
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
- `src/fallback-chain.js` — the persisted Fallback Chain, its mode and the one-time legacy import.
- `src/fallback-plan.js` — the routing planner: the configured chain, the automatic health-based order, and the remembered target.
- `src/config.js` — environment parsing and routing-target construction.
- `src/router.js` — the sequential plan walker, failure classification and session memory.
- `src/health.js` — target health, scoring, cooldown and health-refresh infrastructure.
- `src/health-checks.js` — provider-aware health probes (no generation quota, except Cohere — see "Provider-aware probing") and status classification.
- `src/adapters.js` — client protocol detection and upstream request construction.
- `src/providers/catalog.js` — provider catalog.
- `src/observability/` — request log, metrics, safe config view, routing preview and sanitization.

The architecture document describes the runtime design; implementation details remain in the source files.
