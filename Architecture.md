# MultiAI Router — Full Architecture

## Overview

MultiAI Router is a protocol-aware multi-provider AI gateway.

```text
Client
  ↓
HTTP Gateway
  ↓
Authentication
  ↓
Protocol Detection
  ↓
Compatible Targets
  ↓
Health Ranking
  ↓
Sticky Session
  ↓
Fallback Router
  ↓
Provider Adapter
  ↓
AI Provider
```

## Core Flow

1. Client sends a request to one of the supported gateway endpoints.
2. The gateway optionally authenticates the client.
3. The request protocol is detected from the endpoint.
4. Configured provider/model/key combinations are expanded into independent targets.
5. Targets incompatible with the client protocol are excluded.
6. If the requested model exists, matching targets are preferred.
7. Health ranking chooses the available targets.
8. The current session's successful target is preferred.
9. The router calls targets sequentially.
10. Retryable failures put the exact target into cooldown and move routing forward.
11. A successful target becomes the session's sticky target.
12. The upstream response is streamed back to the client.

## Supported Endpoints

| Method | Endpoint | Protocol |
|---|---|---|
| GET | `/health` | Router health |
| GET | `/v1/models` | Model discovery |
| POST | `/v1/messages` | Anthropic |
| POST | `/v1/responses` | OpenAI Responses |
| POST | `/v1/chat/completions` | OpenAI Chat Completions |

## Provider Target Model

Every configured provider/model/key combination becomes an independent target:

```text
provider + model + keyIndex
```

Example:

```text
Groq / model-a / key-0
Groq / model-a / key-1
Groq / model-b / key-0
Groq / model-b / key-1
```

This allows one failed API key to enter cooldown while sibling keys remain available.

## Protocol Mapping

```text
AgentRouter → anthropic, openai
Gemini      → gemini
Other       → openai
```

The adapter converts the common gateway request into the provider request format.

## Health System

Each target tracks:

```text
status
score
successes
failures
consecutiveFailures
latencyMs
lastStatus
cooldownUntil
updatedAt
```

Default failed-target cooldown:

```text
15 minutes
```

Default health refresh interval provided by the health module:

```text
15 minutes
```

Retryable status codes:

```text
402, 408, 429, 500, 502, 503, 504
```

## Sticky Sessions

The client may send:

```http
X-Multi-AI-Session-ID: <session-id>
```

If absent, the router creates a UUID and returns:

```http
x-multi-ai-session-id: <session-id>
```

A successful target becomes the session's preferred target. If it later fails with a retryable error, routing continues to the next available target.

## Security

Router authentication is optional:

```env
MULTIAI_ROUTER_API_KEYS=
```

Provider API keys remain server-side and are never returned in routing metadata.

Real credentials must stay in `.env` and must not be committed.

## Runtime

```text
Node.js >= 20
npm start
npm test
```

## Source Architecture

```text
src/
├── server.js              HTTP gateway
├── config.js              environment + target construction
├── router.js              fallback + sticky routing
├── health.js              health + ranking + cooldown
├── adapters.js            protocol + upstream request adapter
└── providers/
    └── catalog.js         provider catalog
```

## Complete Current Core Source

## src/server.js

