import test from "node:test";
import assert from "node:assert/strict";
import { HealthRegistry, targetId } from "../src/health.js";
import { FALLBACK_MODES } from "../src/fallback-chain.js";
import { buildRoutePlan, resetAutomaticOrderCache } from "../src/fallback-plan.js";
import {
  FAILURE_SCOPE,
  RouteSession,
  SessionStore,
  classifyFailure,
  describeFailure,
  isRetryableStatus,
  withFallback
} from "../src/router.js";

const t = (provider, model, keyIndex = 0) => ({ provider, model, keyIndex, pool: "text", protocols: ["openai-chat"] });
const entries = (...pairs) => pairs.map((pair) => {
  const [provider, model, extra = {}] = pair;
  return { provider, model, keys: null, enabled: true, ...extra };
});
const fail = (status, extra = {}) => Object.assign(new Error(`boom ${status}`), { status, ...extra });

const targets = [
  t("a", "A", 0), t("a", "A", 1),
  t("b", "B", 0), t("b", "B", 1),
  t("c", "C", 0)
];

/** Runs one walk with the chain a, b, c and every key, in the given mode. */
async function walk(invoke, {
  health = new HealthRegistry(),
  session = new RouteSession(),
  mode = FALLBACK_MODES.FIXED,
  chain = entries(["a", "A"], ["b", "B"], ["c", "C"]),
  retryable = new Set([400, 401, 402, 403, 404, 413, 429, 500, 502, 503]),
  onSkip = null,
  cacheKey = `walk-${Math.random()}`
} = {}) {
  const plan = buildRoutePlan({ targets, chain, mode, health, cacheKey });
  return withFallback(targets, invoke, retryable, session, health, {
    plan: plan.steps,
    onSkip,
    remember: mode !== FALLBACK_MODES.FIXED
  });
}

// ---------------------------------------------------------------------------
// Multi-key fallback
// ---------------------------------------------------------------------------

test("every eligible key of a model is tried before the walk moves to the next model", async () => {
  resetAutomaticOrderCache();
  const calls = [];
  const result = await walk(async (target) => {
    calls.push(`${target.provider}/${target.model}#${target.keyIndex}`);
    if (target.model === "A") throw fail(500);
    if (target.model === "B" && target.keyIndex === 0) throw fail(500);
    return `${target.model}#${target.keyIndex}`;
  });

  assert.equal(result, "B#1");
  assert.deepEqual(calls, ["a/A#0", "a/A#1", "b/B#0", "b/B#1"]);
});

test("a success stops the walk immediately", async () => {
  resetAutomaticOrderCache();
  const calls = [];
  await walk(async (target) => {
    calls.push(target.model);
    return "ok";
  });
  assert.deepEqual(calls, ["A"], "nothing after the first success may be attempted");
});

test("the same target is never attempted twice in one request", async () => {
  resetAutomaticOrderCache();
  const skips = [];
  const calls = [];
  await walk(
    async (target) => {
      calls.push(targetId(target));
      if (target.model === "A") throw fail(500);
      return "ok";
    },
    { onSkip: (target, info) => skips.push([targetId(target), info.reason]) }
  );

  assert.equal(new Set(calls).size, calls.length, "no target may be invoked twice");
  // A appears once in the chain, so nothing is skipped as already attempted here.
  assert.deepEqual(skips, []);
});

test("a cooling target is skipped without a call, and the skip is reported once", async () => {
  resetAutomaticOrderCache();
  const health = new HealthRegistry();
  health.markFailure(t("a", "A", 0), 500, { cooldownMs: 60_000 });

  const skips = [];
  const calls = [];
  const result = await walk(
    async (target) => {
      calls.push(targetId(target));
      if (target.model === "A") throw fail(500);
      return "ok";
    },
    { health, onSkip: (target, info) => skips.push([targetId(target), info.reason]) }
  );

  assert.equal(result, "ok");
  assert.ok(!calls.includes("a:A:key-0"), "a cooling target must never be called");
  assert.deepEqual(skips.filter(([id]) => id === "a:A:key-0"), [["a:A:key-0", "cooldown"]]);
});

