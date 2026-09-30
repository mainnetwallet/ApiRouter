# MultiAI Router

A protocol-aware multi-provider AI routing layer for Claude Code, Codex, OpenCode, custom applications, and API clients.

## Goals

- Route requests across multiple AI providers and models
- Rotate multiple API keys for the same provider/model
- Automatic fallback on retryable failures
- Provider/model health tracking
- Protocol-aware adapters
- No secrets committed to source control

## Providers

The initial catalog is designed for AgentRouter, Gemini, Groq, Hugging Face, Mistral, OpenRouter, Cerebras, Cloudflare, SambaNova, Cohere, and Z.AI.

## Retry policy

Default retryable HTTP statuses: 402, 408, 429, 500, 502, 503, 504.
Authentication/configuration errors such as 401 and 403 are not retried by default.

## Security

Keep API keys in environment variables or a local .env file. Never commit real credentials.
