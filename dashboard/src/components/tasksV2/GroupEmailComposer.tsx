// Group email composer for the Tasks board. Takes whatever tasks the rep
// selected (or a whole carrier / customer group) and drafts ONE email per
// recipient covering every shipment behind those tasks. A selection that
// spans three carriers becomes three emails, listed in the left rail.
import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, Check, CheckCircle2, Copy, ExternalLink, Flame, Link2, Handshake, Loader2, Mail, Play, Send, Sparkles, Target, X } from "lucide-react";
import { api } from "../../lib/api";
import type { TaskBoardRow } from "../../lib/types";
import { isActive, shortTitle } from "./shared";

export type EmailAudience = "carrier" | "customer";
type Tone = "friendly" | "direct" | "escalate";

const TONES: { id: Tone; label: string; hint: string; icon: typeof Flame; on: string }[] = [
  { id: "friendly", label: "Friendly", hint: "A warm check-in, no pressure", icon: Handshake, on: "bg-emerald-600 text-white ring-emerald-600" },
  { id: "direct", label: "Direct", hint: "Businesslike: a specific update per shipment", icon: Target, on: "bg-sky-600 text-white ring-sky-600" },
  { id: "escalate", label: "Escalate", hint: "Firm: overdue or unanswered, reply today", icon: Flame, on: "bg-rose-600 text-white ring-rose-600" },
];

// Past this, mail clients start cutting the body off a mailto: link.
const MAILTO_MAX = 1900;
const MAX_SHIPMENTS = 60;

interface ShipmentLine { id: string; row: TaskBoardRow; tasks: TaskBoardRow[] }
interface Batch { name: string; lines: ShipmentLine[]; oldestDays: number }
interface BatchState {
  excluded: Set<string>; tone: Tone; notes: string;
  busy: boolean; err: string | null;
  subject: string; body: string; model: string | null; draftedFor: number;
  taskIds: string[]; started: boolean; copied: boolean;
  // PROs that should be in the draft but aren't in its text.
  missing: string[];
}
const blank = (): BatchState => ({
  excluded: new Set(), tone: "direct", notes: "", busy: false, err: null,
  subject: "", body: "", model: null, draftedFor: 0, taskIds: [], started: false, copied: false, missing: [],
});

const nameFor = (r: TaskBoardRow, audience: EmailAudience) =>
  (audience === "carrier" ? (r.shipment?.carrier_name || r.shipment?.carrier || "") : (r.shipment?.customer_name || "")).trim();
const ageDays = (iso: string) => Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 86_400_000));

