import { Icon } from "../ui/Icon.jsx";

/**
 * Standard page header: title, description, a live freshness note and the
 * page's own actions.
 *
 * The freshness line matters in a polling UI — without it an operator cannot
 * tell a page that is up to date from one whose last refresh failed.
 */
export function PageHeader({ title, description, actions = null, lastUpdatedAt = null, refreshing = false, paused = false, children = null }) {
  return (
    <div className="page__header">
      <div className="page__heading">
        <h1 className="page__title">{title}</h1>
        {description ? <p className="page__subtitle">{description}</p> : null}
        <FreshnessLine lastUpdatedAt={lastUpdatedAt} refreshing={refreshing} paused={paused} />
      </div>
      {actions ? <div className="page__actions">{actions}</div> : null}
      {children}
    </div>
  );
}

function FreshnessLine({ lastUpdatedAt, refreshing, paused }) {
  if (!lastUpdatedAt && !refreshing) return null;

  return (
    <div className="row tiny dim" style={{ marginTop: 4, gap: "var(--sp-3)" }}>
      {refreshing ? (
        <span className="row" style={{ gap: 5 }}>
          <Icon name="refresh" size={11} />
          updating…
        </span>
      ) : lastUpdatedAt ? (
        <span>updated {new Date(lastUpdatedAt).toLocaleTimeString()}</span>
      ) : null}
      {paused ? <span title="Polling pauses while the tab is hidden">paused (tab hidden)</span> : null}
    </div>
  );
}