```js
import http from "node:http";
import { loadConfig, buildTargets } from "./config.js";
import { getAllHealth, rankTargets, healthRegistry } from "./health.js";
import { RouteSession, withFallback } from "./router.js";
import { clientProtocol, buildUpstreamRequest, readJsonBody, createSessionId } from "./adapters.js";
import { PROVIDERS } from "./providers/catalog.js";

const config = loadConfig();
const targets = buildTargets(config.providers);
const sessions = new Map();

function json(res, status, body, extraHeaders = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(payload), ...extraHeaders });
  res.end(payload);
}

function authorized(req) {
  if (config.routerApiKeys.length === 0) return true;
  const value = String(req.headers.authorization || "");
  const token = value.startsWith("Bearer ") ? value.slice(7).trim() : "";
  return Boolean(token && config.routerApiKeys.includes(token));
}

function getSession(req, protocol) {
  const requested = String(req.headers["x-multi-ai-session-id"] || "").trim();
  const id = requested || createSessionId();
  const key = protocol + ":" + id;
  if (!sessions.has(key)) sessions.set(key, { id, protocol, session: new RouteSession() });
  return { id, state: sessions.get(key) };
}

function publicFailure(error) {
  return (error?.failures || []).map((item) => ({
    provider: item.target?.provider,
    model: item.target?.model,
    keyIndex: item.target?.keyIndex,
    status: item.status,
    message: item.message
  }));
}

async function proxy(req, res, protocol) {
  if (!authorized(req)) return json(res, 401, { error: { message: "Unauthorized", type: "authentication_error" } });

  let body;
  try { body = await readJsonBody(req); }
  catch (error) { return json(res, error.status || 400, { error: { message: error.message, type: "invalid_request_error" } }); }

  const sessionInfo = getSession(req, protocol);
  const compatible = targets.filter((target) => target.protocols.includes(protocol === "responses" ? "openai" : protocol));
  if (compatible.length === 0) return json(res, 503, { error: { message: "No configured provider targets support this client protocol", type: "no_route" } });

  const requestedModel = typeof body.model === "string" ? body.model : "";
  const exact = requestedModel ? compatible.filter((target) => target.model === requestedModel) : [];
  const routeTargets = exact.length ? exact : compatible;

  try {
    const result = await withFallback(
      routeTargets,
      async (target) => {
        const request = buildUpstreamRequest(target, protocol, body, req.headers);
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), config.timeoutMs);
        try {
          const upstream = await fetch(request.url, { ...request.options, signal: controller.signal });
          if (!upstream.ok) {
            const text = await upstream.text();
            const error = new Error(text.slice(0, 2000) || ("Upstream HTTP " + upstream.status));
            error.status = upstream.status;
            throw error;
          }
          return { upstream, target };
        } catch (error) {
          if (error.name === "AbortError") { error.status = 408; error.message = "Upstream request timed out"; }
          throw error;
        } finally { clearTimeout(timer); }
      },
      config.retryableStatus,
      sessionInfo.state.session,
      healthRegistry
    );

    const sessionId = sessionInfo.id;
    res.writeHead(result.upstream.status, {
      "content-type": result.upstream.headers.get("content-type") || "application/json",
      "cache-control": "no-cache",
      "x-multi-ai-provider": result.target.provider,
      "x-multi-ai-model": result.target.model,
      "x-multi-ai-key-index": String(result.target.keyIndex),
      "x-multi-ai-session-id": sessionId
    });
    if (result.upstream.body) {
      const reader = result.upstream.body.getReader();
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          res.write(Buffer.from(chunk.value));
        }
      } finally {
        res.end();
      }
    } else {
      res.end();
    }
  } catch (error) {
    return json(res, error.status || 502, { error: { message: error.message || "All routing targets failed", type: "upstream_error", failures: publicFailure(error) }, }, { "x-multi-ai-session-id": sessionInfo.id });
  }
}

const server = http.createServer(async (req, res) => {
  const pathname = new URL(req.url, "http://127.0.0.1").pathname;

  if (req.method === "GET" && pathname === "/health") {
    const ranked = rankTargets(targets).map((target, index) => ({ rank: index + 1, provider: target.provider, model: target.model, keyIndex: target.keyIndex, protocols: target.protocols }));
    return json(res, 200, { ok: true, service: "multi-ai-router", providers: PROVIDERS, configuredTargets: targets.length, health: getAllHealth(), rankedTargets: ranked, retryableStatus: [...config.retryableStatus] });
  }

  if (req.method === "GET" && pathname === "/v1/models") {
    const data = rankTargets(targets).map((target) => ({ id: target.model, object: "model", provider: target.provider, keyIndex: target.keyIndex }));
    return json(res, 200, { object: "list", data });
  }

  const protocol = req.method === "POST" ? clientProtocol(pathname) : null;
  if (protocol) return proxy(req, res, protocol);

  return json(res, 404, { error: { message: "Not found", type: "not_found" } });
});

server.listen(config.port, () => console.log("MultiAI Router listening on http://127.0.0.1:" + config.port));
```

## src/config.js

