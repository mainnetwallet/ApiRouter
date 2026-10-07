import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/layout.css";
import "./styles/components.css";
import "./styles/manual-order.css";

import App from "./App.jsx";
import { ToastProvider } from "./context/ToastContext.jsx";
import { ConnectionProvider } from "./context/ConnectionContext.jsx";
import { SystemStatusProvider } from "./context/SystemStatusContext.jsx";
import { HealthProvider } from "./context/HealthContext.jsx";
import { ErrorBoundary } from "./components/ui/ErrorBoundary.jsx";

/**
 * Provider order is deliberate:
 *
 *   ToastProvider       outermost, so every layer below can report failures —
 *                       including the providers themselves
 *   ConnectionProvider  supplies the router token; must precede anything that
 *                       fetches
 *   SystemStatus        liveness + runtime identity for the header
 *   HealthProvider      target health, deliberately *below* SystemStatus so a
 *                       10s health poll re-renders only health consumers
 *
 * The ErrorBoundary wraps the tree so a render fault in one page shows a
 * recoverable message instead of a blank screen.
 */
createRoot(document.getElementById("root")).render(
  <StrictMode>
    <ToastProvider>
      <ConnectionProvider>
        <SystemStatusProvider>
          <HealthProvider>
            <ErrorBoundary>
              <App />
            </ErrorBoundary>
          </HealthProvider>
        </SystemStatusProvider>
      </ConnectionProvider>
    </ToastProvider>
  </StrictMode>
);