test("a target skipped as cooling does not count as an upstream attempt", async () => {
  resetAutomaticOrderCache();
  const health = new HealthRegistry();
  for (const target of targets) health.markFailure(target, 503, { cooldownMs: 60_000 });

  await assert.rejects(
    walk(async () => "unreachable", { health }),
    (error) => {
      assert.equal(error.status, 503, "no eligible target is a 503, not a 502");
      assert.deepEqual(error.failures, []);
      return true;
    }
  );
});

// ---------------------------------------------------------------------------
// Error scope
// ---------------------------------------------------------------------------

test("classifyFailure reads the status, and an explicit scope wins", () => {
  for (const status of [401, 402, 403]) assert.equal(classifyFailure(status), FAILURE_SCOPE.KEY, `${status} is key-level`);
  for (const status of [400, 404, 413, 422]) assert.equal(classifyFailure(status), FAILURE_SCOPE.TARGET, `${status} is model-level`);
  for (const status of [408, 429, 500, 503, 529, 0]) assert.equal(classifyFailure(status), FAILURE_SCOPE.TARGET, `${status} is target-level by default`);
  // A provider that can read its own error body may state the scope outright.
  assert.equal(classifyFailure(500, { scope: FAILURE_SCOPE.KEY }), FAILURE_SCOPE.KEY);
  assert.equal(classifyFailure(400, { scope: FAILURE_SCOPE.PROVIDER }), FAILURE_SCOPE.PROVIDER);
  assert.equal(classifyFailure(500, { scope: "nonsense" }), FAILURE_SCOPE.TARGET);
});

// The exact upstream text Agentrouter returned in production.
const BUDGET_POOL_402 = "Budget pool quota has been exhausted. Please ask an administrator to increase the limit or select another budget pool.";

test("an Agentrouter budget-pool 402 is target-scoped, while a bare or account-level 402 stays key-level", () => {
  const pool = fail(402, { message: BUDGET_POOL_402 });
  assert.equal(classifyFailure(402, pool), FAILURE_SCOPE.TARGET);
  assert.equal(describeFailure(402, pool).kind, "budget pool exhausted");

  // Genuinely shared account / credential failures keep their key scope.
  for (const message of [
    "Insufficient balance. Please top up your account.",
    "Your account balance is too low",
    "Billing issue: payment required",
    "Account suspended"
  ]) {
    assert.equal(classifyFailure(402, fail(402, { message })), FAILURE_SCOPE.KEY, message);
  }
  assert.equal(classifyFailure(402), FAILURE_SCOPE.KEY, "no message: existing behaviour is kept");
  assert.equal(classifyFailure(402, fail(402, { message: "" })), FAILURE_SCOPE.KEY);
  assert.equal(describeFailure(402, fail(402, { message: "Insufficient balance" })).kind, null);

  // A message that mentions both an account problem and a pool is not narrowed.
  assert.equal(classifyFailure(402, fail(402, { message: `Account suspended. ${BUDGET_POOL_402}` })), FAILURE_SCOPE.KEY);
});

test("401 is always the credential, and a 403 is narrowed only by an explicit model message", () => {
  // Even text that names a budget pool or a model cannot narrow a 401.
  assert.equal(classifyFailure(401, fail(401, { message: BUDGET_POOL_402 })), FAILURE_SCOPE.KEY);
  assert.equal(classifyFailure(401, fail(401, { message: "model not allowed" })), FAILURE_SCOPE.KEY);
  assert.equal(classifyFailure(403, fail(403, { message: "Forbidden" })), FAILURE_SCOPE.KEY);
  assert.equal(classifyFailure(403, fail(403, { message: "Invalid API key" })), FAILURE_SCOPE.KEY);
  assert.equal(classifyFailure(403, fail(403, { message: "Your account does not have access to model gpt-6-astra" })), FAILURE_SCOPE.TARGET);
  // An explicit scope from the provider adapter still wins over the message.
  assert.equal(classifyFailure(402, fail(402, { message: BUDGET_POOL_402, scope: FAILURE_SCOPE.KEY })), FAILURE_SCOPE.KEY);
  assert.equal(classifyFailure(402, fail(402, { message: BUDGET_POOL_402, scope: FAILURE_SCOPE.PROVIDER })), FAILURE_SCOPE.PROVIDER);
});

