# OpenAI-Compatible Clients

Any client or SDK that supports a custom OpenAI-compatible base URL can use MultiAI Router.

Gateway:

```text
http://localhost:9999/v1
```

## JavaScript

```js
import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "http://localhost:9999/v1",
  apiKey: process.env.MULTIAI_ROUTER_API_KEY
});

const response = await client.chat.completions.create({
  model: "your-model",
  messages: [{ role: "user", content: "Hello" }]
});
```

## Python

```python
from openai import OpenAI
import os

client = OpenAI(
    base_url="http://localhost:9999/v1",
    api_key=os.environ["MULTIAI_ROUTER_API_KEY"],
)
```

## cURL

PowerShell:

```powershell
curl.exe http://localhost:9999/v1/chat/completions `
  -H "Authorization: Bearer $env:MULTIAI_ROUTER_API_KEY" `
  -H "Content-Type: application/json" `
  -d '{"model":"your-model","messages":[{"role":"user","content":"Hello"}]}'
```

The router handles health ranking and fallback while provider keys stay server-side.

A chat-completions provider is called directly. A Gemini provider is reached
through the router's translation bridge, so a Gemini-only configuration still
serves any OpenAI-compatible client. On such a bridged request, tools that are
not `type: "function"` are dropped (they have no `generateContent` equivalent)
and only base64 `data:` image URLs are forwarded.

An exact match for the requested model is tried first, then the remaining
reachable targets; a retryable failure moves the request to the next one.

Clients such as Cursor, Cline, Roo Code, Continue, Qwen Code and similar tools can use the same endpoint when they support custom OpenAI-compatible providers.
