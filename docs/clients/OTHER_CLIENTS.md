# Other AI Clients

MultiAI Router is intentionally not tied to one CLI.

## OpenAI-compatible clients

Use the gateway base URL:

    http://127.0.0.1:8788/v1

Typical clients that can use a custom OpenAI-compatible endpoint include:

- OpenAI SDK applications
- OpenCode
- Cursor
- Cline
- Roo Code
- Continue
- Qwen Code
- Crush
- custom Node.js applications
- custom Python applications
- cURL/API clients

Exact UI/configuration names differ by application, so use the client's provider settings to set its custom base URL and API key.

## Claude-compatible clients

Clients using the Anthropic Messages protocol should use:

    http://127.0.0.1:8788

with the Anthropic authentication environment variables or equivalent custom gateway configuration.

## Protocol rule

Do not force an Anthropic client through an OpenAI-only target or an OpenAI Responses client through a provider that does not implement Responses.

MultiAI Router keeps protocol selection separate from health ranking so fallback only occurs across compatible targets.