/**
 * Connection settings.
 *
 * The router token is the one secret this UI legitimately handles. It lives in
 * `sessionStorage`, never `localStorage`: it should not outlive the tab, and it
 * must never be shared with another origin or persisted to disk by the browser
 * on a shared machine. It is never written to logs, and never rendered in full
 * (see `lib/mask.js`).
 */

const TOKEN_KEY = "multiai.routerToken";
const THEME_KEY = "multiai.theme";

/** sessionStorage throws in some privacy modes; degrade rather than crash. */
function safeSession() {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

function safeLocal() {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function getRouterToken() {
  return safeSession()?.getItem(TOKEN_KEY) ?? "";
}

export function setRouterToken(token) {
  const store = safeSession();
  if (!store) return;
  const value = String(token ?? "").trim();
  if (value) store.setItem(TOKEN_KEY, value);
  else store.removeItem(TOKEN_KEY);
}

export function clearRouterToken() {
  safeSession()?.removeItem(TOKEN_KEY);
}

/**
 * Theme is not a secret, so it may persist. Only the resolved name is stored —
 * never user content.
 */
export function getStoredTheme() {
  const value = safeLocal()?.getItem(THEME_KEY);
  return value === "light" || value === "dark" ? value : null;
}

export function setStoredTheme(theme) {
  if (theme === "light" || theme === "dark") safeLocal()?.setItem(THEME_KEY, theme);
}

export function preferredTheme() {
  const stored = getStoredTheme();
  if (stored) return stored;
  try {
    return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
  } catch {
    return "dark";
  }
}
