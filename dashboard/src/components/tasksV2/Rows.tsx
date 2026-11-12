// Board table rows: optional group header + one row per task.
import { useMemo, useState } from "react";
import { Ban, CheckCircle2, ChevronDown, ChevronRight, ExternalLink, Play, RotateCcw } from "lucide-react";
import type { TaskBoardRow, TaskFlag, TaskStatus } from "../../lib/types";
import { fmtDate, fmtRelative } from "../../lib/format";
import { RowAnnotations } from "./RowAnnotations";
import { FLAG_CLS, IconBtn, Pill, PRIORITY_CLS, SEGMENT_CLS, SEGMENT_SHORT, STATUS_CLS, STATUS_LABEL, TrackingLink, isActive, shipmentStatusTone, shortTitle, taskMode, MODE_CLS } from "./shared";
import { modeLabel } from "../ModePicker";

export function GroupRows({ group, showHeader, collapsed, onToggle, onSelectGroup, selected, toggle, triageRank, closeCandidateIds, staleDays, flagsMeta, segmentHelp, people, onOpen, onStatus, onDismiss }: {
  group: { key: string; label: string; rows: TaskBoardRow[] };
  showHeader: boolean; collapsed: boolean; onToggle: () => void; onSelectGroup: () => void;
  selected: Set<string>; toggle: (id: string) => void;
  triageRank: Map<string, number>; closeCandidateIds: Set<string>; staleDays: number;
  flagsMeta: { id: TaskFlag; label: string; tone: string; description: string }[];
  segmentHelp: Record<string, string>;
  people: Record<string, string>;
  onOpen: (id: string) => void; onStatus: (id: string, s: TaskStatus, opts?: { open?: boolean }) => void; onDismiss: (id: string) => void;
}) {
  const flagMeta = useMemo(() => new Map(flagsMeta.map((f) => [f.id, f])), [flagsMeta]);
  return (
    <>
      {showHeader ? (
        <tr className="bg-slate-50/70 border-t border-slate-200">
          <td colSpan={9} className="px-3 py-1.5">
            <div className="flex items-center gap-2 text-sm">
              <button onClick={onToggle} className="inline-flex items-center gap-1 font-medium text-slate-800 hover:text-slate-950">
                {collapsed ? <ChevronRight className="h-4 w-4 text-slate-400" /> : <ChevronDown className="h-4 w-4 text-slate-400" />}
                {group.label}
              </button>
              <span className="text-xs text-slate-500">{group.rows.length}</span>
              <button onClick={onSelectGroup} className="ml-auto text-xs text-sky-700 hover:underline">Select group</button>
            </div>
          </td>
        </tr>
      ) : null}
      {!collapsed ? group.rows.map((r) => (
        <TaskRow
          key={r.task.id}
          row={r}
          checked={selected.has(r.task.id)}
          onCheck={() => toggle(r.task.id)}
          rank={triageRank.get(r.task.id)}
          closeCandidate={closeCandidateIds.has(r.task.id)}
          staleDays={staleDays}
          flagMeta={flagMeta}
          segmentHelp={segmentHelp}
          people={people}
          onOpen={() => onOpen(r.task.id)}
          onStatus={(s, opts) => onStatus(r.task.id, s, opts)}
          onDismiss={() => onDismiss(r.task.id)}
        />
      )) : null}
    </>
  );
}

