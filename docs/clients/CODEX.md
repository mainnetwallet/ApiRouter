# Codex + MultiAI Router

Use MultiAI Router as a custom OpenAI-compatible provider for Codex.

Codex supports custom model_providers with base_url and env_key in its user-level config.toml.

## 1. Start MultiAI Router

    npm start

Default gateway:

    http://127.0.0.1:8788

## 2. Configure the router

Example .env:

    GROQ_API_KEYS=YOUR_KEY
    GROQ_MODELS=YOUR_MODEL
    GROQ_BASE_URL=https://api.groq.com/openai/v1

Or configure any of the OpenAI-compatible providers supported by the repository.

## 3. Configure Codex

Open the user-level Codex config:

    notepad $HOME\.codex\config.toml

Example:

    model_provider = "multi_ai_router"

    [model_providers.multi_ai_router]
    name = "MultiAI Router"
    base_url = "http://127.0.0.1:8788/v1"
    env_key = "MULTIAI_ROUTER_API_KEY"
    wire_api = "responses"

Then set the gateway key if gateway authentication is enabled:

    $env:MULTIAI_ROUTER_API_KEY="YOUR_LOCAL_ROUTER_KEY"

Start Codex:

    codex

## 4. Model selection

Set the model requested by Codex to a model configured in the router when you want exact-model routing.

If that exact model is unavailable, the router can use another configured target in the same compatible protocol pool when fallback is required.

## 5. Routing flow

    Codex
      |
      v
    POST /v1/responses
      |
      v
    MultiAI Router
      |
      +--> health-ranked target
      +--> provider/model/key
      +--> retryable failure
      +--> next target

## 6. Important

Codex uses the OpenAI Responses wire API here. The router maps /v1/responses to its OpenAI-compatible upstream target adapter.

Official reference:
https://developers.openai.com/docs/config-file/config-reference