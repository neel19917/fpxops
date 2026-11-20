import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { cacheEventTouches, cachedFetch, peekCache, subscribeCache } from "./sessionCache";

// Stale-while-revalidate in a component: shows the last answer for `key` at
// once (from memory or sessionStorage), asks the server again on mount, when
// the key changes, when the cache is invalidated, and when the tab comes back
// into view after `focusAfterMs`. Nothing blanks while it refreshes.

export interface Cached<T> {
  /** The last answer, or null when there has never been one. */
  data: T | null;
  /** When that answer arrived (ms), or null. */
  updatedAt: number | null;
  /** A request is in flight. */
  refreshing: boolean;
  /** The last request failed (the last answer, if any, is still shown). */
  error: string | null;
  /** Ask the server again now. */
  refresh: () => void;
}

const isAbortError = (e: unknown) => e instanceof DOMException && e.name === "AbortError";

export function useCached<T>(
  key: string,
  fetcher: (signal: AbortSignal) => Promise<T>,
  opts: { focusAfterMs?: number } = {},
): Cached<T> {
  const focusAfterMs = opts.focusAfterMs ?? 60_000;

  const subscribe = useCallback(
    (onChange: () => void) => subscribeCache((e) => { if (cacheEventTouches(e, key)) onChange(); }),
    [key],
  );
  const entry = useSyncExternalStore(subscribe, () => peekCache<T>(key), () => null);

  const fetcherRef = useRef(fetcher);
  useEffect(() => { fetcherRef.current = fetcher; });

  const [nonce, setNonce] = useState(0);
  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  // Kept per key so another key's error or spinner never shows here.
  const [state, setState] = useState<{ key: string; refreshing: boolean; error: string | null }>({ key, refreshing: true, error: null });
  const st = state.key === key ? state : { key, refreshing: true, error: null };

  useEffect(() => {
    const ctl = new AbortController();
    setState({ key, refreshing: true, error: null });
    cachedFetch(key, (s) => fetcherRef.current(s), { signal: ctl.signal }).then(
      () => { if (!ctl.signal.aborted) setState({ key, refreshing: false, error: null }); },
      (e: unknown) => {
        if (ctl.signal.aborted || isAbortError(e)) return;
        setState({ key, refreshing: false, error: (e as Error)?.message || "The server did not answer." });
      },
    );
    return () => ctl.abort();
  }, [key, nonce]);

  // Something changed the data (an action, sign-out): ask again.
  useEffect(() => subscribeCache((e) => {
    if (e.kind !== "write" && cacheEventTouches(e, key)) refresh();
  }), [key, refresh]);

  // Back to this tab after a while: ask again.
  useEffect(() => {
    if (typeof document === "undefined") return;
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      const e = peekCache(key);
      if (!e || e.stale || Date.now() - e.at > focusAfterMs) refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [key, focusAfterMs, refresh]);

  return {
    data: entry ? entry.value : null,
    updatedAt: entry ? entry.at : null,
    refreshing: st.refreshing,
    error: st.error,
    refresh,
  };
}
