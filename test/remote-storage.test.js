import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { encryptText, decryptText, createGithubStorage, createRemoteStorage, RemoteStorageError } from "../src/remote-storage.js";
import { CustomEndpointStore, CustomEndpointError } from "../src/custom-endpoints.js";
import { startMockGithub } from "../test-helpers/mock-github.js";
import { startMockUpstream } from "../test-helpers/mock-upstream.js";
import { startRouter } from "../test-helpers/router-harness.js";

const SECRET = "a-long-enough-secret";
const publicLookup = async () => [{ address: "93.184.216.34", family: 4 }];
const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "remote-store-")), "custom-endpoints.json");
const sample = (over = {}) => ({ name: "Mine", baseUrl: "https://gw.example.com/v1", protocol: "openai-chat", models: ["m1", "m2"], apiKeys: ["secret-key-1", "secret-key-2"], ...over });
const storageFor = (github, over = {}) => createGithubStorage({
  repo: github.repo, token: github.token, branch: "apirouter-data", path: "custom-endpoints.enc.json", secret: SECRET, apiBase: github.apiBase, ...over
});

// ---------------------------------------------------------------------------
// Encryption
// ---------------------------------------------------------------------------

test("encryption round-trips, hides the text, and a wrong secret is detected", () => {
  const blob = encryptText('{"apiKeys":["sk-very-secret"]}', SECRET);
  assert.equal(blob.includes("sk-very-secret"), false);
  assert.equal(decryptText(blob, SECRET), '{"apiKeys":["sk-very-secret"]}');
  assert.throws(() => decryptText(blob, "another-secret-value"), (error) => error.code === "wrong_secret");
  assert.throws(() => decryptText("plain text", SECRET), (error) => error.code === "unreadable");
  // Fresh salt and iv every time: the same input never encrypts to the same blob.
  assert.notEqual(encryptText("x", SECRET), encryptText("x", SECRET));
});

// ---------------------------------------------------------------------------
// Configuration is checked up front
// ---------------------------------------------------------------------------

test("remote storage config fails fast instead of silently using the disk", () => {
  assert.equal(createRemoteStorage({ repo: "" }), null);
  assert.equal(createRemoteStorage(undefined), null);
  assert.throws(() => createRemoteStorage({ repo: "not-a-repo", token: "t", secret: SECRET, branch: "d" }), /owner\/name/);
  assert.throws(() => createRemoteStorage({ repo: "a/b", token: "", secret: SECRET, branch: "d" }), /TOKEN/);
  assert.throws(() => createRemoteStorage({ repo: "a/b", token: "t", secret: "short", branch: "d" }), /SECRET/);
  assert.throws(() => createRemoteStorage({ repo: "a/b", token: "t", secret: SECRET, branch: "main" }), /dedicated data branch/);
  assert.ok(createRemoteStorage({ repo: "a/b", token: "t", secret: SECRET, branch: "apirouter-data", path: "x.json" }));
});

// ---------------------------------------------------------------------------
// GitHub storage against the mock API
// ---------------------------------------------------------------------------

test("github storage: first read is empty, write creates the data branch, later writes update in place", async () => {
  const github = await startMockGithub();
  try {
    const storage = storageFor(github);
    assert.equal(await storage.read(), null);

    await storage.write("v1");
    assert.ok(github.branches.has("apirouter-data"), "the dedicated branch is created from the default branch");
    assert.equal(await storage.read(), "v1");

    await storage.write("v2");
    assert.equal(await storage.read(), "v2");

    const blob = github.stored("apirouter-data", "custom-endpoints.enc.json");
    assert.equal(blob.includes("v2"), false, "the repository only ever holds ciphertext");
    assert.equal(github.files.has("main:custom-endpoints.enc.json"), false, "nothing is written to the default branch");
  } finally { await github.close(); }
});

test("github storage: a stale sha (another writer) is retried once", async () => {
  const github = await startMockGithub();
  try {
    const first = storageFor(github);
    const second = storageFor(github);
    await first.write("one");
    await second.read();       // second now knows the sha
    await first.write("two");  // sha moves on behind second's back
    await second.write("three");
    assert.equal(await first.read(), "three");
  } finally { await github.close(); }
});

