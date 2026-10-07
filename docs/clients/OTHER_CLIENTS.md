# Other AI Clients

## OpenAI-compatible

Use:

```text
http://localhost:9999/v1
```

This pattern can work with clients that support a custom OpenAI-compatible provider, including:

- Cursor
- Cline
- Roo Code
- Continue
- Qwen Code
- Crush
- custom Node.js/Python apps
- cURL/API clients

Set the custom base URL and use the MultiAI Router gateway key if authentication is enabled.

Chat completions reach any provider configured with a chat-completions endpoint
directly, and a Gemini provider through the router's translation bridge.

## Anthropic-compatible

Clients using the Anthropic Messages protocol should use:

```text
http://localhost:9999
```

## Gemini-compatible

Clients using the Gemini `generateContent` protocol should use:

```text
http://localhost:9999
```

### Tool choice through the bridge

A Gemini client that sends `toolConfig.functionCallingConfig` reaches a
chat-only provider through a translation bridge. The tool choice is translated
as follows:

| Gemini | Forwarded to the chat provider |
| --- | --- |
| `mode: "NONE"` | `tool_choice: "none"` |
| `mode: "ANY"`, one allowed function that the request declares | `tool_choice: {type: "function", function: {name}}` |
| `mode: "ANY"`, several allowed functions, all declared | `tool_choice: "required"`, with only the allowed declarations forwarded |
| `mode: "ANY"`, empty list, or names the request does not declare | `tool_choice: "required"`, all declarations forwarded |
| `mode: "ANY"`, but the request declares no tools at all | no `tool_choice`, no tools |
| `mode: "AUTO"` with allowed names | the default choice, with only the allowed declarations forwarded |

OpenAI-compatible APIs can express "call *some* function" but not "call one of
exactly these N". When several functions are allowed the bridge keeps the
restriction by forwarding only the allowed declarations, so a `required` choice
can only select among them — the upstream request means the same thing as the
original.

When the restriction cannot be represented, the bridge falls back to `required`
and drops the name restriction; the model is still told it must call a tool. A
function name the request never declares is never invented or forwarded as an
exact choice, because providers reject a `tool_choice` naming an unknown
function. And when there is nothing callable at all, no choice is sent: `required`
with an empty tool list is a contradictory request, so the bridge leaves the
choice unset rather than assert something the request cannot support.

## Fallback

Requests follow the configured order within each group of targets; health only
decides eligibility, so a cooling target is skipped but never reorders the list. An exact match for the
requested model is tried first, and only once those targets have failed or are
cooling down does the request widen to the remaining compatible targets. A
retryable failure moves the request to the next reachable target.

Falling back is no longer limited to targets that speak the client's own
protocol. Every client protocol the gateway accepts can fall back to **any**
configured provider — Claude Code (`/v1/messages`), Codex (`/v1/responses`) and
Gemini clients all reach chat-only and Gemini providers through a translation
bridge, and a chat client reaches a Gemini provider the same way. See
[CLIENTS.md](CLIENTS.md) for the protocol-by-provider matrix and the content a
bridged request drops.

For exact client configuration, use the client's own documentation.
