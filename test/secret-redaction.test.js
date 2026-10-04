import test from "node:test";
import assert from "node:assert/strict";
import {
  sanitizeMessage,
  registerConfiguredSecrets,
  containsCredentialShapedText
} from "../src/observability/sanitize.js";

// Unit coverage for credential scrubbing. The registry is module state, so every
// test that uses it clears it afterwards.
const reset = () => registerConfiguredSecrets([]);

// Deliberately NOT in any known prefix family: only exact-value redaction can catch these.
const CONFIGURED = {
  nvidia: "nvapi-ABCDEF1234567890SECRETnv",
  cerebras: "csk-xyz789SECRETcerebras0000",
  cloudflareToken: "Cf0Token_aB3dE5gH7jK9mN1pQ3sT5vW7yZ9bD1fH",
  cloudflareAccount: "0123456789abcdef0123456789abcdef",
  random: "some-random-secret-value-4f9a2c"
};

test("configured credentials are redacted exactly, whatever their format", (t) => {
  t.after(reset);
  registerConfiguredSecrets(Object.values(CONFIGURED));

  for (const [name, secret] of Object.entries(CONFIGURED)) {
    const out = sanitizeMessage(`authentication failed with key ${secret}`);
    assert.ok(!out.includes(secret), `${name} leaked: ${out}`);
    assert.equal(out.startsWith("authentication failed with key"), true, `${name} lost its diagnostic text`);
  }
});

test("a configured secret embedded in a larger error string is redacted", (t) => {
  t.after(reset);
  registerConfiguredSecrets([CONFIGURED.nvidia, CONFIGURED.random]);

  const text = `{"error":{"message":"upstream says authentication failed for ${CONFIGURED.nvidia}","detail":"retry with ${CONFIGURED.random}!"}}`;
  const out = sanitizeMessage(text, { maxLength: 2000 });
  assert.ok(!out.includes("ABCDEF1234567890SECRETnv"));
  assert.ok(!out.includes(CONFIGURED.random));
  assert.match(out, /authentication failed for/);
});

test("an unknown-format secret is redacted only because it is configured", (t) => {
  t.after(reset);
  const secret = CONFIGURED.random;
  assert.ok(sanitizeMessage(`bad key ${secret}`).includes(secret), "premise: no pattern matches this value");
  registerConfiguredSecrets([secret]);
  assert.ok(!sanitizeMessage(`bad key ${secret}`).includes(secret));
});

test("URL-encoded and JSON-escaped echoes of a configured secret are redacted", (t) => {
  t.after(reset);
  const secret = "weird secret/with+chars&more=1234";
  registerConfiguredSecrets([secret]);
  for (const echoed of [secret, encodeURIComponent(secret), JSON.stringify(secret).slice(1, -1)]) {
    assert.ok(!sanitizeMessage(`url ${echoed} end`).includes(echoed), `leaked form: ${echoed}`);
  }
});

test("generic secret patterns still redact without any registration", () => {
  reset();
  const secrets = [
    "nvapi-AbCdEf0123456789xyz",
    "csk-AbCdEf0123456789xyz",
    "sk-proj-abcdef0123456789",
    "sk_live_abcdef0123456789",
    "AIzaSyA-abcdefghijklmnopqrstuv",
    "hf_abcdefghijklmnopqrstuvwx",
    "gsk_abcdefghijklmnopqrstuvwx"
  ];
  for (const secret of secrets) {
    const out = sanitizeMessage(`provider rejected ${secret} for this account`);
    assert.ok(!out.includes(secret), `pattern leaked ${secret}: ${out}`);
    assert.ok(containsCredentialShapedText(secret), `not detected: ${secret}`);
  }
  const bearer = sanitizeMessage("sent Authorization: Bearer tok.en-123_abc/def=");
  assert.ok(!/tok\.en-123/.test(bearer) && !/bearer/i.test(bearer), bearer);
  const query = sanitizeMessage("GET https://x.test/v1?alt=json&key=QueryKeyValue987654&foo=1");
  assert.ok(!query.includes("QueryKeyValue987654") && query.includes("foo=1"), query);
});

test("ordinary identifiers are not over-redacted", (t) => {
  t.after(reset);
  registerConfiguredSecrets([CONFIGURED.nvidia, CONFIGURED.random, "short"]);
  const text = "models deepseek-v4-flash gemini-2.5-flash llama-3.3-70b via groq cloudflare nvidia cerebras short";
  assert.equal(sanitizeMessage(text), text);
  assert.ok(!containsCredentialShapedText(text));
});

test("containsCredentialShapedText reports a configured secret", (t) => {
  t.after(reset);
  assert.equal(containsCredentialShapedText(CONFIGURED.random), false);
  registerConfiguredSecrets([CONFIGURED.random]);
  assert.equal(containsCredentialShapedText(`x ${CONFIGURED.random} y`), true);
});
