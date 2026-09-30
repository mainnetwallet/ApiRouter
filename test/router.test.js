import test from "node:test";
import assert from "node:assert/strict";
import { isRetryableStatus, withFallback } from "../src/router.js";

test("retryable statuses include quota/rate-limit/server failures", () => { for (const code of [402,408,429,500,502,503,504]) assert.equal(isRetryableStatus(code), true); });
test("401 and 403 are not retryable by default", () => { assert.equal(isRetryableStatus(401), false); assert.equal(isRetryableStatus(403), false); });
test("fallback continues after a retryable failure", async () => { const result = await withFallback([{id:"a"},{id:"b"}], async (target) => { if (target.id === "a") { const e = new Error("quota"); e.status = 402; throw e; } return target.id; }); assert.equal(result, "b"); });