// All four models share provider "agentrouter" and key index 0, as in production.
const agent = (model) => ({ provider: "agentrouter", model, keyIndex: 0, pool: "text", protocols: ["openai-chat"] });
const agentModels = ["gpt-6-astra", "claude-opus-5", "claude-opus-4-8", "deepseek-v4-flash"];
const agentTargets = agentModels.map(agent);
const agentWalk = (invoke, health, cacheKey) => withFallback(
  agentTargets, invoke, new Set([401, 402, 403, 429, 500]), new RouteSession(), health,
  { plan: buildRoutePlan({ targets: agentTargets, chain: entries(...agentModels.map((m) => ["agentrouter", m])), cacheKey }).steps }
);

test("a budget-pool 402 on the first model cools only that model and the walk continues", async () => {
  resetAutomaticOrderCache();
  const health = new HealthRegistry();
  const calls = [];
  const result = await agentWalk(async (target) => {
    calls.push(target.model);
    if (target.model === "gpt-6-astra") throw fail(402, { message: BUDGET_POOL_402 });
    return target.model;
  }, health, "agent-pool-402");

  assert.equal(result, "claude-opus-5");
  assert.deepEqual(calls, ["gpt-6-astra", "claude-opus-5"]);
  assert.ok(!health.isAvailable(agent("gpt-6-astra")), "the failed target is cooling down");
  assert.equal(health.get(targetId(agent("gpt-6-astra"))).lastStatus, 402);
  assert.equal(health.get(targetId(agent("gpt-6-astra"))).lastReason, "402 budget pool exhausted on gpt-6-astra");
  assert.ok(!health.get(targetId(agent("gpt-6-astra"))).lastReason.includes("increase the limit"), "upstream text never reaches the reason");
  for (const model of ["claude-opus-4-8", "deepseek-v4-flash"]) {
    assert.ok(health.isAvailable(agent(model)), `${model} was never touched`);
    assert.equal(health.get(targetId(agent(model))).status, "unknown");
  }
  assert.equal(health.get(targetId(agent("claude-opus-5"))).status, "healthy");
});

test("when every model hits its own budget pool the walk tries all of them, in order, and ends in a 502", async () => {
  resetAutomaticOrderCache();
  const health = new HealthRegistry();
  const calls = [];
  await assert.rejects(agentWalk(async (target) => {
    calls.push(target.model);
    throw fail(402, { message: BUDGET_POOL_402 });
  }, health, "agent-pool-all"), (error) => {
    assert.equal(error.status, 502, "all targets failed — not a 503");
    assert.deepEqual(error.failures.map((f) => f.model ?? f.target.model), agentModels);
    return true;
  });
  assert.deepEqual(calls, agentModels);
});

test("the request after a lone budget-pool failure is served, not answered with a 503", async () => {
  resetAutomaticOrderCache();
  const health = new HealthRegistry();
  // First request: the budget pool 402 on gpt-6-astra, served by the next model.
  await agentWalk(async (target) => {
    if (target.model === "gpt-6-astra") throw fail(402, { message: BUDGET_POOL_402 });
    return "ok";
  }, health, "agent-next-1");

  // Second request: the cooling target is skipped, its siblings are not.
  const calls = [];
  const result = await agentWalk(async (target) => { calls.push(target.model); return target.model; }, health, "agent-next-2");
  assert.equal(result, "claude-opus-5");
  assert.deepEqual(calls, ["claude-opus-5"]);
  assert.equal(health.rank(agentTargets).length, 3, "three of four models remain routable");
});

test("a genuinely shared credential failure still cools every model on the key and stops the walk", async () => {
  for (const [status, message] of [[401, "Invalid API key"], [402, "Insufficient balance. Please top up your account."], [403, "Forbidden"]]) {
    resetAutomaticOrderCache();
    const health = new HealthRegistry();
    const calls = [];
    await assert.rejects(agentWalk(async (target) => {
      calls.push(target.model);
      throw fail(status, { message });
    }, health, `agent-shared-${status}`), (error) => {
      assert.equal(error.status, 502);
      return true;
    });
    assert.deepEqual(calls, ["gpt-6-astra"], `${status}: siblings are known-unusable and must not be retried`);
    for (const model of agentModels) assert.ok(!health.isAvailable(agent(model)), `${status}: ${model} is cooling`);
    assert.match(health.get(targetId(agent("claude-opus-5"))).lastReason, /applies to the whole key/);

    // With every sibling correctly cooled, the next request fails closed.
    await assert.rejects(agentWalk(async () => "never", health, `agent-shared-next-${status}`), (error) => {
      assert.equal(error.status, 503);
      return true;
    });
  }
});