```js
import { providerProtocols } from "./adapters.js";

const DEFAULT_RETRY_STATUS_CODES = [402, 408, 429, 500, 502, 503, 504];

const PROVIDER_IDS = [
  "agentrouter", "gemini", "groq", "huggingface", "mistral",
  "openrouter", "cerebras", "cloudflare", "sambanova", "cohere", "zai"
];

const split = (value) => String(value || "")
  .split(",")
  .map((v) => v.trim())
  .filter(Boolean);

export function isProviderConfigured(provider) {
  return Boolean(
    provider &&
    provider.apiKeys.length > 0 &&
    provider.models.length > 0 &&
    provider.baseUrl
  );
}

export function buildTargets(providers) {
  const targets = [];

  for (const [providerId, provider] of Object.entries(providers)) {
    if (!isProviderConfigured(provider)) continue;

    for (const model of provider.models) {
      for (let keyIndex = 0; keyIndex < provider.apiKeys.length; keyIndex += 1) {
        targets.push({
          provider: providerId,
          model,
          baseUrl: provider.baseUrl,
          apiKey: provider.apiKeys[keyIndex],
          protocols: providerProtocols(providerId),
          keyIndex
        });
      }
    }
  }

  return targets;
}

export function loadConfig(env = process.env) {
  const providers = {};

  for (const id of PROVIDER_IDS) {
    const key = id.toUpperCase();
    providers[id] = {
      apiKeys: split(env[key + "_API_KEYS"]),
      models: split(env[key + "_MODELS"]),
      baseUrl: String(env[key + "_BASE_URL"] || "").trim()
    };
  }

  const retryableValues = split(
    env.RETRY_STATUS_CODES || DEFAULT_RETRY_STATUS_CODES.join(",")
  )
    .map(Number)
    .filter((v) => Number.isInteger(v) && v >= 100 && v <= 599);

  return {
    routerApiKeys: split(env.MULTIAI_ROUTER_API_KEYS),
    port: Number(env.PORT || 8788),
    timeoutMs: Number(env.REQUEST_TIMEOUT_MS || 120000),
    retryableStatus: new Set(retryableValues),
    providers
  };
}

```

## src/router.js

```js
import { HealthRegistry } from "./health.js";

const DEFAULT_RETRY_STATUS_CODES = new Set([402, 408, 429, 500, 502, 503, 504]);

export function isRetryableStatus(status, retryableStatus = DEFAULT_RETRY_STATUS_CODES) {
  return retryableStatus.has(Number(status));
}

export class RouteSession {
  constructor({ targetId = null } = {}) {
    this.targetId = targetId;
  }

  current(targets, health) {
    if (!Array.isArray(targets) || targets.length === 0) {
      const err = new Error("No fully configured routing targets available");
      err.status = 503;
      throw err;
    }

    if (this.targetId) {
      const target = targets.find((item) => health.key(item) === this.targetId);
      if (target && health.isAvailable(target)) return target;
    }

    return health.rank(targets)[0];
  }

  saveSuccess(target, health) {
    this.targetId = health.key(target);
  }
}

export async function withFallback(
  targets,
  invoke,
  retryableStatus = DEFAULT_RETRY_STATUS_CODES,
  session = new RouteSession(),
  health = new HealthRegistry()
) {
  if (!Array.isArray(targets) || targets.length === 0) {
    const err = new Error("No fully configured routing targets available");
    err.status = 503;
    throw err;
  }

  const failures = [];
  const ranked = health.rank(targets);

  if (ranked.length === 0) {
    const err = new Error("No routing targets are currently available");
    err.status = 503;
    err.failures = [];
    throw err;
  }

  const preferred = session.current(ranked, health);
  const preferredId = health.key(preferred);
  const start = Math.max(
    0,
    ranked.findIndex((target) => health.key(target) === preferredId)
  );

  for (let index = start; index < ranked.length; index += 1) {
    const target = ranked[index];
    if (!health.isAvailable(target)) continue;

    const startedAt = Date.now();

    try {
      const result = await invoke(target);
      health.markSuccess(target, { latencyMs: Date.now() - startedAt });
      session.saveSuccess(target, health);
      return result;
    } catch (error) {
      const status = Number(error?.status || 0);

      failures.push({
        target,
        status,
        message: error?.message || String(error)
      });

      if (!isRetryableStatus(status, retryableStatus) && !error?.retryable) {
        throw error;
      }

      health.markFailure(target, status);
    }
  }

  const err = new Error("All routing targets failed");
  err.status = 502;
  err.failures = failures;
  throw err;
}

```