function TaskRow({ row, checked, onCheck, rank, closeCandidate, staleDays, flagMeta, segmentHelp, people, onOpen, onStatus, onDismiss }: {
  row: TaskBoardRow; checked: boolean; onCheck: () => void; rank?: number; closeCandidate: boolean; staleDays: number;
  flagMeta: Map<string, { id: TaskFlag; label: string; tone: string; description: string }>;
  segmentHelp: Record<string, string>;
  people: Record<string, string>;
  onOpen: () => void; onStatus: (s: TaskStatus, opts?: { open?: boolean }) => void; onDismiss: () => void;
}) {
  const { task: t, shipment: s, seg } = row;
  const active = isActive(t.status);
  const moot = seg.flags.includes("resolved_upstream");
  const stale = seg.flags.includes("stale");
  const st = shipmentStatusTone(s?.shipment_status);
  const [expanded, setExpanded] = useState(false);
  return (
    <>
    <tr className={`border-t border-slate-100 align-top ${checked ? "bg-violet-50/40" : moot ? "bg-emerald-50/20" : ""} ${!active ? "opacity-60" : ""}`}>
      <td className="px-3 py-2.5"><input type="checkbox" checked={checked} onChange={onCheck} aria-label="Select task" className="accent-violet-600 mt-0.5" /></td>
      <td className="px-3 py-2.5 min-w-[22rem]">
        <div className="flex items-center gap-1.5 flex-wrap mb-1">
          {rank !== undefined ? <Pill cls="bg-violet-600 text-white ring-violet-600" title="AI triage priority rank">#{rank}</Pill> : null}
          <Pill cls={SEGMENT_CLS[seg.segment]}>{SEGMENT_SHORT[seg.segment]}{seg.attempt && seg.attempt > 1 ? ` · attempt ${seg.attempt}` : ""}</Pill>
          <Pill cls={PRIORITY_CLS[t.priority]}>{t.priority}</Pill>
          {seg.flags.filter((f) => f !== "unassigned" && f !== "blocked").map((f) => {
            const m = flagMeta.get(f);
            return <Pill key={f} cls={FLAG_CLS[m?.tone || "slate"]} title={m?.description}>{m?.label || f}</Pill>;
          })}
          {closeCandidate ? <Pill cls="bg-emerald-600 text-white ring-emerald-600" title="AI triage suggests dismissing this task">AI: close</Pill> : null}
        </div>
        <button onClick={onOpen} className="text-left font-medium text-slate-900 hover:text-sky-700 leading-snug line-clamp-2" title={t.title}>{shortTitle(t.title)}</button>
        {seg.health ? <div className="text-xs text-slate-500 mt-0.5">{seg.health}</div> : null}
        <button type="button" onClick={() => setExpanded((v) => !v)} aria-expanded={expanded}
          className="mt-1 inline-flex items-center gap-0.5 text-[11px] text-violet-700 hover:text-violet-900 hover:underline">
          {expanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />} {expanded ? "Hide details" : "Why this task? · add note"}
        </button>
      </td>
      <td className="px-3 py-2.5 min-w-[14rem]">
        {s ? (
          <div className="space-y-0.5">
            <div className="flex items-center gap-1.5 flex-wrap">
              <TrackingLink tracking={s.tracking_number} carrier={s.carrier_name || s.carrier} onOpen={onOpen} className="text-xs" />
              {s.shipment_id ? <span className="text-[11px] text-slate-400">#{s.shipment_id}</span> : null}
            </div>
            <div className="text-xs text-slate-700 truncate max-w-[16rem]" title={s.customer_name || ""}>{s.customer_name || "—"}</div>
            <div className="flex items-center gap-1.5 flex-wrap">
              <span className="text-xs text-slate-500 truncate max-w-[9rem]" title={s.carrier_name || s.carrier || ""}>{s.carrier_name || s.carrier || "—"}</span>
              <Pill cls={st.cls}>{st.label}</Pill>
              {s.delivery_date ? <Pill cls="bg-emerald-100 text-emerald-800 ring-emerald-200" title={`Delivered ${fmtDate(s.delivery_date)}`}>delivered</Pill>
                : s.updated_eta ? <span className="text-[11px] text-slate-500">ETA {fmtDate(s.updated_eta)}</span> : null}
            </div>
          </div>
        ) : <span className="text-xs text-slate-400">no shipment</span>}
      </td>
      <td className="px-3 py-2.5">
        {taskMode(row) ? <Pill cls={MODE_CLS[taskMode(row)] || FLAG_CLS.slate} title={`Shipment mode: ${taskMode(row)}`}>{modeLabel(taskMode(row))}</Pill>
          : <span className="text-xs text-slate-400" title={s ? "FreightPOP gave no mode for this shipment" : "No shipment linked"}>—</span>}
      </td>
      <td className="px-3 py-2.5">
        {s ? (
          <div className={`text-xs ${stale ? "text-amber-700 font-medium" : "text-slate-600"}`} title={s.scraped_at ? `Scraped ${fmtDate(s.scraped_at)} · stale after ${staleDays}d` : "Never scraped"}>
            <div>{s.scraped_at ? fmtRelative(s.scraped_at) : "never"}</div>
            <div className="text-[11px] text-slate-400">scraped</div>
          </div>
        ) : null}
      </td>
      <td className="px-3 py-2.5 text-xs text-slate-600" title={`Created ${fmtDate(t.created_at)}`}>{seg.age_days === null ? "—" : seg.age_days === 0 ? "today" : `${seg.age_days}d`}</td>
      <td className="px-3 py-2.5 text-xs">
        {t.assigned_to ? <span className="text-slate-800" title={t.assigned_to}>{people[t.assigned_to] || t.assigned_to}</span> : <Pill cls={FLAG_CLS.slate}>unassigned</Pill>}
      </td>
      <td className="px-3 py-2.5"><Pill cls={STATUS_CLS[t.status]}>{STATUS_LABEL[t.status]}</Pill></td>
      <td className="px-3 py-2.5">
        <div className="flex items-center justify-end gap-1">
          {t.status === "open" ? (
            <IconBtn title="Start and open" onClick={() => onStatus("in_progress", { open: true })} cls="text-indigo-700 hover:bg-indigo-50"><Play className="h-4 w-4" /></IconBtn>
          ) : null}
          {active ? (
            <IconBtn title="Mark done" onClick={() => onStatus("done")} cls="text-emerald-700 hover:bg-emerald-50"><CheckCircle2 className="h-4 w-4" /></IconBtn>
          ) : (
            <IconBtn title="Reopen" onClick={() => onStatus("open")} cls="text-slate-600 hover:bg-slate-100"><RotateCcw className="h-4 w-4" /></IconBtn>
          )}
          {active ? <IconBtn title="Dismiss with reason" onClick={onDismiss} cls="text-slate-500 hover:bg-slate-100"><Ban className="h-4 w-4" /></IconBtn> : null}
          <IconBtn title="Open shipment" onClick={onOpen} cls="text-sky-700 hover:bg-sky-50"><ExternalLink className="h-4 w-4" /></IconBtn>
        </div>
      </td>
    </tr>
    {expanded ? (
      <tr className={checked ? "bg-violet-50/40" : "bg-slate-50/60"}>
        <td />
        <td colSpan={8} className="px-3 pb-3 pt-1 border-l-2 border-violet-300">
          <RowAnnotations row={row} rank={rank} closeCandidate={closeCandidate} staleDays={staleDays} flagMeta={flagMeta} segmentHelp={segmentHelp} />
        </td>
      </tr>
    ) : null}
    </>
  );
}
