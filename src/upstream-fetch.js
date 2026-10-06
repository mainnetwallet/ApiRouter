/**
 * The one place the gateway talks to a provider over HTTP.
 *
 * Redirects are never followed. `fetch` follows them by default, and a provider
 * (or anyone who can answer for it, e.g. by taking over its DNS or by returning
 * a crafted redirect) could otherwise send the call on to a host of their
 * choosing with the credential headers still attached: undici strips
 * `Authorization` on a cross-origin hop, but not provider-specific headers such
 * as `x-goog-api-key`. The configured base URL is the only host the gateway
 * contacts, and a 3xx is surfaced to the caller as an ordinary non-2xx response.
 */

/** A 3xx response: a redirect the gateway refuses to follow. */
export function isRedirectStatus(status) {
  const code = Number(status);
  return Number.isInteger(code) && code >= 300 && code < 400;
}

/** `fetch` with the gateway's outbound policy (no redirect following) applied. */
export async function fetchUpstream(url, options = {}, fetchImpl = fetch) {
  return fetchImpl(url, { ...options, redirect: "manual" });
}
