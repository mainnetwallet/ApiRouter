# MultiAI Router

Multi-provider AI routing gateway with health-based fallback.

## Client Integration Guides

- [Claude Code](docs/clients/CLAUDE_CODE.md)
- [Codex](docs/clients/CODEX.md)
- [Qwen Code](docs/clients/QWEN_CODE.md)
- [OpenCode](docs/clients/OPENCODE.md)
- [Generic OpenAI-compatible Clients](docs/clients/GENERIC_OPENAI.md)
- [Other AI Clients](docs/clients/OTHER_CLIENTS.md)
- [All Client Protocols](docs/clients/CLIENTS.md)

## Quick Start

```powershell
git clone https://github.com/mainnetwallet/MultiAI-Router.git
cd MultiAI-Router
npm install
Copy-Item .env.example .env
notepad .env
npm start
```

Default server:

```text
http://127.0.0.1:8788
```

## Configuration

A provider needs:

- API keys
- Models
- Base URL

Configure them in `.env`.

Retryable statuses:

```text
402,408,429,500,502,503,504
```

## Endpoints

| Method | Endpoint |
|---|---|
| GET | /health |
| GET | /v1/models |
| POST | /v1/messages |
| POST | /v1/responses |
| POST | /v1/chat/completions |
| POST | /v1beta/models/{model}:generateContent |

## Test

```powershell
npm test
```

## Security

Keep real API keys in `.env`. Never commit credentials.
