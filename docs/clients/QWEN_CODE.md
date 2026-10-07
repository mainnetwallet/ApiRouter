# Qwen Code + MultiAI Router

Qwen Code can use MultiAI Router through an OpenAI-compatible endpoint when its provider configuration supports a custom base URL.

## Router

Start the router:

```powershell
npm start
```

Gateway:

```text
http://localhost:999/v1
```

## Provider

Configure at least one OpenAI-compatible provider in `.env`:

```env
GROQ_API_KEYS=YOUR_PROVIDER_KEY
GROQ_MODELS=YOUR_MODEL
GROQ_BASE_URL=https://api.groq.com/openai/v1
```

The same pattern can be used for another configured OpenAI-compatible provider.

## Qwen Code

In Qwen Code, configure a custom OpenAI-compatible provider/base URL:

```text
Base URL: http://localhost:999/v1
API key: YOUR_LOCAL_ROUTER_KEY
Model: a model configured in MultiAI Router
```

If router authentication is disabled, the gateway API key can be omitted according to the client's configuration.

## Routing

```text
Qwen Code
   ↓
/v1/chat/completions
   ↓
MultiAI Router
   ↓
health ranking
   ↓
provider / model / key
   ↓
fallback on retryable failure
```

Provider API keys stay inside the router.

## Fallback

An exact match for the requested model is tried first and the remaining
reachable targets follow. Qwen Code reaches chat-completions providers directly
and Gemini providers through the router's translation bridge, so a Gemini-only
configuration serves Qwen Code too.

On a bridged (Gemini) request these are dropped rather than guessed at:

- tools that are not `type: "function"` (hosted/built-in tools have no
  `generateContent` equivalent);
- remote image URLs — only base64 `data:` URLs are forwarded.

## Security

Keep real keys in `.env`. Never commit provider or router credentials.

If the Qwen Code version you use exposes different provider setting names, keep the same gateway URL and use its equivalent custom OpenAI-compatible configuration.
