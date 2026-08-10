// Tiny stale-while-revalidate cache for list endpoints. Pages seed their
// state from the last successful response so the table paints instantly,
// then the live fetch replaces it when it lands. Persisted to localStorage
// so a brand-new tab benefits too; quota / private-mode / parse failures
// all degrade silently to "no cache".
const PREFIX = "fpx.swr.";

// Entries older than this are ignored — a revalidate is always in flight,
// but we'd rather show a spinner than data stale enough to mislead.
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

type Entry<T> = { t: number; v: T };

export function swrGet<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    if (!raw) return null;
    const entry = JSON.parse(raw) as Entry<T>;
    if (!entry || typeof entry.t !== "number") return null;
    if (Date.now() - entry.t > MAX_AGE_MS) return null;
    return entry.v;
  } catch {
    return null;
  }
}

// A single cache entry big enough to crowd out the rest of localStorage isn't
// worth keeping. The auth token shares this storage: if GoTrue's own setItem
// of a freshly rotated token fails on quota, the rotation is lost and the
// session is stranded — a silent logout caused by a cache write.
const MAX_ENTRY_BYTES = 512 * 1024;

function swrKeys(): string[] {
  const keys: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k && k.startsWith(PREFIX)) keys.push(k);
  }
  return keys;
}

// Drop the oldest half of the cache. Called only when we've actually hit
// quota, so being aggressive is cheaper than retrying repeatedly.
function pruneOldest(): void {
  const aged = swrKeys().map((k) => {
    let t = 0;
    try { t = (JSON.parse(localStorage.getItem(k) || "{}") as Entry<unknown>).t || 0; } catch { /* treat as oldest */ }
    return { k, t };
  }).sort((a, b) => a.t - b.t);
  for (const { k } of aged.slice(0, Math.max(1, Math.ceil(aged.length / 2)))) {
    try { localStorage.removeItem(k); } catch { /* ignore */ }
  }
}

export function swrSet(key: string, value: unknown): void {
  let payload: string;
  try {
    payload = JSON.stringify({ t: Date.now(), v: value });
  } catch {
    return; // unserializable — nothing to cache
  }
  if (payload.length > MAX_ENTRY_BYTES) return;
  try {
    localStorage.setItem(PREFIX + key, payload);
  } catch {
    // Almost always quota. Make room and try once more; if it still fails the
    // cache is best-effort and we move on.
    try {
      pruneOldest();
      localStorage.setItem(PREFIX + key, payload);
    } catch {
      // Storage unavailable (private mode) or still full.
    }
  }
}

// Called on sign-out: one user's cached lists must not paint for the next
// person on a shared machine, and clearing them relieves the quota pressure
// described above.
export function swrClear(): void {
  try {
    for (const k of swrKeys()) localStorage.removeItem(k);
  } catch {
    // Storage unavailable — nothing cached to clear.
  }
}
