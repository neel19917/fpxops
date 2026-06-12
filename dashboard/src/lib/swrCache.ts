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

export function swrSet(key: string, value: unknown): void {
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify({ t: Date.now(), v: value }));
  } catch {
    // Quota exceeded or storage unavailable — the cache is best-effort.
  }
}
