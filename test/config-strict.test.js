import test from "node:test";
import assert from "node:assert/strict";

import { loadConfig, readStatusCodes, readBoolean } from "../src/config.js";
import { startRouter } from "../test-helpers/router-harness.js";

const DEFAULTS = [401, 402, 403, 404, 408, 409, 425, 429, 500, 501, 502, 503, 504, 520, 521, 522, 523, 524, 529];
const statuses = (value) => [...loadConfig({ RETRY_STATUS_CODES: value }).retryableStatus];

test("RETRY_STATUS_CODES: valid lists are accepted (spaces and trailing commas tolerated, duplicates removed)", () => {
  assert.deepEqual(statuses("429,500,503"), [429, 500, 503]);
  assert.deepEqual(statuses(" 429 , 500 ,"), [429, 500]);
  assert.deepEqual(statuses("429,429,500"), [429, 500]);
  assert.deepEqual(statuses("100,599"), [100, 599]);
});

test("RETRY_STATUS_CODES: unset or blank means the documented default", () => {
  assert.deepEqual([...loadConfig({}).retryableStatus], DEFAULTS);
  assert.deepEqual(statuses(""), DEFAULTS);
  assert.deepEqual(statuses("   "), DEFAULTS);
});

test("RETRY_STATUS_CODES: any invalid entry fails loudly instead of silently shrinking the list", () => {
  for (const bad of ["abc", "429,abc,500", "99", "600", "429;500", "4xx", "-1", "429.5", ",", "0x1ad"]) {
    assert.throws(() => statuses(bad), /Invalid RETRY_STATUS_CODES/, `"${bad}"`);
  }
});

test("STICKY_TTL_MS, MAX_REQUEST_BODY_BYTES and the REMOTE_IMAGE_* settings are strict too", () => {
  assert.equal(loadConfig({ STICKY_TTL_MS: "5000" }).stickyTtlMs, 5000);
  assert.equal(loadConfig({}).stickyTtlMs, 20 * 60 * 1000);
  for (const bad of ["abc", "0", "-5", "1.5"]) {
    assert.throws(() => loadConfig({ STICKY_TTL_MS: bad }), /Invalid STICKY_TTL_MS/, bad);
    assert.throws(() => loadConfig({ MAX_REQUEST_BODY_BYTES: bad }), /Invalid MAX_REQUEST_BODY_BYTES/, bad);
    assert.throws(() => loadConfig({ REMOTE_IMAGE_MAX_BYTES: bad }), /Invalid REMOTE_IMAGE_MAX_BYTES/, bad);
  }
  assert.throws(() => loadConfig({ REMOTE_IMAGE_ALLOW_HTTP: "maybe" }), /Invalid REMOTE_IMAGE_ALLOW_HTTP/);
});

test("the body limit is off by default (compatibility) and configurable; remote image defaults are strict", () => {
  const defaults = loadConfig({});
  assert.equal(defaults.maxRequestBodyBytes, null, "no limit unless the operator sets one");
  assert.deepEqual(defaults.remoteImages, { allowHttp: false, allowPrivateNetwork: false, maxBytes: 20 * 1024 * 1024, timeoutMs: 15000 });
  assert.equal(loadConfig({ MAX_REQUEST_BODY_BYTES: "1048576" }).maxRequestBodyBytes, 1048576);
  assert.equal(loadConfig({ MAX_REQUEST_BODY_MB: "1" }).maxRequestBodyBytes, null, "the old, undocumented MB name is still not a setting");
});

test("readBoolean / readStatusCodes helpers", () => {
  assert.equal(readBoolean({ X: "TRUE" }, "X", false), true);
  assert.equal(readBoolean({ X: "off" }, "X", true), false);
  assert.equal(readBoolean({}, "X", true), true);
  assert.deepEqual(readStatusCodes({}, "X", [429]), [429]);
});

test("the router process refuses to start on an invalid RETRY_STATUS_CODES, naming the setting", async () => {
  await assert.rejects(
    startRouter({ RETRY_STATUS_CODES: "429,abc" }),
    (error) => /Router exited early/.test(error.message) && /Invalid RETRY_STATUS_CODES/.test(error.message)
  );
});
