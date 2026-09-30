# Claude Code + MultiAI Router

Use MultiAI Router as Claude Code's Anthropic-format gateway.

Anthropic documents LLM gateway usage through ANTHROPIC_BASE_URL and ANTHROPIC_AUTH_TOKEN. The router exposes /v1/messages for this client protocol.

## 1. Start MultiAI Router

From the router repository:

    npm start

Default address:

    http://127.0.0.1:8788

## 2. Configure AgentRouter or another Anthropic-compatible target

Edit .env:

    AGENTROUTER_API_KEYS=YOUR_KEY
    AGENTROUTER_MODELS=claude-opus-5,claude-opus-4-8
    AGENTROUTER_BASE_URL=https://agentrouter.org/

Only fully configured targets enter routing.

## 3. Configure Claude Code

PowerShell:

    $env:ANTHROPIC_BASE_URL="http://127.0.0.1:8788"
    $env:ANTHROPIC_AUTH_TOKEN="YOUR_LOCAL_ROUTER_KEY"
    $env:ANTHROPIC_API_KEY=$null
    claude

If MULTIAI_ROUTER_API_KEYS is empty, the local router accepts the request without gateway authentication. If it is configured, use one of those values as ANTHROPIC_AUTH_TOKEN.

## 4. How routing works

    Claude Code
        |
        v
    POST /v1/messages
        |
        v
    MultiAI Router
        |
        +--> health ranking
        +--> sticky session
        +--> retryable failure
        +--> next provider/model/key

The gateway rewrites the upstream model field to the selected target model.

## 5. Important

Claude Code uses the Anthropic messages protocol. The router therefore selects targets configured for the Anthropic protocol instead of blindly sending Claude requests to an OpenAI-only provider.

Keep real credentials in .env and never commit them.

## Troubleshooting

Check:

    Invoke-RestMethod http://127.0.0.1:8788/health

Then verify that an Anthropic-compatible target is configured.

Official reference:
https://docs.anthropic.com/en/docs/claude-code/llm-gateway