import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, CheckCircle2, MonitorPlay, RefreshCw, RotateCcw } from "lucide-react";
import { hostedBrowser, type BrowserSetting, type BrowserSettingsResponse } from "../lib/hostedBrowser";
import { fmtNum, fmtRelative } from "../lib/format";

// Admin: tune the hosted FreightPOP browser — live-view quality, idle limits,
// capacity — without a redeploy. Saved to fpx_settings ("browser.*"); the
// service picks changes up within ~30s and re-applies them to open views.

// Railway usage rates, for the rough cost readout (see browser-service/cost-log.md).
const EGRESS_PER_GB = 0.05;
const RAM_PER_GB_HOUR = 10 / 730;

const GROUPS: { title: string; hint: string; keys: string[] }[] = [
  {
    title: "Live view (cost)",
    hint: "Most of the Railway bill is the picture data sent to open FreightPOP views. These trade sharpness/smoothness for cost.",
    keys: ["browser.stream_quality", "browser.stream_every_nth_frame", "browser.view_idle_min"],
  },
  {
    title: "Capacity",
    hint: "How many people and views can run at once. Each browser uses ~340 MB of memory on Railway.",
    keys: ["browser.max_browsers", "browser.max_tabs_per_user", "browser.max_sessions", "browser.idle_close_min"],
  },
  {
    title: "Scraping",
    hint: "",
    keys: ["browser.scrape_page_size", "browser.scrape_poll_seconds"],
  },
];

export function HostedBrowserSettingsPage() {
  const [data, setData] = useState<BrowserSettingsResponse | null>(null);
  const [draft, setDraft] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ tone: "ok" | "err"; text: string } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await hostedBrowser.adminSettings();
      setData(r);
      setDraft(Object.fromEntries(r.settings.map((s) => [s.key, s.value])));
    } catch (e) { setMsg({ tone: "err", text: (e as Error).message }); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  // Refresh just the live numbers every 15s without touching the draft.
  useEffect(() => {
    const id = setInterval(() => {
      hostedBrowser.adminSettings().then((r) => setData((d) => (d ? { ...d, live: r.live } : r))).catch(() => {});
    }, 15_000);
    return () => clearInterval(id);
  }, []);

  const byKey = useMemo(() => new Map((data?.settings || []).map((s) => [s.key, s])), [data]);
  const dirty = (data?.settings || []).filter((s) => draft[s.key] !== s.value);

  async function save() {
    setSaving(true); setMsg(null);
    try {
      const patch = Object.fromEntries(dirty.map((s) => [s.key, draft[s.key]]));
      const r = await hostedBrowser.saveAdminSettings(patch);
      setData((d) => ({ ...(d || r), settings: r.settings }));
      setDraft(Object.fromEntries(r.settings.map((s) => [s.key, s.value])));
      setMsg({ tone: "ok", text: `Saved ${dirty.length} change${dirty.length === 1 ? "" : "s"} — applied to open views within ~30 seconds.` });
    } catch (e) { setMsg({ tone: "err", text: (e as Error).message }); }
    finally { setSaving(false); }
  }

  const live = data?.live;
  const costPerHour = live ? (live.egress.mbLastHour / 1000) * EGRESS_PER_GB + (live.memoryMb / 1024) * RAM_PER_GB_HOUR : null;

  if (!hostedBrowser.enabled) {
    return <div className="text-sm text-slate-500">This dashboard isn't connected to a hosted browser (VITE_FPX_BROWSER_URL).</div>;
  }

  return (
    <div className="space-y-5 max-w-3xl">
      <div className="flex items-end justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-xl font-semibold flex items-center gap-2">
            <MonitorPlay className="h-5 w-5 text-violet-600" /> Hosted browser
          </h1>
          <p className="text-sm text-slate-500 mt-0.5">Adjust the FreightPOP live views, capacity and cost. Changes apply within ~30 seconds, no redeploy.</p>
        </div>
        <button onClick={load} disabled={loading}
          className="text-sm text-slate-600 hover:text-slate-900 inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg ring-1 ring-slate-200 bg-white hover:bg-slate-50 disabled:opacity-50">
          <RefreshCw className={"h-4 w-4 " + (loading ? "animate-spin" : "")} /> Refresh
        </button>
      </div>

      {msg ? (
        <div className={"rounded-xl p-3 text-sm flex items-center gap-2 ring-1 " + (msg.tone === "ok" ? "bg-emerald-50 ring-emerald-200 text-emerald-800" : "bg-rose-50 ring-rose-200 text-rose-800")}>
          {msg.tone === "ok" ? <CheckCircle2 className="h-4 w-4" /> : <AlertTriangle className="h-4 w-4" />} {msg.text}
        </div>
      ) : null}

      {live ? (
        <section className="rounded-2xl bg-white ring-1 ring-slate-200 shadow-sm p-5 grid grid-cols-2 sm:grid-cols-4 gap-4">
          <LiveStat label="Open views" value={fmtNum(live.sessions)} />
          <LiveStat label="Browsers running" value={fmtNum(live.browsers)} sub={`${fmtNum(live.memoryMb)} MB`} />
          <LiveStat label="View data, last hour" value={`${fmtNum(live.egress.mbLastHour)} MB`} sub={`${fmtNum(live.egress.mbLast5Min)} MB in last 5 min`} />
          <LiveStat label="Est. cost right now" value={costPerHour != null ? `$${costPerHour.toFixed(3)}/h` : "—"} sub={costPerHour != null ? `≈ $${(costPerHour * 220).toFixed(0)}/mo at 10h × 22 workdays` : ""} />
        </section>
      ) : null}

      {GROUPS.map((g) => (
        <section key={g.title} className="rounded-2xl bg-white ring-1 ring-slate-200 shadow-sm p-5 space-y-4">
          <div>
            <h2 className="text-sm font-semibold text-slate-900">{g.title}</h2>
            {g.hint ? <p className="text-xs text-slate-500 mt-0.5">{g.hint}</p> : null}
          </div>
          {g.keys.map((k) => byKey.get(k)).filter(Boolean).map((s) => (
            <SettingRow key={s!.key} s={s!} value={draft[s!.key] ?? s!.value} onChange={(v) => setDraft((d) => ({ ...d, [s!.key]: v }))} />
          ))}
        </section>
      ))}

      <div className="sticky bottom-4 flex items-center justify-end gap-2">
        {dirty.length ? (
          <button onClick={() => setDraft(Object.fromEntries((data?.settings || []).map((s) => [s.key, s.value])))}
            className="text-sm px-3 py-2 rounded-lg bg-white ring-1 ring-slate-200 hover:bg-slate-50 inline-flex items-center gap-1">
            <RotateCcw className="h-4 w-4" /> Discard
          </button>
        ) : null}
        <button onClick={save} disabled={!dirty.length || saving}
          className="text-sm px-4 py-2 rounded-lg bg-violet-600 text-white hover:bg-violet-700 disabled:opacity-40 shadow">
          {saving ? "Saving…" : dirty.length ? `Save ${dirty.length} change${dirty.length === 1 ? "" : "s"}` : "No changes"}
        </button>
      </div>
    </div>
  );
}

