import test from "node:test";
import assert from "node:assert/strict";
import { HealthRegistry } from "../src/health.js";
import {
  MONTHLY_QUOTA_RECHECK_MS,
  QUOTA_MAX_COOLDOWN_MS,
  RATE_LIMIT_COOLDOWN_MS,
  quotaCooldown,
  withFallback
} from "../src/router.js";

// Real upstream bodies, as they appear in the router's logs.
const OPENROUTER = (reset) => `{"error":{"message":"Rate limit exceeded: free-models-per-day. Add 10 credits to unlock 1000 free model requests per day","code":429,"metadata":{"headers":{"X-RateLimit-Limit":"50","X-RateLimit-Remaining":"0","X-RateLimit-Reset":"${reset}"},"limit_source":"openrouter_free_tier_daily"}}}`;
const CLOUDFLARE = `{"errors":[{"message":"AiError: AiError: you have used up your daily free allocation of 10,000 neurons, please upgrade to Cloudflare's Workers Paid plan if you would like to continue usage. (1fe58794)","code":4006}],"success":false,"result":{},"messages":[]}`;
const COHERE = `{"id":"57dbb325","message":"You are using a Trial key, which is limited to 1000 API calls / month. You can continue to use the Trial key for free or upgrade to a Production key"}`;
const CEREBRAS_TPM = `{"message":"Tokens per minute limit exceeded - too many tokens processed.","type":"too_many_tokens_error","param":"quota","code":"token_quota_exceeded"}`;
const MISTRAL = `{"object":"error","message":"Rate limit exceeded","type":"rate_limited","param":null,"code":"1300","raw_status_code":429}`;

const NOW = Date.UTC(2026, 9, 11, 12, 3, 44); // 2026-10-11 12:03:44 UTC, as in the log
const err = (message) => ({ message });

test("OpenRouter's daily limit is parked until the reset time it reported", () => {
  const reset = Date.UTC(2026, 9, 12, 0, 0, 0); // 1791763200000, the value in the log
  const quota = quotaCooldown(429, err(OPENROUTER(reset)), NOW);
  assert.equal(quota.kind, "daily");
  assert.equal(quota.cooldownMs, reset - NOW + 60 * 1000);
});

test("a reset reported in seconds is read as seconds", () => {
  const reset = Date.UTC(2026, 9, 12, 0, 0, 0);
  const quota = quotaCooldown(429, err(OPENROUTER(Math.floor(reset / 1000))), NOW);
  assert.equal(quota.cooldownMs, reset - NOW + 60 * 1000);
});

test("Cloudflare's daily neuron allocation is parked until the next 00:00 UTC", () => {
  const quota = quotaCooldown(429, err(CLOUDFLARE), NOW);
  assert.equal(quota.kind, "daily");
  assert.equal(quota.cooldownMs, Date.UTC(2026, 9, 12) - NOW + 60 * 1000);
});

test("Cohere's monthly trial limit is re-checked every few hours, not every minute", () => {
  const quota = quotaCooldown(429, err(COHERE), NOW);
  assert.equal(quota.kind, "monthly");
  assert.equal(quota.cooldownMs, MONTHLY_QUOTA_RECHECK_MS);
});

test("ordinary per-minute rate limits are NOT treated as a daily quota", () => {
  assert.equal(quotaCooldown(429, err(CEREBRAS_TPM), NOW), null);
  assert.equal(quotaCooldown(429, err(MISTRAL), NOW), null);
  assert.equal(quotaCooldown(429, err("Too many requests, retry shortly"), NOW), null);
});

test("only a 429 is ever read as a quota, whatever the wording", () => {
  assert.equal(quotaCooldown(500, err(CLOUDFLARE), NOW), null);
  assert.equal(quotaCooldown(402, err(COHERE), NOW), null);
  assert.equal(quotaCooldown(429, null, NOW), null);
  assert.equal(quotaCooldown(429, err(""), NOW), null);
});

test("a wrong or distant reset can never park a target for more than a day", () => {
  const far = Date.UTC(2030, 0, 1);
  assert.equal(quotaCooldown(429, err(OPENROUTER(far)), NOW).cooldownMs, QUOTA_MAX_COOLDOWN_MS);
  // A reset already in the past is ignored: fall back to the next midnight.
  const past = quotaCooldown(429, err(OPENROUTER(Date.UTC(2020, 0, 1))), NOW);
  assert.equal(past.cooldownMs, Date.UTC(2026, 9, 12) - NOW + 60 * 1000);
});

const target = (provider, model, keyIndex = 0) => ({ provider, model, keyIndex, pool: "text" });
const reject = (status, message) => Object.assign(new Error(message), { status });

test("a daily-quota 429 cools the target for the window, an ordinary 429 only for a minute", async () => {
  const health = new HealthRegistry();
  const quotaTarget = target("cloudflare", "@cf/nvidia/nemotron-3-120b-a12b", 0);
  const rateTarget = target("mistral", "mistral-medium-3-5", 0);
  const okTarget = target("groq", "g", 0);

  const before = Date.now();
  await withFallback([quotaTarget, rateTarget, okTarget], async (t) => {
    if (t === quotaTarget) throw reject(429, CLOUDFLARE);
    if (t === rateTarget) throw reject(429, MISTRAL);
    return "ok";
  }, new Set([429]), undefined, health);

  const quotaState = health.get(health.key(quotaTarget));
  const rateState = health.get(health.key(rateTarget));
  assert.ok(quotaState.cooldownUntil - before > 60 * 60 * 1000, "the quota target is parked for hours");
  assert.ok(quotaState.cooldownUntil - before <= QUOTA_MAX_COOLDOWN_MS + 5000);
  assert.ok(rateState.cooldownUntil - before <= RATE_LIMIT_COOLDOWN_MS + 5000, "an ordinary 429 keeps the short cooldown");
  assert.match(quotaState.lastReason, /^429 daily quota exhausted on @cf\/nvidia\/nemotron/);
  assert.ok(!/neurons|upgrade/i.test(quotaState.lastReason), "no upstream text leaks into the reason");
  assert.ok(!health.isAvailable(quotaTarget));
});

test("an exhausted quota is not called a second time inside the same request", async () => {
  const health = new HealthRegistry();
  const quotaTarget = target("cloudflare", "nemo", 0);
  const other = target("groq", "g", 0);
  const calls = [];
  // Manual -> Health alternation lists a target again as a retry round.
  const plan = [
    { target: quotaTarget, phase: "manual-selection" },
    { target: other, phase: "manual-selection" },
    { target: quotaTarget, phase: "manual-retry", retry: true, round: 1 },
    { target: other, phase: "manual-retry", retry: true, round: 1 }
  ];
  await assert.rejects(withFallback([quotaTarget, other], async (t) => {
    calls.push(t.provider);
    throw reject(t === quotaTarget ? 429 : 500, t === quotaTarget ? CLOUDFLARE : "boom");
  }, new Set([429, 500]), undefined, health, { plan }));
  assert.equal(calls.filter((name) => name === "cloudflare").length, 1, "the quota target is tried once, not retried");
});
