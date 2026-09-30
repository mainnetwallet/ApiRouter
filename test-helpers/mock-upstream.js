import http from "node:http";
import net from "node:net";

/**
 * A scripted upstream provider used by integration tests.
 *
 * `script` is a function (request, index) => response descriptor:
 *   { status, headers, body }        - body: string | Buffer | object
 *   { status, stream: [chunk, ...] } - chunked/SSE response
 *   { hang: true }                   - never responds (timeout tests)
 */
export async function startMockUpstream(script) {
  const requests = [];

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      let json = null;
      try { json = JSON.parse(raw); } catch { json = null; }

      const record = {
        method: req.method,
        url: req.url,
        headers: req.headers,
        rawBody: raw,
        body: json
      };
      requests.push(record);

      // Health monitor probes the provider base URL with GET.
      if (req.method === "GET") {
        res.writeHead(404, { "content-type": "application/json" });
        res.end("{}");
        return;
      }

      const descriptor = script(record, requests.length - 1) || {};

      if (descriptor.hang) return; // never respond

      const headers = { "content-type": "application/json", ...(descriptor.headers || {}) };
      const status = descriptor.status || 200;

      if (descriptor.stream) {
        res.writeHead(status, { ...headers, "content-type": headers["content-type"] || "text/event-stream" });
        if (descriptor.delayMs) res.flushHeaders?.();
        let i = 0;
        let stopped = false;
        res.on("close", () => { stopped = true; });
        const writeNext = () => {
          if (stopped) return;
          if (i >= descriptor.stream.length) return res.end();
          res.write(descriptor.stream[i]);
          i += 1;
          setTimeout(writeNext, descriptor.delayMs || 0);
        };
        return writeNext();
      }

      const body = typeof descriptor.body === "string" || Buffer.isBuffer(descriptor.body)
        ? descriptor.body
        : JSON.stringify(descriptor.body ?? { ok: true });

      res.writeHead(status, headers);
      res.end(body);
    });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();

  return {
    port,
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    /** Requests excluding health-monitor probes. */
    get apiRequests() {
      return requests.filter((r) => r.method === "POST");
    },
    close: () => new Promise((resolve) => server.close(resolve))
  };
}

export async function getFreePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}
