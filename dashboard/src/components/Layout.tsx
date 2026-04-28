import { Package, Sparkles, TrendingUp, ReceiptText, KeyRound, LogOut, Users, Link2, ListChecks, MessageSquare, ScrollText, Settings as SettingsIcon, ShieldAlert, AlertTriangle } from "lucide-react";
import { useState, type ReactNode } from "react";
import { useAuth } from "../lib/auth";
import { setImpersonate } from "../lib/impersonate";
import { api } from "../lib/api";
import { ImpersonateModal } from "./ImpersonateModal";

export type TabId = "tracking" | "tasks" | "analyses" | "gp" | "invoice" | "keys" | "users" | "shares" | "feedback" | "audit" | "settings";

interface TabDef { id: TabId; label: string; Icon: typeof Package; adminOnly?: boolean }

const ALL_TABS: TabDef[] = [
  { id: "tracking", label: "Tracking", Icon: Package },
  { id: "tasks",    label: "Tasks", Icon: ListChecks },
  { id: "analyses", label: "AI Analyses", Icon: Sparkles },
  { id: "gp",       label: "GP Audits", Icon: TrendingUp },
  { id: "invoice",  label: "Invoice Audits", Icon: ReceiptText },
  { id: "shares",   label: "Share Links", Icon: Link2 },
  { id: "feedback", label: "Feedback", Icon: MessageSquare },
  { id: "users",    label: "Users", Icon: Users, adminOnly: true },
  { id: "keys",     label: "API Keys", Icon: KeyRound, adminOnly: true },
  { id: "audit",    label: "Audit", Icon: ScrollText, adminOnly: true },
  { id: "settings", label: "Settings", Icon: SettingsIcon, adminOnly: true },
];

interface Props {
  tab: TabId;
  onTab: (t: TabId) => void;
  children: ReactNode;
}

