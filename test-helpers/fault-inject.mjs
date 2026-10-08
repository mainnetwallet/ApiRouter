// Test-only preload (loaded with NODE_OPTIONS=--import). When APIROUTER_TEST_FAULT=session-id it makes
// the session-store lookup for the shared DEFAULT session (a request that carries no
// x-multi-ai-session-id header) throw. That is a genuine server-side fault raised inside request
// handling, so it proves the top-level error boundary. A request with an explicit session id never
// touches that key. Inert unless the variable is set.
if (process.env.APIROUTER_TEST_FAULT === "session-id") {
  const originalGet = Map.prototype.get;
  Map.prototype.get = function patchedGet(key) {
    if (typeof key === "string" && key.endsWith(":default") && key.startsWith("openai-chat:")) {
      throw new Error("injected fault (Bearer sk-secretsecretsecret)");
    }
    return originalGet.call(this, key);
  };
}
