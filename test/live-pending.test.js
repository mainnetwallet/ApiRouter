import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { RequestLog } from "../src/observability/request-log.js";
import { startRouter, postJson } from "../test-helpers/router-harness.js";

const SECRET = "sk-super-secret-provider-key-1234567890";
const NOW = Date.now();

test("begin() registers a pending request that never appears among completed entries", () => {
  const log = new RequestLog();
  const startSeq = log.begin({ id: "r1", receivedAt: NOW, protocol: "anthropic", requestedModel: "m" });

  assert.equal(log.pending().length, 1);
  assert.equal(log.size, 0, "a running request is not a completed entry");
  assert.deepEqual(log.list().entries, []);
  assert.equal(log.pending()[0].outcome, "pending");
  assert.equal(log.pending()[0].startSeq, startSeq);
});

test("progress() shows finished attempts and the attempt on the wire", () => {
  const log = new RequestLog();
  const seq = log.begin({ id: "r1", receivedAt: NOW, protocol: "chat" });

  log.progress(seq, { inflight: { provider: "groq", model: "m", keyIndex: 0, startedAt: NOW + 100 } });
  assert.equal(log.pending()[0].inflight.provider, "groq");
  assert.equal(log.pending()[0].inflight.keyIndex, 0);

  log.progress(seq, {
    attempts: [{ provider: "groq", model: "m", keyIndex: 0, ok: false, status: 429, startedAt: NOW + 100, latencyMs: 80, errorMessage: `bad ${SECRET}` }],
    inflight: null
  });
  const [pending] = log.pending();
  assert.equal(pending.inflight, null);
  assert.equal(pending.attemptCount, 1);
  assert.equal(pending.attempts[0].status, 429);
  assert.ok(!JSON.stringify(pending).includes(SECRET), "attempt text is scrubbed like completed entries");
});

test("record() with pendingSeq retires the pending entry and keeps its start order", () => {
  const log = new RequestLog();
  const first = log.begin({ id: "a", receivedAt: NOW });
  const second = log.begin({ id: "b", receivedAt: NOW + 1 });

  // The later request finishes first.
  const doneB = log.record({ id: "b", receivedAt: NOW + 1, pendingSeq: second, outcome: "success", httpStatus: 200 });
  assert.equal(log.pending().length, 1);
  assert.equal(doneB.startSeq, second);

  const doneA = log.record({ id: "a", receivedAt: NOW, pendingSeq: first, outcome: "success", httpStatus: 200 });
  assert.equal(log.pending().length, 0);
  assert.equal(doneA.startSeq, first);
  assert.ok(doneA.seq > doneB.seq, "completion order still drives seq, so cursor paging is unchanged");
});

test("a record without begin() uses its own seq as startSeq", () => {
  const log = new RequestLog();
  const stored = log.record({ id: "x", outcome: "failed", httpStatus: 401 });
  assert.equal(stored.startSeq, stored.seq);
});

test("an abandoned pending request is dropped after the TTL", () => {
  const log = new RequestLog();
  log.begin({ id: "old", receivedAt: Date.now() - 11 * 60 * 1000 });
  assert.equal(log.pending().length, 0);
});

/** An upstream that holds each response until the test releases it. */
async function startHeldUpstream() {
  const waiting = [];
  const server = http.createServer((req, res) => {
    if (req.method === "GET") { res.writeHead(404); return res.end("{}"); }
    req.resume();
    req.on("end", () => waiting.push(res));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const reply = (status, body) => {
    const res = waiting.shift();
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    get held() { return waiting.length; },
    reply,
    close: () => { server.closeAllConnections?.(); return new Promise((resolve) => server.close(resolve)); }
  };
}

const until = async (check, ms = 4000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("condition not met in time");
};

test("/api/requests exposes a request while it runs, through a fallback, until it completes", async (t) => {
  const groq = await startHeldUpstream();
  const router = await startRouter({
    GROQ_API_KEYS: "groq-k0,groq-k1",
    GROQ_MODELS: "m",
    GROQ_BASE_URL: groq.baseUrl
  });
  t.after(async () => { await router.close(); await groq.close(); });

  const live = async () => (await (await router.request("/api/requests")).json());
  const call = router.request("/v1/chat/completions", postJson({ model: "m", messages: [{ role: "user", content: "hi" }] }));

  // 1. key 0 is on the wire.
  const running = await until(async () => {
    const { pending } = await live();
    return pending.find((entry) => entry.inflight?.keyIndex === 0);
  });
  assert.equal(running.outcome, "pending");
  assert.equal(running.attemptCount, 0);
  assert.equal((await live()).entries.length, 0, "not yet a completed entry");

  // 2. key 0 is rate limited; the router falls back to key 1.
  await until(() => groq.held === 1);
  groq.reply(429, { error: { message: "slow down" } });
  const retrying = await until(async () => {
    const { pending } = await live();
    return pending.find((entry) => entry.attemptCount === 1 && entry.inflight?.keyIndex === 1);
  });
  assert.equal(retrying.attempts[0].status, 429);
  assert.equal(retrying.attempts[0].keyIndex, 0);

  // 3. key 1 answers; the request leaves the pending list for the log.
  await until(() => groq.held === 1);
  groq.reply(200, {
    id: "c", object: "chat.completion", model: "m",
    choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
    usage: { total_tokens: 2 }
  });
  assert.equal((await call).status, 200);

  const done = await live();
  assert.equal(done.pending.length, 0);
  assert.equal(done.entries.length, 1);
  assert.equal(done.entries[0].outcome, "success");
  assert.equal(done.entries[0].startSeq, retrying.startSeq, "the same row, finished");
  assert.equal(done.entries[0].attempts.length, 2);
});

test("a failed request also leaves the pending list", async (t) => {
  const groq = await startHeldUpstream();
  const router = await startRouter({ GROQ_API_KEYS: "k", GROQ_MODELS: "m", GROQ_BASE_URL: groq.baseUrl });
  t.after(async () => { await router.close(); await groq.close(); });

  const call = router.request("/v1/chat/completions", postJson({ model: "m", messages: [{ role: "user", content: "hi" }] }));
  await until(() => groq.held === 1);
  groq.reply(500, { error: { message: "boom" } });
  assert.equal((await call).status, 502);

  const { pending, entries } = await (await router.request("/api/requests")).json();
  assert.equal(pending.length, 0);
  assert.equal(entries[0].outcome, "failed");
});
