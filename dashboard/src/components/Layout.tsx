import { Package, Sparkles, TrendingUp, ReceiptText, KeyRound, LogOut, Users, Link2 } from "lucide-react";
import type { ReactNode } from "react";
import { useAuth } from "../lib/auth";

export type TabId = "shipments" | "analyses" | "gp" | "invoice" | "keys" | "users" | "shares";

interface TabDef { id: TabId; label: string; Icon: typeof Package; adminOnly?: boolean }

const ALL_TABS: TabDef[] = [
  { id: "shipments", label: "Shipments", Icon: Package },
  { id: "analyses",  label: "AI Analyses", Icon: Sparkles },
  { id: "gp",        label: "GP Audits", Icon: TrendingUp },
  { id: "invoice",   label: "Invoice Audits", Icon: ReceiptText },
  { id: "shares",    label: "Share Links", Icon: Link2 },
  { id: "users",     label: "Users", Icon: Users, adminOnly: true },
  { id: "keys",      label: "API Keys", Icon: KeyRound, adminOnly: true },
];

interface Props {
  tab: TabId;
  onTab: (t: TabId) => void;
  children: ReactNode;
}

export function Layout({ tab, onTab, children }: Props) {
  const { profile, signOut } = useAuth();
  const isAdmin = profile?.role === "admin";
  const tabs = ALL_TABS.filter((t) => !t.adminOnly || isAdmin);

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
      <main className="flex-1 max-w-[1500px] w-full mx-auto p-6">{children}</main>
    </div>
  );
}
