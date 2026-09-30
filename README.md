# MultiAI Router

A protocol-aware, health-aware multi-provider AI routing core for Claude Code, Codex, OpenCode, custom applications, and API clients.

MultiAI Router builds a global pool of provider/model/API-key targets, tracks each target independently, and selects available targets using health-aware routing and automatic fallback.

> Current status: the repository contains the routing, health, configuration, and HTTP discovery core. Provider-specific request adapters and final upstream proxy endpoints are the next integration layer.

## Client Integration Guides

Use MultiAI Router with different AI clients:

- [Claude Code](docs/clients/CLAUDE_CODE.md) — Anthropic `/v1/messages`
- [Codex](docs/clients/CODEX.md) — OpenAI `/v1/responses`
- [OpenCode](docs/clients/OPENCODE.md) — OpenAI-compatible `/v1/chat/completions`
- [Generic OpenAI-compatible clients](docs/clients/GENERIC_OPENAI.md)
- [Other AI clients](docs/clients/OTHER_CLIENTS.md)
- [All client protocols](docs/clients/CLIENTS.md)

The client guides are separated so each client can be configured independently while sharing the same MultiAI Router gateway.

## Features

- Multi-provider routing
- Multi-model support
- Multiple API keys per provider/model
- Per-target health tracking
- Global health-based ranking
- Automatic fallback on retryable failures
- 15-minute failure cooldown
- Periodic health-refresh infrastructure
- Sticky routing sessions
- Protocol-aware provider adapter architecture
- Environment-based secret management
- Designed for Claude Code, Codex, OpenCode and custom clients

## Routing Architecture

Every configured combination of provider + model + API key becomes an independent routing target.

    Any AI Client
           |
           v
    +----------------+
    | MultiAI Router |
    +-------+--------+
            |
      +-----+-----+
      |           |
      v           v
    Health     Route Session
    Registry
      |           |
      +-----+-----+
            |
            v
    Global Target Ranking
            |
            v
    Best Available Target
            |
      retryable failure?
        /          \
      yes           no
       |             |
       v             v
    next target    return error

## Health and Fallback

Each target maintains its own health state:

- health score
- status
- success count
- failure count
- consecutive failures
- latency
- last HTTP status
- cooldown expiration

Example ranking:

    Gemini / model-A / key-2       health 97
    Groq / model-X / key-1         health 94
    AgentRouter / model-B / key-1  health 90
    Gemini / model-A / key-1       health 71

The highest-ranked available target is selected first. A retryable failure records the failure and moves routing to the next available target.

## 15-Minute Cooldown

A failed target enters a 15-minute cooldown by default.

    Target fails
        |
        v
    Record failure
        |
        v
    Cooldown for 15 minutes
        |
        v
    Remove from active routing
        |
        v
    Health refresh
        |
        v
    Re-evaluate target

Cooldown is applied to the exact provider + model + API key target. A failed key does not automatically disable sibling keys.

## Retry Policy

Retryable HTTP statuses are configured with:

    RETRY_STATUS_CODES=402,408,429,500,502,503,504

| Status | Typical meaning |
|---|---|
| 402 | Quota / payment / budget exhaustion |
| 408 | Request timeout |
| 429 | Rate limit |
| 500 | Provider server error |
| 502 | Bad gateway |
| 503 | Service unavailable |
| 504 | Gateway timeout |

Authentication/configuration errors such as 401 and 403 are not retryable by default.

## Automatic Health Refresh

The health layer includes a 15-minute refresh monitor.

The intended cycle is:

    Check every configured target
            |
            v
    Record health result
            |
            v
    Update health state
            |
            v
    Rebuild global ranking
            |
            v
    Route using new ranking

Providers expose different protocols, so health checks are designed to be supplied by protocol-aware provider adapters rather than assuming one generic HTTP request works for every provider.

## Sticky Routing

RouteSession remembers the last successful target using its provider/model/key identity.

