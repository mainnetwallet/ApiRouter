import http from "node:http";
import { getFreePort } from "./mock-upstream.js";

/**
 * A scriptable HTTP upstream for lifecycle tests: `handler(req, res, body)` decides
 * the response, including breaking it half-way. GET probes (the router's health
 * checks) are answered 404 and never reach the handler or the call log.
 */
export async function startUpstream(handler) {
  const port = await getFreePort();
  const calls = [];
  const sockets = new Set();
  const server = http.createServer((req, res) => {
    if (req.method === "GET" && !req.url.startsWith("/img")) {
      res.writeHead(404, { "content-type": "application/json" });
      return res.end("{}");
    }
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      let body = null;
      try { body = raw ? JSON.parse(raw) : null; } catch { /* not JSON */ }
      calls.push({ method: req.method, url: req.url, headers: req.headers, body });
      handler(req, res, body);
    });
  });
  server.on("connection", (socket) => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
  await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
  return {
    port,
    url: `http://127.0.0.1:${port}`,
    calls,
    close: () => new Promise((resolve) => {
      for (const socket of sockets) socket.destroy();
      server.close(resolve);
    })
  };
}

export const chatJsonReply = (content = "ok") => JSON.stringify({
  id: "c1", object: "chat.completion", model: "m",
  choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
});

export const sseChunk = (delta, finish = null) =>
  "data: " + JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finish }] }) + "\n\n";

export const PNG_BYTES = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
