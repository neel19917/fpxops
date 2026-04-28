// Admin-only "view as another user" state. Persisted to localStorage so the
// banner survives a refresh; cleared automatically on sign-out.
//
// Two-stage opt-in:
//   stage 1: pick a target  → x-fpx-impersonate header, reads only (server
//            rejects mutations with 403)
//   stage 2: enable writes  → x-fpx-impersonate-write: 1, full action perms
//
// The server attributes every audit log entry to the real admin regardless,
// so this is recoverable / observable.

import type { UserProfileRow } from "./types";

const KEY = "fpx.impersonate.v1";

export interface ImpersonateState {
  target: UserProfileRow;
  writes: boolean;
}

type Listener = (s: ImpersonateState | null) => void;
const listeners = new Set<Listener>();

export function getImpersonate(): ImpersonateState | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as ImpersonateState;
    if (!parsed?.target?.id) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function setImpersonate(next: ImpersonateState | null): void {
  if (typeof window === "undefined") return;
  if (next) {
    window.localStorage.setItem(KEY, JSON.stringify(next));
  } else {
    window.localStorage.removeItem(KEY);
  }
  for (const fn of listeners) fn(next);
}

export function subscribeImpersonate(fn: Listener): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

// Returns headers for the api client to merge in. Only `x-fpx-impersonate-write`
// is gated on the explicit writes opt-in.
export function impersonateHeaders(): Record<string, string> {
  const s = getImpersonate();
  if (!s) return {};
  const out: Record<string, string> = { "x-fpx-impersonate": s.target.id };
  if (s.writes) out["x-fpx-impersonate-write"] = "1";
  return out;
}
