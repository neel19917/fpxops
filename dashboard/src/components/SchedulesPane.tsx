import { useState } from "react";
import { ModePicker, ALL_MODES, modesText } from "./ModePicker";
import { CalendarClock, CheckCircle2, Pencil, Play, Plus, Trash2, X, XCircle } from "lucide-react";
import { hostedBrowser, type ScheduleInput, type ScheduleJob, type ScheduleShipmentType, type ScrapeSchedule } from "../lib/hostedBrowser";
import { fmtRelative } from "../lib/format";

// Scheduled runs. Each schedule has a job: the tracking scrape (Refresh All),
// an ERP lookback, or a shipment details sweep. All run in the hosted browser
// with the owner's FreightPOP login; the service runs one tracking scrape at a
// time, and the other two jobs run in their own lane beside it.

const JOBS: { value: ScheduleJob; label: string; hint: string }[] = [
  { value: "tracking", label: "Tracking scrape", hint: "Runs Refresh All to update tracking for your shipments." },
  { value: "erp_lookback", label: "ERP lookback", hint: "Pulls FreightPOP's Transactions History Report for the last few months into FPX." },
  { value: "shipment_details", label: "Shipment details", hint: "Reads the Shipment Details page of every tracked shipment." },
];
const SHIPMENT_TYPES: { value: ScheduleShipmentType; label: string }[] = [
  { value: "non-parcel", label: "Non-parcel" },
  { value: "parcel", label: "Parcel" },
  { value: "both", label: "Both" },
];
const jobOf = (s: ScrapeSchedule): ScheduleJob => s.job || "tracking";
const clampMonths = (n: unknown) => Math.min(12, Math.max(1, Math.round(Number(n)) || 1));

// The chip beside a non-tracking schedule, e.g. "ERP lookback · 3 mo · Non-parcel".
function jobChip(s: ScrapeSchedule): string | null {
  const job = jobOf(s);
  if (job === "shipment_details") return "Shipment details";
  if (job !== "erp_lookback") return null;
  const type = SHIPMENT_TYPES.find((t) => t.value === (s.shipmentType || "non-parcel"))?.label || "Non-parcel";
  return `ERP lookback · ${clampMonths(s.months)} mo · ${type}`;
}

// " · N saved" / " · N rows" after a successful run, when the run reported it.
function lastRunSuffix(s: ScrapeSchedule): string {
  if (!s.lastRun?.ok || !s.lastRun.counts) return "";
  const counts = s.lastRun.counts as unknown as Record<string, unknown>;
  if (jobOf(s) === "erp_lookback") return typeof counts.uploaded === "number" ? ` · ${counts.uploaded.toLocaleString()} rows` : "";
  return typeof counts.saved === "number" ? ` · ${counts.saved} saved` : "";
}

const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const WEEKDAYS = [1, 2, 3, 4, 5];
const EVERY_DAY = [0, 1, 2, 3, 4, 5, 6];
const LOCAL_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone || "America/Los_Angeles";
const TZ_OPTIONS = Array.from(new Set([
  LOCAL_TZ, "America/Los_Angeles", "America/Denver", "America/Chicago", "America/New_York", "UTC",
]));

