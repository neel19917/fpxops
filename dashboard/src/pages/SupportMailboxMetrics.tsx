import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { BarChart3, Check, Copy, Inbox, Mail, RefreshCw, Send, Users, AlertTriangle, Clock } from "lucide-react";
import { getMailboxMetrics, type DataGap, type MailboxMetrics } from "../lib/mailboxMetricsApi";
import { ErrorBlock } from "../components/ErrorBlock";
import { fmtNum, fmtRelative } from "../lib/format";

// Admin: reply metrics for the shared support mailbox (freightsupport@).
// Read only. Every time on this page is shown in Pacific time, matching the
// server's day/week/month buckets.

type Period = MailboxMetrics["periods"][number];
type Rep = MailboxMetrics["reps"][number];
type Month = MailboxMetrics["monthly"][number];
type Latest = MailboxMetrics["latest"][number];

const TZ = "America/Los_Angeles";
const MONTH_OPTIONS = [3, 6, 12] as const;

// ---------- formatting (Pacific time) ----------

function fmtPT(s: string | null | undefined, opts: Intl.DateTimeFormatOptions = { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }): string {
  if (!s) return "—";
  const d = new Date(s);
  if (isNaN(d.getTime())) return String(s);
  return d.toLocaleString("en-US", { timeZone: TZ, ...opts }) + " PT";
}

function fmtMonth(m: string, short = false): string {
  const [y, mo] = m.split("-").map(Number);
  if (!y || !mo) return m;
  // Mid-month UTC noon keeps the label on the right month in any zone.
  const d = new Date(Date.UTC(y, mo - 1, 15, 12));
  return d.toLocaleDateString("en-US", { timeZone: "UTC", month: short ? "short" : "long", year: short ? "2-digit" : "numeric" });
}

function pctChange(cur: number, prev: number): number | null {
  if (!prev) return null;
  return ((cur - prev) / prev) * 100;
}

// ---------- rep colors ----------

const REP_COLORS = ["#0284c7", "#7c3aed", "#059669", "#d97706", "#db2777", "#0d9488", "#4f46e5", "#65a30d"];
const SHARED_COLOR = "#64748b";
const UNMATCHED_COLOR = "#cbd5e1";

function repColorMap(names: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  let i = 0;
  for (const n of names) {
    if (/^shared mailbox/i.test(n)) out[n] = SHARED_COLOR;
    else if (/^unmatched/i.test(n)) out[n] = UNMATCHED_COLOR;
    else out[n] = REP_COLORS[i++ % REP_COLORS.length];
  }
  return out;
}

// ---------- small pieces ----------

function Card({ title, icon: Icon, right, children, className = "" }: { title: string; icon?: typeof Mail; right?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`rounded-2xl bg-white ring-1 ring-slate-200 shadow-sm p-5 ${className}`}>
      <div className="flex items-center justify-between gap-3 flex-wrap mb-3">
        <h2 className="text-sm font-semibold text-slate-900 flex items-center gap-2">
          {Icon ? <Icon className="h-4 w-4 text-slate-500" /> : null} {title}
        </h2>
        {right}
      </div>
      {children}
    </section>
  );
}

function ConfidenceBadge({ c }: { c: Rep["confidence"] }) {
  if (c === "confirmed") return null;
  const cls = c === "likely" ? "bg-amber-50 text-amber-700 ring-amber-200" : "bg-slate-100 text-slate-500 ring-slate-200";
  return <span className={`inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-medium ring-1 ${cls}`}>{c}</span>;
}

function DirectionPill({ dir }: { dir: "in" | "out" }) {
  return dir === "in" ? (
    <span className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold ring-1 bg-sky-50 text-sky-700 ring-sky-200">
      <Inbox className="h-3 w-3" /> Received
    </span>
  ) : (
    <span className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold ring-1 bg-emerald-50 text-emerald-700 ring-emerald-200">
      <Send className="h-3 w-3" /> Sent
    </span>
  );
}

