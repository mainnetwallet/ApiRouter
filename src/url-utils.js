/**
 * Shared URL construction rules for upstream provider endpoints.
 *
 * A configured base URL may or may not already carry the provider's API version
 * (`https://generativelanguage.googleapis.com` vs `.../v1beta`). Every caller
 * that appends a versioned path therefore has to strip a trailing version
 * segment first, or the request goes to `/v1beta/v1beta/models/...`.
 */

/**
 * A trailing API-version path segment: `/v1`, `/v1beta`, `/v2alpha1`.
 * Anchored to the end of the path so it never eats a real path segment such as
 * `/v1beta` inside something longer.
 */
export const API_VERSION_SUFFIX = /\/v\d+(?:alpha|beta)?\d*$/i;

/**
 * A base URL with any trailing API-version segment and trailing slashes removed.
 *
 * A query string or fragment is preserved: the version is only ever stripped
 * from the end of the path portion, so a custom base URL carrying parameters
 * keeps working.
 */
export function stripApiVersion(baseUrl) {
  const base = String(baseUrl || "").replace(/\/+$/, "");
  const cut = base.search(/[?#]/);
  const path = cut === -1 ? base : base.slice(0, cut);
  const tail = cut === -1 ? "" : base.slice(cut);
  return path.replace(API_VERSION_SUFFIX, "").replace(/\/+$/, "") + tail;
}
