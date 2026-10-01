import { Icon } from "./Icon.jsx";

/**
 * Empty states are explicit about *why* there is nothing to show.
 *
 * "No targets configured" and "no targets match this filter" look identical on
 * screen but need opposite responses — add a provider, or clear the filter.
 */
export function EmptyState({ title, children, icon = "inbox", action = null }) {
  return (
    <div className="state">
      <Icon name={icon} className="state__icon" size={26} />
      <div className="state__title">{title}</div>
      {children ? <div className="state__body">{children}</div> : null}
      {action}
    </div>
  );
}
