import http from "node:http";
import { loadConfig } from "./config.js";
import { getAllHealth } from "./health.js";
import { PROVIDERS } from "./providers/catalog.js";

const config = loadConfig();
function json(res, status, body) { const payload = JSON.stringify(body); res.writeHead(status, {"content-type":"application/json; charset=utf-8","content-length":Buffer.byteLength(payload)}); res.end(payload); }
const server = http.createServer((req, res) => {
  if (req.method === "GET" && req.url === "/health") return json(res, 200, {ok:true, service:"multi-ai-router", providers:PROVIDERS, health:getAllHealth(), retryableStatus:[...config.retryableStatus]});
  if (req.method === "GET" && req.url === "/v1/models") return json(res, 200, {object:"list", data:[]});
  return json(res, 404, {error:{message:"Not found",type:"not_found"}});
});
server.listen(config.port, () => console.log(`MultiAI Router listening on http://127.0.0.1:${config.port}`));
