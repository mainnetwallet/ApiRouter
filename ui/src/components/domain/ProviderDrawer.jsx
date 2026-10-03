import { Drawer } from "../ui/Overlays.jsx";
import { StatusBadge } from "../ui/StatusBadge.jsx";
import { HealthBadge } from "../ui/HealthBadge.jsx";
import { LatencyBadge } from "../ui/LatencyBadge.jsx";
import { PoolBadge } from "../ui/PoolBadge.jsx";
import { CapabilityBadges } from "./CapabilityBadges.jsx";
import { poolLabel } from "../../lib/pools.js";
import {
  formatPercent, formatRelativeTime, protocolLabel, providerLabel, EMPTY
} from "../../lib/format.js";

/**
 * Provider detail, organized by routing pool.
 *
 * The same provider can be configured in both pools, and the two are independent
 * — different models, keys, base URLs, health and latency. So this drawer renders
 * one section per pool and never merges their figures. The Dashboard passes both
 * pools; the Providers page passes the single pool whose row was clicked.
 *
 * Everything shown is an allow-listed field the gateway is willing to expose:
 * base URL, model lists, protocol support and a *count* of keys. There is no
 * code path that reads key material into the browser.
 */
export function ProviderDrawer({ open, onClose, id, pools = [] }) {
  const entries = (Array.isArray(pools) ? pools : []).filter((entry) => entry?.record);
  const first = entries[0]?.record ?? null;
  const capabilities = first?.capabilities ?? null;
  const protocols = first?.protocols ?? [];
  const anyUnconfigured = entries.some((entry) => entry.record.configured === false);

  const subtitle = entries.length === 0
    ? null
    : [
        entries.map((entry) => `${poolLabel(entry.pool)} pool`).join(" · "),
        first?.envPrefix ? `${first.envPrefix}_* environment variables` : null
      ].filter(Boolean).join(" · ");

  return (
    <Drawer
      open={open}
      onClose={onClose}
      wide
      title={id ? providerLabel(id) : ""}
      subtitle={subtitle}
    >
      {entries.length === 0 ? null : (
        <div className="stack" style={{ gap: "var(--sp-4)" }}>
          <div className="row row--wrap" style={{ gap: "var(--sp-1)" }}>
            {anyUnconfigured
              ? <StatusBadge tone="neutral">partly not configured</StatusBadge>
              : <StatusBadge tone="ok">configured</StatusBadge>}
            {entries.map((entry) => <PoolBadge key={entry.pool} pool={entry.pool} />)}
            {protocols.map((protocol) => (
              <StatusBadge key={protocol} tone="neutral" dot={false}>{protocolLabel(protocol)}</StatusBadge>
            ))}
          </div>

          <section>
            <div className="section__title" style={{ marginBottom: "var(--sp-2)" }}>Capabilities</div>
            <CapabilityBadges capabilities={capabilities} />
            <p className="tiny dim" style={{ marginTop: "var(--sp-2)" }}>
              Capabilities are derived from what is configured for each pool, never assumed from
              the provider's name.
            </p>
          </section>

          {entries.map((entry) => (
            <PoolSection key={entry.pool} pool={entry.pool} record={entry.record} />
          ))}

          <div className="notice">
            <span>
              Provider credentials are configured server-side in <code>.env</code> and are never
              sent to this panel. Only the count is shown.
            </span>
          </div>
        </div>
      )}
    </Drawer>
  );
}

/** One pool's configuration, health and targets — kept separate from the other. */
function PoolSection({ pool, record }) {
  const models = pool === "vision" ? (record.visionModels ?? []) : (record.textModels ?? []);
  const targets = Array.isArray(record.targets) ? record.targets : [];

  return (
    <section className="provider-pool">
      <div className="section__header">
        <PoolBadge pool={pool} />
        <span className="section__title" style={{ textTransform: "none" }}>{poolLabel(pool)} pool</span>
        <span className="section__actions tiny dim mono">
          {models.length} models · {record.targetCount} targets · {record.keyCount} keys
        </span>
      </div>

      {record.configured === false ? (
        <div className="notice notice--warn" style={{ marginBottom: "var(--sp-3)" }}>
          <div>
            This provider is incomplete and is excluded from the {poolLabel(pool)} pool. Missing:
            {" "}<strong>{(record.missing ?? []).join(", ")}</strong>.
          </div>
        </div>
      ) : null}

      <dl className="dl">
        <dt className="dl__term">{poolLabel(pool)} models</dt>
        <dd className="dl__desc">
          {models.length > 0
            ? <span className="mono tiny">{models.join(", ")}</span>
            : <span className="dim">none configured</span>}
        </dd>

        <dt className="dl__term">Base URL</dt>
        <dd className="dl__desc mono">{record.baseUrl ?? EMPTY}</dd>

        <dt className="dl__term">Protocols</dt>
        <dd className="dl__desc">{record.protocols.map(protocolLabel).join(", ") || EMPTY}</dd>

        <dt className="dl__term">API keys</dt>
        <dd className="dl__desc">
          {record.keyCount > 0
            ? <span>{record.keyCount} configured — values never leave the server</span>
            : <span className="dim">none configured</span>}
        </dd>

        {record.clientHeaderNames?.length > 0 ? (
          <>
            <dt className="dl__term">Client headers</dt>
            <dd className="dl__desc">
              {record.clientHeaderNames.join(", ")}
              <div className="tiny dim">Names only — header values are not exposed.</div>
            </dd>
          </>
        ) : null}

        <dt className="dl__term">Health</dt>
        <dd className="dl__desc"><HealthBadge status={record.health.status} /></dd>

        <dt className="dl__term">Success rate</dt>
        <dd className="dl__desc">
          {record.health.successRate === null
            ? <span className="dim">no observations yet</span>
            : formatPercent(record.health.successRate)}
        </dd>

        <dt className="dl__term">Observations</dt>
        <dd className="dl__desc mono">{record.health.successes} ok / {record.health.failures} failed</dd>

        <dt className="dl__term">Latency</dt>
        <dd className="dl__desc"><LatencyBadge ms={record.health.latencyMs} /></dd>

        <dt className="dl__term">Last check</dt>
        <dd className="dl__desc">{formatRelativeTime(record.health.lastUpdatedAt)}</dd>
      </dl>

      <div className="section__title" style={{ margin: "var(--sp-3) 0 var(--sp-2)" }}>
        {poolLabel(pool)} targets ({targets.length})
      </div>
      {targets.length === 0 ? (
        <span className="dim small">No targets — this provider is not routable in this pool.</span>
      ) : (
        <div className="table-wrap">
          <table className="table table--compact">
            <caption className="sr-only">Per-target health for {record.id ?? "provider"} ({pool} pool)</caption>
            <thead>
              <tr>
                <th scope="col">Model</th>
                <th scope="col" className="right">Key</th>
                <th scope="col">Health</th>
                <th scope="col" className="right">Score</th>
                <th scope="col" className="right">Latency</th>
                <th scope="col">Last reason</th>
              </tr>
            </thead>
            <tbody>
              {targets.map((target) => (
                <tr key={target.id}>
                  <td className="mono truncate">{target.model}</td>
                  <td className="mono table__num">{target.keyIndex}</td>
                  <td><HealthBadge status={target.status} /></td>
                  <td className="mono table__num">{Math.round(target.score)}</td>
                  <td className="table__num"><LatencyBadge ms={target.latencyMs} /></td>
                  <td className="truncate tiny dim" title={target.lastReason ?? undefined}>
                    {target.lastReason ?? EMPTY}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