export function GroupEmailComposer({ rows, initialAudience, initialTo, onView, onClose, onTasksChanged }: {
  rows: TaskBoardRow[];
  initialAudience: EmailAudience;
  // Recipient to show first (from a link or a group header).
  initialTo?: string | null;
  // Reports who the email is for and which recipient is showing, so the
  // page can keep both in the URL.
  onView?: (audience: EmailAudience, to: string | null) => void;
  onClose: () => void;
  // Called after tasks were moved to In progress, so the board can reload.
  onTasksChanged: () => void;
}) {
  const [audience, setAudience] = useState<EmailAudience>(initialAudience);
  const [states, setStates] = useState<Record<string, BatchState>>({});
  const [activeName, setActiveName] = useState<string | null>(initialTo ?? null);
  const [allBusy, setAllBusy] = useState(false);
  const [linkCopied, setLinkCopied] = useState(false);

  // One batch per recipient, one line per shipment (several tasks on the
  // same shipment share a line so a PRO is never listed twice).
  const { batches, skipped } = useMemo(() => {
    const m = new Map<string, Map<string, ShipmentLine>>();
    let skipped = 0;
    for (const r of rows) {
      const name = nameFor(r, audience);
      if (!r.shipment || !name || !isActive(r.task.status)) { skipped++; continue; }
      if (!m.has(name)) m.set(name, new Map());
      const lines = m.get(name)!;
      const line = lines.get(r.shipment.id);
      if (line) line.tasks.push(r); else lines.set(r.shipment.id, { id: r.shipment.id, row: r, tasks: [r] });
    }
    const batches: Batch[] = Array.from(m.entries()).map(([name, lines]) => {
      const ls = Array.from(lines.values());
      return { name, lines: ls, oldestDays: Math.max(...ls.flatMap((l) => l.tasks.map((t) => ageDays(t.task.created_at)))) };
    }).sort((a, b) => b.lines.length - a.lines.length || a.name.localeCompare(b.name));
    return { batches, skipped };
  }, [rows, audience]);

  const active = batches.find((b) => b.name === activeName) || batches.find((b) => b.name.toLowerCase() === (activeName || "").toLowerCase()) || batches[0] || null;
  useEffect(() => { onView?.(audience, active?.name ?? null); }, [audience, active?.name]); // eslint-disable-line react-hooks/exhaustive-deps

  async function copyLink() {
    try { await navigator.clipboard.writeText(window.location.href); setLinkCopied(true); setTimeout(() => setLinkCopied(false), 1800); } catch { /* clipboard blocked: the address bar has the same link */ }
  }
  const keyOf = (name: string) => `${audience}:${name}`;
  const stateOf = (name: string) => states[keyOf(name)] || blank();
  const patch = (name: string, p: Partial<BatchState>) =>
    setStates((s) => ({ ...s, [keyOf(name)]: { ...(s[keyOf(name)] || blank()), ...p } }));

  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === "Escape") { e.stopPropagation(); onClose(); } }
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  const included = (b: Batch, st: BatchState) => b.lines.filter((l) => !st.excluded.has(l.id));

  async function draft(b: Batch) {
    const st = stateOf(b.name);
    const lines = included(b, st);
    if (!lines.length) { patch(b.name, { err: "Keep at least one shipment in the email." }); return; }
    if (lines.length > MAX_SHIPMENTS) { patch(b.name, { err: `One email covers up to ${MAX_SHIPMENTS} shipments. Untick some and send the rest in a second email.` }); return; }
    patch(b.name, { busy: true, err: null });
    try {
      const r = await api.tasks.v2GroupEmail({
        audience, name: b.name,
        task_ids: lines.flatMap((l) => l.tasks.map((t) => t.task.id)),
        notes: st.notes.trim() || undefined, tone: st.tone,
      });
      patch(b.name, { busy: false, subject: r.subject, body: r.body, model: r.model, draftedFor: r.count, taskIds: r.task_ids, started: false, copied: false, missing: r.missing || [] });
    } catch (e) { patch(b.name, { busy: false, err: (e as Error).message }); }
  }

  // Draft every recipient that doesn't have a draft yet, one at a time.
  async function draftAll() {
    setAllBusy(true);
    try { for (const b of batches) if (!stateOf(b.name).body) await draft(b); }
    finally { setAllBusy(false); }
  }

  async function copy(b: Batch) {
    const st = stateOf(b.name);
    try {
      await navigator.clipboard.writeText(`Subject: ${st.subject}\n\n${st.body}`);
      patch(b.name, { copied: true });
      setTimeout(() => patch(b.name, { copied: false }), 1800);
    } catch { patch(b.name, { err: "Couldn't reach the clipboard — select the text and copy it by hand." }); }
  }

  async function startTasks(b: Batch) {
    const st = stateOf(b.name);
    const openIds = b.lines.flatMap((l) => l.tasks).filter((t) => st.taskIds.includes(t.task.id) && t.task.status === "open").map((t) => t.task.id);
    if (!openIds.length) { patch(b.name, { started: true }); return; }
    patch(b.name, { busy: true, err: null });
    try {
      await api.tasks.bulkUpdate({ ids: openIds, status: "in_progress" });
      patch(b.name, { busy: false, started: true });
      onTasksChanged();
    } catch (e) { patch(b.name, { busy: false, err: (e as Error).message }); }
  }

  const who = audience === "carrier" ? "carrier" : "customer";
  const undrafted = batches.filter((b) => !stateOf(b.name).body).length;

  return (
    <div className="fixed inset-0 z-40 bg-slate-900/40 flex items-center justify-center p-4" onClick={onClose}>
      <div className="w-full max-w-5xl h-[88vh] rounded-2xl bg-white shadow-xl ring-1 ring-slate-200 flex flex-col overflow-hidden" onClick={(e) => e.stopPropagation()}>
        <div className="shrink-0 flex items-center gap-3 px-5 py-3 border-b border-slate-200 flex-wrap">
          <h2 className="font-semibold text-slate-900 inline-flex items-center gap-2"><Mail className="h-4 w-4 text-violet-600" /> Group email</h2>
          <div className="inline-flex rounded-lg ring-1 ring-slate-200 p-0.5 text-sm" role="tablist" aria-label="Who the email is for">
            {(["carrier", "customer"] as const).map((a) => (
              <button key={a} role="tab" aria-selected={audience === a} onClick={() => { setAudience(a); setActiveName(null); }}
                className={"px-3 py-1 rounded-md " + (audience === a ? "bg-slate-900 text-white" : "text-slate-600 hover:bg-slate-100")}>
                To the {a}
              </button>
            ))}
          </div>
          <span className="text-xs text-slate-500">
            {batches.length} {who}{batches.length === 1 ? "" : "s"} · one email each. Nothing is sent from here.
          </span>
          <button onClick={copyLink} title="Copy a link that reopens this group email (same recipient and shipments). Drafts aren't part of the link."
            className="ml-auto inline-flex items-center gap-1 text-xs px-2 py-1 rounded-md ring-1 ring-slate-200 text-slate-600 hover:bg-slate-50">
            {linkCopied ? <Check className="h-3.5 w-3.5 text-emerald-600" /> : <Link2 className="h-3.5 w-3.5" />} {linkCopied ? "Link copied" : "Copy link"}
          </button>
          <button onClick={onClose} className="p-1.5 rounded text-slate-400 hover:text-slate-700 hover:bg-slate-100" aria-label="Close" title="Close (Esc)"><X className="h-4 w-4" /></button>
        </div>

        {!batches.length ? (
          <div className="flex-1 flex items-center justify-center p-10 text-center text-sm text-slate-500">
            None of the selected tasks has a {who} on its shipment, so there's nobody to address.
            {audience === "carrier" ? " Try “To the customer”." : " Try “To the carrier”."}
          </div>
        ) : (
          <div className="flex-1 min-h-0 flex">
            {/* Recipients */}
            <div className="w-60 shrink-0 border-r border-slate-200 bg-slate-50/60 flex flex-col">
              <div className="flex-1 overflow-y-auto p-2 space-y-1">
                {batches.map((b) => {
                  const st = stateOf(b.name);
                  const on = active?.name === b.name;
                  return (
                    <button key={b.name} onClick={() => setActiveName(b.name)}
                      className={"w-full text-left rounded-lg px-2.5 py-2 ring-1 transition " + (on ? "bg-white ring-violet-300 shadow-sm" : "ring-transparent hover:bg-white hover:ring-slate-200")}>
                      <div className="flex items-center gap-1.5">
                        <span className="text-sm font-medium text-slate-900 truncate">{b.name}</span>
                        <span className="ml-auto shrink-0">
                          {st.busy ? <Loader2 className="h-3.5 w-3.5 animate-spin text-violet-600" />
                            : st.started ? <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" />
                            : st.body ? <Check className="h-3.5 w-3.5 text-violet-600" /> : null}
                        </span>
                      </div>
                      <div className="text-[11px] text-slate-500">
                        {b.lines.length} shipment{b.lines.length === 1 ? "" : "s"} · oldest {b.oldestDays}d
                        {st.body ? " · drafted" : ""}
                      </div>
                    </button>
                  );
                })}
              </div>
              <div className="shrink-0 p-2 border-t border-slate-200 space-y-1.5">
                {batches.length > 1 ? (
                  <button onClick={draftAll} disabled={allBusy || !undrafted}
                    className="w-full inline-flex items-center justify-center gap-1.5 text-sm px-3 py-1.5 rounded-lg bg-violet-600 text-white hover:bg-violet-700 disabled:opacity-40">
                    {allBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
                    {allBusy ? "Drafting…" : undrafted ? `Draft all ${undrafted}` : "All drafted"}
                  </button>
                ) : null}
                {skipped ? <div className="text-[11px] text-slate-500 px-1">{skipped} task{skipped === 1 ? "" : "s"} left out: closed, or no {who} on the shipment.</div> : null}
              </div>
            </div>

            {/* The email for the active recipient */}
            {active ? <BatchPane key={keyOf(active.name)} batch={active} audience={audience} st={stateOf(active.name)}
              patch={(p) => patch(active.name, p)} onDraft={() => draft(active)} onCopy={() => copy(active)} onStart={() => startTasks(active)} locked={allBusy} /> : null}
          </div>
        )}
      </div>
    </div>
  );
}

