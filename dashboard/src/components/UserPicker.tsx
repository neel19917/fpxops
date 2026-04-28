import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, X } from "lucide-react";
import { api } from "../lib/api";
import type { UserProfileRow } from "../lib/types";

// Module-level cache so opening the picker on multiple pages doesn't
// re-fetch the user list each time. Lives until full reload.
let userCache: Promise<UserProfileRow[]> | null = null;
function loadUsers(): Promise<UserProfileRow[]> {
  if (!userCache) {
    userCache = api.users
      .list()
      .then((r) => r.data.filter((u) => u.enabled !== false))
      .catch((e) => { userCache = null; throw e; });
  }
  return userCache;
}

function labelFor(u: UserProfileRow) {
  return u.full_name?.trim() ? `${u.full_name} <${u.email}>` : u.email;
}

interface UserPickerProps {
  value: string | null;
  onChange: (next: string | null) => void;
  placeholder?: string;
  className?: string;
  // When true, free-text values are kept as-is (good for legacy free-text
  // assignees that aren't in the user table). When false, only entries from
  // the user list can be picked.
  allowFreeText?: boolean;
  autoFocus?: boolean;
  size?: "sm" | "md";
}

export function UserPicker({
  value,
  onChange,
  placeholder = "Assign to…",
  className = "",
  allowFreeText = true,
  autoFocus = false,
  size = "md",
}: UserPickerProps) {
  const [users, setUsers] = useState<UserProfileRow[]>([]);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState(value || "");
  const [activeIdx, setActiveIdx] = useState(0);
  const wrapRef = useRef<HTMLDivElement>(null);

  // Keep input synced with parent value when it changes externally.
  useEffect(() => { setQuery(value || ""); }, [value]);

  useEffect(() => {
    let cancelled = false;
    loadUsers().then((list) => { if (!cancelled) setUsers(list); }).catch(() => {});
    return () => { cancelled = true; };
  }, []);

  // Close on outside click.
  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    }
    if (open) document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return users.slice(0, 8);
    return users
      .filter((u) =>
        u.email.toLowerCase().includes(q) ||
        (u.full_name || "").toLowerCase().includes(q),
      )
      .slice(0, 8);
  }, [users, query]);

  function pick(u: UserProfileRow) {
    onChange(u.email);
    setQuery(u.email);
    setOpen(false);
  }

  function commitFreeText() {
    const v = query.trim();
    if (!v) { onChange(null); return; }
    // Exact match against email/full name? prefer the user record.
    const hit = users.find((u) =>
      u.email.toLowerCase() === v.toLowerCase() ||
      (u.full_name || "").toLowerCase() === v.toLowerCase(),
    );
    if (hit) { onChange(hit.email); return; }
    if (allowFreeText) onChange(v);
  }

  const sizing = size === "sm"
    ? "px-2.5 py-1.5 text-sm"
    : "px-3 py-2 text-sm";

  return (
    <div ref={wrapRef} className={`relative ${className}`}>
      <div className={`flex items-center rounded-lg border border-slate-200 bg-white focus-within:ring-2 focus-within:ring-sky-300 focus-within:border-sky-300 ${sizing}`}>
        <input
          autoFocus={autoFocus}
          value={query}
          onChange={(e) => { setQuery(e.target.value); setOpen(true); setActiveIdx(0); }}
          onFocus={() => setOpen(true)}
          onClick={(e) => e.stopPropagation()}
          onBlur={() => { setTimeout(() => commitFreeText(), 80); }}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "ArrowDown") { e.preventDefault(); setOpen(true); setActiveIdx((i) => Math.min(i + 1, Math.max(filtered.length - 1, 0))); }
            else if (e.key === "ArrowUp") { e.preventDefault(); setActiveIdx((i) => Math.max(i - 1, 0)); }
            else if (e.key === "Enter") {
              e.preventDefault();
              if (open && filtered[activeIdx]) pick(filtered[activeIdx]);
              else { commitFreeText(); setOpen(false); }
            } else if (e.key === "Escape") { setOpen(false); }
          }}
          placeholder={placeholder}
          className="flex-1 bg-transparent outline-none placeholder:text-slate-400"
        />
        {query ? (
          <button
            type="button"
            onClick={() => { setQuery(""); onChange(null); setOpen(true); }}
            className="p-0.5 text-slate-400 hover:text-slate-700"
            title="Clear"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        ) : null}
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="p-0.5 text-slate-400 hover:text-slate-700 ml-1"
          title="Show users"
        >
          <ChevronDown className="h-3.5 w-3.5" />
        </button>
      </div>

      {open ? (
        <div className="absolute z-30 mt-1 w-full rounded-lg border border-slate-200 bg-white shadow-lg max-h-64 overflow-y-auto">
          {filtered.length === 0 ? (
            <div className="px-3 py-2 text-xs text-slate-400">
              {users.length === 0 ? "Loading users…" : (allowFreeText ? "No match — press Enter to use anyway" : "No matching user")}
            </div>
          ) : filtered.map((u, i) => (
            <button
              key={u.id}
              type="button"
              onMouseDown={(e) => { e.preventDefault(); pick(u); }}
              onMouseEnter={() => setActiveIdx(i)}
              className={"w-full text-left px-3 py-1.5 text-sm flex items-center gap-2 " + (i === activeIdx ? "bg-sky-50" : "hover:bg-slate-50")}
            >
              <div className="h-6 w-6 rounded-full bg-sky-100 text-sky-700 text-[11px] font-semibold flex items-center justify-center shrink-0">
                {(u.full_name || u.email).slice(0, 1).toUpperCase()}
              </div>
              <div className="min-w-0">
                <div className="truncate text-slate-900">{u.full_name || u.email}</div>
                {u.full_name ? <div className="truncate text-[11px] text-slate-500">{u.email}</div> : null}
              </div>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

// Helper for callers that just want to render the canonical display name
// for an assignee email. Returns the email if no match yet (e.g. before the
// user list has loaded).
export function useUserDisplay(value: string | null): string {
  const [users, setUsers] = useState<UserProfileRow[]>([]);
  useEffect(() => {
    let cancelled = false;
    loadUsers().then((list) => { if (!cancelled) setUsers(list); }).catch(() => {});
    return () => { cancelled = true; };
  }, []);
  if (!value) return "";
  const hit = users.find((u) => u.email.toLowerCase() === value.toLowerCase());
  return hit ? labelFor(hit) : value;
}