function LiveStat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div>
      <div className="text-xs text-slate-500">{label}</div>
      <div className="text-lg font-semibold text-slate-900 tabular-nums">{value}</div>
      {sub ? <div className="text-[11px] text-slate-500">{sub}</div> : null}
    </div>
  );
}

function SettingRow({ s, value, onChange }: { s: BrowserSetting; value: number; onChange: (v: number) => void }) {
  const changed = value !== s.value;
  const fmt = (v: number) => (s.key === "browser.view_idle_min" && v === 0 ? "Never" : `${v}${s.unit ? ` ${s.unit}` : ""}`);
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-3">
        <label htmlFor={s.key} className="text-sm font-medium text-slate-800">{s.label}</label>
        <div className="flex items-center gap-2">
          <input type="number" min={s.min} max={s.max} step={s.step} value={value}
            onChange={(e) => onChange(Number(e.target.value))}
            className={"w-20 text-sm text-right px-2 py-1 rounded border tabular-nums " + (changed ? "border-violet-400 bg-violet-50" : "border-slate-200")} />
          <span className="text-xs text-slate-500 w-16">{s.key === "browser.view_idle_min" && value === 0 ? "never" : s.unit}</span>
        </div>
      </div>
      <input id={s.key} type="range" min={s.min} max={s.max} step={s.step} value={value} onChange={(e) => onChange(Number(e.target.value))}
        className="w-full accent-violet-600" />
      <div className="flex items-start justify-between gap-3 text-[11px] text-slate-500">
        <span>{s.help}</span>
        <span className="shrink-0 text-right">
          {changed ? <span className="text-violet-700">was {fmt(s.value)}</span> : value === s.default ? "default" : <>default {fmt(s.default)}</>}
          {s.updated_by && !changed ? <span className="block">set by {s.updated_by.split("@")[0]} {s.updated_at ? fmtRelative(s.updated_at) : ""}</span> : null}
        </span>
      </div>
    </div>
  );
}
