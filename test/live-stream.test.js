import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { RequestLog } from "../src/observability/request-log.js";
import { startRouter, postJson } from "../test-helpers/router-harness.js";

test("subscribe() hears begin, progress and record, and stops after unsubscribe", () => {
  const log = new RequestLog();
  const heard = [];
  const off = log.subscribe(({ type, entry }) => heard.push([type, entry.outcome, entry.attemptCount ?? null]));

  const seq = log.begin({ id: "a", receivedAt: Date.now() });
  log.progress(seq, { inflight: { provider: "groq", model: "m", keyIndex: 0, startedAt: Date.now() } });
  log.progress(seq, { attempts: [{ provider: "groq", model: "m", keyIndex: 0, ok: false, status: 500 }], inflight: null });
  log.record({ id: "a", pendingSeq: seq, outcome: "failed", httpStatus: 502 });

  // The attempt reported without an id is registered once as its own `attempt`
  // event (a real upstream call is always an event), between the pending updates.
  assert.deepEqual(heard.map((h) => h[0]), ["pending", "pending", "attempt", "pending", "entry"]);
  assert.equal(heard[4][1], "failed");

  off();
  log.begin({ id: "b" });
  assert.equal(heard.length, 5, "no events after unsubscribe");
});

test("a throwing listener never breaks the request log", () => {
  const log = new RequestLog();
  log.subscribe(() => { throw new Error("boom"); });
  assert.doesNotThrow(() => log.begin({ id: "x" }));
  assert.equal(log.pending().length, 1);
});

/** Reads an SSE response into `events`, resolving waiters as they arrive. */
async function openStream(router, headers = {}) {
  const res = await router.request("/api/requests/stream", { headers });
  const events = [];
  const waiters = [];
  const decoder = new TextDecoder();
  let buffer = "";
  const t0 = performance.now();

  if (res.status === 200) {
    (async () => {
      for await (const chunk of res.body) {
        buffer += decoder.decode(chunk, { stream: true });
        let end;
        while ((end = buffer.indexOf("\n\n")) !== -1) {
          const block = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          const event = /^event: (.*)$/m.exec(block)?.[1];
          const data = /^data: (.*)$/m.exec(block)?.[1];
          if (!event || !data) continue;
          const item = { event, data: JSON.parse(data), at: performance.now() - t0 };
          events.push(item);
          for (const w of [...waiters]) w(item);
        }
      }
    })().catch(() => {});
  }

  const next = (match) => new Promise((resolve, reject) => {
    const found = events.find(match);
    if (found) return resolve(found);
    const timer = setTimeout(() => reject(new Error("event not received in time")), 3000);
    const waiter = (item) => {
      if (match(item)) { clearTimeout(timer); waiters.splice(waiters.indexOf(waiter), 1); resolve(item); }
    };
    waiters.push(waiter);
  });
  return { res, events, next, close: () => res.body?.cancel().catch(() => {}) };
}

async function heldUpstream() {
  const waiting = [];
  const server = http.createServer((req, res) => {
    if (req.method === "GET") { res.writeHead(404); return res.end("{}"); }
    req.resume();
    req.on("end", () => waiting.push(res));
  });
  await new Promise((resolve) => server.listen(0, "localhost", resolve));
  return {
    baseUrl: `http://localhost:${server.address().port}`,
    get held() { return waiting.length; },
    reply(status, body) {
      const res = waiting.shift();
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    },
    close: () => { server.closeAllConnections?.(); return new Promise((resolve) => server.close(resolve)); }
  };
}

const OK = {
  id: "c", object: "chat.completion", model: "m",
  choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
  usage: { total_tokens: 2 }
};
const until = async (check, ms = 3000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await check()) return; await new Promise((r) => setTimeout(r, 10)); }
  throw new Error("condition not met in time");
};

test("the stream pushes every step of a call while the upstream is still held", async (t) => {
  const groq = await heldUpstream();
  const router = await startRouter({ GROQ_API_KEYS: "k0,k1", GROQ_MODELS: "m", GROQ_BASE_URL: groq.baseUrl });
  const stream = await openStream(router);
  t.after(async () => { await stream.close(); await router.close(); await groq.close(); });

  assert.equal(stream.res.status, 200);
  assert.match(stream.res.headers.get("content-type"), /text\/event-stream/);
  const snapshot = await stream.next((e) => e.event === "snapshot");
  assert.deepEqual(snapshot.data.pending, []);

  const call = router.request("/v1/chat/completions", postJson({ model: "m", messages: [{ role: "user", content: "hi" }] }));

  // Pushed with nothing polling: the call is on the wire and the upstream has not answered.
  const calling = await stream.next((e) => e.event === "pending" && e.data.inflight?.keyIndex === 0);
  assert.equal(groq.held <= 1, true);
  assert.ok(calling.at < 1000, "arrives immediately, not on a poll interval");

  await until(() => groq.held === 1);
  groq.reply(429, { error: { message: "slow down" } });
  const retry = await stream.next((e) => e.event === "pending" && e.data.attemptCount === 1 && e.data.inflight?.keyIndex === 1);
  assert.equal(retry.data.attempts[0].status, 429);
  assert.equal(retry.data.startSeq, calling.data.startSeq, "same call, next box");

  await until(() => groq.held === 1);
  groq.reply(200, OK);
  assert.equal((await call).status, 200);

  const done = await stream.next((e) => e.event === "entry");
  assert.equal(done.data.outcome, "success");
  assert.equal(done.data.startSeq, calling.data.startSeq);
  assert.equal(done.data.attempts.length, 2);
});

test("a client that connects mid-call gets it in the snapshot", async (t) => {
  const groq = await heldUpstream();
  const router = await startRouter({ GROQ_API_KEYS: "k0", GROQ_MODELS: "m", GROQ_BASE_URL: groq.baseUrl });
  t.after(async () => { await router.close(); await groq.close(); });

  const call = router.request("/v1/chat/completions", postJson({ model: "m", messages: [{ role: "user", content: "hi" }] }));
  await until(() => groq.held === 1);

  const stream = await openStream(router);
  t.after(() => stream.close());
  const snapshot = await stream.next((e) => e.event === "snapshot");
  assert.equal(snapshot.data.pending.length, 1);
  assert.equal(snapshot.data.pending[0].inflight.keyIndex, 0);

  groq.reply(200, OK);
  await call;
});

test("the stream is behind the same client auth as the rest of /api", async (t) => {
  const router = await startRouter({ MULTIAI_ROUTER_API_KEYS: "secret-client-key" });
  t.after(() => router.close());

  const denied = await router.request("/api/requests/stream");
  assert.equal(denied.status, 401);
  await denied.body?.cancel();

  const stream = await openStream(router, { authorization: "Bearer secret-client-key" });
  t.after(() => stream.close());
  assert.equal(stream.res.status, 200);
  await stream.next((e) => e.event === "snapshot");
});

test("/api/requests/stream is not mistaken for a request id lookup", async (t) => {
  const router = await startRouter({});
  const stream = await openStream(router);
  t.after(async () => { await stream.close(); await router.close(); });
  assert.equal(stream.res.status, 200);
});