function BatchPane({ batch, audience, st, patch, onDraft, onCopy, onStart, locked }: {
  batch: Batch; audience: EmailAudience; st: BatchState;
  patch: (p: Partial<BatchState>) => void;
  onDraft: () => void; onCopy: () => void; onStart: () => void; locked: boolean;
}) {
  const count = batch.lines.length - st.excluded.size;
  const mailto = `mailto:?subject=${encodeURIComponent(st.subject)}&body=${encodeURIComponent(st.body)}`;
  const openCount = batch.lines.flatMap((l) => l.tasks).filter((t) => st.taskIds.includes(t.task.id) && t.task.status === "open").length;
  // The list changed since the draft was written.
  const stale = !!st.body && st.draftedFor !== count;

  function toggle(id: string) {
    const next = new Set(st.excluded);
    if (next.has(id)) next.delete(id); else next.add(id);
    patch({ excluded: next, err: null });
  }

  return (
    <div className="flex-1 min-w-0 overflow-y-auto p-5 space-y-4">
      <div className="flex items-baseline gap-2 flex-wrap">
        <h3 className="text-lg font-semibold text-slate-900">{batch.name}</h3>
        <span className="text-sm text-slate-500">{count} of {batch.lines.length} shipment{batch.lines.length === 1 ? "" : "s"} in this email</span>
      </div>

      <div className="rounded-xl ring-1 ring-slate-200 divide-y divide-slate-100 max-h-52 overflow-y-auto">
        {batch.lines.map((l) => {
          const s = l.row.shipment!;
          const other = audience === "carrier" ? s.customer_name : (s.carrier_name || s.carrier);
          const oldest = Math.max(...l.tasks.map((t) => ageDays(t.task.created_at)));
          return (
            <label key={l.id} className={"flex items-start gap-2.5 px-3 py-2 text-xs cursor-pointer hover:bg-slate-50 " + (st.excluded.has(l.id) ? "opacity-50" : "")}>
              <input type="checkbox" checked={!st.excluded.has(l.id)} onChange={() => toggle(l.id)} className="mt-0.5 accent-violet-600" />
              <span className="min-w-0 flex-1">
                <span className="font-mono font-semibold text-slate-900">{s.tracking_number || s.shipment_id || "(no PRO)"}</span>
                <span className="text-slate-500"> · {s.shipment_status || "No status"}{other ? ` · ${other}` : ""}</span>
                <span className="block text-slate-500 truncate">
                  {l.tasks.map((t) => shortTitle(t.task.title)).join(" · ")}
                </span>
              </span>
              <span className={"shrink-0 tabular-nums " + (oldest >= 7 ? "text-rose-600 font-medium" : "text-slate-400")}>{oldest}d</span>
              <a href={`/tasks/v2/${l.tasks[0].task.id}`} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}
                title="Open this shipment and its task in a new tab" aria-label="Open shipment in a new tab" className="shrink-0 text-slate-400 hover:text-sky-700">
                <ExternalLink className="h-3.5 w-3.5" />
              </a>
            </label>
          );
        })}
      </div>

      <div className="space-y-2">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-xs font-medium text-slate-600">Temperature</span>
          <div className="inline-flex gap-1">
            {TONES.map((t) => {
              const Icon = t.icon;
              const on = st.tone === t.id;
              return (
                <button key={t.id} type="button" title={t.hint} aria-pressed={on} onClick={() => patch({ tone: t.id })}
                  className={"inline-flex items-center gap-1 text-xs px-2.5 py-1 rounded-full ring-1 transition " + (on ? t.on : "bg-white text-slate-600 ring-slate-200 hover:bg-slate-50")}>
                  <Icon className="h-3.5 w-3.5" /> {t.label}
                </button>
              );
            })}
          </div>
          {batch.oldestDays >= 7 && st.tone !== "escalate" ? (
            <button type="button" onClick={() => patch({ tone: "escalate" })} className="text-[11px] text-rose-700 hover:underline">
              Oldest ask is {batch.oldestDays} days old — escalate?
            </button>
          ) : null}
        </div>
        <textarea value={st.notes} onChange={(e) => patch({ notes: e.target.value })} rows={2} maxLength={2000}
          placeholder={audience === "carrier" ? "Anything to add? e.g. “We need PODs on the delivered ones. CC dispatch.”" : "Anything to add? e.g. “Apologise for the delay on the Spokane load.”"}
          className="w-full text-sm rounded-lg ring-1 ring-slate-200 focus:ring-2 focus:ring-violet-400 px-3 py-2 outline-none" />
        <div className="flex items-center gap-3 flex-wrap">
          <button onClick={onDraft} disabled={st.busy || locked || !count}
            className="inline-flex items-center gap-1.5 text-sm px-3.5 py-2 rounded-lg bg-violet-600 text-white hover:bg-violet-700 disabled:opacity-40">
            {st.busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
            {st.busy ? "Drafting… (up to a minute)" : st.body ? "Redraft" : `Draft email for ${count} shipment${count === 1 ? "" : "s"}`}
          </button>
          {stale ? <span className="text-xs text-amber-700 inline-flex items-center gap-1"><AlertTriangle className="h-3.5 w-3.5" /> The draft below covers {st.draftedFor}; you now have {count} ticked. Redraft to match.</span> : null}
          {st.err ? <span className="text-xs text-rose-700 inline-flex items-center gap-1"><AlertTriangle className="h-3.5 w-3.5" /> {st.err}</span> : null}
        </div>
      </div>

      {st.body ? (
        <div className="rounded-xl ring-1 ring-slate-200 overflow-hidden">
          <div className="bg-slate-50 px-3 py-2 text-xs text-slate-500 flex items-center justify-between gap-2 flex-wrap">
            <span>Draft — edit it here before you copy</span>
            {st.model ? <span>{st.model}</span> : null}
          </div>
          {st.missing.filter((tn) => !st.body.includes(tn)).length ? (
            <div className="px-3 py-2 bg-amber-50 border-b border-amber-200 text-xs text-amber-900 flex items-start gap-1.5">
              <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
              <span>
                Check before sending: {st.missing.filter((tn) => !st.body.includes(tn)).length === 1 ? "this PRO isn't" : "these PROs aren't"} in the draft —{" "}
                <span className="font-mono font-semibold">{st.missing.filter((tn) => !st.body.includes(tn)).join(", ")}</span>.
                The AI may have left a shipment out or put another shipment's number on its line. Fix it here or Redraft.
              </span>
            </div>
          ) : null}
          <div className="flex items-center gap-2 px-3 py-2 border-b border-slate-100">
            <span className="text-sm text-slate-500 shrink-0">Subject</span>
            <input value={st.subject} onChange={(e) => patch({ subject: e.target.value })} aria-label="Subject"
              className="flex-1 min-w-0 text-sm font-medium text-slate-900 outline-none bg-transparent" />
          </div>
          <textarea value={st.body} onChange={(e) => patch({ body: e.target.value })} aria-label="Email body"
            rows={Math.min(22, Math.max(10, st.body.split("\n").length + 1))}
            className="w-full px-3 py-3 text-sm text-slate-800 leading-relaxed outline-none resize-y" />
          <div className="flex items-center gap-2 px-3 py-2.5 border-t border-slate-100 bg-slate-50 flex-wrap">
            <button onClick={onCopy} className="inline-flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-lg bg-slate-900 text-white hover:bg-slate-800">
              {st.copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />} {st.copied ? "Copied" : "Copy email"}
            </button>
            {mailto.length <= MAILTO_MAX ? (
              <a href={mailto} className="inline-flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-lg ring-1 ring-slate-200 bg-white text-slate-700 hover:bg-slate-50">
                <Send className="h-4 w-4" /> Open in mail
              </a>
            ) : <span className="text-[11px] text-slate-500">Too long for a mail link — copy and paste it into your mail.</span>}
            <span className="ml-auto">
              {st.started ? (
                <span className="text-xs text-emerald-700 inline-flex items-center gap-1"><CheckCircle2 className="h-3.5 w-3.5" /> Tasks marked in progress</span>
              ) : openCount ? (
                <button onClick={onStart} disabled={st.busy} title="Once the email is sent, move its open tasks to In progress so the board shows you're waiting on a reply"
                  className="inline-flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-lg bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-40">
                  <Play className="h-4 w-4" /> Sent it — mark {openCount} task{openCount === 1 ? "" : "s"} in progress
                </button>
              ) : null}
            </span>
          </div>
        </div>
      ) : null}
    </div>
  );
}
