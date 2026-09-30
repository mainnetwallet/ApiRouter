# OpenAI-Compatible Clients + MultiAI Router

Any client or SDK that supports a custom OpenAI-compatible base URL can use MultiAI Router.

Gateway:

    http://127.0.0.1:8788/v1

## OpenAI SDK

JavaScript:

    import OpenAI from "openai";

    const client = new OpenAI({
      baseURL: "http://127.0.0.1:8788/v1",
      apiKey: process.env.MULTIAI_ROUTER_API_KEY
    });

    const response = await client.chat.completions.create({
      model: "your-model",
      messages: [{ role: "user", content: "Hello" }]
    });

Python:

    from openai import OpenAI
    import os

    client = OpenAI(
        base_url="http://127.0.0.1:8788/v1",
        api_key=os.environ["MULTIAI_ROUTER_API_KEY"],
    )

## cURL

    curl http://127.0.0.1:8788/v1/chat/completions `
      -H "Authorization: Bearer $env:MULTIAI_ROUTER_API_KEY" `
      -H "Content-Type: application/json" `
      -d '{"model":"your-model","messages":[{"role":"user","content":"Hello"}]}'

## What happens

    Client
      |
      v
    /v1/chat/completions
      |
      v
    MultiAI Router
      |
      +--> healthy target
      +--> failed target cooldown
      +--> next target

Provider API keys never need to be exposed to the client.

## Other coding clients

Clients such as Cursor, Cline, Roo Code, Continue, Qwen Code, Crush and similar tools can use this same pattern when their provider configuration supports a custom OpenAI-compatible endpoint.

Use the client's own provider/base URL setting and point it to:

    http://127.0.0.1:8788/v1

Then provide the MultiAI Router gateway key if gateway authentication is enabled.