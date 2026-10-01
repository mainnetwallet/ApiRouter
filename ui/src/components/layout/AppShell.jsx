import { Suspense } from "react";
import { Icon } from "../ui/Icon.jsx";
import { Sidebar } from "./Sidebar.jsx";
import { Header } from "./Header.jsx";
import { MetricSkeleton, TableSkeleton } from "../ui/LoadingSkeleton.jsx";

/**
 * The application shell.
 *
 * Layout is driven entirely by CSS grid areas (see styles/layout.css), so the
 * responsive behaviour — full sidebar, icon rail, overlay drawer — is a
 * media-query concern and not a JavaScript one. `isMobile` is used only to
 * decide whether the sidebar should start closed.
 */
export function AppShell({
  route,
  path,
  navOpen,
  onOpenNav,
  onCloseNav,
  onOpenSettings,
  theme,
  onToggleTheme,
  children
}) {
  return (
    <>
      <a className="skip-link" href="#main-content">Skip to main content</a>

      <div className="app">
        <div className="brand">
          <Icon name="route" className="brand__mark" size={22} />
          <span className="brand__name">MultiAI Router</span>
        </div>

        <Header
          route={route}
          onOpenNav={onOpenNav}
          onOpenSettings={onOpenSettings}
          theme={theme}
          onToggleTheme={onToggleTheme}
        />

        <Sidebar path={path} open={navOpen} onClose={onCloseNav} />

        {navOpen ? (
          <button type="button" className="scrim" onClick={onCloseNav} aria-label="Close navigation" tabIndex={-1} />
        ) : null}

        <main className="main" id="main-content" tabIndex={-1}>
          <Suspense fallback={<PageFallback />}>
            {children}
          </Suspense>
        </main>
      </div>
    </>
  );
}

/**
 * Suspense fallback shaped like a real page, so the layout does not collapse
 * and then jump when a lazily-loaded route arrives.
 */
function PageFallback() {
  return (
    <div className="page">
      <div className="page__header">
        <div className="page__heading">
          <div className="skeleton" style={{ height: 22, width: 180 }} />
          <div className="skeleton" style={{ height: 12, width: 280, marginTop: 8 }} />
        </div>
      </div>
      <MetricSkeleton count={8} />
      <div className="section" style={{ marginTop: "var(--sp-5)" }}>
        <div className="panel">
          <div className="panel__body">
            <TableSkeleton rows={6} label="Loading page" />
          </div>
        </div>
      </div>
    </div>
  );
}
