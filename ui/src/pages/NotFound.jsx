import { PageHeader } from "../components/layout/PageHeader.jsx";
import { EmptyState } from "../components/ui/EmptyState.jsx";
import { Link } from "../router.jsx";
import { ROUTES } from "../routes.js";

/** Unknown route. Lists the real destinations rather than offering a dead end. */
export default function NotFound() {
  return (
    <div className="page">
      <PageHeader title="Page not found" description="There is no panel at this address" />

      <div className="panel">
        <EmptyState title="Nothing here" icon="alert">
          The address you opened does not match any page in this panel. It may have been mistyped,
          or the link may be out of date.
        </EmptyState>

        <div className="panel__body">
          <div className="section__title" style={{ marginBottom: "var(--sp-2)" }}>Available pages</div>
          <div className="row row--wrap" style={{ gap: "var(--sp-2)" }}>
            {ROUTES.map((route) => (
              <Link key={route.path} className="btn btn--sm" to={route.path}>
                {route.label}
              </Link>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
