# OpenAI-Compatible Clients + ApiRouter

## Base URL

```text
http://localhost:8788/v1
```

## API key

### With ApiRouter API key

```text
YOUR_APIROUTER_KEY
```

### Without ApiRouter API key

```text
any-key
```

## JavaScript

```js
import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "http://localhost:8788/v1",
  apiKey: process.env.APIROUTER_API_KEY || "any-key"
});

const response = await client.chat.completions.create({
  model: "Router",
  messages: [{ role: "user", content: "Hello" }]
});
```

## Python

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://localhost:8788/v1",
    api_key="YOUR_APIROUTER_KEY",
)

response = client.chat.completions.create(
    model="Router",
    messages=[{"role": "user", "content": "Hello"}],
)
```