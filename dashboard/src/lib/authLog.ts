// Durable record of what happened to the Supabase session.
//
// When someone reports "it logged me out", the evidence is gone by the time
// anyone looks: the console is cleared by the reload, and Supabase's auth logs
// show a successful re-login rather than the failure that preceded it. This
// keeps a small ring buffer in localStorage that survives the logout, the
// reload, and closing the tab, so the next report comes with a timeline.
//
// Read it from the browser console with `fpxAuthLog()` (installed in main.tsx),
// or copy it out with `copy(JSON.stringify(fpxAuthLog(), null, 2))`.
const KEY = "fpx.authlog.v1";

// Deliberately small. This buffer shares localStorage with the auth token
// itself, and a full localStorage makes GoTrue's write of a rotated token fail
// silently — which is one of the ways a session gets stranded. 40 entries at
// roughly 200 bytes is ~8 KB.
const MAX_ENTRIES = 40;

export interface AuthLogEntry {
  /** ISO timestamp, so entries stay readable when pasted into a ticket. */
  ts: string;
  /** supabase-js event name, or one of our own synthetic markers. */
  event: string;
  hasSession: boolean;
  /** Unix seconds. Confirms the project's real access-token TTL. */
  expiresAt: number | null;
  /** Negative means the token was already expired when the event fired. */
  secondsToExpiry: number | null;
  /** A backgrounded tab refreshes differently — worth knowing. */
  visibility: string;
  online: boolean;
  /** Approximate localStorage usage in bytes; near-quota is a failure mode. */
  storageBytes: number;
  note?: string;
}

function approxStorageBytes(): number {
  try {
    let total = 0;
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k) continue;
      total += k.length + (localStorage.getItem(k)?.length || 0);
    }
    return total;
  } catch {
    return -1;
  }
}

export function readAuthLog(): AuthLogEntry[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as AuthLogEntry[]) : [];
  } catch {
    return [];
  }
}

export function clearAuthLog(): void {
  try { localStorage.removeItem(KEY); } catch { /* nothing to clear */ }
}

type SessionLike = { expires_at?: number | null } | null | undefined;

export function logAuth(event: string, session: SessionLike, note?: string): void {
  const expiresAt = session?.expires_at ?? null;
  const entry: AuthLogEntry = {
    ts: new Date().toISOString(),
    event,
    hasSession: !!session,
    expiresAt,
    secondsToExpiry: expiresAt ? Math.round(expiresAt - Date.now() / 1000) : null,
    visibility: typeof document === "undefined" ? "unknown" : document.visibilityState,
    online: typeof navigator === "undefined" ? true : navigator.onLine,
    storageBytes: approxStorageBytes(),
    ...(note ? { note } : {}),
  };

  // Console too, so it's visible live as well as after the fact. A session
  // ending is the event worth shouting about; everything else is routine.
  const line = `[auth] ${event}${session ? ` (expires in ${entry.secondsToExpiry}s)` : " — no session"}${note ? ` — ${note}` : ""}`;
  if (!session) console.warn(line); else console.info(line);

  try {
    const next = [...readAuthLog(), entry].slice(-MAX_ENTRIES);
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // Quota or private mode. Drop the history rather than the session — this
    // buffer must never be the thing that fills storage.
    try { localStorage.removeItem(KEY); } catch { /* give up quietly */ }
  }
}
