import test from "node:test";
import assert from "node:assert/strict";
import { startMockUpstream } from "../test-helpers/mock-upstream.js";
import { startRouter, postJson } from "../test-helpers/router-harness.js";

/**
 * Codex (OpenAI Responses) stream lifecycle, end to end through the real
 * src/server.js against SCRIPTED upstream providers.
 *
 * These pin behaviour. They do not prove anything about a real provider, and a
 * pass here is not evidence that a production hang is fixed.
 *
 *   A normal text                         E provider 429/401/5xx -> fallback
 *   B single tool call                    F provider 200 -> incomplete SSE
 *   C multiple tool calls                 G terminal event + sequence invariants
 *   D tool call -> output -> follow-up    H client abort
 *
 * Tests marked `todo` assert the behaviour a client needs but the router does
 * not have yet. They are reported, never silently skipped, and do not fail the
 * suite; each names the evidence that shows the gap.
 */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitUntil(predicate, { timeoutMs = 5000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await sleep(25);
  }
  return false;
}

const sse = (o) => `data: ${JSON.stringify(o)}\n\n`;
const chunk = (delta, finish = null) => sse({ id: "c", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: finish }] });
const DONE = "data: [DONE]\n\n";
const SSE_HEADERS = { "content-type": "text/event-stream" };
const textStream = (extra = {}) => ({
  status: 200, headers: SSE_HEADERS,
  stream: [chunk({ role: "assistant", content: "Hel" }), chunk({ content: "lo" }), chunk({}, "stop"), DONE],
  ...extra
});

const SHELL_TOOL = {
  type: "function", name: "exec_command", description: "run a command",
  parameters: { type: "object", properties: { cmd: { type: "string" } }, required: ["cmd"] }
};
const responsesBody = (extra = {}) => ({
  model: "m", stream: true, store: false,
  input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
  tools: [SHELL_TOOL],
  ...extra
});

/** Parses a Responses SSE body into [{ event, data }]. */
function parseSse(text) {
  return text.split(/\r?\n\r?\n/).filter(Boolean).map((raw) => {
    const event = /^event:\s*(.+)$/m.exec(raw)?.[1]?.trim();
    const dataLine = /^data:\s*(.*)$/m.exec(raw)?.[1];
    let data = null;
    try { data = dataLine ? JSON.parse(dataLine) : null; } catch { /* keep null */ }
    return { event, data };
  });
}
const types = (events) => events.map((e) => e.event);

/**
 * Reads a body chunk by chunk. The router destroys the connection after it has
 * written response.failed, so res.text() would throw and lose every byte that
 * did arrive; this keeps them. Returns { text, error }.
 */
async function readBody(res) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let error = null;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
  } catch (e) { error = e; }
  return { text, error };
}
const TERMINALS = ["response.completed", "response.incomplete", "response.failed"];

async function boot(t, providers, env = {}) {
  const mocks = {};
  const e = { MULTIAI_DEBUG_INGRESS: "1", ...env };
  for (const [id, script] of Object.entries(providers)) {
    mocks[id] = await startMockUpstream(script);
    e[`${id}_API_KEYS`] = "k";
    e[`${id}_MODELS`] = "m";
    e[`${id}_BASE_URL`] = mocks[id].baseUrl;
  }
  const router = await startRouter(e);
  t.after(async () => {
    await router.close();
    for (const mock of Object.values(mocks)) await mock.close();
  });
  return {
    router, mocks,
    rows: async () => (await (await router.request("/api/requests")).json()).entries,
    attempts: async () => (await (await router.request("/api/attempts")).json()).entries,
    async respond(body = responsesBody()) {
      const res = await router.request("/v1/responses", postJson(body));
      const text = await res.text();
      return { res, text, events: parseSse(text) };
    }
  };
}

const outputItems = (events) => events.filter((e) => e.event === "response.output_item.done").map((e) => e.data.item);

// ------------------------------------------------------------------ A, G
test("A. normal text: created -> text deltas -> done -> completed, in order", async (t) => {
  const h = await boot(t, { GROQ: () => textStream() });
  const { res, events } = await h.respond();
  assert.equal(res.status, 200);
  const seq = types(events);
  assert.equal(seq[0], "response.created");
  const deltas = events.filter((e) => e.event === "response.output_text.delta").map((e) => e.data.delta);
  assert.equal(deltas.join(""), "Hello");
  assert.ok(seq.indexOf("response.output_item.added") < seq.indexOf("response.output_text.delta"));
  assert.ok(seq.lastIndexOf("response.output_text.delta") < seq.indexOf("response.output_item.done"));
  assert.equal(seq.at(-1), "response.completed");
  const done = outputItems(events);
  assert.equal(done.length, 1);
  assert.equal(done[0].type, "message");
  assert.equal(done[0].content[0].text, "Hello");
});

