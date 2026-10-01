import { useEffect, useState } from "react";
import { AppShell } from "./components/layout/AppShell.jsx";
import { ConnectionSettings } from "./components/layout/ConnectionSettings.jsx";
import { useRoute } from "./router.jsx";
import { findRoute } from "./routes.js";
import { useIsMobile } from "./hooks/useMediaQuery.js";
import { preferredTheme, setStoredTheme } from "./lib/session.js";
import NotFound from "./pages/NotFound.jsx";

/**
 * Application root.
 *
 * Owns only cross-cutting UI state: the resolved theme, mobile navigation, and
 * the connection dialog. Everything else — health, system status, toasts —
 * lives in its own provider so a health poll cannot re-render the shell.
 */
export default function App() {
  const path = useRoute();
  const route = findRoute(path);
  const isMobile = useIsMobile();

  const [theme, setTheme] = useState(preferredTheme);
  const [navOpen, setNavOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    setStoredTheme(theme);
  }, [theme]);

  // Navigating always dismisses the mobile drawer, including via back/forward.
  useEffect(() => {
    setNavOpen(false);
  }, [path]);

  useEffect(() => {
    document.title = route ? `${route.label} · MultiAI Router` : "MultiAI Router";
  }, [route]);

  const Page = route?.element ?? NotFound;

  return (
    <>
      <AppShell
        route={route}
        path={path}
        navOpen={isMobile && navOpen}
        onOpenNav={() => setNavOpen(true)}
        onCloseNav={() => setNavOpen(false)}
        onOpenSettings={() => setSettingsOpen(true)}
        theme={theme}
        onToggleTheme={() => setTheme((current) => (current === "dark" ? "light" : "dark"))}
      >
        <Page />
      </AppShell>

      <ConnectionSettings open={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </>
  );
}
