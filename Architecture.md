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
AgentRouter → anthropic, openai
Gemini      → gemini
Other       → openai
```

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
cooldownUntil
updatedAt
```

Default failed-target cooldown:

```text
15 minutes
```

Default health refresh interval provided by the health module:

```text
15 minutes
```

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
- `src/adapters.js` — client protocol detection and upstream request construction.
- `src/providers/catalog.js` — provider catalog.

The architecture document describes the runtime design; implementation details remain in the source files.