test("a model-specific failure never cools down the model's siblings on the same key", async () => {
  resetAutomaticOrderCache();
  const health = new HealthRegistry();
  const calls = [];
  // 404 says "this model is gone", not "this key is bad". b/B#0 shares key 0
  // with the failing model and must still be REACHED — if the failure had
  // fanned out, the walk would skip it as a cooldown instead of calling it.
  const result = await walk(async (target) => {
    calls.push(`${target.provider}/${target.model}#${target.keyIndex}`);
    if (target.model === "A") throw fail(404);
    return "ok";
  }, { health });

  assert.equal(result, "ok");
  assert.deepEqual(calls, ["a/A#0", "a/A#1", "b/B#0"]);
  assert.ok(!health.isAvailable(t("a", "A", 0)), "the failing target itself is cooled down");
  assert.equal(health.get(targetId(t("b", "B", 0))).status, "healthy", "the sibling on the same key was never cooled");
  assert.equal(health.get(targetId(t("b", "B", 1))).status, "unknown", "an unrelated key was never touched");
});

test("a genuine key-level failure cools the sibling models that share the key", async () => {
  resetAutomaticOrderCache();
  const health = new HealthRegistry();
  // Siblings = the OTHER MODELS of the same provider using the same key index.
  const local = [t("a", "A", 0), t("a", "A2", 0), t("a", "A", 1), t("b", "B", 0)];
  const calls = [];
  const plan = buildRoutePlan({
    targets: local,
    chain: entries(["a", "A"], ["a", "A2"], ["b", "B"]),
    cacheKey: "key-scope"
  });

  const result = await withFallback(local, async (target) => {
    calls.push(`${target.provider}/${target.model}#${target.keyIndex}`);
    if (target.provider === "a") throw fail(401);
    return "ok";
  }, new Set([401]), new RouteSession(), health, { plan: plan.steps });

  assert.equal(result, "ok");
  // A2 is a second model of provider a on the SAME key: it must never be
  // reached, because key 0 was already proven bad by A.
  assert.deepEqual(calls, ["a/A#0", "a/A#1", "b/B#0"]);
  assert.ok(!health.isAvailable(t("a", "A2", 0)), "the sibling model on the same key is cooled down too");
  assert.match(health.get(targetId(t("a", "A2", 0))).lastReason, /applies to the whole key/);
  assert.equal(health.get(targetId(t("a", "A2", 0))).lastStatus, 401);
  // The same key INDEX at a different provider is a different credential.
  assert.equal(health.get(targetId(t("b", "B", 0))).status, "healthy");
});

test("a provider-scoped failure is only ever applied from explicit metadata", async () => {
  resetAutomaticOrderCache();
  const health = new HealthRegistry();
  const calls = [];
  const result = await walk(async (target) => {
    calls.push(`${target.provider}/${target.model}#${target.keyIndex}`);
    if (target.provider === "a") throw fail(500, { scope: FAILURE_SCOPE.PROVIDER });
    return "ok";
  }, { health });

  assert.equal(result, "ok");
  // Provider a's second key is skipped because the whole provider is down, and
  // provider b is never touched by another provider's outage.
  assert.deepEqual(calls, ["a/A#0", "b/B#0"]);
  assert.ok(!health.isAvailable(t("a", "A", 0)));
  assert.ok(!health.isAvailable(t("a", "A", 1)), "a provider-scoped failure covers the provider's other keys");
  assert.equal(health.get(targetId(t("b", "B", 0))).status, "healthy");
});

test("a provider-scoped failure never crosses a pool boundary", async () => {
  resetAutomaticOrderCache();
  const health = new HealthRegistry();
  const text = [t("a", "A", 0)];
  const vision = [{ ...t("a", "VA", 0), id: "vision:a:VA:key-0", pool: "vision" }];
  const plan = buildRoutePlan({ targets: text, chain: entries(["a", "A"]), cacheKey: "scope-pool" });

  await assert.rejects(withFallback([...text, ...vision], async () => {
    throw fail(500, { scope: FAILURE_SCOPE.PROVIDER });
  }, new Set([500]), new RouteSession(), health, { plan: plan.steps }));

  assert.ok(!health.isAvailable(text[0]), "the text target is down");
  assert.ok(health.isAvailable(vision[0]), "the vision pool's target is a separate target and stays up");
});

