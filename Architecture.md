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
6. If the requested model exists, matching targets are preferred.
7. Health ranking chooses the available targets.
8. The current session's successful target is preferred.
9. The router calls targets sequentially.
10. Retryable failures put the exact target into cooldown and move routing forward.
11. A successful target becomes the session's sticky target.
12. The upstream response is streamed back to the client.

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
402, 408, 429, 500, 502, 503, 504
```

## Sticky Sessions

The client may send:

```http
X-Multi-AI-Session-ID: <session-id>
```

If absent, the router creates a UUID and returns:

```http
x-multi-ai-session-id: <session-id>
```

A successful target becomes the session's preferred target. If it later fails with a retryable error, routing continues to the next available target.

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
├── config.js              environment + target construction
├── router.js              fallback + sticky routing
├── health.js              health + ranking + cooldown
├── health-checks.js       provider-aware health probes
├── adapters.js            protocol + upstream request adapter
└── providers/
    └── catalog.js         provider catalog
```

## Architecture Notes

The core implementation is separated by responsibility:

- `src/server.js` — HTTP gateway, endpoints, authentication, sessions and proxy execution.
- `src/config.js` — environment parsing and routing-target construction.
- `src/router.js` — health-ranked fallback and sticky routing.
- `src/health.js` — target health, scoring, cooldown and health-refresh infrastructure.
- `src/health-checks.js` — provider-aware, quota-free health probes and status classification.
- `src/adapters.js` — client protocol detection and upstream request construction.
- `src/providers/catalog.js` — provider catalog.

The architecture document describes the runtime design; implementation details remain in the source files.