## src/health.js

```js
const DEFAULT_COOLDOWN_MS = 15 * 60 * 1000;
const DEFAULT_HEALTH_CHECK_INTERVAL_MS = 15 * 60 * 1000;

export const targetId = (target) =>
  target.id || `${target.provider}:${target.model}:key-${target.keyIndex}`;

export class HealthRegistry {
  constructor({ cooldownMs = DEFAULT_COOLDOWN_MS } = {}) {
    this.cooldownMs = cooldownMs;
    this.states = new Map();
  }

  key(target) {
    return targetId(target);
  }

  ensureTarget(target) {
    const id = this.key(target);
    if (!this.states.has(id)) {
      this.states.set(id, {
        id,
        provider: target.provider,
        model: target.model,
        keyIndex: target.keyIndex,
        status: "unknown",
        score: 50,
        cooldownUntil: 0,
        successes: 0,
        failures: 0,
        consecutiveFailures: 0,
        latencyMs: null,
        lastStatus: null,
        updatedAt: new Date().toISOString()
      });
    }
    return this.states.get(id);
  }

  get(id) {
    return this.states.get(id) || { id, status: "unknown" };
  }

  all() {
    return [...this.states.values()].map((state) => ({ ...state }));
  }

  isAvailable(target, now = Date.now()) {
    return this.ensureTarget(target).cooldownUntil <= now;
  }

  markSuccess(target, { latencyMs = null } = {}, now = Date.now()) {
    const state = this.ensureTarget(target);
    state.status = "healthy";
    state.score = Math.min(100, state.score * 0.75 + 25);
    state.cooldownUntil = 0;
    state.successes += 1;
    state.consecutiveFailures = 0;
    state.lastStatus = 200;
    state.latencyMs = Number.isFinite(latencyMs) ? latencyMs : state.latencyMs;
    state.updatedAt = new Date(now).toISOString();
    return state;
  }

  markFailure(target, status, { cooldownMs = this.cooldownMs } = {}, now = Date.now()) {
    const state = this.ensureTarget(target);
    state.status = "failed";
    state.score = Math.max(0, state.score * 0.7 - 10);
    state.cooldownUntil = now + cooldownMs;
    state.failures += 1;
    state.consecutiveFailures += 1;
    state.lastStatus = Number(status) || null;
    state.updatedAt = new Date(now).toISOString();
    return state;
  }

  recordHealthCheck(target, { ok, status = ok ? 200 : 503, latencyMs = null } = {}, now = Date.now()) {
    return ok
      ? this.markSuccess(target, { latencyMs }, now)
      : this.markFailure(target, status, {}, now);
  }

  rank(targets, now = Date.now()) {
    return [...targets]
      .filter((target) => this.isAvailable(target, now))
      .sort((a, b) => {
        const aState = this.ensureTarget(a);
        const bState = this.ensureTarget(b);
        return (bState.score - aState.score)
          || String(a.provider).localeCompare(String(b.provider))
          || String(a.model).localeCompare(String(b.model))
          || Number(a.keyIndex) - Number(b.keyIndex);
      });
  }
}

export const healthRegistry = new HealthRegistry();

export function setHealth(id, status, extra = {}) {
  const previous = healthRegistry.get(id);
  healthRegistry.states.set(id, {
    ...previous,
    id,
    status,
    updatedAt: new Date().toISOString(),
    ...extra
  });
}

export function getHealth(id) {
  return healthRegistry.get(id);
}

export function getAllHealth() {
  return healthRegistry.all();
}

export function ensureTargetHealth(target) {
  return healthRegistry.ensureTarget(target);
}

export function isAvailable(target, now = Date.now()) {
  return healthRegistry.isAvailable(target, now);
}

export function markSuccess(target, options = {}, now = Date.now()) {
  return healthRegistry.markSuccess(target, options, now);
}

export function markFailure(target, status, options = {}, now = Date.now()) {
  return healthRegistry.markFailure(target, status, options, now);
}

export function recordHealthCheck(target, result = {}, now = Date.now()) {
  return healthRegistry.recordHealthCheck(target, result, now);
}

export function rankTargets(targets, now = Date.now()) {
  return healthRegistry.rank(targets, now);
}

export async function refreshAllHealth(targets, check) {
  if (!Array.isArray(targets) || typeof check !== "function") {
    throw new TypeError("refreshAllHealth requires targets[] and check(target)");
  }

  const results = [];

  for (const target of targets) {
    const startedAt = Date.now();

    try {
      const result = await check(target);
      const state = recordHealthCheck(target, {
        ...result,
        latencyMs: result?.latencyMs ?? Date.now() - startedAt
      });
      results.push({ target, state });
    } catch (error) {
      const status = Number(error?.status || 503);
      const state = markFailure(target, status);
      results.push({
        target,
        state,
        error: error?.message || String(error)
      });
    }
  }

  return results;
}

export function startHealthMonitor(
  targets,
  check,
  intervalMs = DEFAULT_HEALTH_CHECK_INTERVAL_MS
) {
  const run = () => refreshAllHealth(targets, check).catch(() => []);
  void run();
  const timer = setInterval(run, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

```

