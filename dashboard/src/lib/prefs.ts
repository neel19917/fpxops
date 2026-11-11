import { useEffect, useState } from "react";
import { api } from "./api";

// The signed-in user's own FPX preferences, loaded once and shared by every
// component (the FreightPOP pane reads it on each lookup).
let autoOpen = true;
let loaded: Promise<void> | null = null;
const subs = new Set<(v: boolean) => void>();

function load() {
  if (!loaded) {
    loaded = api.me.preferences()
      .then((r) => { autoOpen = r.auto_open_tracking !== false; subs.forEach((f) => f(autoOpen)); })
      .catch(() => { loaded = null; });
  }
  return loaded;
}

export function getAutoOpenTracking() { return autoOpen; }

export async function setAutoOpenTracking(v: boolean) {
  const prev = autoOpen;
  autoOpen = v; subs.forEach((f) => f(v));
  try {
    const r = await api.me.setPreferences({ auto_open_tracking: v });
    autoOpen = r.auto_open_tracking; subs.forEach((f) => f(autoOpen));
  } catch (e) {
    autoOpen = prev; subs.forEach((f) => f(prev));
    throw e;
  }
}

// Re-read after an admin changes it on the Users page.
export function reloadPreferences() { loaded = null; return load(); }

export function useAutoOpenTracking(): boolean {
  const [v, setV] = useState(autoOpen);
  useEffect(() => {
    subs.add(setV);
    load();
    setV(autoOpen);
    return () => { subs.delete(setV); };
  }, []);
  return v;
}
