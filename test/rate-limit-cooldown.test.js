import test from "node:test";
import assert from "node:assert/strict";
import { HealthRegistry, targetId } from "../src/health.js";
import { buildRoutePlan, resetAutomaticOrderCache } from "../src/fallback-plan.js";
import {
  RATE_LIMIT_COOLDOWN_MS,
  RATE_LIMIT_MAX_COOLDOWN_MS,
  RATE_LIMIT_MIN_COOLDOWN_MS,
  RouteSession,
  parseRetryAfterMs,
  withFallback
} from "../src/router.js";

const t = (model, keyIndex) => ({ provider: "p", model, keyIndex, pool: "text", protocols: ["openai-chat"] });
const fail = (status, extra = {}) => Object.assign(new Error(`boom ${status}`), { status, ...extra });
const retryable = new Set([401, 402, 403, 404, 429, 500]);
const entries = (...models) => models.map((model) => ({ provider: "p", model, keys: null, enabled: true }));

const targets = [t("M1", 0), t("M1", 1), t("M1", 2), t("M2", 0), t("M2", 1)];

async function walk(invoke, health = new HealthRegistry()) {
  resetAutomaticOrderCache();
  const plan = buildRoutePlan({ targets, chain: entries("M1", "M2"), health, cacheKey: `rl-${Math.random()}` });
  const result = await withFallback(targets, invoke, retryable, new RouteSession(), health, { plan: plan.steps });
  return { result, health };
}

const cooldownLeft = (health, target) => Number(health.get(targetId(target)).cooldownUntil) - Date.now();

test("a 429 on one key cools only that key + model and the model's next key is tried", async () => {
  const calls = [];
  const { result, health } = await walk(async (target) => {
    calls.push(`${target.model}#${target.keyIndex}`);
    if (target.keyIndex === 0) throw fail(429);
    return `${target.model}#${target.keyIndex}`;
  });

  assert.equal(result, "M1#1");
  assert.deepEqual(calls, ["M1#0", "M1#1"]);
  assert.ok(!health.isAvailable(t("M1", 0)), "the rate-limited key is cooling");
  assert.ok(health.isAvailable(t("M1", 1)), "the working key is not");
  assert.ok(health.isAvailable(t("M1", 2)), "an untried key of the same model is not");
  assert.ok(health.isAvailable(t("M2", 0)), "another model on the same key index is not");
});

test("a 429 without Retry-After cools the key for the short rate-limit cooldown, not 12 minutes", async () => {
  const { health } = await walk(async (target) => {
    if (target.keyIndex === 0) throw fail(429);
    return "ok";
  });

  const left = cooldownLeft(health, t("M1", 0));
  assert.ok(left > RATE_LIMIT_COOLDOWN_MS - 5000 && left <= RATE_LIMIT_COOLDOWN_MS, `cooldown was ${left}ms`);
});

test("a 429 honours the upstream Retry-After, clamped to a sane range", async () => {
  const { health } = await walk(async (target) => {
    if (target.model === "M1" && target.keyIndex === 0) throw fail(429, { retryAfterMs: 20_000 });
    if (target.model === "M1" && target.keyIndex === 1) throw fail(429, { retryAfterMs: 1 });
    if (target.model === "M1" && target.keyIndex === 2) throw fail(429, { retryAfterMs: 24 * 60 * 60 * 1000 });
    return "ok";
  });

  const k0 = cooldownLeft(health, t("M1", 0));
  const k1 = cooldownLeft(health, t("M1", 1));
  const k2 = cooldownLeft(health, t("M1", 2));
  assert.ok(k0 > 15_000 && k0 <= 20_000, `Retry-After 20s gave ${k0}ms`);
  assert.ok(k1 > RATE_LIMIT_MIN_COOLDOWN_MS - 1000 && k1 <= RATE_LIMIT_MIN_COOLDOWN_MS, `tiny Retry-After gave ${k1}ms`);
  assert.ok(k2 > RATE_LIMIT_MAX_COOLDOWN_MS - 5000 && k2 <= RATE_LIMIT_MAX_COOLDOWN_MS, `huge Retry-After gave ${k2}ms`);
});

test("when every key of a model is rate limited the whole model cools and the walk moves on", async () => {
  const calls = [];
  const { result, health } = await walk(async (target) => {
    calls.push(`${target.model}#${target.keyIndex}`);
    if (target.model === "M1") throw fail(429);
    return `${target.model}#${target.keyIndex}`;
  });

  assert.equal(result, "M2#0");
  assert.deepEqual(calls, ["M1#0", "M1#1", "M1#2", "M2#0"]);
  for (const key of [0, 1, 2]) assert.ok(!health.isAvailable(t("M1", key)), `M1 key ${key} is cooling`);
  assert.ok(health.isAvailable(t("M2", 0)));
});

test("a non-429 transient failure keeps the default cooldown", async () => {
  const { health } = await walk(async (target) => {
    if (target.keyIndex === 0) throw fail(500);
    return "ok";
  });

  assert.ok(cooldownLeft(health, t("M1", 0)) > RATE_LIMIT_MAX_COOLDOWN_MS - 5000);
});

test("parseRetryAfterMs reads seconds and HTTP dates and rejects junk", () => {
  const now = Date.parse("2026-10-10T10:00:00Z");
  assert.equal(parseRetryAfterMs("30"), 30_000);
  assert.equal(parseRetryAfterMs(" 1.5 "), 1500);
  assert.equal(parseRetryAfterMs("Sat, 10 Oct 2026 10:01:00 GMT", now), 60_000);
  assert.equal(parseRetryAfterMs("Sat, 10 Oct 2026 09:00:00 GMT", now), null, "a date in the past is unusable");
  for (const bad of [null, undefined, "", "0", "-5", "soon"]) assert.equal(parseRetryAfterMs(bad, now), null, String(bad));
});
