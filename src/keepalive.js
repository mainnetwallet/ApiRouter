/**
 * Optional self-ping so free hosts that sleep after ~15 minutes without
 * inbound traffic (e.g. Render) stay awake.
 *
 * The ping goes to the PUBLIC url (not localhost) so it re-enters through the
 * host's edge and counts as inbound traffic. It only hits the open /health
 * endpoint, which never exposes credentials.
 *
 * Enabled when KEEPALIVE_URL is set, or automatically on Render
 * (RENDER_EXTERNAL_URL). Disable with KEEPALIVE_URL=off.
 */
const DEFAULT_INTERVAL_MS = 10 * 60 * 1000;

export function startKeepAlive(env = process.env, log = console) {
  const raw = (env.KEEPALIVE_URL || env.RENDER_EXTERNAL_URL || "").trim();
  if (!raw || raw.toLowerCase() === "off") return () => {};

  const base = raw.replace(/\/+$/, "");
  const intervalMs = Math.max(60_000, Number(env.KEEPALIVE_INTERVAL_MS) || DEFAULT_INTERVAL_MS);
  const url = base + "/health";

  const ping = async () => {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
      await res.arrayBuffer().catch(() => {});
    } catch (error) {
      log.warn?.("keep-alive ping failed: " + (error?.name || "error"));
    }
  };

  const timer = setInterval(ping, intervalMs);
  timer.unref?.();
  log.log?.("Keep-alive enabled: " + url + " every " + Math.round(intervalMs / 60000) + " min");
  return () => clearInterval(timer);
}