## src/adapters.js

```js
import { randomUUID } from "node:crypto";

const OPENAI_PROTOCOL_PROVIDERS = new Set(["groq","huggingface","mistral","openrouter","cerebras","sambanova","cohere","zai"]);

export function providerProtocols(provider) {
  if (provider === "agentrouter") return ["anthropic", "openai"];
  if (provider === "gemini") return ["gemini"];
  return ["openai"];
}

export function providerProtocol(provider) {
  return providerProtocols(provider)[0];
}

function joinUrl(baseUrl, suffix) {
  const base = String(baseUrl || "").replace(/\/+$/, "");
  const path = String(suffix || "").replace(/^\/+/, "");
  return path ? base + "/" + path : base;
}

export function buildUpstreamRequest(target, protocol, body, incomingHeaders = {}) {
  const payload = { ...(body || {}), model: target.model };
  const headers = { "content-type": "application/json", accept: incomingHeaders.accept || "application/json" };\n  if (incomingHeaders["user-agent"]) headers["user-agent"] = incomingHeaders["user-agent"];\n  if (incomingHeaders.originator) headers.originator = incomingHeaders.originator;
  const base = String(target.baseUrl || "").replace(/\/+$/, "");
  let url;

  if (protocol === "anthropic") {
    url = joinUrl(base, base.endsWith("/v1") ? "messages" : "v1/messages");
    headers.authorization = "Bearer " + target.apiKey;
    headers["anthropic-version"] = incomingHeaders["anthropic-version"] || "2023-06-01";
    if (incomingHeaders["anthropic-beta"]) headers["anthropic-beta"] = incomingHeaders["anthropic-beta"];
  } else if (protocol === "responses") {
    url = joinUrl(base, base.endsWith("/v1") ? "responses" : "v1/responses");
    headers.authorization = "Bearer " + target.apiKey;
  } else {
    url = joinUrl(base, base.endsWith("/v1") ? "chat/completions" : "v1/chat/completions");
    headers.authorization = "Bearer " + target.apiKey;
  }

  return { url, options: { method: "POST", headers, body: JSON.stringify(payload) } };
}

export function createSessionId() { return randomUUID(); }

export async function readJsonBody(req, maxBytes = 10 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) { const error = new Error("Request body too large"); error.status = 413; throw error; }
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export function clientProtocol(pathname) {
  if (pathname === "/v1/messages") return "anthropic";
  if (pathname === "/v1/responses") return "responses";
  if (pathname === "/v1/chat/completions") return "openai";
  return null;
}
```

## Architecture Limitations

- Sessions are currently stored in process memory.
- Health state is currently stored in process memory.
- The health module exposes active refresh infrastructure, but the current server does not wire a provider-specific active health-check function into startup.
- Provider protocol capabilities must remain explicit; not every provider necessarily implements every protocol endpoint.
- Distributed deployments require shared session and health state.

## Configuration Contract

Each provider requires all three:

```text
<PROVIDER>_API_KEYS
<PROVIDER>_MODELS
<PROVIDER>_BASE_URL
```

A provider missing any one of these is excluded from generated routing targets.

## Design Principle

The gateway presents a stable client-facing interface while provider credentials, model selection, health state, fallback behavior, and upstream protocol details remain inside the router.