test("G. exactly one terminal event, it is last, sequence_number strictly increases, completed matches the items", async (t) => {
  const h = await boot(t, { GROQ: () => textStream() });
  const { events } = await h.respond();
  const terminals = events.filter((e) => TERMINALS.includes(e.event));
  assert.equal(terminals.length, 1, "exactly one terminal event");
  assert.equal(events.at(-1).event, "response.completed", "the terminal event is the last event");
  const seqNums = events.map((e) => e.data.sequence_number);
  assert.deepEqual(seqNums, seqNums.map((_, i) => i), "sequence_number is 0,1,2,... with no gap or repeat");
  const completed = terminals[0].data.response;
  assert.equal(completed.status, "completed");
  assert.deepEqual(completed.output, outputItems(events), "the completed snapshot carries exactly the items that were streamed");
  assert.ok(completed.usage && Number.isFinite(completed.usage.total_tokens));
  const rows = await (async () => { await waitUntil(async () => (await h.rows()).length === 1); return h.rows(); })();
  assert.equal(rows[0].outcome, "success");
});

// ------------------------------------------------------------------ B, C
test("B. single tool call: identity, arguments and completion are intact", async (t) => {
  const args = JSON.stringify({ cmd: "git clone https://example.invalid/repo.git" });
  const h = await boot(t, {
    GROQ: () => ({
      status: 200, headers: SSE_HEADERS,
      stream: [
        chunk({ role: "assistant", content: null, tool_calls: [{ index: 0, id: "call_one", type: "function", function: { name: "exec_command", arguments: "" } }] }),
        chunk({ tool_calls: [{ index: 0, function: { arguments: args.slice(0, 9) } }] }),
        chunk({ tool_calls: [{ index: 0, function: { arguments: args.slice(9) } }] }),
        chunk({}, "tool_calls"), DONE
      ]
    })
  });
  const { events } = await h.respond();
  const items = outputItems(events);
  assert.equal(items.length, 1);
  assert.equal(items[0].type, "function_call");
  assert.equal(items[0].call_id, "call_one", "the upstream call id is preserved");
  assert.equal(items[0].name, "exec_command");
  assert.equal(items[0].arguments, args, "arguments are the exact JSON string the model produced");
  assert.deepEqual(JSON.parse(items[0].arguments), { cmd: "git clone https://example.invalid/repo.git" });
  const doneArgs = events.find((e) => e.event === "response.function_call_arguments.done").data;
  assert.equal(doneArgs.arguments, args);
  assert.equal(events.at(-1).event, "response.completed");
});

test("C. multiple (parallel) tool calls keep distinct ids, order and interleaved arguments", async (t) => {
  const h = await boot(t, {
    GROQ: () => ({
      status: 200, headers: SSE_HEADERS,
      stream: [
        chunk({ role: "assistant", tool_calls: [{ index: 0, id: "call_a", type: "function", function: { name: "exec_command", arguments: "" } }] }),
        chunk({ tool_calls: [{ index: 1, id: "call_b", type: "function", function: { name: "exec_command", arguments: "" } }] }),
        chunk({ tool_calls: [{ index: 0, function: { arguments: '{"cmd":"ls' } }] }),
        chunk({ tool_calls: [{ index: 1, function: { arguments: '{"cmd":"pwd' } }] }),
        chunk({ tool_calls: [{ index: 0, function: { arguments: '"}' } }] }),
        chunk({ tool_calls: [{ index: 1, function: { arguments: '"}' } }] }),
        chunk({}, "tool_calls"), DONE
      ]
    })
  });
  const { events } = await h.respond();
  const items = outputItems(events);
  assert.equal(items.length, 2);
  assert.deepEqual(items.map((i) => i.call_id), ["call_a", "call_b"]);
  assert.deepEqual(items.map((i) => i.arguments), ['{"cmd":"ls"}', '{"cmd":"pwd"}']);
  assert.equal(new Set(items.map((i) => i.id)).size, 2, "distinct item ids");
  const added = events.filter((e) => e.event === "response.output_item.added").map((e) => e.data.output_index);
  assert.deepEqual(added, [0, 1]);
  const last = events.findLastIndex((e) => e.event === "response.output_item.done");
  assert.ok(last < events.findIndex((e) => e.event === "response.completed"), "every item is done before the terminal event");
});

