# Codex + ApiRouter

Use the router as Codex's OpenAI Responses gateway.

## Start

```powershell
npm start
```

Gateway:

```text
http://localhost:8788/v1
```

## Configure provider

Codex sends OpenAI Responses requests to `POST /v1/responses`. ApiRouter supports three upstream paths for those requests:

- **Native Responses:** targets that advertise `openai-responses` (currently AgentRouter) receive the Responses request directly.
- **OpenAI Chat bridge:** chat-completions providers are translated to/from Responses, including streaming and function/custom tool calls.
- **Gemini bridge:** Gemini `generateContent` / SSE is translated to/from Responses, including function/custom tool calls and image inputs that are representable by the selected Gemini route.

Exact requested-model matches are preferred. If a target fails with a retryable status or transport/timeout failure, the normal router fallback continues through the configured priority/provider/key/model plan. Native is preferred only when the routing configuration makes that target first; it is **not** an unconditional global preference over every configured target.

A request returns `503 no_route` when no compatible configured target exists. A translated request can therefore use any configured chat/Gemini provider that is reachable and compatible with the request.

### Provider example

```env
AGENTROUTER_API_KEYS=YOUR_PROVIDER_KEY
AGENTROUTER_MODELS=YOUR_MODEL
AGENTROUTER_BASE_URL=https://agentrouter.org/
```

## Codex configuration

Edit the user-level Codex config:

```powershell
notepad $HOME\\.codex\\config.toml
```

Current Codex configuration supports a custom `model_providers.<id>` entry with `base_url`, `env_key`, and `wire_api = "responses"`.

```toml
model_provider = "multi_ai_router"

[model_providers.multi_ai_router]
name = "ApiRouter"
base_url = "http://localhost:8788/v1"
env_key = "APIROUTER_API_KEY"
wire_api = "responses"
```

If ApiRouter authentication is enabled:

```powershell
$env:APIROUTER_API_KEY="YOUR_LOCAL_ROUTER_KEY"
```

Then:

```powershell
codex
```

The official Codex config reference documents `~/.codex/config.toml`, custom `model_providers`, `base_url`, `env_key`, and `wire_api = "responses"`. citeturn0search1

## Routing and session behavior

- Exact requested model matches are selected before non-matching compatible targets.
- The router can use sticky sessions; `x-multi-ai-session-id` explicitly selects a session. When the header is omitted, ApiRouter uses its stable default session for that protocol/pool.
- The response includes `x-multi-ai-provider`, `x-multi-ai-model`, `x-multi-ai-key-index`, and `x-multi-ai-session-id` when a target answers.
- Text and vision routing use separate pools. A vision request never silently falls back to a text-only pool.
- `/v1/models` exposes the configured unique model IDs for client discovery.

## Bridge behavior and limitations

The bridge preserves the useful Responses surface where an upstream protocol has an equivalent:

- text input/output
- system/developer instructions
- image inputs where the upstream supports them
- function tools
- Responses custom/freeform tools are represented as a single-string `input` function argument and mapped back to `custom_tool_call`
- tool results / function call outputs
- JSON object / JSON-schema output formatting where the upstream supports it
- `max_output_tokens`, temperature and top-p where supported
- streaming Responses SSE events

The following Responses features are **not fully portable to chat-completions/Gemini bridges** and are dropped or cannot be reproduced exactly:

- hosted/built-in tools such as web search, local shell, image generation, file search, Code Interpreter and hosted MCP/connectors
- reasoning items/signatures that have no equivalent on the selected upstream
- other Responses-only fields for which the upstream protocol has no equivalent

Native Responses targets are not subject to these bridge translation losses.

## Authentication

If `APIROUTER_API_KEYS` is empty, the local gateway accepts requests without authentication. If it is configured, clients must send:

```http
Authorization: Bearer YOUR_LOCAL_ROUTER_KEY
```

The Codex `env_key` points to the **router's client key**, not a provider key. Provider credentials stay in ApiRouter environment variables and are never sent back to Codex.

## Request-size safety

ApiRouter rejects request bodies larger than `MAX_REQUEST_BODY_BYTES` before routing. The default is 10 MiB; the accepted range is 1 byte through 100 MiB.

```env
MAX_REQUEST_BODY_BYTES=10485760
```

## Troubleshooting

- **401 Unauthorized:** check `APIROUTER_API_KEYS` and the Codex `env_key` variable.
- **503 no_route:** check provider keys/models/base URLs and ensure at least one configured target supports Responses natively or through the bridge.
- **503 no_vision_route:** the request requires the vision pool but no vision provider is configured.
- **400 capability mismatch:** the requested model is configured for the other pool.
- **Repeated fallback:** inspect `/health` and the control-panel request logs to see target health, cooldowns and the actual attempt chain.
- **Model rejected by a provider:** ApiRouter can retry another configured target when the upstream 400 clearly identifies an invalid/unsupported model.

## Related endpoints

```text
POST /v1/responses
GET  /v1/models
GET  /health
```

The router also supports Anthropic, OpenAI Chat Completions and Gemini client protocols, but Codex uses `/v1/responses`.

## Security notes

Do not commit provider API keys or the router client key to the repository. Put them in the runtime environment. The router authenticates clients with Bearer tokens and forwards provider credentials only to the selected upstream.
