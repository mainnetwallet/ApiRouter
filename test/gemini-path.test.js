import test from "node:test";
import assert from "node:assert/strict";

import { parseGeminiPath, clientProtocol, isGeminiStream, isGeminiNamespace } from "../src/adapters.js";
import { startRouter, postJson } from "../test-helpers/router-harness.js";

test("one parser: exact casing only, and routing, stream detection and model extraction agree", () => {
  const cases = [
    ["/v1beta/models/m:generateContent", { model: "m", stream: false }],
    ["/v1beta/models/m:streamGenerateContent", { model: "m", stream: true }],
    ["/v1beta/models/gemini-2.5-pro:generateContent", { model: "gemini-2.5-pro", stream: false }],
    ["/v1beta/models/g%2Dx:generateContent", { model: "g-x", stream: false }]
  ];
  for (const [path, expected] of cases) {
    assert.deepEqual(parseGeminiPath(path), expected, path);
    assert.equal(clientProtocol(path), "gemini", path);
    assert.equal(isGeminiStream(path), expected.stream, path);
  }
  for (const path of [
    "/v1beta/models/m:GenerateContent", "/v1beta/models/m:StreamGenerateContent", "/v1beta/models/m:streamgenerateContent",
    "/v1beta/models/m:generatecontent", "/v1beta/models/a:b:generateContent", "/v1beta/models/m:generateContent/",
    "/v1beta/models/:generateContent", "/v1beta/models/%E0%A4%A:generateContent", "/v1beta/models/m:countTokens",
    "/v1/models/m:generateContent", "/v1beta/models/m/x:generateContent"
  ]) {
    assert.equal(parseGeminiPath(path), null, path);
    assert.equal(clientProtocol(path), null, path);
    assert.equal(isGeminiStream(path), false, path);
  }
  assert.equal(isGeminiNamespace("/v1beta/models/m:GenerateContent"), true);
  assert.equal(isGeminiNamespace("/v1/chat/completions"), false);
});

test("a malformed or wrong-case Gemini endpoint is refused by name; a valid one is routed", async (t) => {
  const router = await startRouter({});
  t.after(() => router.close());
  for (const path of ["/v1beta/models/m:GenerateContent", "/v1beta/models/m:streamgenerateContent", "/v1beta/models/a:b:generateContent", "/v1beta/models/m:generateContent/"]) {
    const res = await router.request(path, postJson({ contents: [] }));
    assert.equal(res.status, 404, path);
    assert.equal((await res.json()).error.type, "invalid_gemini_endpoint", path);
  }
  // A well-formed endpoint reaches routing (no provider is configured here, so: no route), not the 404 above.
  const ok = await router.request("/v1beta/models/m:generateContent", postJson({ contents: [{ role: "user", parts: [{ text: "hi" }] }] }));
  assert.equal(ok.status, 503);
  assert.equal((await ok.json()).error.type, "no_route");
});