// ------------------------------------------------------------------ D
test("D. tool call -> tool output on the SAME call_id -> follow-up model response", async (t) => {
  const h = await boot(t, {
    GROQ: (rec) => {
      const last = rec.body.messages.at(-1);
      if (last.role === "tool") return textStream();
      return {
        status: 200, headers: SSE_HEADERS,
        stream: [
          chunk({ role: "assistant", tool_calls: [{ index: 0, id: "call_d1", type: "function", function: { name: "exec_command", arguments: '{"cmd":"pwd"}' } }] }),
          chunk({}, "tool_calls"), DONE
        ]
      };
    }
  });
  const first = await h.respond();
  const call = outputItems(first.events)[0];
  assert.equal(call.call_id, "call_d1");

  // Codex 0.161.0 resends the whole history every turn (previous_response_id null, store false).
  const second = await h.respond(responsesBody({
    input: [
      ...responsesBody().input,
      { type: "function_call", call_id: call.call_id, name: call.name, arguments: call.arguments },
      { type: "function_call_output", call_id: call.call_id, output: "/work" }
    ]
  }));
  assert.equal(types(second.events).at(-1), "response.completed");
  assert.equal(second.events.filter((e) => e.event === "response.output_text.delta").map((e) => e.data.delta).join(""), "Hello");

  const upstream = h.mocks.GROQ.apiRequests.at(-1).body.messages;
  const assistant = upstream.find((m) => m.role === "assistant" && m.tool_calls);
  const tool = upstream.find((m) => m.role === "tool");
  assert.equal(assistant.tool_calls[0].id, "call_d1");
  assert.equal(tool.tool_call_id, "call_d1", "the tool output goes back under the same call id");
  assert.equal(tool.content, "/work");
  assert.equal(h.mocks.GROQ.apiRequests.length, 2);
});

// ------------------------------------------------------------------ E
for (const status of [429, 401, 500]) {
  test(`E. provider ${status} before any byte -> fallback to the next provider, client gets one clean stream`, async (t) => {
    const h = await boot(t, {
      GROQ: () => ({ status, body: { error: { message: `upstream ${status}` } } }),
      OPENROUTER: () => textStream()
    });
    const { res, events } = await h.respond();
    assert.equal(res.status, 200);
    assert.equal(h.mocks.GROQ.apiRequests.length, 1, "the failing provider was tried once");
    assert.equal(h.mocks.OPENROUTER.apiRequests.length, 1, "the fallback provider answered");
    assert.equal(events[0].event, "response.created", "no partial stream from the failed attempt leaks to the client");
    assert.equal(events.filter((e) => TERMINALS.includes(e.event)).length, 1);
    assert.equal(events.at(-1).event, "response.completed");
    assert.equal(events.filter((e) => e.event === "response.created").length, 1, "exactly one response.created");

    assert.ok(await waitUntil(async () => (await h.rows()).length === 1));
    const [row] = await h.rows();
    const real = row.attempts.filter((a) => !a.skipped);
    assert.equal(real.length, 2);
    assert.equal(real[0].ok, false);
    assert.equal(real[0].status, status);
    assert.equal(real[1].ok, true);
  });
}

// ------------------------------------------------------------------ F
test("F1. provider 200 then the socket dies mid-body: client gets response.failed (never completed), request is NOT a success", async (t) => {
  const h = await boot(t, {
    GROQ: () => ({
      status: 200, headers: SSE_HEADERS, truncateAfter: 2,
      stream: [chunk({ role: "assistant", content: "par" }), chunk({ content: "tial" }), chunk({ content: "never sent" })]
    })
  });
  const res = await h.router.request("/v1/responses", postJson(responsesBody()));
  assert.equal(res.status, 200, "headers were already sent when the body broke");
  const { text } = await readBody(res);
  const seq = types(parseSse(text));
  assert.ok(!seq.includes("response.completed"), "a broken stream must never be presented as completed");
  assert.ok(seq.includes("response.failed"), "the client is told the stream failed instead of being left waiting");
  assert.ok(await waitUntil(async () => (await h.rows()).length === 1));
  const [row] = await h.rows();
  assert.notEqual(row.outcome, "success", "a 200 that did not complete is not a success");
  assert.equal(row.streamOutcome, "truncated");
});

test("F2. provider 200, stream ends cleanly mid tool-call with no finish_reason and no [DONE]: must not be reported as completed", {
  todo: "OBSERVED GAP: streamToResponses exits its loop on a clean close and emits response.completed with a half-written function_call (invalid JSON arguments). Needs a decision on 'no finish_reason and no [DONE]' = truncated."
}, async (t) => {
  const h = await boot(t, {
    GROQ: () => ({
      status: 200, headers: SSE_HEADERS,
      stream: [
        chunk({ role: "assistant", tool_calls: [{ index: 0, id: "call_cut", type: "function", function: { name: "exec_command", arguments: '{"cmd":"pw' } }] })
      ]
    })
  });
  const { events } = await h.respond();
  const seq = types(events);
  assert.ok(!seq.includes("response.completed"), "truncated upstream presented as completed");
  const call = outputItems(events).find((i) => i.type === "function_call");
  if (call) assert.doesNotThrow(() => JSON.parse(call.arguments), "a function_call with unparsable arguments was handed to the client");
});

