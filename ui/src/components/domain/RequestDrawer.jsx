import { Drawer } from "../ui/Overlays.jsx";
import { StatusBadge } from "../ui/StatusBadge.jsx";
import { PoolBadge } from "../ui/PoolBadge.jsx";
import { CopyableId } from "../ui/CopyableId.jsx";
import { ErrorState } from "../ui/ErrorState.jsx";
import { RequestTimeline, phaseLabel } from "./RequestTimeline.jsx";
import { formatDateTime, formatLatency, formatTokens, protocolLabel, providerLabel, EMPTY } from "../../lib/format.js";
import { ApiError, classifyFailure, failureLabel } from "../../lib/errors.js";

/**
 * Full detail for one request.
 *
 * Everything rendered here is an allow-listed field from the gateway's request
 * log — request bodies, prompts and headers are never recorded server-side, so
 * there is nothing sensitive to redact at this layer. The drawer says so
 * explicitly rather than leaving an operator to wonder whether the blank space
 * means "not recorded" or "not loaded".
 */
export function RequestDrawer({ entry, open, onClose, loading = false, error = null }) {
  const title = entry ? `${providerLabel(entry.finalProvider)} / ${entry.finalModel ?? "unrouted"}` : "Request";

  return (
    <Drawer
      open={open}
      onClose={onClose}
      wide
      title={title}
      subtitle={entry ? `${protocolLabel(entry.protocol)} · ${formatDateTime(entry.receivedAt)}` : null}
    >
      {loading ? <div className="skeleton skeleton--title" /> : null}
      {error ? <ErrorState error={error} compact /> : null}

      {entry ? (
        <div className="stack" style={{ gap: "var(--sp-4)" }}>
          <div className="row row--wrap" style={{ gap: "var(--sp-2)" }}>
            <StatusBadge tone={entry.outcome === "success" ? "ok" : "danger"} dot={false}>
              {entry.outcome}
            </StatusBadge>
            <StatusBadge tone="neutral" dot={false}>HTTP {entry.httpStatus ?? EMPTY}</StatusBadge>
            {entry.fallbackCount > 0 ? (
              <StatusBadge tone="warn" dot={false}>{entry.fallbackCount} fallback</StatusBadge>
            ) : (
              <StatusBadge tone="ok" dot={false}>no fallback</StatusBadge>
            )}
          </div>

          <section>
            <div className="section__title" style={{ marginBottom: "var(--sp-2)" }}>Lifecycle</div>
            <RequestTimeline entry={entry} />
          </section>

          <section>
            <div className="section__title" style={{ marginBottom: "var(--sp-2)" }}>Request</div>
            <dl className="dl">
              <dt className="dl__term">Request ID</dt>
              <dd className="dl__desc"><CopyableId value={entry.id} showFull label="Copy request ID" /></dd>

              <dt className="dl__term">Received</dt>
              <dd className="dl__desc">{formatDateTime(entry.receivedAt)}</dd>

              <dt className="dl__term">Completed</dt>
              <dd className="dl__desc">{formatDateTime(entry.completedAt)}</dd>

              <dt className="dl__term">Protocol</dt>
              <dd className="dl__desc">{protocolLabel(entry.protocol)}</dd>

              <dt className="dl__term">Routing pool</dt>
              <dd className="dl__desc">
                <PoolBadge pool={entry.pool} />
              </dd>

              <dt className="dl__term">Requested model</dt>
              <dd className="dl__desc mono">{entry.requestedModel ?? <span className="dim">auto route</span>}</dd>

              <dt className="dl__term">Gateway latency</dt>
              <dd className="dl__desc">{formatLatency(entry.latencyMs)}</dd>

              <dt className="dl__term">Total duration</dt>
              <dd className="dl__desc">{formatLatency(entry.totalMs)}</dd>

              <dt className="dl__term">Streamed</dt>
              <dd className="dl__desc">{entry.streamed ? "yes" : "no"}</dd>

              <dt className="dl__term">Tokens</dt>
              <dd className="dl__desc">
                {Number.isFinite(entry.tokens)
                  ? formatTokens(entry.tokens)
                  : <span className="dim" title="The upstream response did not report usage">not reported by provider</span>}
              </dd>

              <dt className="dl__term">Finish reason</dt>
              <dd className="dl__desc">
                {entry.finishReason ?? <span className="dim" title="The upstream response did not report a finish reason">not reported by provider</span>}
              </dd>
            </dl>
          </section>

          {entry.outcome === "failed" ? (
            <section>
              <div className="section__title" style={{ marginBottom: "var(--sp-2)" }}>Failure</div>
              <ErrorState
                error={new ApiError({
                  status: entry.httpStatus,
                  type: entry.errorType,
                  message: entry.errorMessage
                })}
                title={failureLabel(classifyFailure(entry))}
                compact
              />
            </section>
          ) : null}

          <section>
            <div className="section__title" style={{ marginBottom: "var(--sp-2)" }}>
              Upstream attempts ({entry.attemptCount})
            </div>
            <div className="stack stack--tight">
              {(entry.attempts ?? []).map((attempt) => (
                <div key={attempt.attemptId ?? `${entry.seq}:${attempt.index}`} className={`chain__card chain__card--${attempt.ok ? "ok" : attempt.skipped ? "neutral" : "danger"}`}>
                  <span className="chain__rank">{attempt.index}</span>
                  <div className="chain__main">
                    <div className="chain__target">
                      <span className="chain__provider">{providerLabel(attempt.provider)}</span> / {attempt.model ?? EMPTY}
                    </div>
                    <div className="chain__meta">
                      {attempt.phase ? <span>{phaseLabel(attempt)}</span> : null}
                      <span>key {attempt.keyIndex ?? "?"}</span>
                      {attempt.status ? <span>HTTP {attempt.status}</span> : null}
                      {Number.isFinite(attempt.latencyMs) ? <span>{formatLatency(attempt.latencyMs)}</span> : null}
                    </div>
                    {attempt.errorMessage ? <div className="chain__meta">{attempt.errorMessage}</div> : null}
                  </div>
                  <div className="chain__side">
                    <StatusBadge tone={attempt.ok ? "ok" : attempt.skipped ? (attempt.skipReason === "cooldown" ? "warn" : "neutral") : "danger"} dot={false}>
                      {attempt.ok ? "ok" : attempt.skipped ? (attempt.skipReason === "cooldown" ? "skipped · cooldown" : "skipped · already tried") : "failed"}
                    </StatusBadge>
                  </div>
                </div>
              ))}
              {(entry.attempts ?? []).length === 0 ? <span className="dim small">No upstream attempt recorded.</span> : null}
            </div>
          </section>

          <div className="notice">
            <span>
              Request and response bodies, prompts and headers are never recorded by the gateway,
              so they cannot be displayed here.
            </span>
          </div>
        </div>
      ) : null}
    </Drawer>
  );
}
