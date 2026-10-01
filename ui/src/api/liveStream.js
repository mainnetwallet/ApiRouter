import { getRouterToken } from "../lib/session.js";

/**
 * Live request stream (server-sent events) for Live Logs.
 *
 * `fetch` rather than `EventSource`: the panel authenticates with a Bearer
 * header, and `EventSource` cannot send headers. Everything else is the same
 * contract: a `snapshot` event first, then one event per change.
 */

/**
 * Incremental SSE parser. Feed it text as it arrives; it calls `onEvent({event,
 * data})` once per complete event and ignores comments (heartbeats).
 */
export function createSseParser(onEvent) {
  let buffer = "";
  return {
    feed(text) {
      buffer += text.replace(/\r\n?/g, "\n");
      let end;
      while ((end = buffer.indexOf("\n\n")) !== -1) {
        const block = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);

        let event = "message";
        const data = [];
        for (const line of block.split("\n")) {
          if (!line || line.startsWith(":")) continue;
          const colon = line.indexOf(":");
          const field = colon === -1 ? line : line.slice(0, colon);
          const value = colon === -1 ? "" : line.slice(colon + 1).replace(/^ /, "");
          if (field === "event") event = value;
          else if (field === "data") data.push(value);
        }
        if (data.length === 0) continue;
        try {
          onEvent({ event, data: JSON.parse(data.join("\n")) });
        } catch { /* a malformed event is skipped, never fatal */ }
      }
    }
  };
}

/** The server pings every 15 s; this long without a byte means a dead link. */
const STALL_MS = 40_000;
const RETRY_BASE_MS = 500;
const RETRY_MAX_MS = 5_000;

/**
 * Open the stream and keep it open, reconnecting with backoff. Each reconnect
 * starts with a fresh `snapshot`, so nothing missed while away is lost.
 *
 * @param {{limit?: number, onEvent: (e: {event: string, data: any}) => void,
 *          onState?: (state: "connecting"|"open"|"error") => void}} options
 * @returns {() => void} close
 */
export function openRequestStream({ limit = 200, onEvent, onState = () => {} }) {
  let stopped = false;
  let controller = null;

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  async function run() {
    let failures = 0;
    while (!stopped) {
      controller = new AbortController();
      let stall = null;
      const arm = () => {
        clearTimeout(stall);
        stall = setTimeout(() => controller.abort(), STALL_MS);
      };

      try {
        onState("connecting");
        const token = getRouterToken();
        const response = await fetch(`/api/requests/stream?limit=${limit}`, {
          headers: { accept: "text/event-stream", ...(token ? { authorization: `Bearer ${token}` } : {}) },
          cache: "no-store",
          signal: controller.signal
        });
        if (!response.ok || !response.body) throw new Error(`stream ${response.status}`);

        failures = 0;
        onState("open");
        arm();
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        const parser = createSseParser(onEvent);
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          arm();
          parser.feed(decoder.decode(value, { stream: true }));
        }
      } catch { /* fall through to the retry below */ } finally {
        clearTimeout(stall);
      }

      if (stopped) return;
      onState("error");
      failures += 1;
      await sleep(Math.min(RETRY_BASE_MS * 2 ** (failures - 1), RETRY_MAX_MS));
    }
  }

  void run();
  return () => {
    stopped = true;
    controller?.abort();
  };
}