function ChangeChip({ pct, label }: { pct: number | null; label: string }) {
  if (pct == null) return <span className="text-xs text-slate-400">{label}: no prior data</span>;
  const up = pct >= 0;
  return (
    <span className={`text-xs font-medium ${up ? "text-emerald-700" : "text-rose-700"}`}>
      {label} {up ? "▲" : "▼"} {Math.abs(pct).toFixed(0)}%
    </span>
  );
}

function CopyButton({ text }: { text: string }) {
  const [state, setState] = useState<"idle" | "ok" | "err">("idle");
  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setState("ok");
    } catch {
      setState("err");
    }
    window.setTimeout(() => setState("idle"), 1800);
  }
  return (
    <button type="button" onClick={copy}
      className="shrink-0 text-xs inline-flex items-center gap-1 px-2 py-1 rounded-md bg-slate-800 text-slate-100 hover:bg-slate-700 ring-1 ring-slate-600">
      {state === "ok" ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
      {state === "ok" ? "Copied" : state === "err" ? "Copy failed" : "Copy"}
    </button>
  );
}

// ---------- skeleton / empty ----------

function Skeleton() {
  return (
    <div className="space-y-5 animate-pulse">
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {[0, 1, 2].map((i) => (
          <div key={i} className="rounded-2xl bg-white ring-1 ring-slate-200 p-5 space-y-3">
            <div className="h-3 w-20 rounded bg-slate-200" />
            <div className="flex gap-6"><div className="h-8 w-16 rounded bg-slate-200" /><div className="h-8 w-16 rounded bg-slate-200" /></div>
            {[0, 1, 2, 3, 4].map((j) => <div key={j} className="h-3 w-full rounded bg-slate-100" />)}
          </div>
        ))}
      </div>
      {[0, 1, 2].map((i) => (
        <div key={i} className="rounded-2xl bg-white ring-1 ring-slate-200 p-5 space-y-3">
          <div className="h-3 w-32 rounded bg-slate-200" />
          {[0, 1, 2, 3].map((j) => <div key={j} className="h-4 w-full rounded bg-slate-100" />)}
        </div>
      ))}
    </div>
  );
}

// ---------- 2. period cards ----------

const PERIOD_LABEL: Record<Period["period"], string> = { today: "Today", week: "This week", month: "This month" };

