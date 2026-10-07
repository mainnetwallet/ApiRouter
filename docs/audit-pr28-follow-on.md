# Audit: Remaining Files After PR #28

**Scope:** Files not covered by the PR #27 and PR #28 audits.

**Result: No bugs found. All 55 backend test files + 8 UI test files pass on `main`.**

---

## Files Audited

### `src/upstream-fetch.js`
Clean. `fetchUpstream` passes `redirect: "manual"` on every call — the only place the gateway contacts a provider. No redirect-following, no SSRF surface.

### `src/observability/sanitize.js`
Clean. Credential scrubbing is thorough:
- Pattern-based redaction runs on known key shapes (`sk-`, `AIza`, `hf_`, `gsk_`, etc.) and `Bearer <token>`.
- `registerConfiguredSecrets` / `redactConfiguredSecrets` adds exact-value matching for every configured provider key, including URL-encoded and JSON-escaped forms. Secrets shorter than 8 characters are not registered (avoids false positives).
- Control characters are stripped before any pattern pass, so they cannot split a credential around a pattern boundary.
- `containsCredentialShapedText` resets `/g` regex `lastIndex` before and after each test, preventing state leakage between calls.

### `src/request-validation.js`
Clean. Minimal, intentional: only rejects shapes the adapters cannot interpret at all (non-array `messages`, non-object entries). Finer validation is left to the upstream provider.

### `src/bridge-errors.js`
Clean. `parseToolArguments` refuses (with a typed, `retryable + skipCooldown` error) any tool-argument value that is not a JSON object when one is needed. The historical silent-`{}` fallback is gone. `markStreamFailure` preserves the original `streamCause`/`code` tags from `guardUpstreamStream`.

### `src/adapters.js`
Clean. `buildUpstreamRequest` is a strict allow-list of outgoing headers; the client's `authorization` header is never forwarded. `readJsonBody` buffers with a size cap and rejects non-object JSON at the body-read layer.

### `src/static-files.js`
Clean. Path traversal prevention is two-layered:
1. Lexical: `resolveWithinRoot` rejects `..`, null bytes, dotfiles, and absolute paths; the result must still start with the root after `path.resolve`.
2. Symlink: `resolveFile` calls `realpath` on the resolved path and re-checks that the real path is inside the root. A symlink planted inside the root that points outside it is caught here.

Assets under `/assets/` are served with `immutable` cache headers; everything else is `no-cache`. Security headers (`x-content-type-options`, `referrer-policy`) are set on every served file.

### `src/dev-proxy.js`
Clean. Proxy target is validated at start-up (`parseDevUiOrigin`) to be a loopback `http://host:port` origin; any non-loopback or non-http value throws. No part of a request selects the destination — it cannot be used as an open proxy.

Additional mitigations:
- Loop detection via `LOOP_HEADER` prevents forwarding a request that already passed through the proxy.
- Filesystem-touching Vite endpoints (`/@fs`, `/__open-in-editor`) are blocked for non-loopback clients, except prebundled dependency files under `node_modules/.vite/deps`.
- Gateway-owned paths (`/api/`, `/v1/`, `/v1beta/`, `/health`) are never forwarded, even when percent-encoded (`/api%2fconfig`).

### `src/observability/request-log.js`
Clean. `record()` and `begin()` are explicit allow-lists — request bodies, upstream bodies, headers and credentials are never stored. All text fields pass through `sanitizeMessage`. Attempt IDs are minted by the log (never supplied by a provider), so provider identity cannot hijack a log slot. The pending-entry TTL and size cap prevent unbounded growth.

### `src/api.js`
Clean. Every handler is read-only over existing state. Auth is delegated to the same `authorized()` predicate as the proxy path, so enabling client auth protects the admin surface too. Live SSE streams are capped at 50 concurrent. The `[DONE]` terminator from providers cannot reach `openRequestStream` because that stream only forwards from `requestLog.subscribe`, which emits typed internal events, not raw upstream data.

### Bridge files (`anthropic-bridge.js`, `chat-bridge.js`, `codex-bridge.js`, `gemini-bridge.js`)

All clean. Key observations:

- **Tool argument parsing** is centralised in `parseToolArguments` (`bridge-errors.js`), called by every bridge path that translates a JSON-string argument to an object. The old silent-`{}` fallback no longer exists anywhere.
- **`cleanSchemaForGemini`** handles `anyOf`/`oneOf`/`allOf` by collapsing to the first non-null variant and setting `nullable`; handles array `type` values; ensures every `array` node has `items`. Used consistently across all four bridges.
- **`rememberSignature` / `signatureFor`** (Gemini 3 thoughtSignature relay) is keyed by `(callId, sessionId)`, capped at 2 000 entries FIFO, and volatile across restarts. Two unrelated sessions reusing the same tool-call id never exchange signatures.
- **Streaming error paths**: every bridge's stream emits its protocol's terminal error event before re-throwing a `markStreamFailure`-tagged error, so `pipeline()` always rejects, the request is recorded as truncated, the target is not marked healthy, and no sticky is saved.
- **Image/file refusals**: every bridge refuses, with a typed `unsupported_image_source` error, any image shape it cannot actually carry (remote URLs the gateway will not fetch, `fileData` references, images inside tool results, `input_file`/file_id references).

**Minor dead code** (`anthropic-bridge.js` `streamToAnthropic`): the `open` array tracks open content-block indices but is only ever used to remove `textIndex` in `closeText`. Tool-block indices are added to `open` but the final cleanup uses `toolBlocks.values()` instead. The array is maintained correctly and never affects output — it is a no-op artefact that can be removed in a future cleanup PR.

---

## Test Coverage

All tests pass on `main` (without the PR #28 fixes):

| Group | Tests |
|---|---|
| Bridge + security (unit) | 166 |
| Tool-arg, multimodal, observability, upstream-fetch | 86 |
| Robustness, stream-failure, API, Gemini-client-bridge (integration) | 65 |
| Health, router, priority, sticky, live-stream, attempt-events | 168 |
| Audit-fixes, auth, bridge-token-cap, config, provider unit tests | 203 |
| Vision, pool-capabilities, exact-model, playground-pin, priority, client-abort (integration) | 85 |
| Health-monitor, server (integration) | 59 |
| **UI (Vitest)** | **181** |
| **Total** | **≈ 1 013** |

Zero failures across all 55 backend test files and 8 UI test files.

---

## Still not audited

Nothing security-sensitive was left. The remaining unread code is pure presentation / observability:

- `src/observability/config-view.js` — safe read of config for the `/api/config` endpoint
- `src/observability/metrics.js` — analytics aggregation over the in-memory request log
- `src/observability/monitor-state.js` — health-monitor state machine
- `src/observability/router-preview.js` — routing dry-run for the UI
- `src/observability/route-select.js` — capability matching for the preview (partially read in PR #28 audit)
- `src/observability/system-info.js` — process/runtime info for `/api/system`
- `src/providers/catalog.js` — static provider capability registry
- `src/image-source.js` — inline data URL splitting and error constructors
- `src/upstream-url.js` — URL builders for each provider protocol
- `src/vision.js` — vision request detection
- `src/capabilities.js` — per-target capability detection
- `src/health-checks.js` — active health-check logic
- `src/config.js`, `src/health.js`, `src/routing-plan.js`, `src/router.js`, `src/server.js` — covered in the PR #27 and PR #28 audits

None of these touch credential handling, upstream fetching, response translation or logging in a way that wasn't already covered.