test("github storage: auth failure and wrong secret are reported without leaking the token", async () => {
  const github = await startMockGithub();
  try {
    await storageFor(github).write("data");

    await assert.rejects(() => storageFor(github, { token: "ghp_wrongtoken" }).read(), (error) => {
      assert.ok(error instanceof RemoteStorageError);
      assert.equal(error.code, "auth");
      assert.equal(error.message.includes("ghp_wrongtoken"), false);
      return true;
    });
    await assert.rejects(() => storageFor(github, { secret: "different-secret-here" }).read(), (error) => error.code === "wrong_secret");
  } finally { await github.close(); }
});

// ---------------------------------------------------------------------------
// The store on top of remote storage
// ---------------------------------------------------------------------------

test("store: endpoints saved before a 'redeploy' come back although the local disk is empty", async () => {
  const github = await startMockGithub();
  try {
    const before = new CustomEndpointStore({ file: tmpFile(), remote: storageFor(github), lookup: publicLookup });
    await before.init();
    await before.create(sample());
    await before.create(sample({ name: "Other", models: ["x"], apiKeys: ["k"] }));

    // A new container: a different, empty data directory and no memory of the old one.
    const after = new CustomEndpointStore({ file: tmpFile(), remote: storageFor(github), lookup: publicLookup });
    assert.equal(after.list().length, 0, "the local disk starts empty");
    await after.init();
    assert.deepEqual(after.list().map((e) => e.id), ["custom-mine", "custom-other"]);
    assert.deepEqual(after.list()[0].apiKeys, ["secret-key-1", "secret-key-2"]);
    assert.deepEqual(after.storageInfo(), { mode: "github", location: "github:acme/data@apirouter-data:custom-endpoints.enc.json", ready: true, error: null });
  } finally { await github.close(); }
});

test("store: an endpoint that only exists on the local disk is uploaded once (migration)", async () => {
  const github = await startMockGithub();
  try {
    const file = tmpFile();
    const local = new CustomEndpointStore({ file, lookup: publicLookup });
    await local.create(sample());

    const store = new CustomEndpointStore({ file, remote: storageFor(github), lookup: publicLookup });
    await store.init();
    assert.ok(github.stored("apirouter-data", "custom-endpoints.enc.json"), "the existing endpoint reached GitHub");

    const fresh = new CustomEndpointStore({ file: tmpFile(), remote: storageFor(github), lookup: publicLookup });
    await fresh.init();
    assert.deepEqual(fresh.list().map((e) => e.id), ["custom-mine"]);
  } finally { await github.close(); }
});

test("store: while GitHub is unreachable a change is refused, never written over the saved list", async () => {
  const github = await startMockGithub();
  try {
    const writer = new CustomEndpointStore({ file: tmpFile(), remote: storageFor(github), lookup: publicLookup });
    await writer.init();
    await writer.create(sample());

    // A restarted instance cannot reach GitHub.
    github.setFailing(true);
    const restarted = new CustomEndpointStore({ file: tmpFile(), remote: storageFor(github), lookup: publicLookup });
    await restarted.init();
    assert.equal(restarted.storageInfo().ready, false);
    await assert.rejects(() => restarted.create(sample({ name: "New" })), (error) => error instanceof CustomEndpointError && error.status === 503);

    // GitHub is back: the next change first loads the saved list, then adds to it.
    github.setFailing(false);
    let announced = 0;
    restarted.onChange(() => { announced += 1; });
    await restarted.create(sample({ name: "New" }));
    assert.deepEqual(restarted.list().map((e) => e.id).sort(), ["custom-mine", "custom-new"], "the saved endpoint was not lost");
    assert.ok(announced >= 1);
  } finally { await github.close(); }
});

