import { sb } from "./supabase";

// A small stale-while-revalidate cache for read calls.
//
// - Every answer is kept in memory and in sessionStorage (this tab only), so
//   coming back to a page paints the last answer at once, even after a reload.
// - Identical calls that are in flight at the same time share one request.
//   Each caller keeps its own AbortSignal: aborting rejects that caller with an
//   AbortError, and the shared request is only aborted once nobody waits on it.
// - invalidateCache marks answers stale (they still show, and the next call
//   goes to the server); clearCache drops them (done on sign-out).
// Storage failures (private mode, quota, bad JSON) all degrade to memory only.

const PREFIX = "fpx.sc.";
/** Answers older than this are not read back from storage. */
const MAX_STORED_AGE_MS = 12 * 60 * 60 * 1000;
/** A single answer bigger than this is kept in memory only. */
const MAX_ENTRY_CHARS = 256 * 1024;

export interface CacheEntry<T> {
  value: T;
  /** When the answer arrived (ms since epoch). */
  at: number;
  /** True once something has changed the data since this answer arrived. */
  stale: boolean;
}

export type CacheEvent =
  | { kind: "write"; key: string }
  | { kind: "invalidate" | "clear"; prefix: string; except?: string };

const mem = new Map<string, CacheEntry<unknown>>();
const listeners = new Set<(e: CacheEvent) => void>();
// Bumped by invalidate and clear: a request that started before is not written
// back, and new callers do not join it.
let generation = 0;

function store(): Storage | null {
  try { return typeof window === "undefined" ? null : window.sessionStorage; } catch { return null; }
}

function storedKeys(s: Storage, prefix: string): string[] {
  const out: string[] = [];
  try {
    for (let i = 0; i < s.length; i++) {
      const k = s.key(i);
      if (k && k.startsWith(PREFIX + prefix)) out.push(k);
    }
  } catch { /* storage unavailable */ }
  return out;
}

function readStored<T>(key: string): CacheEntry<T> | undefined {
  const s = store();
  if (!s) return undefined;
  try {
    const raw = s.getItem(PREFIX + key);
    if (!raw) return undefined;
    const e = JSON.parse(raw) as Partial<CacheEntry<T>>;
    if (!e || typeof e.at !== "number" || !("value" in e)) return undefined;
    if (Date.now() - e.at > MAX_STORED_AGE_MS) return undefined;
    return { value: e.value as T, at: e.at, stale: !!e.stale };
  } catch {
    return undefined;
  }
}

function persist(key: string, e: CacheEntry<unknown>): void {
  const s = store();
  if (!s) return;
  let raw: string;
  try { raw = JSON.stringify(e); } catch { return; }
  try {
    if (raw.length > MAX_ENTRY_CHARS) { s.removeItem(PREFIX + key); return; }
    s.setItem(PREFIX + key, raw);
  } catch {
    // Almost always quota: drop this cache's stored answers and try once more.
    try {
      for (const k of storedKeys(s, "")) s.removeItem(k);
      s.setItem(PREFIX + key, raw);
    } catch { /* memory only */ }
  }
}

function emit(e: CacheEvent): void {
  for (const fn of listeners) {
    try { fn(e); } catch { /* a listener's failure is its own */ }
  }
}

