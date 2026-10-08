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
 * The dev server proxies the gateway's own routes so `npm run ui:dev` talks to
 * a real router on 8788 with no CORS shim and no second code path for API
 * calls. Production uses the same relative URLs, served from the same origin.
 */
const projectRoot = fileURLToPath(new URL(".", import.meta.url));
const ROUTER_ORIGIN = process.env.APIROUTER_ORIGIN || "http://localhost:8788";

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
    proxy: Object.fromEntries(
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
