import http from "node:http";
import { loadConfig, buildTargets } from "./config.js";
import { getAllHealth, rankTargets } from "./health.js";
import { PROVIDERS } from "./providers/catalog.js";

const config = loadConfig();
const targets = buildTargets(config.providers);

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload)
  });
  res.end(payload);
}

const server = http.createServer((req, res) => {
  if (req.method === "GET" && req.url === "/health") {
    const ranked = rankTargets(targets).map((target, index) => ({
      rank: index + 1,
      provider: target.provider,
      model: target.model,
      keyIndex: target.keyIndex
    }));

    return json(res, 200, {
      ok: true,
      service: "multi-ai-router",
      providers: PROVIDERS,
      configuredTargets: targets.length,
      health: getAllHealth(),
      rankedTargets: ranked,
      retryableStatus: [...config.retryableStatus]
    });
  }

  if (req.method === "GET" && req.url === "/v1/models") {
    const data = targets.map((target) => ({
      id: target.model,
      object: "model",
      provider: target.provider,
      keyIndex: target.keyIndex
    }));

    return json(res, 200, { object: "list", data });
  }

  return json(res, 404, {
    error: { message: "Not found", type: "not_found" }
  });
});

server.listen(config.port, () =>
  console.log(`MultiAI Router listening on http://127.0.0.1:${config.port}`)
);
