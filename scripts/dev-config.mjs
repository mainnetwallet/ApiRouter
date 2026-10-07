/**
 * Environment `npm run dev` hands to the processes it starts. Kept separate
 * from `dev.mjs` (which starts processes on import) so it can be tested.
 */

const LOOPBACK_HOST = "127.0.0.1";

/**
 * Development binds to loopback unless `HOST` is set on purpose. The gateway
 * forwards the Vite dev server (including its source-tree endpoints), so
 * listening on every interface by default would publish the project's source
 * to the local network. An explicit `HOST` (for example `0.0.0.0` to try the
 * panel from a phone) is respected, never overridden.
 */
export function resolveGatewayHost(env) {
  const configured = String(env.HOST ?? "").trim();
  return configured === "" ? LOOPBACK_HOST : configured;
}

/** Extra environment for the gateway process. */
export function gatewayEnv(env, vitePort) {
  return {
    HOST: resolveGatewayHost(env),
    MULTIAI_DEV_UI_ORIGIN: `http://${LOOPBACK_HOST}:${vitePort}`
  };
}

/**
 * Extra environment for the Vite process. It tells `ui/vite.config.js` that the
 * gateway fronts this server, so Vite must not proxy `/api`, `/v1`, `/v1beta`
 * or `/health` back to the gateway (that is what made a request bounce
 * gateway -> Vite -> gateway). Standalone `npm run ui:dev` does not set it and
 * keeps its proxy.
 */
export const viteEnv = Object.freeze({ MULTIAI_UI_BEHIND_GATEWAY: "1" });
