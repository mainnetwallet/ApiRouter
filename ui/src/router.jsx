import { useCallback, useEffect, useState } from "react";

/**
 * Minimal History-API router.
 *
 * The panel needs eleven flat routes and no nested layouts, so a routing
 * library would be a dependency bought for two functions. What a library does
 * give you — intercepting link clicks, back/forward, deep links — is the part
 * implemented here.
 */

const listeners = new Set();

function currentPath() {
  if (typeof window === "undefined") return "/";
  return window.location.pathname.replace(/\/+$/, "") || "/";
}

export function navigate(to, { replace = false } = {}) {
  if (typeof window === "undefined") return;
  if (to === currentPath()) return;

  if (replace) window.history.replaceState(null, "", to);
  else window.history.pushState(null, "", to);

  for (const listener of listeners) listener(to);
}

export function useRoute() {
  const [path, setPath] = useState(currentPath);

  useEffect(() => {
    const listener = (next) => setPath(next);
    listeners.add(listener);

    const onPopState = () => setPath(currentPath());
    window.addEventListener("popstate", onPopState);

    return () => {
      listeners.delete(listener);
      window.removeEventListener("popstate", onPopState);
    };
  }, []);

  return path;
}

/**
 * Anchor that routes client-side.
 *
 * Renders a real `<a href>` so the destination is visible on hover, can be
 * opened in a new tab, and is keyboard-operable for free. Only plain left
 * clicks are intercepted; anything with a modifier key is left to the browser.
 */
export function Link({ to, children, className, onClick, ...rest }) {
  const handleClick = useCallback((event) => {
    onClick?.(event);
    if (event.defaultPrevented) return;
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;

    event.preventDefault();
    navigate(to);
  }, [to, onClick]);

  return (
    <a href={to} className={className} onClick={handleClick} {...rest}>
      {children}
    </a>
  );
}
