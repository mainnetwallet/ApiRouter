import { createContext, useCallback, useContext, useMemo, useState } from "react";
import { getRouterToken, setRouterToken } from "../lib/session.js";
import { invalidateCache } from "../api/client.js";

/**
 * The operator's gateway credentials.
 *
 * Only the client-side router token lives here — provider keys never reach the
 * browser at all, so there is nothing else to hold. When the token changes,
 * every cached ETag is dropped and `generation` is bumped; the polling
 * contexts list `generation` as a dependency, so the whole panel refetches
 * against the new credential without a page reload.
 */

const ConnectionContext = createContext(null);

export function ConnectionProvider({ children }) {
  const [token, setTokenState] = useState(() => getRouterToken());
  const [generation, setGeneration] = useState(0);

  const setToken = useCallback((next) => {
    const value = String(next ?? "").trim();
    setRouterToken(value);
    setTokenState(value);
    invalidateCache();
    setGeneration((current) => current + 1);
  }, []);

  const value = useMemo(() => ({
    token,
    hasToken: token.length > 0,
    setToken,
    generation
  }), [token, setToken, generation]);

  return <ConnectionContext.Provider value={value}>{children}</ConnectionContext.Provider>;
}

export function useConnection() {
  const context = useContext(ConnectionContext);
  if (!context) throw new Error("useConnection must be used inside a ConnectionProvider");
  return context;
}
