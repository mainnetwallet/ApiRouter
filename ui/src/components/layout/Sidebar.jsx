import { useMemo } from "react";
import { Icon } from "../ui/Icon.jsx";
import { Link } from "../../router.jsx";
import { ROUTES, NAV_GROUPS } from "../../routes.js";
import { useHealth } from "../../context/HealthContext.jsx";

/**
 * Primary navigation.
 *
 * On desktop this is a fixed column; on mobile it is an overlay drawer driven
 * by `open`. The same markup serves both so there is one navigation to keep
 * correct. Selecting a route closes the drawer.
 *
 * The health badge next to "Health Monitor" is a real count of unhealthy
 * targets, so an operator sees a problem before navigating to it.
 */
export function Sidebar({ path, open = false, onClose }) {
  const { summary } = useHealth();

  const attentionCount = useMemo(() => {
    if (!summary) return null;
    const count = (summary.failed ?? 0) + (summary.cooldown ?? 0);
    return count > 0 ? count : null;
  }, [summary]);

  const badgeFor = (route) => {
    if (route.path === "/health-monitor" && attentionCount) {
      return <span className="nav-item__count" title={`${attentionCount} target(s) not healthy`}>{attentionCount}</span>;
    }
    return null;
  };

  return (
    <nav
      className="sidebar"
      data-open={open ? "true" : "false"}
      aria-label="Main navigation"
    >
      {NAV_GROUPS.map((group) => (
        <div key={group}>
          <div className="nav-group" id={`nav-group-${group}`}>{group}</div>
          {ROUTES.filter((route) => route.group === group).map((route) => {
            const isCurrent = route.path === path;
            return (
              <Link
                key={route.path}
                to={route.path}
                className="nav-item"
                aria-current={isCurrent ? "page" : undefined}
                onClick={onClose}
                title={route.label}
              >
                <Icon name={route.icon} className="nav-item__icon" size={16} />
                <span className="nav-item__label">{route.label}</span>
                {badgeFor(route)}
              </Link>
            );
          })}
        </div>
      ))}

      <div className="nav-group">Endpoints</div>
      <a className="nav-item" href="/health" target="_blank" rel="noreferrer" title="GET /health">
        <Icon name="external" className="nav-item__icon" size={16} />
        <span className="nav-item__label">/health</span>
      </a>
      <a className="nav-item" href="/v1/models" target="_blank" rel="noreferrer" title="GET /v1/models">
        <Icon name="external" className="nav-item__icon" size={16} />
        <span className="nav-item__label">/v1/models</span>
      </a>
    </nav>
  );
}