test("store: a failed remote write rolls the change back", async () => {
  const github = await startMockGithub();
  try {
    const store = new CustomEndpointStore({ file: tmpFile(), remote: storageFor(github), lookup: publicLookup });
    await store.init();
    await store.create(sample());

    const flaky = { name: "github", location: "x", read: async () => "{}", write: async () => { throw new RemoteStorageError("boom", { status: 500 }); } };
    store.remote = flaky;
    await assert.rejects(() => store.create(sample({ name: "Second" })), (error) => error.status === 500);
    await assert.rejects(() => store.remove("custom-mine"), (error) => error.status === 500);
    assert.deepEqual(store.list().map((e) => e.id), ["custom-mine"], "memory matches what was actually saved");
  } finally { await github.close(); }
});

test("store: concurrent saves do not lose each other", async () => {
  const github = await startMockGithub();
  try {
    const store = new CustomEndpointStore({ file: tmpFile(), remote: storageFor(github), lookup: publicLookup });
    await store.init();
    await Promise.all([1, 2, 3, 4].map((n) => store.create(sample({ name: `E${n}`, models: ["m"], apiKeys: ["k"] }))));
    const fresh = new CustomEndpointStore({ file: tmpFile(), remote: storageFor(github), lookup: publicLookup });
    await fresh.init();
    assert.equal(fresh.list().length, 4);
  } finally { await github.close(); }
});

// ---------------------------------------------------------------------------
// End to end: the real server, wiped between boots like a Render redeploy
// ---------------------------------------------------------------------------

const okBody = { id: "x", object: "chat.completion", model: "cm", choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" }] };
const post = (router, url, body, method = "POST") => router.request(url, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

test("e2e: saved endpoints survive a redeploy that wipes the disk, and answer requests again", async () => {
  const github = await startMockGithub();
  const upstream = await startMockUpstream(() => ({ status: 200, body: okBody }));
  const remoteEnv = {
    PLAYGROUND_ALLOW_PRIVATE_HOSTS: "1",
    CUSTOM_ENDPOINTS_GITHUB_REPO: github.repo,
    CUSTOM_ENDPOINTS_GITHUB_TOKEN: github.token,
    CUSTOM_ENDPOINTS_GITHUB_API: github.apiBase,
    CUSTOM_ENDPOINTS_SECRET: SECRET
  };
  // Each boot gets its own empty data directory (the harness makes a fresh one), as after a redeploy.
  let router = await startRouter(remoteEnv);
  try {
    const created = await post(router, "/api/custom-endpoints", { name: "Keep", baseUrl: `${upstream.baseUrl}/v1`, models: ["cm", "cm2"], apiKeys: ["k1", "k2"] });
    assert.equal(created.status, 201, await created.clone().text());
    const listed = await (await router.request("/api/custom-endpoints")).json();
    assert.equal(listed.storage.mode, "github");
    assert.equal(listed.storage.ready, true);
    assert.equal(JSON.stringify(listed).includes(github.token), false, "the token is never shown");
  } finally { await router.close(); }

  assert.equal(github.stored("apirouter-data", "custom-endpoints.enc.json").includes("k1"), false, "keys are encrypted at rest");

  router = await startRouter(remoteEnv);
  try {
    const listed = await (await router.request("/api/custom-endpoints")).json();
    assert.deepEqual(listed.endpoints.map((e) => e.id), ["custom-keep"]);
    assert.equal(listed.endpoints[0].keyCount, 2);

    const providers = await (await router.request("/api/providers")).json();
    assert.equal(providers.providers.find((p) => p.id === "custom-keep")?.targetCount, 4);

    const response = await router.request("/v1/chat/completions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "anything", messages: [{ role: "user", content: "hello" }] }) });
    assert.equal(response.status, 200, await response.clone().text());
  } finally { await router.close(); await upstream.close(); await github.close(); }
});

test("e2e: repo without a secret stops startup with a clear message", async () => {
  await assert.rejects(
    () => startRouter({ CUSTOM_ENDPOINTS_GITHUB_REPO: "acme/data", CUSTOM_ENDPOINTS_GITHUB_TOKEN: "t", CUSTOM_ENDPOINTS_SECRET: "" }),
    /CUSTOM_ENDPOINTS_SECRET/
  );
});