function PeriodCard({ p }: { p: Period }) {
  const rows: { label: string; value: number; warn?: boolean }[] = [
    { label: "Replies", value: p.replies },
    { label: "Conversations replied to", value: p.conversationsReplied },
    { label: "New conversations started", value: p.newOutbound },
    { label: "Conversations with new email", value: p.inboundConversations },
    { label: "Still waiting on a reply", value: p.awaiting, warn: true },
  ];
  return (
    <div className="rounded-2xl bg-white ring-1 ring-slate-200 shadow-sm p-5">
      <div className="flex items-baseline justify-between gap-2">
        <div className="text-xs font-medium text-slate-500 uppercase tracking-wide">{PERIOD_LABEL[p.period]}</div>
        <div className="text-[11px] text-slate-400">since {fmtPT(p.start, { month: "short", day: "numeric" })}</div>
      </div>
      <div className="flex gap-6 mt-2">
        <div>
          <div className="text-3xl font-semibold text-slate-900">{fmtNum(p.received)}</div>
          <div className="text-xs text-slate-500 flex items-center gap-1"><Inbox className="h-3 w-3" /> Received</div>
        </div>
        <div>
          <div className="text-3xl font-semibold text-slate-900">{fmtNum(p.sent)}</div>
          <div className="text-xs text-slate-500 flex items-center gap-1"><Send className="h-3 w-3" /> Sent</div>
        </div>
      </div>
      <dl className="mt-4 divide-y divide-slate-100 text-sm">
        {rows.map((r) => (
          <div key={r.label} className="flex items-center justify-between py-1.5">
            <dt className="text-slate-600">{r.label}</dt>
            <dd className={r.warn && r.value > 0 ? "font-semibold text-amber-600" : "font-medium text-slate-900"}>{fmtNum(r.value)}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

// ---------- 3. by rep ----------

function RepTable({ reps, colors }: { reps: Rep[]; colors: Record<string, string> }) {
  return (
    <Card title="By rep" icon={Users}>
      {reps.length === 0 ? (
        <div className="text-sm text-slate-500 py-4">No sent email has been attributed yet.</div>
      ) : (
        <div className="overflow-x-auto -mx-5 px-5">
          <table className="w-full text-sm min-w-[720px]">
            <thead className="bg-slate-50 text-xs uppercase text-slate-500">
              <tr>
                <th className="px-3 py-2 text-left">Rep</th>
                <th className="px-3 py-2 text-right">Today</th>
                <th className="px-3 py-2 text-right">This week</th>
                <th className="px-3 py-2 text-right">This month</th>
                <th className="px-3 py-2 text-right">Replies (month)</th>
                <th className="px-3 py-2 text-right">Conv. replied (month)</th>
                <th className="px-3 py-2 text-left">Last sent</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {reps.map((r) => (
                <tr key={r.rep} className="hover:bg-slate-50">
                  <td className="px-3 py-2">
                    <div className="flex items-center gap-2">
                      <span className="h-2.5 w-2.5 rounded-sm shrink-0" style={{ background: colors[r.rep] }} />
                      <span className="font-medium text-slate-900">{r.rep}</span>
                      <ConfidenceBadge c={r.confidence} />
                    </div>
                    {r.email ? <div className="text-xs text-slate-400 pl-[18px]">{r.email}</div> : null}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">{fmtNum(r.today)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{fmtNum(r.week)}</td>
                  <td className="px-3 py-2 text-right tabular-nums font-medium">{fmtNum(r.month)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{fmtNum(r.monthReplies)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{fmtNum(r.monthConversationsReplied)}</td>
                  <td className="px-3 py-2 whitespace-nowrap">
                    {r.lastSentAt ? (
                      <>
                        <span className="text-slate-700">{fmtRelative(r.lastSentAt)}</span>
                        <span className="text-xs text-slate-400 ml-1.5">{fmtPT(r.lastSentAt)}</span>
                      </>
                    ) : <span className="text-slate-300">—</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="text-xs text-slate-500 mt-3 leading-relaxed">
        Every email goes out as "FP Freight Support" with no signature, so reps are identified by the Exchange server in each email's
        Message-ID. <span className="font-medium">Likely</span> means the server was inferred, not confirmed by an email from that person.
        <span className="font-medium"> Shared mailbox</span> means the email was typed directly in freightsupport@, so no person is known.
        <span className="font-medium"> Unmatched sender</span> is a server that hasn't been tied to anyone yet.
      </p>
    </Card>
  );
}

// ---------- 4. month over month ----------

function MonthChart({ monthly, repNames, colors }: { monthly: Month[]; repNames: string[]; colors: Record<string, string> }) {
  const H = 200;
  const padL = 32, padB = 22, padT = 8;
  const groupW = 56;
  const W = padL + monthly.length * groupW + 8;
  const max = Math.max(1, ...monthly.map((m) => Math.max(m.received, m.sent)));
  const step = niceStep(max);
  const top = Math.ceil(max / step) * step;
  const y = (v: number) => padT + (H - padT - padB) * (1 - v / top);
  const ticks: number[] = [];
  for (let v = 0; v <= top; v += step) ticks.push(v);
  const barW = 18;

  return (
    <div className="overflow-x-auto">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full min-w-[320px]" style={{ maxHeight: 260 }} role="img" aria-label="Received and sent by rep per month">
        {ticks.map((t) => (
          <g key={t}>
            <line x1={padL} x2={W - 4} y1={y(t)} y2={y(t)} stroke="#e2e8f0" strokeWidth={1} />
            <text x={padL - 4} y={y(t) + 3} textAnchor="end" fontSize={9} fill="#94a3b8">{t}</text>
          </g>
        ))}
        {monthly.map((m, i) => {
          const gx = padL + i * groupW + (groupW - barW * 2 - 4) / 2;
          const partial = i === monthly.length - 1;
          let acc = 0;
          return (
            <g key={m.month} opacity={partial ? 0.75 : 1}>
              <rect x={gx} y={y(m.received)} width={barW} height={Math.max(0, y(0) - y(m.received))} fill="#bae6fd" rx={2}>
                <title>{`${fmtMonth(m.month)}: ${m.received} received`}</title>
              </rect>
              {repNames.map((r) => {
                const v = m.byRep[r] || 0;
                if (!v) return null;
                const y1 = y(acc + v), y0 = y(acc);
                acc += v;
                return (
                  <rect key={r} x={gx + barW + 4} y={y1} width={barW} height={Math.max(0, y0 - y1)} fill={colors[r] || UNMATCHED_COLOR}>
                    <title>{`${fmtMonth(m.month)} · ${r}: ${v} sent`}</title>
                  </rect>
                );
              })}
              {/* Sends not attributed to a listed rep, if any. */}
              {m.sent > acc ? (
                <rect x={gx + barW + 4} y={y(m.sent)} width={barW} height={Math.max(0, y(acc) - y(m.sent))} fill={UNMATCHED_COLOR}>
                  <title>{`${fmtMonth(m.month)} · other: ${m.sent - acc} sent`}</title>
                </rect>
              ) : null}
              <text x={padL + i * groupW + groupW / 2} y={H - 8} textAnchor="middle" fontSize={10} fill="#64748b">
                {fmtMonth(m.month, true)}{partial ? "*" : ""}
              </text>
            </g>
          );
        })}
        <line x1={padL} x2={W - 4} y1={y(0)} y2={y(0)} stroke="#94a3b8" strokeWidth={1} />
      </svg>
      <div className="flex flex-wrap gap-x-4 gap-y-1 mt-2 text-xs text-slate-600">
        <span className="inline-flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-sm" style={{ background: "#bae6fd" }} /> Received</span>
        {repNames.map((r) => (
          <span key={r} className="inline-flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-sm" style={{ background: colors[r] }} /> Sent · {r}</span>
        ))}
      </div>
    </div>
  );
}

function niceStep(max: number): number {
  const raw = max / 4;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const n = raw / mag;
  const s = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10;
  return Math.max(1, s * mag);
}

function MonthOverMonth({ monthly, repNames, colors }: { monthly: Month[]; repNames: string[]; colors: Record<string, string> }) {
  // Compare the last full month with the one before it (the newest month is partial).
  const full = monthly.slice(0, -1);
  const last = full[full.length - 1];
  const prev = full[full.length - 2];
  const right = last && prev ? (
    <div className="flex items-center gap-3 flex-wrap">
      <span className="text-xs text-slate-500">{fmtMonth(last.month, true)} vs {fmtMonth(prev.month, true)}:</span>
      <ChangeChip pct={pctChange(last.received, prev.received)} label="Received" />
      <ChangeChip pct={pctChange(last.sent, prev.sent)} label="Sent" />
    </div>
  ) : null;
  const rows = [...monthly].reverse();
  return (
    <Card title="Month over month" icon={BarChart3} right={right}>
      {monthly.length === 0 ? (
        <div className="text-sm text-slate-500 py-4">No monthly data yet.</div>
      ) : (
        <>
          <MonthChart monthly={monthly} repNames={repNames} colors={colors} />
          <div className="overflow-x-auto -mx-5 px-5 mt-4">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-xs uppercase text-slate-500">
                <tr>
                  <th className="px-3 py-2 text-left">Month</th>
                  <th className="px-3 py-2 text-right">Received</th>
                  <th className="px-3 py-2 text-right">Sent</th>
                  <th className="px-3 py-2 text-right">Replies</th>
                  {repNames.map((r) => <th key={r} className="px-3 py-2 text-right whitespace-nowrap normal-case font-medium">{r}</th>)}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {rows.map((m, i) => (
                  <tr key={m.month}>
                    <td className="px-3 py-1.5 whitespace-nowrap text-slate-800">
                      {fmtMonth(m.month)}{i === 0 ? <span className="ml-1.5 text-[10px] text-slate-400 uppercase">partial</span> : null}
                    </td>
                    <td className="px-3 py-1.5 text-right tabular-nums">{fmtNum(m.received)}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums font-medium">{fmtNum(m.sent)}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums">{fmtNum(m.replies)}</td>
                    {repNames.map((r) => (
                      <td key={r} className="px-3 py-1.5 text-right tabular-nums text-slate-600">{m.byRep[r] ? fmtNum(m.byRep[r]) : <span className="text-slate-300">0</span>}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-xs text-slate-500 mt-2">* {fmtMonth(monthly[monthly.length - 1].month)} is the current month and is partial. Percent change compares the last two full months.</p>
        </>
      )}
    </Card>
  );
}

// ---------- 5. data gaps ----------

const OWNERS: DataGap["owner"][] = ["Allen", "Support team", "FPX"];
const SEV_RANK: Record<DataGap["severity"], number> = { high: 0, medium: 1, low: 2 };
const SEV_CLS: Record<DataGap["severity"], string> = {
  high: "bg-rose-50 text-rose-700 ring-rose-200",
  medium: "bg-amber-50 text-amber-700 ring-amber-200",
  low: "bg-slate-100 text-slate-600 ring-slate-200",
};
const OWNER_NOTE: Record<DataGap["owner"], string> = {
  Allen: "Exchange admin",
  "Support team": "How the team sends and replies",
  FPX: "This app",
};

// Pull a PowerShell command out of the fix text so it can be shown in a code block.
function splitFix(fix: string): { text: string; code: string | null } {
  const m = fix.match(/((?:Set|Get|New|Add|Enable|Search)-[A-Za-z]+\b[^\n`]*)/);
  const tick = fix.match(/`([^`]+)`/);
  if (tick && /^[A-Z][a-z]+-[A-Za-z]+/.test(tick[1].trim())) {
    return { text: fix.replace(tick[0], "").replace(/\s*:\s*$/, "").trim(), code: tick[1].trim() };
  }
  if (!m || m.index == null) return { text: fix, code: null };
  const code = m[1].trim().replace(/[.;]\s*$/, "");
  const text = (fix.slice(0, m.index) + fix.slice(m.index + m[1].length)).replace(/\s*:\s*$/, "").replace(/\s{2,}/g, " ").trim();
  return { text, code };
}

function GapCard({ g }: { g: DataGap }) {
  const { text, code } = splitFix(g.fix);
  return (
    <div className="rounded-xl ring-1 ring-slate-200 bg-white p-4 space-y-2">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2 flex-wrap min-w-0">
          <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold ring-1 uppercase ${SEV_CLS[g.severity]}`}>{g.severity}</span>
          <h3 className="text-sm font-semibold text-slate-900">{g.title}</h3>
        </div>
        {g.metric != null ? <div className="text-xl font-semibold text-slate-900 tabular-nums shrink-0">{fmtNum(g.metric)}</div> : null}
      </div>
      <p className="text-sm text-slate-600 leading-relaxed">{g.detail}</p>
      <div className="text-sm">
        <span className="font-medium text-slate-800">Fix: </span>
        {text ? <span className="text-slate-700">{text}</span> : null}
      </div>
      {code ? (
        <div className="rounded-lg bg-slate-900 text-slate-100 p-3 flex items-start gap-3">
          <pre className="font-mono text-xs whitespace-pre-wrap break-all flex-1 min-w-0">{code}</pre>
          <CopyButton text={code} />
        </div>
      ) : null}
    </div>
  );
}

function DataGaps({ gaps }: { gaps: DataGap[] }) {
  return (
    <Card title="Data gaps" icon={AlertTriangle} right={<span className="text-xs text-slate-500">What's keeping these numbers from being complete</span>}>
      {gaps.length === 0 ? (
        <div className="text-sm text-emerald-700 py-2 flex items-center gap-1.5"><Check className="h-4 w-4" /> No data gaps found.</div>
      ) : (
        <div className="space-y-5">
          {OWNERS.map((owner) => {
            const list = gaps.filter((g) => g.owner === owner).sort((a, b) => SEV_RANK[a.severity] - SEV_RANK[b.severity]);
            if (!list.length) return null;
            return (
              <div key={owner}>
                <div className="text-xs font-semibold uppercase tracking-wide text-slate-500 mb-2">
                  {owner} <span className="normal-case font-normal text-slate-400">· {OWNER_NOTE[owner]}</span>
                </div>
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
                  {list.map((g) => <GapCard key={g.id} g={g} />)}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}

// ---------- 6. latest emails ----------

function LatestEmails({ latest }: { latest: Latest[] }) {
  return (
    <Card title="Latest emails" icon={Mail}>
      {latest.length === 0 ? (
        <div className="text-sm text-slate-500 py-4">No emails synced yet.</div>
      ) : (
        <div className="overflow-x-auto -mx-5 px-5">
          <table className="w-full text-sm min-w-[720px]">
            <thead className="bg-slate-50 text-xs uppercase text-slate-500">
              <tr>
                <th className="px-3 py-2 text-left">Time</th>
                <th className="px-3 py-2 text-left" />
                <th className="px-3 py-2 text-left">Sender</th>
                <th className="px-3 py-2 text-left">Rep</th>
                <th className="px-3 py-2 text-left">Subject</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {latest.slice(0, 10).map((e) => (
                <tr key={e.id} className="align-top">
                  <td className="px-3 py-2 whitespace-nowrap text-slate-600">{fmtPT(e.at)}</td>
                  <td className="px-3 py-2"><DirectionPill dir={e.direction} /></td>
                  <td className="px-3 py-2 text-slate-800 max-w-[180px] truncate" title={e.sender ?? ""}>{e.sender || "—"}</td>
                  <td className="px-3 py-2 text-slate-600 whitespace-nowrap">{e.direction === "out" ? (e.rep || "—") : <span className="text-slate-300">—</span>}</td>
                  <td className="px-3 py-2 max-w-[420px]">
                    <div className="font-medium text-slate-900 truncate" title={e.subject ?? ""}>{e.subject || "(no subject)"}</div>
                    {e.preview ? <div className="text-xs text-slate-500 line-clamp-2">{e.preview}</div> : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

// ---------- page ----------

export default function SupportMailboxMetricsPage() {
  const [months, setMonths] = useState<number>(6);
  const [data, setData] = useState<MailboxMetrics | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const reqId = useRef(0);

  const load = useCallback(async (m: number) => {
    const id = ++reqId.current;
    setLoading(true);
    try {
      const d = await getMailboxMetrics(m);
      if (id !== reqId.current) return;
      setData(d);
      setError(null);
    } catch (e) {
      if (id !== reqId.current) return;
      setError((e as Error).message || "Could not load mailbox metrics.");
    } finally {
      if (id === reqId.current) setLoading(false);
    }
  }, []);

  useEffect(() => { load(months); }, [load, months]);

  const repNames = useMemo(() => {
    if (!data) return [] as string[];
    const names = new Set<string>(data.reps.map((r) => r.rep));
    for (const m of data.monthly) for (const k of Object.keys(m.byRep)) names.add(k);
    // People first, then shared mailbox, then unmatched.
    const rank = (n: string) => (/^shared mailbox/i.test(n) ? 1 : /^unmatched/i.test(n) ? 2 : 0);
    return [...names].sort((a, b) => rank(a) - rank(b));
  }, [data]);
  const colors = useMemo(() => repColorMap(repNames), [repNames]);

  const periods = useMemo(() => {
    if (!data) return [] as Period[];
    const order: Period["period"][] = ["today", "week", "month"];
    return order.map((p) => data.periods.find((x) => x.period === p)).filter((x): x is Period => !!x);
  }, [data]);

  const isEmpty = !!data && data.periods.every((p) => p.received === 0 && p.sent === 0)
    && data.monthly.every((m) => m.received === 0 && m.sent === 0) && data.latest.length === 0;

  return (
    <div className="space-y-5 max-w-6xl">
      {/* 1. Header */}
      <div className="flex items-end justify-between gap-3 flex-wrap">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold flex items-center gap-2">
            <BarChart3 className="h-5 w-5 text-sky-600" /> Mailbox Metrics
          </h1>
          <p className="text-sm text-slate-500 mt-0.5">
            {data ? (
              <>
                {data.mailbox} · as of {fmtPT(data.asOf)} · last sync{" "}
                {data.lastSyncAt ? <span title={fmtPT(data.lastSyncAt)}>{fmtRelative(data.lastSyncAt)} ({fmtPT(data.lastSyncAt, { hour: "numeric", minute: "2-digit" })})</span> : "never"}
              </>
            ) : "Reply metrics for the shared support mailbox. All times Pacific."}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className="inline-flex rounded-lg ring-1 ring-slate-200 bg-white overflow-hidden text-sm" role="group" aria-label="Months shown">
            {MONTH_OPTIONS.map((m) => (
              <button key={m} type="button" onClick={() => setMonths(m)}
                className={`px-2.5 py-1.5 ${months === m ? "bg-sky-600 text-white" : "text-slate-600 hover:bg-slate-50"}`}>
                {m} mo
              </button>
            ))}
          </div>
          <button onClick={() => load(months)} disabled={loading}
            className="text-sm text-slate-600 hover:text-slate-900 inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg ring-1 ring-slate-200 bg-white hover:bg-slate-50 disabled:opacity-50">
            <RefreshCw className={"h-4 w-4 " + (loading ? "animate-spin" : "")} /> Refresh
          </button>
        </div>
      </div>

      {error ? (
        <ErrorBlock>
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <span>{error}</span>
            <button onClick={() => load(months)} disabled={loading}
              className="text-sm px-2.5 py-1 rounded-md bg-white ring-1 ring-rose-200 text-rose-700 hover:bg-rose-50 disabled:opacity-50 inline-flex items-center gap-1">
              <RefreshCw className={"h-3.5 w-3.5 " + (loading ? "animate-spin" : "")} /> Retry
            </button>
          </div>
        </ErrorBlock>
      ) : null}

      {!data && loading ? <Skeleton /> : null}

      {data && isEmpty ? (
        <div className="rounded-2xl bg-white ring-1 ring-slate-200 shadow-sm p-10 text-center">
          <Inbox className="h-8 w-8 text-slate-300 mx-auto" />
          <div className="mt-2 text-sm font-medium text-slate-700">No email synced for {data.mailbox} yet</div>
          <div className="text-xs text-slate-500 mt-1 flex items-center justify-center gap-1">
            <Clock className="h-3 w-3" /> Metrics appear once the mailbox sync has pulled messages.
          </div>
        </div>
      ) : null}

      {data && !isEmpty ? (
        <div className={`space-y-5 ${loading ? "opacity-60 transition-opacity" : ""}`}>
          {/* 2. Periods */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {periods.map((p) => <PeriodCard key={p.period} p={p} />)}
          </div>

          {/* 3. By rep */}
          <RepTable reps={data.reps} colors={colors} />

          {/* 4. Month over month */}
          <MonthOverMonth monthly={data.monthly} repNames={repNames} colors={colors} />

          {/* 5. Data gaps */}
          <DataGaps gaps={data.gaps} />

          {/* 6. Latest */}
          <LatestEmails latest={data.latest} />
        </div>
      ) : null}
    </div>
  );
}
