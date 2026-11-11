import { useEffect, useState } from "react";
import { Mail, Check } from "lucide-react";
import { api, type ScrapeEmailPref } from "../lib/api";

// "Email me when a scrape finishes" — each person's own subscription
// (fpx_user_profiles.scrape_email). Sent by the hosted browser via Resend.
const OPTIONS: { value: ScrapeEmailPref; label: string }[] = [
  { value: "off", label: "Off" },
  { value: "all", label: "Every run" },
  { value: "failed", label: "Only failed runs" },
];

export function ScrapeEmailSubscription() {
  const [value, setValue] = useState<ScrapeEmailPref | null>(null);
  const [saved, setSaved] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => { api.me.preferences().then((r) => setValue(r.scrape_email || "off")).catch((e) => setErr((e as Error).message)); }, []);

  async function choose(v: ScrapeEmailPref) {
    const prev = value;
    setValue(v); setErr(null); setSaved(false);
    try { await api.me.setPreferences({ scrape_email: v }); setSaved(true); setTimeout(() => setSaved(false), 1800); }
    catch (e) { setValue(prev); setErr((e as Error).message); }
  }

  return (
    <div className="flex items-center gap-2 flex-wrap text-sm">
      <Mail className="h-4 w-4 text-violet-600" />
      <span className="text-slate-700">Email me when a scrape finishes</span>
      <div className="inline-flex rounded-lg ring-1 ring-slate-200 bg-white overflow-hidden" role="radiogroup" aria-label="Scrape email">
        {OPTIONS.map((o) => (
          <button key={o.value} type="button" role="radio" aria-checked={value === o.value} disabled={value == null} onClick={() => choose(o.value)}
            className={"text-xs px-2.5 py-1 font-medium border-r last:border-r-0 border-slate-200 disabled:opacity-50 " + (value === o.value ? "bg-violet-600 text-white" : "text-slate-600 hover:bg-slate-50")}>
            {o.label}
          </button>
        ))}
      </div>
      {saved ? <span className="text-xs text-emerald-700 inline-flex items-center gap-1"><Check className="h-3.5 w-3.5" /> Saved</span> : null}
      {err ? <span className="text-xs text-rose-700">{err}</span> : null}
    </div>
  );
}