export function Layout({ tab, onTab, children }: Props) {
  const { profile, realProfile, impersonate, stopImpersonate, signOut } = useAuth();
  const isAdmin = profile?.role === "admin";
  const isRealAdmin = realProfile?.role === "admin";
  const tabs = ALL_TABS.filter((t) => !t.adminOnly || isAdmin);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [writePromptOpen, setWritePromptOpen] = useState(false);

  async function enableWrites() {
    if (!impersonate) return;
    try { await api.impersonate.toggleWrites(impersonate.target.id, true); }
    catch (e) { console.warn("[FPX] toggleWrites audit log failed:", (e as Error).message); }
    setImpersonate({ ...impersonate, writes: true });
    setWritePromptOpen(false);
  }
  async function disableWrites() {
    if (!impersonate) return;
    try { await api.impersonate.toggleWrites(impersonate.target.id, false); }
    catch (e) { console.warn("[FPX] toggleWrites audit log failed:", (e as Error).message); }
    setImpersonate({ ...impersonate, writes: false });
  }
  async function stopImpersonateWithLog() {
    const snapshot = impersonate;
    stopImpersonate(); // clear localStorage first so the audit call is attributed to the real admin
    if (snapshot) {
      try { await api.impersonate.stop(snapshot.target.id, snapshot.writes); }
      catch (e) { console.warn("[FPX] impersonate-stop audit log failed:", (e as Error).message); }
    }
  }

  return (
    <div className="min-h-full flex flex-col">
      <header className="bg-white border-b border-slate-200 sticky top-0 z-10">
        <div className="max-w-[1500px] mx-auto px-6 py-3 flex items-center gap-6 flex-wrap">
          <div className="flex items-center gap-2.5">
            <div className="h-8 w-8 rounded-lg bg-gradient-to-br from-sky-500 to-blue-600 flex items-center justify-center shadow-sm">
              <Package className="h-[18px] w-[18px] text-white" />
            </div>
            <div>
              <div className="text-sm font-semibold leading-tight">FPXpress</div>
              <div className="text-[11px] text-slate-500 leading-tight">Shipment intelligence</div>
            </div>
          </div>
          <nav className="flex gap-1 ml-4 flex-wrap">
            {tabs.map(({ id, label, Icon }) => (
              <button
                key={id}
                onClick={() => onTab(id)}
                className={
                  "px-3 py-1.5 rounded-lg text-sm font-medium flex items-center gap-1.5 transition " +
                  (tab === id
                    ? "bg-sky-50 text-sky-700 ring-1 ring-sky-200"
                    : "text-slate-600 hover:text-slate-900 hover:bg-slate-100")
                }
              >
                <Icon className="h-4 w-4" />
                {label}
              </button>
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-3">
            {profile ? (
              <div className="flex items-center gap-2">
                {profile.avatarUrl ? (
                  <img src={profile.avatarUrl} alt="" className="h-8 w-8 rounded-full" />
                ) : (
                  <div className="h-8 w-8 rounded-full bg-slate-200 flex items-center justify-center text-xs font-medium text-slate-600">
                    {(profile.fullName || profile.email).slice(0, 2).toUpperCase()}
                  </div>
                )}
                <div className="text-xs leading-tight">
                  <div className="font-medium text-slate-900">{profile.fullName || profile.email.split("@")[0]}</div>
                  <div className="text-slate-500">{profile.role}</div>
                </div>
              </div>
            ) : null}
            {isRealAdmin && !impersonate ? (
              <button
                onClick={() => setPickerOpen(true)}
                className="text-sm text-slate-600 hover:text-slate-900 flex items-center gap-1 px-2 py-1 rounded-lg hover:bg-slate-100"
                title="View the dashboard as another user"
              >
                <ShieldAlert className="h-4 w-4" /> View as
              </button>
            ) : null}
            <button
              onClick={signOut}
              className="text-sm text-slate-500 hover:text-slate-900 flex items-center gap-1"
              title="Sign out"
            >
              <LogOut className="h-4 w-4" /> Sign out
            </button>
          </div>
        </div>
      </header>

      {impersonate ? (
        <div className={
          "border-b px-6 py-2 flex flex-wrap items-center gap-3 text-sm " +
          (impersonate.writes
            ? "bg-rose-50 border-rose-200 text-rose-900"
            : "bg-amber-50 border-amber-200 text-amber-900")
        }>
          {impersonate.writes
            ? <AlertTriangle className="h-4 w-4 text-rose-600" />
            : <ShieldAlert className="h-4 w-4 text-amber-600" />}
          <div>
            Viewing as <strong>{impersonate.target.full_name || impersonate.target.email}</strong>
            <span className="ml-2 text-[11px] uppercase tracking-wide font-semibold">
              {impersonate.target.role} · {impersonate.writes ? "writes enabled" : "reads only"}
            </span>
          </div>
          <div className="ml-auto flex items-center gap-2">
            {impersonate.writes ? (
              <button onClick={disableWrites} className="text-xs px-2.5 py-1 rounded-md bg-white ring-1 ring-rose-200 text-rose-800 hover:bg-rose-100">
                Disable writes
              </button>
            ) : (
              <button onClick={() => setWritePromptOpen(true)} className="text-xs px-2.5 py-1 rounded-md bg-white ring-1 ring-amber-200 text-amber-900 hover:bg-amber-100">
                Enable writes…
              </button>
            )}
            <button onClick={stopImpersonateWithLog} className="text-xs px-2.5 py-1 rounded-md bg-slate-900 text-white hover:bg-slate-800">
              Stop impersonating
            </button>
          </div>
        </div>
      ) : null}

      <main className="flex-1 max-w-[1500px] w-full mx-auto p-6">{children}</main>

      {pickerOpen ? <ImpersonateModal onClose={() => setPickerOpen(false)} /> : null}

      {writePromptOpen && impersonate ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 backdrop-blur-sm"
          onClick={() => setWritePromptOpen(false)}
        >
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md p-6" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-base font-semibold flex items-center gap-2 text-rose-700">
              <AlertTriangle className="h-5 w-5" />
              Enable write impersonation?
            </h3>
            <p className="text-sm text-slate-700 mt-2">
              You'll be able to perform <strong>full action permissions</strong> as
              <strong> {impersonate.target.email}</strong> — overrides, deletes, task assignment,
              setting changes. Every action stays attributed to you in the audit log, with their
              email recorded as the impersonated identity.
            </p>
            <p className="text-xs text-slate-500 mt-2">You can disable writes again from the banner at any time.</p>
            <div className="mt-5 flex justify-end gap-2">
              <button onClick={() => setWritePromptOpen(false)} className="px-4 py-2 text-sm rounded-lg text-slate-600 hover:bg-slate-100">Cancel</button>
              <button onClick={enableWrites} className="px-4 py-2 text-sm rounded-lg bg-rose-600 text-white hover:bg-rose-700">
                I understand — enable writes
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
