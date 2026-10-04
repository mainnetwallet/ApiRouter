// Test-only preload (loaded with NODE_OPTIONS=--import). When MULTIAI_TEST_FAULT=session-id it makes
// crypto.randomUUID throw, which the router calls while minting a session id for a request that
// carries none. That is a genuine server-side fault raised inside request handling, so it proves
// the top-level error boundary. Inert unless the variable is set.
import crypto, { } from "node:crypto";
import { syncBuiltinESMExports } from "node:module";

if (process.env.MULTIAI_TEST_FAULT === "session-id") {
  crypto.randomUUID = () => { throw new Error("injected fault (Bearer sk-secretsecretsecret)"); };
  syncBuiltinESMExports();
}
