@echo off
rem Launch Claude Code against the local MultiAI Router (Windows).
rem Sets the gateway env and makes localhost bypass any system proxy.
if "%ROUTER_URL%"=="" (set "ANTHROPIC_BASE_URL=http://localhost:8788") else (set "ANTHROPIC_BASE_URL=%ROUTER_URL%")
if "%ANTHROPIC_AUTH_TOKEN%"=="" set "ANTHROPIC_AUTH_TOKEN=any-key"
set "ANTHROPIC_API_KEY="
if "%NO_PROXY%"=="" (set "NO_PROXY=127.0.0.1,localhost") else (set "NO_PROXY=127.0.0.1,localhost,%NO_PROXY%")
set "no_proxy=%NO_PROXY%"
claude %*
