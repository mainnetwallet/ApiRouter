import http from "node:http";
import { loadConfig, buildTargets } from "./config.js";
import { getAllHealth, rankTargets, healthRegistry, startHealthMonitor } from "./health.js";
import { RouteSession, withFallback } from "./router.js";
import { clientProtocol, buildUpstreamRequest, readJsonBody, createSessionId } from "./adapters.js";
import { PROVIDERS } from "./providers/catalog.js";

const config = loadConfig();
const targets = buildTargets(config.providers);
const sessions = new Map();

async function checkTargetHealth(target) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.min(config.timeoutMs, 10000));

  try {
    const upstream = await fetch(target.baseUrl, {
      method: "GET",
      headers: { authorization: "Bearer " + target.apiKey },
      signal: controller.signal
    });

    if (upstream.status >= 500 || upstream.status === 429) {
      const error = new Error("Provider health endpoint returned HTTP " + upstream.status);
      error.status = upstream.status;
      throw error;
    }

    return { ok: true, status: upstream.status };
  } catch (error) {
    if (error.name === "AbortError") {
      error.status = 408;
      error.message = "Provider health check timed out";
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

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
  const compatible = targets.filter((target) => target.protocols.includes(protocol));
  if (compatible.length === 0) return json(res, 503, { error: { message: "No configured provider targets support this client protocol", type: "no_route" } });

  const geminiPathModel = protocol === "gemini" ? pathname.match(/^\/v1beta\/models\/([^:]+):generateContent$/)?.[1] : "";\n  const requestedModel = typeof body.model === "string" ? body.model : (geminiPathModel || "");
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

const stopHealthMonitor = startHealthMonitor(targets, checkTargetHealth);
process.once("SIGINT", () => {
  stopHealthMonitor();
  server.close(() => process.exit(0));
});
process.once("SIGTERM", () => {
  stopHealthMonitor();
  server.close(() => process.exit(0));
});

server.listen(config.port, () => console.log("MultiAI Router listening on http://127.0.0.1:" + config.port));