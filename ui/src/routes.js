import { lazy } from "react";

/**
 * Route and navigation table.
 *
 * One source of truth for the sidebar, the header title and the router, so a
 * new page cannot appear in the navigation without also being routable, or
 * vice versa.
 *
 * Pages are lazily loaded. The panel has eleven of them and an operator
 * typically uses two or three per session; shipping them all in the entry
 * chunk would make first paint pay for screens that are never opened.
 */
const Dashboard = lazy(() => import("./pages/Dashboard.jsx"));
const Providers = lazy(() => import("./pages/Providers.jsx"));
const Models = lazy(() => import("./pages/Models.jsx"));
const HealthMonitor = lazy(() => import("./pages/HealthMonitor.jsx"));
const RouterControl = lazy(() => import("./pages/RouterControl.jsx"));
const Fallback = lazy(() => import("./pages/Fallback.jsx"));
const ManualOrder = lazy(() => import("./pages/ManualOrder.jsx"));
const Playground = lazy(() => import("./pages/Playground.jsx"));
const Requests = lazy(() => import("./pages/Requests.jsx"));
const LiveLogs = lazy(() => import("./pages/LiveLogs.jsx"));
const Analytics = lazy(() => import("./pages/Analytics.jsx"));
const Configuration = lazy(() => import("./pages/Configuration.jsx"));
const SystemPage = lazy(() => import("./pages/SystemPage.jsx"));

export const ROUTES = [
  { path: "/", label: "Dashboard", icon: "dashboard", group: "Overview", element: Dashboard,
    description: "Live gateway health, traffic and fallback activity" },

  { path: "/providers", label: "Providers", icon: "server", group: "Configure", element: Providers,
    description: "Configured providers, credentials and per-provider health" },
  { path: "/models", label: "Models", icon: "box", group: "Configure", element: Models,
    description: "Model catalogue with health, protocol and usage" },

  // Deliberately NOT "/health": the gateway answers GET /health with the raw
  // JSON contract, and `RESERVED_PREFIXES` in src/server.js shadows the SPA for
  // that path. A panel route there would be unreachable in a browser.
  { path: "/health-monitor", label: "Health Monitor", icon: "activity", group: "Operate", element: HealthMonitor,
    description: "Every routing target, its score and cooldown state" },
  { path: "/router", label: "Router", icon: "route", group: "Operate", element: RouterControl,
    description: "How the gateway resolves a request to a target" },
  { path: "/fallback", label: "Fallback", icon: "layers", group: "Operate", element: Fallback,
    description: "The ordered chain the router walks when a target fails" },
  { path: "/manual-order", label: "Model Manual Order", icon: "sliders", group: "Operate", element: ManualOrder,
    description: "Pick the models requests try first, in your own order (text and vision separately)" },
  { path: "/playground", label: "Playground", icon: "terminal", group: "Operate", element: Playground,
    description: "Send a real request through the gateway router" },

  { path: "/requests", label: "Requests", icon: "list", group: "Observe", element: Requests,
    description: "Live request log with full routing lifecycle" },
  { path: "/live-logs", label: "Live Logs", icon: "activity", group: "Observe", element: LiveLogs,
    description: "Real-time attempt-by-attempt execution events" },
  { path: "/analytics", label: "Analytics", icon: "chart", group: "Observe", element: Analytics,
    description: "Traffic, latency, fallback and error breakdowns" },

  { path: "/configuration", label: "Configuration", icon: "sliders", group: "Admin", element: Configuration,
    description: "Safe view of the gateway's effective configuration" },
  { path: "/system", label: "System", icon: "cpu", group: "Admin", element: SystemPage,
    description: "Runtime, health monitor scheduling and process details" }
];

export const NAV_GROUPS = ["Overview", "Configure", "Operate", "Observe", "Admin"];

export function findRoute(path) {
  const exact = ROUTES.find((route) => route.path === path);
  if (exact) return exact;
  // Deep links below a known section (/requests/abc) resolve to that section.
  return ROUTES.find((route) => route.path !== "/" && path.startsWith(route.path + "/")) ?? null;
}