test("F3. keepalive/reasoning-only upstream bytes must not keep a client-silent stream alive past the idle timeout", {
  todo: "CONFIRMED with a mock (and real Codex 0.161.0): guardUpstreamStream counts raw upstream bytes, so SSE comments and reasoning-only deltas reset STREAM_IDLE_TIMEOUT_MS while the client receives nothing after response.in_progress. Production causation NOT proven."
}, async (t) => {
  const beat = ": keepalive\n\n";
  const h = await boot(t, {
    GROQ: () => ({ status: 200, headers: SSE_HEADERS, stream: [chunk({ role: "assistant" }), ...Array(40).fill(beat)], delayMs: 250 })
  }, { STREAM_IDLE_TIMEOUT_MS: "1500" });
  const started = Date.now();
  const res = await h.router.request("/v1/responses", postJson(responsesBody()));
  const { text } = await readBody(res);
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 5000, `stream stayed open ${elapsed}ms with no client-visible event (idle timeout 1500ms)`);
  assert.ok(types(parseSse(text)).includes("response.failed"));
});

test("F4. provider goes fully silent after the headers: idle timeout ends the stream with response.failed and cools the target", async (t) => {
  const h = await boot(t, {
    // The second chunk is never sent: the mock only stalls while chunks remain.
    GROQ: () => ({ status: 200, headers: SSE_HEADERS, stream: [chunk({ role: "assistant", content: "x" }), chunk({ content: "never sent" })], stallAfter: 1 })
  }, { STREAM_IDLE_TIMEOUT_MS: "800" });
  const started = Date.now();
  const res = await h.router.request("/v1/responses", postJson(responsesBody()));
  const { text } = await readBody(res);
  assert.ok(Date.now() - started < 4000, "silent stream was cut by the idle timeout");
  const seq = types(parseSse(text));
  assert.ok(seq.includes("response.failed"));
  assert.ok(!seq.includes("response.completed"));
  assert.ok(await waitUntil(async () => (await h.rows()).length === 1));
  assert.equal((await h.rows())[0].streamOutcome, "truncated");
});

// ------------------------------------------------------------------ H
test("H. client abort mid-stream: filed as a client abort, no provider is cooled, the next request still succeeds", async (t) => {
  let n = 0;
  const h = await boot(t, {
    GROQ: () => (++n === 1
      ? { status: 200, headers: SSE_HEADERS, stream: [chunk({ role: "assistant", content: "x" }), chunk({ content: "never sent" })], stallAfter: 1 }
      : textStream())
  });
  const controller = new AbortController();
  const res = await h.router.request("/v1/responses", { ...postJson(responsesBody()), signal: controller.signal });
  const reader = res.body.getReader();
  const first = await reader.read();
  assert.ok(!first.done, "the stream started");
  controller.abort();
  await reader.cancel().catch(() => {});

  assert.ok(await waitUntil(async () => (await h.rows()).length === 1), "the aborted request reached a terminal record (nothing left pending)");
  const [row] = await h.rows();
  assert.equal(row.streamOutcome, "aborted");
  assert.equal(row.errorType, "client_aborted");

  const next = await h.respond();
  assert.equal(types(next.events).at(-1), "response.completed", "a client that walked away did not cool the provider");
  assert.equal(h.mocks.GROQ.apiRequests.length, 2);
});

// ------------------------------------------------------------------ diagnostics
test("diagnostics: with MULTIAI_DEBUG_INGRESS=1 the stream lifecycle is logged and credentials are redacted", async (t) => {
  const secret = "ghp_" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8";
  const args = JSON.stringify({ cmd: `git clone https://${secret}@github.com/o/r.git` });
  const h = await boot(t, {
    GROQ: () => ({
      status: 200, headers: SSE_HEADERS,
      stream: [
        chunk({ role: "assistant", tool_calls: [{ index: 0, id: "call_s", type: "function", function: { name: "exec_command", arguments: args } }] }),
        chunk({}, "tool_calls"), DONE
      ]
    })
  });
  await h.respond();
  assert.ok(await waitUntil(async () => h.router.stdout.includes("[STREAM_END]")));
  const out = h.router.stdout;
  for (const marker of ["[ATTEMPT_START]", "[STREAM_OPEN]", "[STREAM_UPSTREAM_FIRST_BYTE]", "[STREAM_FIRST_CLIENT_EVENT]", "[STREAM_EVENT] type=response.output_item.done", "[STREAM_END]", "[ATTEMPT_END]"]) {
    assert.ok(out.includes(marker), `missing ${marker}`);
  }
  assert.ok(out.includes("call_id=call_s"));
  assert.ok(out.includes("outcome=completed client_terminal=response.completed"));
  assert.ok(!out.includes(secret), "a credential-shaped value must never reach the log");
  assert.ok(!h.router.stderr.includes(secret));
});
