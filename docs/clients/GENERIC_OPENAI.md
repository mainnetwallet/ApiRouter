# OpenAI-Compatible Clients

Any client or SDK that supports a custom OpenAI-compatible base URL can use MultiAI Router.

Gateway:

```text
http://127.0.0.1:8788/v1
```

## JavaScript

```js
import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "http://127.0.0.1:8788/v1",
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
    base_url="http://127.0.0.1:8788/v1",
    api_key=os.environ["MULTIAI_ROUTER_API_KEY"],
)
```

## cURL

PowerShell:

```powershell
curl.exe http://127.0.0.1:8788/v1/chat/completions `
  -H "Authorization: Bearer $env:MULTIAI_ROUTER_API_KEY" `
  -H "Content-Type: application/json" `
  -d '{"model":"your-model","messages":[{"role":"user","content":"Hello"}]}'
```

The router handles health ranking and fallback while provider keys stay server-side.

Clients such as Cursor, Cline, Roo Code, Continue, Qwen Code and similar tools can use the same endpoint when they support custom OpenAI-compatible providers.
