# MultiAI Router

A protocol-aware multi-provider AI routing layer for Claude Code, Codex, OpenCode, custom applications, and API clients.

## Routing model

Every configured provider/model/key combination is an independent routing target:

provider + model + key

A provider is eligible only when all three required values are configured:

1. API keys
2. Models
3. Base URL

If any one is missing, the whole provider is skipped.

## Health-ranked fallback

The router does not use a fixed provider-first order. It builds one global pool of all configured targets and ranks them by health.

Example:

1. Gemini / model-A / key-2 — health 97
2. Groq / model-X / key-1 — health 94
3. AgentRouter / model-B / key-1 — health 90
4. Gemini / model-A / key-1 — health 71

The highest healthy target is tried first. A retryable failure moves to the next available target in the current ranking.

Health is tracked independently for every API key. A failed key does not disable its sibling keys for the same model.

## 15-minute failure cooldown

When a target fails with a retryable status, that exact provider/model/key target enters a 15-minute cooldown.

During the cooldown it is excluded from routing.

After the cooldown, the target becomes eligible for the next health refresh and can return to the ranking if it is healthy again.

The default retryable statuses are:

402, 408, 429, 500, 502, 503, 504

They are controlled by RETRY_STATUS_CODES.

## Automatic health refresh

The health layer provides a 15-minute refresh monitor. It checks every configured provider/model/key target and stores a new health state.

Because providers use different protocols, the monitor receives a protocol-aware check(target) function from the provider adapter layer. The core router does not pretend that one generic HTTP request is a valid health check for every provider.

The refresh cycle is:

health check all targets
→ save results
→ rebuild global health ranking
→ route using the new ranking

## Sticky routing

A RouteSession remembers the last successful target by its provider/model/key identity.

The next request for the same session starts from that target when it is still available. If it is unavailable, routing continues forward through the current health-ranked targets.

The router never backtracks to a target that already failed during the same request.

## Multiple keys

Multiple API keys are expanded into independent targets.

For example:

Gemini / model-A / key-1
Gemini / model-A / key-2
Gemini / model-A / key-3

Each key gets its own health score, cooldown, success count, failure count, latency, and last status.

## Security

Keep API keys in environment variables or a local .env file. Never commit real credentials.

## Providers

The initial catalog is designed for AgentRouter, Gemini, Groq, Hugging Face, Mistral, OpenRouter, Cerebras, Cloudflare, SambaNova, Cohere, and Z.AI.