/** Listen for writes, invalidations and clears. Returns the unsubscribe. */
export function subscribeCache(fn: (e: CacheEvent) => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/** Whether an event concerns this key. */
export function cacheEventTouches(e: CacheEvent, key: string): boolean {
  if (e.kind === "write") return e.key === key;
  return key.startsWith(e.prefix) && key !== e.except;
}

/** The last answer for this key, or null. Returns the same object until the entry changes. */
export function peekCache<T>(key: string): CacheEntry<T> | null {
  let e = mem.get(key);
  if (!e) {
    const s = readStored<T>(key);
    if (s) { mem.set(key, s); e = s; }
  }
  return (e as CacheEntry<T> | undefined) ?? null;
}

export function writeCache<T>(key: string, value: T): void {
  const e: CacheEntry<T> = { value, at: Date.now(), stale: false };
  mem.set(key, e);
  persist(key, e);
  emit({ kind: "write", key });
}

/**
 * Mark every answer whose key starts with `prefix` as stale. They keep showing,
 * but the next call for them goes to the server. `except` is left alone.
 */
export function invalidateCache(prefix = "", except?: string): void {
  generation++;
  for (const [k, e] of mem) {
    if (k.startsWith(prefix) && k !== except && !e.stale) mem.set(k, { ...e, stale: true });
  }
  const s = store();
  if (s) {
    for (const sk of storedKeys(s, prefix)) {
      const k = sk.slice(PREFIX.length);
      if (k === except) continue;
      const e = mem.get(k) ?? readStored(k);
      if (e) persist(k, { ...e, stale: true });
    }
  }
  emit({ kind: "invalidate", prefix, except });
}

/** Drop every answer whose key starts with `prefix`, from memory and storage. */
export function clearCache(prefix = ""): void {
  generation++;
  for (const k of [...mem.keys()]) if (k.startsWith(prefix)) mem.delete(k);
  const s = store();
  if (s) {
    for (const sk of storedKeys(s, prefix)) {
      try { s.removeItem(sk); } catch { /* ignore */ }
    }
  }
  emit({ kind: "clear", prefix });
}

const abortError = () => new DOMException("The operation was aborted.", "AbortError");

interface Flight {
  promise: Promise<unknown>;
  ctl: AbortController;
  waiters: number;
  gen: number;
}
const inflight = new Map<string, Flight>();

/**
 * Get an answer through the cache.
 * - `maxAgeMs` > 0: a fresh (not stale, younger than this) answer is returned without a request.
 * - Otherwise the server is asked; identical calls in flight share one request.
 * The answer is written to the cache, unless the cache was invalidated meanwhile.
 */
export function cachedFetch<T>(
  key: string,
  fetcher: (signal: AbortSignal) => Promise<T>,
  opts: { signal?: AbortSignal; maxAgeMs?: number } = {},
): Promise<T> {
  const { signal, maxAgeMs = 0 } = opts;
  if (signal?.aborted) return Promise.reject(abortError());
  if (maxAgeMs > 0) {
    const e = peekCache<T>(key);
    if (e && !e.stale && Date.now() - e.at < maxAgeMs) return Promise.resolve(e.value);
  }

  let flight = inflight.get(key);
  if (!flight || flight.gen !== generation) {
    const ctl = new AbortController();
    const gen = generation;
    const f: Flight = { promise: Promise.resolve(), ctl, waiters: 0, gen };
    f.promise = fetcher(ctl.signal)
      .then((v) => {
        if (gen === generation) writeCache(key, v);
        return v;
      })
      .finally(() => { if (inflight.get(key) === f) inflight.delete(key); });
    // Nobody may be listening if every caller aborted; that rejection is expected.
    f.promise.catch(() => {});
    inflight.set(key, f);
    flight = f;
  }

  const f = flight;
  f.waiters++;
  // A caller without a signal never lets go, so the request always finishes.
  if (!signal) return f.promise as Promise<T>;

  return new Promise<T>((resolve, reject) => {
    let done = false;
    const release = () => {
      if (done) return;
      done = true;
      signal.removeEventListener("abort", onAbort);
      f.waiters--;
      // Wait a tick: React StrictMode unmounts and mounts again at once, and
      // the second mount should join this request rather than start another.
      setTimeout(() => {
        if (f.waiters === 0 && inflight.get(key) === f) {
          inflight.delete(key);
          f.ctl.abort();
        }
      }, 0);
    };
    const onAbort = () => { release(); reject(abortError()); };
    signal.addEventListener("abort", onAbort, { once: true });
    f.promise.then(
      (v) => { if (!done) { done = true; signal.removeEventListener("abort", onAbort); f.waiters--; resolve(v as T); } },
      (e: unknown) => { if (!done) { done = true; signal.removeEventListener("abort", onAbort); f.waiters--; reject(e); } },
    );
  });
}

// One person's answers must not paint for the next person in this tab.
try {
  sb.auth.onAuthStateChange((event) => { if (event === "SIGNED_OUT") clearCache(); });
} catch { /* no auth client: nothing to clear on */ }
