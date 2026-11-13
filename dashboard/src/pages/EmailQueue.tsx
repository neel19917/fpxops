// Email Studio (rep-facing). Two tabs:
//   Queue   — tasks marked "to email" (hotkey E in the task drawer, or
//             "Queue for email" on the Tasks board), grouped by carrier or
//             customer, ready to draft as one email per recipient.
//   History — every group email drafted, with the shipments it covered.
// The AI prompts behind the emails are edited on the admin "Email prompts" page.
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { ChevronDown, ChevronRight, Copy, ExternalLink, History, Inbox, Layers, Mail, PanelRightOpen, RefreshCw, Search, Settings2, Sparkles, Trash2, X } from "lucide-react";
import { api, type GroupEmailRecord } from "../lib/api";
import type { TaskBoardRow } from "../lib/types";
import { fmtRelative } from "../lib/format";
import { useAuth } from "../lib/auth";
import { ErrorBlock } from "../components/ErrorBlock";
import { LoadingState } from "../components/LoadingState";
import { GroupEmailComposer, type EmailAudience } from "../components/tasksV2/GroupEmailComposer";
import { BlockedTabsDialog, isActive, openTasksInTabs, shortTitle, SLOW_TABS } from "../components/tasksV2/shared";
import { DedupeDialog } from "../components/tasksV2/DedupeDialog";

const nameFor = (r: TaskBoardRow, by: EmailAudience) =>
  (by === "carrier" ? (r.shipment?.carrier_name || r.shipment?.carrier || "") : (r.shipment?.customer_name || "")).trim();
const ageDays = (iso: string) => Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 86_400_000));

// Who a task is written for, read from its title prefix. Anything else is
// "none" and is never collapsed.
const titleAudience = (title: string): EmailAudience | null => {
  const m = /^\s*(carrier|customer) followup:/i.exec(title || "");
  return m ? (m[1].toLowerCase() as EmailAudience) : null;
};
const isNewer = (a: TaskBoardRow, b: TaskBoardRow) => {
  const d = (Date.parse(a.task.created_at) || 0) - (Date.parse(b.task.created_at) || 0);
  return d ? d > 0 : a.task.id > b.task.id;
};
// When one shipment has several queued tasks for the same audience, the newest
// one wins. `rows` keeps the incoming order with the older ones taken out;
// `older` maps each surviving task id to the tasks it stands in for (newest first).
function collapseNewest(rows: TaskBoardRow[]): { rows: TaskBoardRow[]; older: Map<string, TaskBoardRow[]>; hidden: number } {
  const sets = new Map<string, TaskBoardRow[]>();
  for (const r of rows) {
    const ship = r.task.shipment_id || r.shipment?.id;
    const aud = titleAudience(r.task.title);
    if (!ship || !aud) continue;
    // Storage-risk tasks are their own lane, same as the server rule.
    const k = `${ship}|${aud}|${/^\s*(carrier|customer) followup:\s*storage risk/i.test(r.task.title) ? "storage" : "std"}`;
    if (!sets.has(k)) sets.set(k, []);
    sets.get(k)!.push(r);
  }
  const older = new Map<string, TaskBoardRow[]>();
  const drop = new Set<string>();
  for (const set of sets.values()) {
    if (set.length < 2) continue;
    const [newest, ...rest] = [...set].sort((a, b) => (isNewer(a, b) ? -1 : 1));
    older.set(newest.task.id, rest);
    rest.forEach((r) => drop.add(r.task.id));
  }
  return { rows: drop.size ? rows.filter((r) => !drop.has(r.task.id)) : rows, older, hidden: drop.size };
}