test("a non-retryable failure ends the walk instead of continuing it", async () => {
  resetAutomaticOrderCache();
  const calls = [];
  await assert.rejects(
    walk(async (target) => {
      calls.push(target.model);
      throw fail(418);
    }, { retryable: new Set([500]) }),
    (error) => {
      assert.equal(error.status, 418);
      return true;
    }
  );
  assert.deepEqual(calls, ["A"], "a non-retryable error must not be retried on the next target");
});

test("an error that opts out of health tracking does not cool anything down", async () => {
  resetAutomaticOrderCache();
  const health = new HealthRegistry();
  const result = await walk(async (target) => {
    if (target.model === "A") throw fail(400, { skipCooldown: true, retryable: true });
    return "ok";
  }, { health });

  assert.equal(result, "ok");
  assert.ok(health.isAvailable(t("a", "A", 0)), "a refusal that is not the provider's fault must not start a cooldown");
});

test("every target answering 400 surfaces the 400, not a 502", async () => {
  resetAutomaticOrderCache();
  await assert.rejects(
    walk(async () => { throw fail(400); }),
    (error) => {
      assert.equal(error.status, 400);
      assert.ok(Array.isArray(error.failures) && error.failures.length > 0);
      return true;
    }
  );
});

test("every target failing otherwise surfaces a 502 carrying the failures", async () => {
  resetAutomaticOrderCache();
  await assert.rejects(
    walk(async (target) => { throw fail(target.model === "C" ? 429 : 500); }),
    (error) => {
      assert.equal(error.status, 502);
      assert.equal(error.failures.length, 5);
      return true;
    }
  );
});

test("the retryable status set is what decides, and the default set is the documented one", () => {
  assert.ok(isRetryableStatus(429));
  assert.ok(isRetryableStatus(503));
  assert.equal(isRetryableStatus(418), false);
  assert.equal(isRetryableStatus(429, new Set([500])), false);
});

// ---------------------------------------------------------------------------
// Remembering
// ---------------------------------------------------------------------------

test("the remembering modes store the successful target; Fixed Order does not", async () => {
  resetAutomaticOrderCache();
  for (const [mode, expected] of [
    [FALLBACK_MODES.FIXED, null],
    [FALLBACK_MODES.LAST_SUCCESS, "b:B:key-1"],
    [FALLBACK_MODES.AUTO, "b:B:key-1"]
  ]) {
    const session = new RouteSession();
    await walk(async (target) => {
      if (target.model === "A") throw fail(500);
      if (target.keyIndex === 0) throw fail(500);
      return "ok";
    }, { mode, session, chain: entries(["a", "A"], ["b", "B"]) });

    assert.equal(session.validTargetId(), expected, `mode ${mode}`);
  }
});

test("a remembered target expires on its own and is then ignored", () => {
  const session = new RouteSession({ ttlMs: 1000, targetId: "b:B:key-1", expiresAt: 5000 });
  assert.equal(session.validTargetId(4999), "b:B:key-1");
  assert.equal(session.validTargetId(5000), null);
  assert.equal(session.validTargetId(), null, "an expired target stays cleared");
});

test("clearing a session forgets the target but touches nothing else", () => {
  const session = new RouteSession({ targetId: "b:B:key-1", expiresAt: Date.now() + 60_000 });
  session.clear();
  assert.equal(session.targetId, null);
  assert.equal(session.expiresAt, null);
  assert.equal(session.ttlMs, 20 * 60 * 1000, "the configured TTL survives a reset");
});

test("the session store is bounded and can enumerate what it holds", () => {
  const store = new SessionStore({ maxEntries: 3 });
  for (const id of ["a", "b", "c", "d"]) store.set(id, { id });
  assert.equal(store.size, 3);
  assert.equal(store.get("a"), null, "the oldest session is evicted first");
  assert.deepEqual(store.values().map((entry) => entry.id).sort(), ["b", "c", "d"]);
});