function fmtTime(hhmm: string) {
  const [h, m] = hhmm.split(":").map(Number);
  const ampm = h >= 12 ? "PM" : "AM";
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, "0")} ${ampm}`;
}

function fmtDays(days: number[]) {
  const key = [...days].sort().join(",");
  if (key === EVERY_DAY.join(",")) return "Every day";
  if (key === WEEKDAYS.join(",")) return "Weekdays";
  if (key === "0,6") return "Weekends";
  return [...days].sort().map((d) => DAY_LABELS[d]).join(", ");
}

function tzShort(tz: string) {
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "short" })
      .formatToParts(new Date()).find((p) => p.type === "timeZoneName")?.value || tz;
  } catch { return tz; }
}

function fmtNext(iso: string | null) {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" });
}

export function SchedulesPane({ schedules, me, isAdmin, onChanged }: {
  schedules: ScrapeSchedule[];
  me: string | undefined;
  isAdmin: boolean;
  onChanged: () => void;
}) {
  const [editing, setEditing] = useState<ScrapeSchedule | "new" | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ tone: "ok" | "err"; text: string } | null>(null);

  async function act(id: string, fn: () => Promise<unknown>, ok?: string) {
    setBusyId(id); setMsg(null);
    try { await fn(); if (ok) setMsg({ tone: "ok", text: ok }); onChanged(); }
    catch (e) { setMsg({ tone: "err", text: (e as Error).message }); }
    finally { setBusyId(null); }
  }

  async function runNow(s: ScrapeSchedule) {
    setBusyId(s.id); setMsg(null);
    try {
      const r = await hostedBrowser.runScheduleNow(s.id);
      if (!r.queued && !r.coalesced) throw new Error(`Not queued: ${r.reason}`);
      const text = jobOf(s) === "tracking"
        ? "Queued — it starts as soon as nothing else is scraping."
        : r.coalesced
          ? "Already queued or running in the hosted browser."
          : "Queued for the hosted browser.";
      setMsg({ tone: "ok", text });
      onChanged();
    } catch (e) { setMsg({ tone: "err", text: (e as Error).message }); }
    finally { setBusyId(null); }
  }

  const mine = schedules.filter((s) => s.owner === me);
  const others = schedules.filter((s) => s.owner !== me);

  return (
    <section className="rounded-2xl bg-white ring-1 ring-slate-200 shadow-sm p-5 space-y-3">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold text-slate-900 inline-flex items-center gap-2">
          <CalendarClock className="h-4 w-4 text-slate-500" /> Schedules
        </h2>
        {editing ? null : (
          <button onClick={() => setEditing("new")} className="text-xs px-2.5 py-1.5 rounded-lg ring-1 ring-slate-200 bg-white hover:bg-slate-50 inline-flex items-center gap-1">
            <Plus className="h-3.5 w-3.5" /> New schedule
          </button>
        )}
      </div>
      <p className="text-xs text-slate-500">
        Runs a job automatically, using your FreightPOP login: a tracking scrape (Refresh All), an ERP lookback, or a shipment details sweep.
        One tracking scrape runs at a time — if another is running, yours starts right after. The other two jobs run alongside it.
      </p>

      {msg ? (
        <div className={"text-xs rounded-lg px-3 py-2 ring-1 " + (msg.tone === "ok" ? "bg-emerald-50 ring-emerald-200 text-emerald-800" : "bg-rose-50 ring-rose-200 text-rose-800")}>{msg.text}</div>
      ) : null}

      {editing ? (
        <ScheduleEditor
          initial={editing === "new" ? null : editing}
          onCancel={() => setEditing(null)}
          onSaved={(text) => { setEditing(null); setMsg({ tone: "ok", text }); onChanged(); }}
        />
      ) : null}

      {mine.length === 0 && !editing ? (
        <div className="text-sm text-slate-500">No schedules yet.</div>
      ) : null}

      {[...mine, ...(isAdmin ? others : [])].length ? (
        <ul className="divide-y divide-slate-100">
          {[...mine, ...(isAdmin ? others : [])].map((s) => {
            const own = s.owner === me;
            const job = jobOf(s);
            const chip = jobChip(s);
            return (
              <li key={s.id} className="py-3 flex items-start gap-3">
                <button
                  onClick={() => act(s.id, () => hostedBrowser.updateSchedule(s.id, { enabled: !s.enabled }))}
                  disabled={busyId === s.id}
                  role="switch"
                  aria-checked={s.enabled}
                  title={s.enabled ? "On — click to pause" : "Paused — click to turn on"}
                  className={"mt-0.5 shrink-0 h-5 w-9 rounded-full transition relative " + (s.enabled ? "bg-violet-600" : "bg-slate-300")}
                >
                  <span className={"absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition " + (s.enabled ? "left-[18px]" : "left-0.5")} />
                </button>
                <div className="min-w-0 flex-1">
                  <div className="text-sm text-slate-900">
                    {s.name ? <span className="font-medium">{s.name} · </span> : null}
                    {fmtDays(s.days)} at {s.times.map(fmtTime).join(", ")} <span className="text-slate-500">({tzShort(s.tz)})</span>
                    {chip ? <span className="ml-1 text-[11px] px-1.5 py-0.5 rounded bg-sky-50 text-sky-700 ring-1 ring-sky-200">{chip}</span> : null}
                    {job === "tracking" && s.modes?.length ? <span className="ml-1 text-[11px] px-1.5 py-0.5 rounded bg-violet-50 text-violet-700 ring-1 ring-violet-200">{modesText(s.modes)}</span> : null}
                  </div>
                  <div className="text-xs text-slate-500 mt-0.5 flex flex-wrap gap-x-3">
                    {!own ? <span className="text-slate-700">{s.owner}</span> : null}
                    <span>{s.enabled ? <>Next: <span className="text-slate-700">{fmtNext(s.nextRunAt)}</span></> : "Paused"}</span>
                    {s.lastRun ? (
                      <span className={"inline-flex items-center gap-1 " + (s.lastRun.ok ? "text-emerald-700" : "text-rose-700")} title={s.lastRun.note}>
                        {s.lastRun.ok ? <CheckCircle2 className="h-3 w-3" /> : <XCircle className="h-3 w-3" />}
                        Last {s.lastRun.ok ? "ran" : "failed"} {fmtRelative(s.lastRun.finishedAt)}
                        {lastRunSuffix(s)}
                      </span>
                    ) : s.lastFired ? (
                      s.lastFired.queued
                        ? <span>Queued {fmtRelative(s.lastFired.at)}</span>
                        : <span className="text-rose-700">Not queued {fmtRelative(s.lastFired.at)}{s.lastFired.reason ? `: ${s.lastFired.reason}` : ""}</span>
                    ) : <span>Never run</span>}
                  </div>
                </div>
                <div className="shrink-0 flex items-center gap-1">
                  <IconBtn title="Run now" disabled={busyId === s.id}
                    onClick={() => runNow(s)}>
                    <Play className="h-3.5 w-3.5" />
                  </IconBtn>
                  {own || isAdmin ? (
                    <>
                      <IconBtn title="Edit" onClick={() => setEditing(s)}><Pencil className="h-3.5 w-3.5" /></IconBtn>
                      <IconBtn title="Delete" disabled={busyId === s.id}
                        onClick={() => { if (confirm("Delete this schedule?")) act(s.id, () => hostedBrowser.deleteSchedule(s.id), "Schedule deleted."); }}>
                        <Trash2 className="h-3.5 w-3.5" />
                      </IconBtn>
                    </>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      ) : null}
    </section>
  );
}

function IconBtn({ title, onClick, disabled, children }: { title: string; onClick: () => void; disabled?: boolean; children: React.ReactNode }) {
  return (
    <button onClick={onClick} disabled={disabled} title={title} aria-label={title}
      className="p-1.5 rounded-md text-slate-500 hover:text-slate-900 hover:bg-slate-100 disabled:opacity-40">
      {children}
    </button>
  );
}

function ScheduleEditor({ initial, onCancel, onSaved }: {
  initial: ScrapeSchedule | null;
  onCancel: () => void;
  onSaved: (msg: string) => void;
}) {
  const [name, setName] = useState(initial?.name || "");
  const [days, setDays] = useState<number[]>(initial?.days || WEEKDAYS);
  const [times, setTimes] = useState<string[]>(initial?.times || ["07:00"]);
  const [tz, setTz] = useState(initial?.tz || LOCAL_TZ);
  const [modes, setModes] = useState<string[]>(initial?.modes?.length ? initial.modes : ALL_MODES);
  const [job, setJob] = useState<ScheduleJob>(initial ? jobOf(initial) : "tracking");
  const [months, setMonths] = useState<number>(clampMonths(initial?.months));
  const [shipmentType, setShipmentType] = useState<ScheduleShipmentType>(initial?.shipmentType || "non-parcel");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const toggleDay = (d: number) => setDays((cur) => cur.includes(d) ? cur.filter((x) => x !== d) : [...cur, d].sort());

  async function save() {
    setSaving(true); setErr(null);
    const input: ScheduleInput = {
      name: name.trim(), days, times: times.filter(Boolean), tz, job,
      modes: job === "tracking" && modes.length !== ALL_MODES.length ? modes : null,
      ...(job === "erp_lookback" ? { months: clampMonths(months), shipmentType } : {}),
    };
    try {
      if (initial) await hostedBrowser.updateSchedule(initial.id, input);
      else await hostedBrowser.createSchedule(input);
      onSaved(initial ? "Schedule updated." : "Schedule created.");
    } catch (e) { setErr((e as Error).message); }
    finally { setSaving(false); }
  }

  const tzOptions = TZ_OPTIONS.includes(tz) ? TZ_OPTIONS : [tz, ...TZ_OPTIONS];

  return (
    <div className="rounded-xl bg-slate-50 ring-1 ring-slate-200 p-4 space-y-3">
      <div>
        <label className="text-[11px] uppercase font-semibold text-slate-500">Job</label>
        <div className="mt-1 flex flex-wrap gap-1" role="radiogroup" aria-label="Job">
          {JOBS.map((j) => (
            <button key={j.value} onClick={() => setJob(j.value)} role="radio" aria-checked={job === j.value}
              className={"text-xs px-2.5 py-1 rounded-md ring-1 " + (job === j.value ? "bg-violet-600 text-white ring-violet-600" : "bg-white text-slate-600 ring-slate-200 hover:bg-slate-50")}>
              {j.label}
            </button>
          ))}
        </div>
        <p className="mt-1 text-xs text-slate-500">{JOBS.find((j) => j.value === job)?.hint}</p>
      </div>

      <div>
        <label className="text-[11px] uppercase font-semibold text-slate-500">Name (optional)</label>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Morning refresh" maxLength={80}
          className="mt-1 w-full text-sm px-2 py-1.5 rounded border border-slate-200 bg-white" />
      </div>

      <div>
        <div className="flex items-center gap-2">
          <label className="text-[11px] uppercase font-semibold text-slate-500">Days</label>
          <button onClick={() => setDays(EVERY_DAY)} className="text-[11px] text-violet-700 hover:underline">Every day</button>
          <button onClick={() => setDays(WEEKDAYS)} className="text-[11px] text-violet-700 hover:underline">Weekdays</button>
        </div>
        <div className="mt-1 flex flex-wrap gap-1">
          {DAY_LABELS.map((l, d) => (
            <button key={d} onClick={() => toggleDay(d)} aria-pressed={days.includes(d)}
              className={"text-xs w-11 py-1 rounded-md ring-1 " + (days.includes(d) ? "bg-violet-600 text-white ring-violet-600" : "bg-white text-slate-600 ring-slate-200 hover:bg-slate-50")}>
              {l}
            </button>
          ))}
        </div>
      </div>

      <div>
        <label className="text-[11px] uppercase font-semibold text-slate-500">Times</label>
        <div className="mt-1 flex flex-wrap items-center gap-2">
          {times.map((t, i) => (
            <span key={i} className="inline-flex items-center gap-1">
              <input type="time" value={t} step={60}
                onChange={(e) => setTimes((cur) => cur.map((x, j) => (j === i ? e.target.value : x)))}
                className="text-sm px-2 py-1 rounded border border-slate-200 bg-white" />
              {times.length > 1 ? (
                <button onClick={() => setTimes((cur) => cur.filter((_, j) => j !== i))} className="p-1 text-slate-400 hover:text-slate-700" aria-label="Remove time">
                  <X className="h-3.5 w-3.5" />
                </button>
              ) : null}
            </span>
          ))}
          {times.length < 12 ? (
            <button onClick={() => setTimes((cur) => [...cur, "13:00"])} className="text-xs text-violet-700 hover:underline inline-flex items-center gap-1">
              <Plus className="h-3 w-3" /> Add time
            </button>
          ) : null}
        </div>
      </div>

      {job === "tracking" ? (
        <div>
          <label className="text-[11px] uppercase font-semibold text-slate-500">Shipment modes</label>
          <div className="mt-1 flex items-center gap-2">
            <ModePicker value={modes} onChange={setModes} size="sm" />
            <span className="text-xs text-slate-500">{modes.length === ALL_MODES.length ? "Every mode" : `Only ${modesText(modes)}`}</span>
          </div>
        </div>
      ) : null}

      {job === "erp_lookback" ? (
        <div className="flex flex-wrap gap-4">
          <div>
            <label className="text-[11px] uppercase font-semibold text-slate-500">Months back</label>
            <select value={months} onChange={(e) => setMonths(clampMonths(e.target.value))} className="mt-1 block text-sm px-2 py-1.5 rounded border border-slate-200 bg-white">
              {Array.from({ length: 12 }, (_, i) => i + 1).map((n) => (
                <option key={n} value={n}>{n === 1 ? "Last month" : `Last ${n} months`}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="text-[11px] uppercase font-semibold text-slate-500">Shipment type</label>
            <select value={shipmentType} onChange={(e) => setShipmentType(e.target.value as ScheduleShipmentType)} className="mt-1 block text-sm px-2 py-1.5 rounded border border-slate-200 bg-white">
              {SHIPMENT_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
            </select>
          </div>
        </div>
      ) : null}

      <div>
        <label className="text-[11px] uppercase font-semibold text-slate-500">Time zone</label>
        <select value={tz} onChange={(e) => setTz(e.target.value)} className="mt-1 block text-sm px-2 py-1.5 rounded border border-slate-200 bg-white">
          {tzOptions.map((z) => <option key={z} value={z}>{z} ({tzShort(z)})</option>)}
        </select>
      </div>

      {err ? <div className="text-xs text-rose-700">{err}</div> : null}
      <div className="flex justify-end gap-2">
        <button onClick={onCancel} className="text-sm px-3 py-1.5 rounded-lg text-slate-600 hover:bg-slate-100">Cancel</button>
        <button onClick={save} disabled={saving || !days.length || !times.filter(Boolean).length}
          className="text-sm px-3 py-1.5 rounded-lg bg-violet-600 text-white hover:bg-violet-700 disabled:opacity-40">
          {saving ? "Saving…" : initial ? "Save" : "Create schedule"}
        </button>
      </div>
    </div>
  );
}
