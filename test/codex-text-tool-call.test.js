import test from "node:test";
import assert from "node:assert/strict";
import { extractTextToolCalls, openAIJsonToResponses, streamToResponses } from "../src/codex-bridge.js";

const MARK = '<|message_model|>exec<|content_invoke_tool_json|>{"name":"exec","args":{"command":"cat > a.html << \'EOF\'\\nhi\\nEOF"}}<|end_message|>';
const shellTools = [{ name: "shell", parameters: { type: "object", properties: { command: { type: "array" }, workdir: { type: "string" } } } }];
const execTools = [{ name: "exec_command", parameters: { type: "object", properties: { cmd: { type: "string" } } } }];

test("text-encoded exec call maps onto a shell tool with an array command", () => {
  const { text, calls } = extractTextToolCalls(MARK, shellTools);
  assert.equal(text, "");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, "shell");
  assert.deepEqual(calls[0].args.command.slice(0, 2), ["bash", "-lc"]);
});

test("text-encoded exec call maps onto exec_command with cmd", () => {
  const { calls } = extractTextToolCalls(MARK, execTools);
  assert.equal(calls[0].name, "exec_command");
  assert.match(calls[0].args.cmd, /^cat > a\.html/);
});

test("no tools declared or unknown tool: text is left alone", () => {
  assert.equal(extractTextToolCalls(MARK, []).calls.length, 0);
  assert.equal(extractTextToolCalls(MARK, [{ name: "other", parameters: {} }]).calls.length, 0);
});

test("JSON response: marker text becomes a function_call", () => {
  const json = { choices: [{ message: { role: "assistant", content: MARK }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } };
  const out = openAIJsonToResponses(json, "m", { tools: shellTools });
  assert.deepEqual(out.output.map((i) => i.type), ["function_call"]);
  assert.equal(out.output[0].name, "shell");
});

test("stream: marker split across chunks becomes a function_call, normal text still streams", async () => {
  async function* chunks(parts) {
    for (const c of parts) yield JSON.stringify({ choices: [{ delta: { content: c } }] });
    yield JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] });
    yield "[DONE]";
  }
  const collect = async (parts) => {
    let out = "";
    for await (const e of streamToResponses("openai-chat", chunks(parts), "m", { tools: shellTools })) out += e;
    return out;
  };
  const a = await collect([MARK.slice(0, 7), MARK.slice(7, 60), MARK.slice(60)]);
  assert.match(a, /"type":"function_call"/);
  assert.doesNotMatch(a, /message_model/);
  const b = await collect(["Hello ", "world"]);
  assert.match(b, /response\.output_text\.delta/);
  assert.doesNotMatch(b, /"type":"function_call"/);
});
