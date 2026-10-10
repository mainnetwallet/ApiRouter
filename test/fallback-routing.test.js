import test from "node:test";
import assert from "node:assert/strict";
import { HealthRegistry, targetId } from "../src/health.js";
import { buildRoutePlan, resetAutomaticOrderCache } from "../src/fallback-plan.js";
import {
  CLIENT_ERROR_COOLDOWN_MS,
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

/** Runs one walk with the chain a, b, c and every key. */
async function walk(invoke, {
  health = new HealthRegistry(),
  session = new RouteSession(),
  chain = entries(["a", "A"], ["b", "B"], ["c", "C"]),
  retryable = new Set([400, 401, 402, 403, 404, 413, 429, 500, 502, 503]),
  onSkip = null,
  cacheKey = `walk-${Math.random()}`
} = {}) {
  const plan = buildRoutePlan({ targets, chain, health, cacheKey });
  return withFallback(targets, invoke, retryable, session, health, {
    plan: plan.steps,
    onSkip,
    remember: true
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
  // 401/402/403 are about the credential, but they are recorded against the
  // key + model that was tried: the key's other models are attempted on their own.
  for (const status of [401, 402, 403]) assert.equal(classifyFailure(status), FAILURE_SCOPE.TARGET, `${status} is recorded per key + model`);
  for (const status of [400, 404, 413, 422]) assert.equal(classifyFailure(status), FAILURE_SCOPE.TARGET, `${status} is model-level`);
  for (const status of [408, 429, 500, 503, 529, 0]) assert.equal(classifyFailure(status), FAILURE_SCOPE.TARGET, `${status} is target-level by default`);
  // A provider that can read its own error body may state the scope outright.
  assert.equal(classifyFailure(500, { scope: FAILURE_SCOPE.KEY }), FAILURE_SCOPE.KEY);
  assert.equal(classifyFailure(400, { scope: FAILURE_SCOPE.PROVIDER }), FAILURE_SCOPE.PROVIDER);
  assert.equal(classifyFailure(500, { scope: "nonsense" }), FAILURE_SCOPE.TARGET);
});

// The exact upstream text Agentrouter returned in production.
const BUDGET_POOL_402 = "Budget pool quota has been exhausted. Please ask an administrator to increase the limit or select another budget pool.";

test("an Agentrouter budget-pool 402 is labelled, while a bare or account-level 402 is still recorded per key + model", () => {
  const pool = fail(402, { message: BUDGET_POOL_402 });
  assert.equal(classifyFailure(402, pool), FAILURE_SCOPE.TARGET);
  assert.equal(describeFailure(402, pool).kind, "budget pool exhausted");

  // Account / credential failures are recorded against the key + model tried,
  // with no label: the key's other models are attempted separately.
  for (const message of [
    "Insufficient balance. Please top up your account.",
    "Your account balance is too low",
    "Billing issue: payment required",
    "Account suspended"
  ]) {
    assert.equal(classifyFailure(402, fail(402, { message })), FAILURE_SCOPE.TARGET, message);
    assert.equal(describeFailure(402, fail(402, { message })).kind, null, message);
  }
  assert.equal(classifyFailure(402), FAILURE_SCOPE.TARGET, "no message: recorded per key + model");
  assert.equal(classifyFailure(402, fail(402, { message: "" })), FAILURE_SCOPE.TARGET);
  assert.equal(describeFailure(402, fail(402, { message: "Insufficient balance" })).kind, null);

  // A message that mentions both an account problem and a pool is not labelled.
  assert.equal(describeFailure(402, fail(402, { message: `Account suspended. ${BUDGET_POOL_402}` })).kind, null);
});

test("401 is never labelled, and a 403 is labelled only by an explicit model message", () => {
  // Even text that names a budget pool or a model cannot label a 401.
  assert.equal(describeFailure(401, fail(401, { message: BUDGET_POOL_402 })).kind, null);
  assert.equal(describeFailure(401, fail(401, { message: "model not allowed" })).kind, null);
  assert.equal(describeFailure(403, fail(403, { message: "Forbidden" })).kind, null);
  assert.equal(describeFailure(403, fail(403, { message: "Invalid API key" })).kind, null);
  for (const [status, message] of [[401, BUDGET_POOL_402], [401, "model not allowed"], [403, "Forbidden"], [403, "Invalid API key"]]) {
    assert.equal(classifyFailure(status, fail(status, { message })), FAILURE_SCOPE.TARGET, `${status} ${message}`);
  }
  assert.equal(classifyFailure(403, fail(403, { message: "Your account does not have access to model gpt-6-astra" })), FAILURE_SCOPE.TARGET);
  assert.equal(describeFailure(403, fail(403, { message: "Your account does not have access to model gpt-6-astra" })).kind, "no access to this model");
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

test("a 401/402/403 is recorded per key + model, so every model on the key is still tried", async () => {
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
    assert.deepEqual(calls, agentModels, `${status}: each model on the key is attempted once, on its own`);
    for (const model of agentModels) {
      assert.ok(!health.isAvailable(agent(model)), `${status}: ${model} is cooling after its own failure`);
      assert.equal(health.get(targetId(agent(model))).lastStatus, status);
    }

    // Every target failed for itself, so the next request fails closed.
    await assert.rejects(agentWalk(async () => "never", health, `agent-shared-next-${status}`), (error) => {
      assert.equal(error.status, 503);
      return true;
    });
  }
});

test("a 401/402/403 on one model does not stop the key's other models from serving", async () => {
  for (const status of [401, 402, 403]) {
    resetAutomaticOrderCache();
    const health = new HealthRegistry();
    const calls = [];
    const result = await agentWalk(async (target) => {
      calls.push(target.model);
      if (target.model === "gpt-6-astra") throw fail(status, { message: "Forbidden" });
      return target.model;
    }, health, `agent-sibling-${status}`);

    assert.equal(result, "claude-opus-5", `${status}`);
    assert.deepEqual(calls, ["gpt-6-astra", "claude-opus-5"]);
    assert.ok(!health.isAvailable(agent("gpt-6-astra")));
    for (const model of ["claude-opus-5", "claude-opus-4-8", "deepseek-v4-flash"]) {
      assert.ok(health.isAvailable(agent(model)), `${status}: ${model} was not cooled by its sibling's failure`);
    }
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

test("a 401 cools only the key + model tried; the sibling models on that key are attempted separately", async () => {
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
  // A2 is a second model of provider a on the SAME key. It is reached and tried
  // on its own: one model's 401 does not disable the key's other models.
  assert.deepEqual(calls, ["a/A#0", "a/A#1", "a/A2#0", "b/B#0"]);
  assert.ok(!health.isAvailable(t("a", "A", 0)), "the target that failed is cooling");
  assert.ok(!health.isAvailable(t("a", "A2", 0)), "the sibling is cooling because it failed itself");
  assert.equal(health.get(targetId(t("a", "A2", 0))).lastStatus, 401);
  assert.doesNotMatch(String(health.get(targetId(t("a", "A2", 0))).lastReason), /applies to the whole key/);
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

test("a status outside the retry list no longer ends the walk: the next key and model are still tried", async () => {
  resetAutomaticOrderCache();
  const calls = [];
  await assert.rejects(
    walk(async (target) => {
      calls.push(`${target.model}#${target.keyIndex}`);
      throw fail(418);
    }, { retryable: new Set([500]) }),
    (error) => {
      assert.equal(error.status, 418, "every target refused the same way, so the client sees that status");
      assert.equal(error.failures.length, 5);
      return true;
    }
  );
  assert.deepEqual(calls, ["A#0", "A#1", "B#0", "B#1", "C#0"], "each key of each model is attempted once");
});

test("a failure on one key with a status outside the retry list is served by the model's next key", async () => {
  resetAutomaticOrderCache();
  const health = new HealthRegistry();
  const calls = [];
  const result = await walk(async (target) => {
    calls.push(`${target.model}#${target.keyIndex}`);
    if (target.model === "A" && target.keyIndex === 0) throw fail(422);
    return `${target.model}#${target.keyIndex}`;
  }, { health, retryable: new Set([500]) });

  assert.equal(result, "A#1");
  assert.deepEqual(calls, ["A#0", "A#1"]);
  assert.ok(!health.isAvailable(t("a", "A", 0)), "only the key that failed is cooling");
  assert.ok(health.isAvailable(t("a", "A", 1)));
  assert.ok(health.isAvailable(t("b", "B", 0)));
  const left = Number(health.get(targetId(t("a", "A", 0))).cooldownUntil) - Date.now();
  assert.ok(left > 0 && left <= CLIENT_ERROR_COOLDOWN_MS, `a request-level 4xx cools briefly, not 12 minutes (${left}ms)`);
});

test("a client disconnect (retryable: false) still ends the walk at once", async () => {
  resetAutomaticOrderCache();
  const calls = [];
  await assert.rejects(
    walk(async (target) => {
      calls.push(`${target.model}#${target.keyIndex}`);
      throw fail(499, { retryable: false });
    }),
    (error) => {
      assert.equal(error.status, 499);
      return true;
    }
  );
  assert.deepEqual(calls, ["A#0"], "nobody is waiting for an answer, so no further key is tried");
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
      // Five targets, each attempted in the first round and once more in the
      // permitted retry round: every failure is reported, not just the last.
      assert.equal(error.failures.length, 10);
      assert.equal(new Set(error.failures.map((f) => `${f.target.provider}/${f.target.model}#${f.target.keyIndex}`)).size, 5,
        "one entry per failing target");
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

test("the target that answered is remembered, whatever the selection", async () => {
  resetAutomaticOrderCache();
  const session = new RouteSession();
  await walk(async (target) => {
    if (target.model === "A") throw fail(500);
    if (target.keyIndex === 0) throw fail(500);
    return "ok";
  }, { session, chain: entries(["a", "A"], ["b", "B"]) });

  assert.equal(session.validTargetId(), "b:B:key-1", "the provider, model and key that answered are remembered");
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

// ---------------------------------------------------------------------------
// Manual Model Selection: a remembered target leads only from inside the
// selection, and a restriction is honoured before the remembered key
// ---------------------------------------------------------------------------

// provider p1 serves two models, M1 with three keys and M2 with two; provider p2
// serves N1 with two keys. The chain is p1/M1, p1/M2, p2/N1, in that order.
const fx = (provider, model, keyIndex, pool = "text") => ({
  provider, model, keyIndex, pool, protocols: ["openai-chat"],
  ...(pool === "vision" ? { id: `vision:${provider}:${model}:key-${keyIndex}` } : {})
});
const fixedTargets = [
  fx("p1", "M1", 0), fx("p1", "M1", 1), fx("p1", "M1", 2),
  fx("p1", "M2", 0), fx("p1", "M2", 1),
  fx("p2", "N1", 0), fx("p2", "N1", 1)
];
const fixedChain = entries(["p1", "M1"], ["p1", "M2"], ["p2", "N1"]);
const lbl = (target) => `${target.provider}/${target.model}#${target.keyIndex}`;
const SAVED_ORDER = ["p1/M1#0", "p1/M1#1", "p1/M1#2", "p1/M2#0", "p1/M2#1", "p2/N1#0", "p2/N1#1"];

/**
 * One request exactly as the server makes it: the plan is built from the
 * session's remembered target, and the walk records its success on the session.
 */
async function fixedRequest(invoke, {
  health = new HealthRegistry(),
  session = new RouteSession(),
  chain = fixedChain,
  pool = fixedTargets,
  cacheKey = `saved-${Math.random()}`
} = {}) {
  const plan = buildRoutePlan({ targets: pool, chain, health, stickyTargetId: session.validTargetId(), cacheKey });
  // The server refuses a chain it cannot honour before any walk starts; an empty
  // plan handed to the walker would otherwise widen to every target.
  if (plan.failClosed) throw Object.assign(new Error("the saved chain cannot serve this request"), { status: 503 });
  return withFallback(pool, invoke, new Set([500]), session, health, { plan: plan.steps, remember: true });
}
const remember = (session, target) => session.saveSuccess(target, new HealthRegistry());

test("Manual Model Selection exhausts every key of a model, then every model of a provider, before the next provider", async () => {
  resetAutomaticOrderCache();
  const calls = [];
  await assert.rejects(fixedRequest(async (target) => {
    calls.push(lbl(target));
    throw fail(500);
  }), (error) => {
    assert.equal(error.status, 502);
    return true;
  });

  const first = calls.slice(0, SAVED_ORDER.length);
  assert.deepEqual(first, SAVED_ORDER, "the saved order, every key of a model before the next model");
  // p2 is reached only after BOTH of p1's models were exhausted.
  assert.ok(first.indexOf("p2/N1#0") > first.lastIndexOf("p1/M2#1"));
  // The transient 500s earn each target one retry, in the same order.
  assert.deepEqual(calls.slice(SAVED_ORDER.length), SAVED_ORDER, "the permitted retry round repeats the order");
});

test("the remembered key is tried first on the next request, then the model's remaining keys in key order", async () => {
  resetAutomaticOrderCache();
  const session = new RouteSession();
  remember(session, fx("p1", "M1", 2));

  // The remembered key answers: nothing else is called.
  let calls = [];
  assert.equal(await fixedRequest(async (target) => { calls.push(lbl(target)); return "ok"; }, { session }), "ok");
  assert.deepEqual(calls, ["p1/M1#2"]);
  assert.equal(session.targetId, "p1:M1:key-2", "the success is remembered again");

  // It fails: the model's other keys follow in the existing key order, all before M2.
  calls = [];
  await fixedRequest(async (target) => {
    calls.push(lbl(target));
    if (calls.length <= 3) throw fail(500);
    return "ok";
  }, { session });
  assert.deepEqual(calls, ["p1/M1#2", "p1/M1#0", "p1/M1#1", "p1/M2#0"]);
  assert.equal(session.targetId, "p1:M2:key-0", "every success updates the remembered target");
});

test("a remembered target leads only when it is part of the selection", async () => {
  resetAutomaticOrderCache();
  const session = new RouteSession();
  remember(session, fx("p2", "N1", 1));

  // The remembered target is one of the selected models, so it leads: the
  // saved order decides between models, and this one answered last time.
  let calls = [];
  assert.equal(await fixedRequest(async (target) => { calls.push(lbl(target)); return "ok"; }, { session }), "ok");
  assert.deepEqual(calls, ["p2/N1#1"], "a remembered target inside the selection leads");
  assert.equal(session.targetId, "p2:N1:key-1");

  // An unselected remembered target never jumps the queue: it is reached only
  // by the health-based fallback, after the whole selection has been walked.
  const unselected = new RouteSession();
  remember(unselected, fx("p2", "N1", 1));
  calls = [];
  await fixedRequest(async (target) => { calls.push(lbl(target)); return "ok"; }, {
    session: unselected, chain: entries(["p1", "M1"], ["p1", "M2"])
  });
  assert.deepEqual(calls, ["p1/M1#0"], "an unselected remembered target does not lead the walk");
  assert.equal(unselected.targetId, "p1:M1:key-0", "the success replaces what was remembered");

  // And with the selected models failing, the unselected remembered model is
  // reached only after every selected model has been exhausted.
  remember(unselected, fx("p2", "N1", 1));
  calls = [];
  await fixedRequest(async (target) => {
    calls.push(lbl(target));
    if (target.provider === "p1") throw fail(500);
    return "ok";
  }, { session: unselected, chain: entries(["p1", "M1"], ["p1", "M2"]) });
  assert.deepEqual(calls, ["p1/M1#0", "p1/M1#1", "p1/M1#2", "p1/M2#0", "p1/M2#1", "p2/N1#0"],
    "the selection is exhausted first, then the fallback batch in its health order — the remembered key does not lead it");
});

test("a remembered key that is cooling down is skipped without disturbing the order", async () => {
  resetAutomaticOrderCache();
  const health = new HealthRegistry();
  const session = new RouteSession();
  remember(session, fx("p1", "M1", 1));
  health.markFailure(fx("p1", "M1", 1), 500);

  const calls = [];
  await fixedRequest(async (target) => { calls.push(lbl(target)); return "ok"; }, { session, health });
  assert.deepEqual(calls, ["p1/M1#0"], "the cooling remembered key is skipped; the model's next key answers");
});

test("Manual Model Selection still honours disabled models and key restrictions over a remembered key", async () => {
  resetAutomaticOrderCache();
  const session = new RouteSession();
  remember(session, fx("p1", "M1", 2));

  // The remembered key is no longer allowed by the entry: it is not tried, and the model keeps its place.
  const restricted = ["p1/M1#0", "p1/M1#1", "p1/M2#0", "p1/M2#1", "p2/N1#0", "p2/N1#1"];
  let calls = [];
  await fixedRequest(async (target) => { calls.push(lbl(target)); throw fail(500); }, {
    session,
    chain: entries(["p1", "M1", { keys: [0, 1] }], ["p1", "M2"], ["p2", "N1"])
  }).catch(() => {});
  assert.deepEqual(calls, [...restricted, ...restricted], "the restriction holds in both rounds");

  // A disabled model is never walked, remembered or not.
  const remaining = ["p1/M2#0", "p1/M2#1", "p2/N1#0", "p2/N1#1"];
  calls = [];
  await fixedRequest(async (target) => { calls.push(lbl(target)); throw fail(500); }, {
    session,
    chain: entries(["p1", "M1", { enabled: false }], ["p1", "M2"], ["p2", "N1"])
  }).catch(() => {});
  assert.deepEqual(calls, [...remaining, ...remaining]);

  // A chain whose entries all exclude every key still fails closed: nothing is called.
  calls = [];
  await assert.rejects(fixedRequest(async (target) => { calls.push(lbl(target)); return "ok"; }, {
    session, chain: entries(["p1", "M1", { keys: [9] }])
  }));
  assert.deepEqual(calls, []);
});

test("Reset clears the remembered key and nothing else; sessions and pools stay isolated", async () => {
  resetAutomaticOrderCache();
  const health = new HealthRegistry();
  health.markFailure(fx("p1", "M2", 0), 500);
  const a = new RouteSession();
  const b = new RouteSession();
  remember(a, fx("p1", "M1", 2));

  // Session b never saw a success, so it is unaffected by a's.
  let calls = [];
  await fixedRequest(async (target) => { calls.push(lbl(target)); return "ok"; }, { session: b, health });
  assert.deepEqual(calls, ["p1/M1#0"]);
  assert.equal(a.targetId, "p1:M1:key-2", "b's success did not overwrite a's");

  // A text target remembered by a vision-pool session cannot leak into the text pool.
  const visionTargets = [fx("p1", "M1", 0, "vision"), fx("p1", "M1", 1, "vision")];
  const visionSession = new RouteSession();
  calls = [];
  await fixedRequest(async (target) => { calls.push(`${target.pool}:${lbl(target)}`); return "ok"; }, {
    session: visionSession, pool: visionTargets, chain: entries(["p1", "M1"])
  });
  assert.deepEqual(calls, ["vision:p1/M1#0"]);
  assert.equal(visionSession.targetId, "vision:p1:M1:key-0");
  assert.equal(b.targetId, "p1:M1:key-0", "the text session is untouched by the vision walk");

  // Reset: a's remembered key is gone, the walk is the plain order again, and health is intact.
  a.clear();
  assert.equal(a.validTargetId(), null);
  calls = [];
  await fixedRequest(async (target) => { calls.push(lbl(target)); return "ok"; }, { session: a, health });
  assert.deepEqual(calls, ["p1/M1#0"]);
  assert.ok(!health.isAvailable(fx("p1", "M2", 0)), "a genuine cooldown is not part of what Reset clears");
  assert.equal(b.targetId, "p1:M1:key-0", "resetting one session leaves another alone");
});

test("an empty selection routes automatically and remembers what answered", async () => {
  resetAutomaticOrderCache();
  const session = new RouteSession();
  const calls = [];
  await fixedRequest(async (target) => { calls.push(lbl(target)); return "ok"; }, { session, chain: [] });
  assert.deepEqual(calls, ["p1/M1#0"], "the automatic health/latency order leads");
  assert.equal(session.targetId, "p1:M1:key-0", "and the target that answered is remembered");
});
