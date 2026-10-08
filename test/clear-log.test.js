import test from "node:test";
import assert from "node:assert/strict";
import { RequestLog, ATTEMPT_STATES } from "../src/observability/request-log.js";

const target = { provider: "groq", keyIndex: 0, model: "m", protocol: "openai-chat" };

test("clearCompleted removes finished requests and attempts for good", () => {
  const log = new RequestLog();
  const seq = log.begin({ id: "s", pool: "text" });
  const attemptId = log.startAttempt(seq, target);
  log.finishAttempt(attemptId, { ok: true, status: 200 });
  log.record({ id: "s", pendingSeq: seq, outcome: "success", httpStatus: 200, attempts: [] });

  assert.equal(log.clearCompleted(), 1);
  assert.equal(log.list().entries.length, 0);
  assert.equal(log.listAttempts().entries.length, 0);
});

test("clearCompleted keeps a call that is still running, and it can still finish", () => {
  const log = new RequestLog();
  const seq = log.begin({ id: "s", pool: "text" });
  const attemptId = log.startAttempt(seq, target);

  log.clearCompleted();
  assert.equal(log.pending().length, 1);
  assert.equal(log.listAttempts().entries[0].state, ATTEMPT_STATES.CALLING);

  log.finishAttempt(attemptId, { ok: true, status: 200 });
  assert.equal(log.listAttempts().entries[0].state, ATTEMPT_STATES.SUCCESS);
});

test("clearCompleted announces `cleared` and never reuses sequence numbers", () => {
  const log = new RequestLog();
  const seen = [];
  log.subscribe(({ type, entry }) => { if (type === "cleared") seen.push(entry); });
  const first = log.begin({ id: "a", pool: "text" });
  log.record({ id: "a", pendingSeq: first, outcome: "success", httpStatus: 200, attempts: [] });

  log.clearCompleted();
  assert.equal(seen.length, 1);
  assert.equal(seen[0].cleared, 1);
  assert.ok(log.begin({ id: "b", pool: "text" }) > first);
});