Example:

    Request 1
      Target A fails
      Target B succeeds

    Request 2
      Start from Target B
      If B fails, continue forward
      Do not backtrack to an already-failed target

For multi-process production deployments, session state should use a shared store such as Redis instead of process-local memory.

## Multiple API Keys

Multiple keys for the same provider/model are expanded into separate targets.

    Gemini / model-A / key-1
    Gemini / model-A / key-2
    Gemini / model-A / key-3

Each target has independent health score, cooldown, success count, failure count, latency, and last status.

## Provider Catalog

The initial catalog includes:

- AgentRouter
- Gemini
- Groq
- Hugging Face
- Mistral
- OpenRouter
- Cerebras
- Cloudflare
- SambaNova
- Cohere
- Z.AI

Provider-specific protocol adapters are intentionally separated from the core routing engine because these services do not all expose identical APIs.

## Configuration

A provider is eligible only when all three values are configured:

1. API keys
2. Models
3. Base URL

If any one is missing, the provider produces no routing targets and is skipped.

The environment template is organized as:

    1. API KEYS
    2. MODELS
    3. BASE URLS
    4. RETRY POLICY

Real credentials belong only in the local .env file.

## Run on Windows / PowerShell

### 1. Install Node.js

Install Node.js 20 or newer.

Verify:

    node --version
    npm --version

### 2. Clone the repository

    git clone https://github.com/mainnetwallet/MultiAI-Router.git
    cd MultiAI-Router

### 3. Install dependencies

    npm install

### 4. Create local configuration

    Copy-Item .env.example .env
    notepad .env

Add your provider API keys, models, and base URLs.

### 5. Start the router

    npm start

Expected output:

    MultiAI Router listening on http://127.0.0.1:8788

### Development mode

    npm run dev

## Verify the Server

Check service health:

    Invoke-RestMethod http://127.0.0.1:8788/health

Check available/ranked models:

    Invoke-RestMethod http://127.0.0.1:8788/v1/models

## Run Tests

    npm test

The test suite covers routing and health primitives including:

- retryable status handling
- health-ranked fallback
- per-key cooldown
- sibling-key availability
- sticky routing
- provider configuration validation
- incomplete-provider exclusion
- health refresh across configured targets

## Current HTTP Endpoints

| Method | Endpoint | Purpose |
|---|---|---|
| GET | /health | Service and target health information |
| GET | /v1/models | Available and ranked routing targets |

The current HTTP server exposes discovery and health endpoints. The provider-specific request adapter layer is still required for forwarding chat/message requests to upstream services.

## Project Structure

    MultiAI-Router/
    ├─ src/
    │  ├─ config.js
    │  ├─ health.js
    │  ├─ router.js
    │  ├─ server.js
    │  └─ providers/
    │     └─ catalog.js
    ├─ test/
    │  └─ router.test.js
    ├─ .env.example
    ├─ .gitignore
    ├─ package.json
    └─ README.md

## Security

Never commit real API credentials.

The repository ignores local environment files. Keep production credentials in deployment environment variables or a dedicated secret manager.

If an API key is accidentally exposed, revoke or rotate it immediately.

## Production Considerations

Before using the router as a production upstream gateway, add:

- protocol-specific request adapters
- upstream request forwarding endpoints
- shared session storage for multi-process deployments
- persistent health storage
- provider-specific authentication handling
- structured logging
- rate-limit/backoff controls
- metrics and observability
- TLS/reverse-proxy deployment
- deployment-level secret management

## Design Principle

MultiAI Router separates routing intelligence from provider protocol implementation.

    Client
      |
      v
    Router
      ├─ Target selection
      ├─ Health ranking
      ├─ Key-level health
      ├─ Cooldown
      ├─ Retry/fallback
      └─ Session routing
            |
            v
      Provider Adapter
            |
            v
      Upstream AI Provider

This keeps the routing core reusable while allowing each provider to implement the protocol it actually supports.

## License

See the repository for the current project license and distribution terms.