export function EmailQueuePage() {
  const { profile: me } = useAuth();
  const [params, setParams] = useSearchParams();
  const tab = params.get("tab") === "history" ? "history" : "queue";
  const by: EmailAudience = params.get("by") === "customer" ? "customer" : "carrier";
  const setParam = (k: string, v: string | null) => setParams((p) => { const n = new URLSearchParams(p); if (v) n.set(k, v); else n.delete(k); return n; }, { replace: true });

  const [rows, setRows] = useState<TaskBoardRow[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const load = useCallback(async () => {
    setErr(null);
    try { setRows((await api.tasks.v2Board()).rows); } catch (e) { setErr((e as Error).message); }
  }, []);
  useEffect(() => { load(); }, [load]);

  // Newest task per shipment + audience; the older ones ride along in `older`.
  const { rows: queued, older, hidden } = useMemo(
    () => collapseNewest((rows || []).filter((r) => r.task.email_queued_at && isActive(r.task.status))),
    [rows],
  );

  return (
    <div className="space-y-4">
      <div className="flex items-end justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-xl font-semibold flex items-center gap-2"><Mail className="h-5 w-5 text-violet-600" /> Email Studio</h1>
          <p className="text-sm text-slate-500 mt-0.5">Group the tasks you marked for email into one message per carrier or customer.</p>
        </div>
        <div className="flex items-center gap-2">
          {me?.role === "admin" ? (
            <Link to="/admin/email-studio" className="inline-flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-lg ring-1 ring-slate-200 bg-white hover:bg-slate-50 text-slate-700">
              <Settings2 className="h-4 w-4" /> Edit AI prompts
            </Link>
          ) : null}
          <button onClick={load} className="inline-flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-lg ring-1 ring-slate-200 bg-white hover:bg-slate-50"><RefreshCw className="h-4 w-4" /> Refresh</button>
        </div>
      </div>

      <div className="flex gap-1 border-b border-slate-200" role="tablist">
        {([["queue", "Queue", Inbox], ["history", "History", History]] as const).map(([id, label, Icon]) => (
          <button key={id} role="tab" aria-selected={tab === id} onClick={() => setParam("tab", id === "queue" ? null : id)}
            className={"px-3 py-2 text-sm -mb-px border-b-2 inline-flex items-center gap-1.5 " + (tab === id ? "border-violet-600 text-violet-700 font-medium" : "border-transparent text-slate-600 hover:text-slate-900")}>
            <Icon className="h-4 w-4" /> {label}
            {id === "queue" && queued.length ? <span className="text-[10px] font-semibold rounded-full px-1.5 py-0.5 bg-violet-100 text-violet-800">{queued.length}</span> : null}
          </button>
        ))}
      </div>

      {tab === "queue" ? (
        err ? <ErrorBlock>{err} <button onClick={load} className="underline ml-1">Retry</button></ErrorBlock>
          : !rows ? <LoadingState />
          : <Queue queued={queued} older={older} hidden={hidden} by={by} onBy={(b) => setParam("by", b === "carrier" ? null : b)} onChanged={load} />
      ) : <HistoryList />}
    </div>
  );
}

function Queue({ queued, older, hidden, by, onBy, onChanged }: {
  queued: TaskBoardRow[];                 // newest task per shipment + audience
  older: Map<string, TaskBoardRow[]>;     // shown task id → the older tasks hidden behind it
  hidden: number;
  by: EmailAudience; onBy: (b: EmailAudience) => void; onChanged: () => void;
}) {
  const navigate = useNavigate();
  const location = useLocation();
  // `only`: draft just these task ids instead of the whole queue.
  const [composing, setComposing] = useState<{ to: string | null; only?: string[] } | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [err, setErr] = useState<string | null>(null);
  const [deduping, setDeduping] = useState(false);
  const dedupeDialog = deduping ? <DedupeDialog onClose={() => setDeduping(false)} onApplied={() => onChanged()} /> : null;

  const { groups, homeless } = useMemo(() => {
    const m = new Map<string, TaskBoardRow[]>();
    const homeless: TaskBoardRow[] = [];
    for (const r of queued) {
      const name = nameFor(r, by);
      if (!name) { homeless.push(r); continue; }
      if (!m.has(name)) m.set(name, []);
      m.get(name)!.push(r);
    }
    const groups = Array.from(m.entries()).map(([name, rows]) => ({ name, rows, shipments: new Set(rows.map((r) => r.shipment?.id)).size, oldest: Math.max(...rows.map((r) => ageDays(r.task.created_at))) }))
      .sort((a, b) => b.shipments - a.shipments || a.name.localeCompare(b.name));
    return { groups, homeless };
  }, [queued, by]);

  // Drop ticks for tasks that have left the queue.
  useEffect(() => { setPicked((p) => new Set(Array.from(p).filter((id) => queued.some((r) => r.task.id === id)))); }, [queued]);
  const order = useMemo(() => groups.flatMap((g) => g.rows.map((r) => r.task.id)), [groups]);
  const pickedIds = order.filter((id) => picked.has(id));
  const [lastTicked, setLastTicked] = useState<string | null>(null);
  function tick(id: string, shift: boolean) {
    setPicked((p) => {
      const n = new Set(p);
      const a = shift && lastTicked ? order.indexOf(lastTicked) : -1;
      const b = order.indexOf(id);
      if (a >= 0 && b >= 0 && a !== b) { for (let i = Math.min(a, b); i <= Math.max(a, b); i++) n.add(order[i]); return n; }
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });
    setLastTicked(id);
  }
  function tickMany(ids: string[]) {
    setPicked((p) => { const n = new Set(p); const all = ids.every((id) => n.has(id)); ids.forEach((id) => (all ? n.delete(id) : n.add(id))); return n; });
  }
  function walk(ids: string[]) {
    if (ids.length) navigate(`/tasks/v2/${ids[0]}`, { state: { from: `/email-studio${location.search}`, walkIds: ids } });
  }
  const [blockedTabs, setBlockedTabs] = useState<{ ids: string[]; total: number } | null>(null);
  function openTabs(ids: string[]) {
    const blocked = openTasksInTabs(ids);
    setBlockedTabs(blocked.length ? { ids: blocked, total: ids.length } : null);
  }
  // Also un-queues the older tasks hidden behind each row, so they don't pop back up.
  async function unqueue(ids: string[]) {
    setBusyId(ids[0]); setErr(null);
    const all = ids.flatMap((id) => [id, ...(older.get(id) || []).map((r) => r.task.id)]);
    try { await api.tasks.bulkUpdate({ ids: all, email_queued: false }); onChanged(); }
    catch (e) { setErr((e as Error).message); }
    finally { setBusyId(null); }
  }

  if (!queued.length) {
    return (
      <div className="rounded-2xl bg-white ring-1 ring-slate-200 shadow-sm p-10 text-center">
        <Inbox className="h-8 w-8 text-slate-300 mx-auto" />
        <div className="mt-2 font-medium text-slate-900">Nothing queued for email</div>
        <p className="mt-1 text-sm text-slate-500 max-w-md mx-auto">
          While working a task, press <kbd className="px-1.5 py-0.5 rounded bg-slate-100 ring-1 ring-slate-200 font-mono text-[11px]">E</kbd> to mark it for email.
          On the Tasks board you can also tick several tasks and choose “Queue for email”. They collect here, grouped by carrier or customer.
        </p>
        <div className="mt-4 flex items-center justify-center gap-2 flex-wrap">
          <Link to="/tasks/v2" className="inline-flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-lg bg-slate-900 text-white hover:bg-slate-800">Go to Tasks</Link>
          <button onClick={() => setDeduping(true)} className="inline-flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-lg text-slate-600 hover:bg-slate-100" title="Find shipments with several tasks for the same carrier or customer and keep the newest"><Layers className="h-4 w-4" /> Clean up duplicates</button>
        </div>
        {dedupeDialog}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3 flex-wrap">
        <div className="inline-flex rounded-lg ring-1 ring-slate-200 bg-white p-0.5 text-sm">
          {(["carrier", "customer"] as const).map((a) => (
            <button key={a} onClick={() => onBy(a)} aria-pressed={by === a}
              className={"px-3 py-1 rounded-md " + (by === a ? "bg-slate-900 text-white" : "text-slate-600 hover:bg-slate-100")}>
              Group by {a}
            </button>
          ))}
        </div>
        <span className="text-sm text-slate-500">{queued.length} task{queued.length === 1 ? "" : "s"} queued · {groups.length} {by}{groups.length === 1 ? "" : "s"}</span>
        <label className="inline-flex items-center gap-1.5 text-sm text-slate-600 cursor-pointer select-none">
          <input type="checkbox" checked={order.length > 0 && order.every((id) => picked.has(id))} onChange={() => tickMany(order)} className="accent-violet-600" /> Select all
        </label>
        <div className="ml-auto flex items-center gap-2">
          <button onClick={() => setDeduping(true)} className="inline-flex items-center gap-1.5 text-sm px-2.5 py-1.5 rounded-lg text-slate-600 hover:bg-slate-100" title="Find shipments with several tasks for the same carrier or customer and keep the newest">
            <Layers className="h-4 w-4" /> Clean up duplicates
          </button>
          {groups.length > 1 ? (
            <button onClick={() => setComposing({ to: null })} className="inline-flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-lg bg-violet-600 text-white hover:bg-violet-700">
              <Sparkles className="h-4 w-4" /> Draft all {groups.length} emails
            </button>
          ) : null}
        </div>
      </div>
      {err ? <div className="text-sm text-rose-700">{err}</div> : null}

      {hidden ? (
        <div className="rounded-xl bg-slate-50 ring-1 ring-slate-200 px-4 py-2 text-sm text-slate-600 flex items-center gap-3 flex-wrap">
          <span>{hidden} older duplicate task{hidden === 1 ? " is" : "s are"} hidden. The newest task for each shipment is shown.</span>
          <button onClick={() => setDeduping(true)} className="ml-auto inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md ring-1 ring-slate-200 bg-white text-slate-700 hover:bg-slate-50"><Layers className="h-3.5 w-3.5" /> Clean up duplicates</button>
        </div>
      ) : null}

      {pickedIds.length ? (
        <div className="sticky top-2 z-10 rounded-xl bg-slate-900 text-white px-4 py-2.5 flex items-center gap-2 flex-wrap text-sm">
          <span className="font-medium">{pickedIds.length} selected</span>
          <span className="text-slate-400">·</span>
          <button onClick={() => setComposing({ to: null, only: pickedIds })} className="inline-flex items-center gap-1 rounded-md bg-violet-500 hover:bg-violet-400 px-2.5 py-1"><Mail className="h-3.5 w-3.5" /> Draft email</button>
          <button onClick={() => walk(pickedIds)} className="inline-flex items-center gap-1 rounded-md bg-white/10 hover:bg-white/20 px-2.5 py-1" title="Open these in the drawer and step through them with the arrows"><PanelRightOpen className="h-3.5 w-3.5" /> Open {pickedIds.length}</button>
          <button onClick={() => openTabs(pickedIds)} className="inline-flex items-center gap-1 rounded-md bg-white/10 hover:bg-white/20 px-2.5 py-1" title={pickedIds.length > SLOW_TABS ? `Open all ${pickedIds.length} in their own browser tabs. That many will take a second to load.` : "Open each one in its own browser tab"}><ExternalLink className="h-3.5 w-3.5" /> Open all in tabs</button>
          <button onClick={() => unqueue(pickedIds)} disabled={!!busyId} className="inline-flex items-center gap-1 rounded-md bg-slate-600 hover:bg-slate-500 px-2.5 py-1 disabled:opacity-50" title="Take these out of the email queue (the tasks themselves are untouched)"><Trash2 className="h-3.5 w-3.5" /> Remove from queue</button>
          <button onClick={() => setPicked(new Set())} className="ml-auto text-slate-300 hover:text-white inline-flex items-center gap-1"><X className="h-3.5 w-3.5" /> Clear</button>
        </div>
      ) : null}

      <div className="grid gap-3 lg:grid-cols-2">
        {groups.map((g) => (
          <div key={g.name} className="rounded-2xl bg-white ring-1 ring-slate-200 shadow-sm p-4">
            <div className="flex items-start justify-between gap-2">
              <input type="checkbox" checked={g.rows.every((r) => picked.has(r.task.id))} onChange={() => tickMany(g.rows.map((r) => r.task.id))}
                aria-label={`Select all for ${g.name}`} title="Select every task in this group" className="accent-violet-600 mt-1.5 shrink-0" />
              <div className="min-w-0 flex-1">
                <div className="font-semibold text-slate-900 truncate">{g.name}</div>
                <div className="text-xs text-slate-500">{g.shipments} shipment{g.shipments === 1 ? "" : "s"} · oldest ask <span className={g.oldest >= 7 ? "text-rose-600 font-medium" : ""}>{g.oldest}d</span></div>
              </div>
              <button onClick={() => setComposing({ to: g.name })} className="shrink-0 inline-flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-lg bg-violet-600 text-white hover:bg-violet-700">
                <Mail className="h-4 w-4" /> Draft email
              </button>
            </div>
            <ul className="mt-3 divide-y divide-slate-100 rounded-xl ring-1 ring-slate-100 max-h-64 overflow-y-auto">
              {g.rows.map((r) => (
                <li key={r.task.id} className={"flex items-start gap-2 px-3 py-2 text-xs " + (picked.has(r.task.id) ? "bg-violet-50/60" : "")}>
                  <input type="checkbox" checked={picked.has(r.task.id)} onChange={() => {}} onClick={(e) => tick(r.task.id, e.shiftKey)}
                    aria-label="Select task" title="Shift-click to select a range" className="accent-violet-600 mt-0.5 shrink-0" />
                  <span className="min-w-0 flex-1">
                    <Link to={`/tasks/v2/${r.task.id}`} className="font-mono font-semibold text-sky-700 hover:underline">{r.shipment?.tracking_number || r.shipment?.shipment_id || "(no PRO)"}</Link>
                    <span className="text-slate-500"> · {r.shipment?.shipment_status || "No status"} · {by === "carrier" ? r.shipment?.customer_name : (r.shipment?.carrier_name || r.shipment?.carrier)}</span>
                    <span className="block text-slate-500 truncate">{shortTitle(r.task.title)}</span>
                  </span>
                  {older.get(r.task.id)?.length ? (
                    <span className="shrink-0 text-slate-400 cursor-help" title={"Older tasks hidden behind this one:\n" + older.get(r.task.id)!.map((o) => `• ${o.task.title}`).join("\n")}>+{older.get(r.task.id)!.length} older</span>
                  ) : null}
                  <span className="shrink-0 text-slate-400 tabular-nums">{ageDays(r.task.created_at)}d</span>
                  <button onClick={() => unqueue([r.task.id])} disabled={busyId === r.task.id} title={older.get(r.task.id)?.length ? "Take this task and its older duplicates out of the email queue (the tasks themselves are untouched)" : "Take this task out of the email queue (the task itself is untouched)"}
                    className="shrink-0 text-slate-400 hover:text-rose-600 disabled:opacity-40" aria-label="Remove from queue"><X className="h-3.5 w-3.5" /></button>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>

      {homeless.length ? (
        <div className="rounded-xl bg-amber-50 ring-1 ring-amber-200 px-4 py-3 text-sm text-amber-900">
          {homeless.length} queued task{homeless.length === 1 ? " has" : "s have"} no {by} on the shipment, so {homeless.length === 1 ? "it isn't" : "they aren't"} in any group here.
          Try “Group by {by === "carrier" ? "customer" : "carrier"}”.
        </div>
      ) : null}

      {blockedTabs ? (
        <BlockedTabsDialog ids={blockedTabs.ids} total={blockedTabs.total} onClose={() => setBlockedTabs(null)}
          onRetry={() => { const still = openTasksInTabs(blockedTabs.ids, { quiet: true }); setBlockedTabs(still.length ? { ids: still, total: blockedTabs.total } : null); }} />
      ) : null}

      {dedupeDialog}

      {composing ? (
        <GroupEmailComposer
          rows={composing.only ? queued.filter((r) => composing.only!.includes(r.task.id)) : queued}
          initialAudience={by}
          initialTo={composing.to}
          onClose={() => setComposing(null)}
          onTasksChanged={onChanged}
        />
      ) : null}
    </div>
  );
}

function HistoryList() {
  const [rows, setRows] = useState<GroupEmailRecord[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  useEffect(() => { api.tasks.v2GroupEmails(100).then((r) => setRows(r.data)).catch((e) => setErr((e as Error).message)); }, []);

  const shown = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return rows || [];
    return (rows || []).filter((d) => [d.recipient, d.subject, d.by, d.body, ...(d.scope || []).flatMap((x) => [x.tn, x.fpx])].filter(Boolean).join(" ").toLowerCase().includes(s));
  }, [rows, q]);

  async function copy(d: GroupEmailRecord) {
    try { await navigator.clipboard.writeText(`Subject: ${d.subject || ""}\n\n${d.body}`); setCopiedId(d.id); setTimeout(() => setCopiedId(null), 1500); } catch { /* clipboard blocked */ }
  }

  if (err) return <ErrorBlock>{err}</ErrorBlock>;
  if (!rows) return <LoadingState />;
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 rounded-lg ring-1 ring-slate-200 bg-white px-3 py-2 max-w-md">
        <Search className="h-4 w-4 text-slate-400" />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by carrier, customer, PRO or wording…" className="flex-1 text-sm outline-none bg-transparent" />
      </div>
      {!shown.length ? <div className="text-sm text-slate-500">{rows.length ? "No emails match that search." : "No group emails have been drafted yet."}</div> : (
        <ul className="rounded-2xl bg-white ring-1 ring-slate-200 shadow-sm divide-y divide-slate-100 overflow-hidden">
          {shown.map((d) => {
            const open = openId === d.id;
            // Reopens the composer on the same tasks (those still active).
            const again = d.scope?.length
              ? `/tasks/v2?email=${d.audience}${d.recipient ? `&to=${encodeURIComponent(d.recipient)}` : ""}&tasks=${d.scope.flatMap((x) => x.task_ids).slice(0, 60).map((id) => id.slice(0, 8)).join(",")}`
              : null;
            return (
              <li key={d.id}>
                <button onClick={() => setOpenId(open ? null : d.id)} className="w-full text-left px-4 py-2.5 hover:bg-slate-50 flex items-start gap-2">
                  {open ? <ChevronDown className="h-4 w-4 text-slate-400 mt-0.5 shrink-0" /> : <ChevronRight className="h-4 w-4 text-slate-400 mt-0.5 shrink-0" />}
                  <span className="min-w-0 flex-1">
                    <span className="text-sm font-medium text-slate-900">{d.recipient || "(no recipient)"}</span>
                    <span className={"ml-1.5 text-[10px] uppercase tracking-wide font-semibold px-1.5 py-0.5 rounded-full " + (d.audience === "carrier" ? "bg-slate-200 text-slate-700" : "bg-sky-100 text-sky-700")}>{d.audience}</span>
                    {d.count ? <span className="text-xs text-slate-500"> · {d.count} shipment{d.count === 1 ? "" : "s"}</span> : null}
                    {d.tone ? <span className="text-xs text-slate-500"> · {d.tone}</span> : null}
                    <span className="block text-xs text-slate-600 truncate">{d.subject || "(no subject)"}</span>
                  </span>
                  <span className="text-[11px] text-slate-400 shrink-0 text-right">{fmtRelative(d.created_at)}<br />{d.by || "—"}</span>
                </button>
                {open ? (
                  <div className="px-4 pb-4 pl-10 space-y-3">
                    <div>
                      <div className="text-[10px] font-bold uppercase tracking-wider text-slate-500 mb-1">In scope</div>
                      {d.scope?.length ? (
                        <div className="flex gap-1.5 flex-wrap">
                          {d.scope.map((x) => (
                            <Link key={x.id} to={`/tracking/${x.id}`} title={x.fpx ? `FPX ${x.fpx}` : undefined}
                              className="font-mono text-xs px-2 py-0.5 rounded-md bg-slate-100 ring-1 ring-slate-200 text-sky-700 hover:bg-sky-50">{x.tn || x.fpx || "shipment"}</Link>
                          ))}
                        </div>
                      ) : <div className="text-xs text-slate-500">The shipment list wasn't recorded for this email (it predates scope tracking). The PROs are in the text below.</div>}
                    </div>
                    <pre className="text-sm whitespace-pre-wrap font-sans text-slate-800 bg-slate-50 ring-1 ring-slate-200 rounded-lg p-3 max-h-96 overflow-auto">{d.body}</pre>
                    <div className="flex items-center gap-2 flex-wrap text-xs text-slate-500">
                      <button onClick={() => copy(d)} className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md bg-slate-900 text-white hover:bg-slate-800"><Copy className="h-3 w-3" /> {copiedId === d.id ? "Copied" : "Copy email"}</button>
                      {again ? <Link to={again} className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md ring-1 ring-slate-200 bg-white text-slate-700 hover:bg-slate-50" title="Open the composer on the tasks from this email that are still active"><Mail className="h-3 w-3" /> Draft a follow-up</Link> : null}
                      <span>This is the AI's draft; edits the rep made before sending aren't saved.</span>
                    </div>
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
