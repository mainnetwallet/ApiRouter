# OpenCode + MultiAI Router

OpenCode supports custom providers and configurable base URLs. MultiAI Router can be used as an OpenAI-compatible custom provider.

## 1. Start MultiAI Router

    npm start

Gateway base URL:

    http://127.0.0.1:8788/v1

## 2. Configure OpenCode

Edit your OpenCode config, for example:

    notepad $HOME\.config\opencode\opencode.json

Example:

    {
      "$schema": "https://opencode.ai/config.json",
      "provider": {
        "multi-ai-router": {
          "npm": "@ai-sdk/openai-compatible",
          "name": "MultiAI Router",
          "options": {
            "baseURL": "http://127.0.0.1:8788/v1",
            "apiKey": "{env:MULTIAI_ROUTER_API_KEY}"
          },
          "models": {
            "your-model": {
              "name": "Router Model"
            }
          }
        }
      }
    }

Then set:

    $env:MULTIAI_ROUTER_API_KEY="YOUR_LOCAL_ROUTER_KEY"

Use /models in OpenCode to select the configured model.

## 3. Routing

OpenCode
   |
   v
OpenAI-compatible endpoint
   |
   v
MultiAI Router
   |
   +--> global health ranking
   +--> key-level health
   +--> cooldown
   +--> automatic fallback

## 4. Notes

OpenCode's current provider documentation supports custom OpenAI-compatible providers and baseURL configuration.

Keep API keys outside the repository.

Official reference:
https://opencode.ai/docs/providers