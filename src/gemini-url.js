/**
 * The one place a Gemini API URL is built.
 *
 * A configured base URL may be a bare host (`https://generativelanguage.googleapis.com`),
 * or already carry an API version (`.../v1`, `.../v1beta`, `.../v1alpha`, with or
 * without a trailing slash). Every caller — the native adapter, the three
 * translation bridges and the health probe — goes through these functions, so a
 * version can never be appended twice (`/v1beta/v1beta/...`) and a request and
 * its health probe always talk to the same API version.
 *
 * The router speaks `generateContent` as defined in `v1beta`, so a configured
 * version is replaced by it rather than honoured: the request body the bridges
 * build is a v1beta body.
 */

export const GEMINI_API_VERSION = "v1beta";

const VERSION_SUFFIX = /\/v\d+(?:alpha|beta)?\d*$/i;

/** The base URL without trailing slashes and without any API version segment. */
export function geminiRoot(baseUrl) {
  const trimmed = String(baseUrl || "").trim().replace(/\/+$/, "");
  return trimmed.replace(VERSION_SUFFIX, "").replace(/\/+$/, "");
}

/** `<root>/v1beta` */
export function geminiVersionedBase(baseUrl) {
  const root = geminiRoot(baseUrl);
  return root ? `${root}/${GEMINI_API_VERSION}` : "";
}

/** `<root>/v1beta/models` — the health-probe URL. */
export function geminiModelsUrl(baseUrl) {
  const base = geminiVersionedBase(baseUrl);
  return base ? `${base}/models` : "";
}

/** `<root>/v1beta/models/<model>:generateContent` (or `:streamGenerateContent?alt=sse`). */
export function geminiModelUrl(baseUrl, model, { stream = false } = {}) {
  const base = geminiVersionedBase(baseUrl);
  const method = stream ? ":streamGenerateContent?alt=sse" : ":generateContent";
  return `${base}/models/${encodeURIComponent(String(model))}${method}`;
}
