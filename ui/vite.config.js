import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

/**
 * Vite config lives inside `ui/`. `root` is set explicitly rather than left to
 * default, because the default is the *current working directory* — which is
 * the repository root when this config is invoked as
 * `vite build --config ui/vite.config.js`. Without this, the entry would be
 * looked for at `<repo>/index.html` instead of `<repo>/ui/index.html`.
 *
 * The build output is therefore `ui/dist`, which is what `src/static-files.js`
 * serves and what `.gitignore` already excludes.
 *
 * Normal development is `npm run dev`: the gateway (default :999) is the only
 * URL you open and it forwards panel requests to this Vite server on a private
 * port. Running `npm run ui:dev` directly is the optional frontend-only mode;
 * there the dev server proxies the gateway's own routes to a router already
 * running on :999 (override with MULTIAI_ROUTER_ORIGIN), with no CORS shim and
 * no second code path for API calls. Production uses the same relative URLs,
 * served from the same origin.
 */
const projectRoot = fileURLToPath(new URL(".", import.meta.url));
const ROUTER_ORIGIN = process.env.MULTIAI_ROUTER_ORIGIN || "http://localhost:999";

// Under `npm run dev` the gateway forwards panel requests here and serves the
// API routes itself, so Vite must not proxy them back: a request the gateway
// does not treat as an API route would otherwise bounce gateway -> Vite ->
// gateway indefinitely. `scripts/dev-config.mjs` sets this; standalone
// `npm run ui:dev` does not, and keeps the proxy.
const BEHIND_GATEWAY = process.env.MULTIAI_UI_BEHIND_GATEWAY === "1";

export default defineConfig({
  root: projectRoot,
  plugins: [react()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    // Small enough to keep the panel snappy, large enough to avoid noise.
    chunkSizeWarningLimit: 700
  },
  server: {
    port: 5173,
    strictPort: false,
    proxy: BEHIND_GATEWAY
      ? undefined
      : Object.fromEntries(
        ["/api", "/health", "/v1", "/v1beta"].map((path) => [
          path,
          { target: ROUTER_ORIGIN, changeOrigin: true }
        ])
      )
  },
  test: {
    // Pure-function tests only; no DOM environment is pulled in.
    environment: "node",
    include: ["src/**/__tests__/**/*.test.jsx", "src/**/__tests__/**/*.test.js"],
    reporters: "default"
  }
});
