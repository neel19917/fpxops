// Right sidebar of an open conversation: who it is with (party), the FPX
// shipments it is linked to, their tasks, and other conversations about the
// same shipments. Links are found by the server's linker; a person can add a
// link by hand, hide a wrong one (flagged, never deleted) or change the party.
// With view-only access (readOnly) the values show but none of those controls do.
// A linked shipment that is in FPX gets the email logged in its notes ("Logged on
// shipment"); numbers found in the emails that match no FPX shipment are listed
// under "Not in FPX" with a search link and a one-click fill of the link input.
import { useCallback, useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { Link } from "react-router-dom";
import { ArrowRight, CheckCircle2, Link2, ListChecks, Loader2, Mail, Package, Plus, Search, SearchX, Users, X } from "lucide-react";
import {
  dismissLink, getThreadContext, linkShipment, setDomainParty, setThreadParty,
  type ContextShipment, type ContextTask, type NotInFpx, type Party, type ThreadContext,
} from "../../lib/mailboxApi";
import { useCached } from "../../lib/useCached";
import { invalidateCache } from "../../lib/sessionCache";
import { fmtDate, fmtDateTime, fmtRelative } from "../../lib/format";
import { ErrorBlock } from "../ErrorBlock";
import { LoadingState } from "../LoadingState";
import { PARTY_CHOICES, PartyTag, ThreadStatusBadge, asParty } from "./shared";

export const threadContextKey = (conversationId: string) => `mailbox:context:${conversationId}`;

type Choice = Exclude<Party, "unknown">;

const SOURCE_LABEL: Record<string, string> = { rule: "by rule", ai: "by AI", person: "set by a person" };
const KIND_LABEL: Record<string, string> = {
  shipment_id: "Shipment", tracking: "PRO", bol: "BOL", po: "PO", load: "Load", reference: "Ref",
  pickup: "Pickup", confirmation: "Conf", number: "No.",
};

const MATCHED_LABEL: Record<string, string> = {
  shipment_id: "shipment id", tracking_number: "tracking / PRO", order_number: "PO / order", reference: "reference",
  pickup_number: "pickup number", confirmation_number: "confirmation number", manual: "linked by hand",
};

interface Props {
  conversationId: string;
  onOpenThread: (conversationId: string) => void;
  /** Shows a close button in the panel header. */
  onClose?: () => void;
  /** View-only access: no link / dismiss / party controls, values shown read-only. */
  readOnly?: boolean;
}

export function ThreadSidebar({ conversationId, onOpenThread, onClose, readOnly = false }: Props) {
  const fetcher = useCallback((signal: AbortSignal) => getThreadContext(conversationId, signal), [conversationId]);
  const { data, error, refresh } = useCached(threadContextKey(conversationId), fetcher);
  const [busy, setBusy] = useState<string | null>(null);
  const [actionErr, setActionErr] = useState<string | null>(null);
  // Value + bump counter so clicking "Link" on the same number twice re-fills the input.
  const [prefill, setPrefill] = useState<{ value: string; n: number } | null>(null);

  /** Runs a write, then refreshes the sidebar and the conversation list. */
  const run = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key);
    setActionErr(null);
    try {
      await fn();
      invalidateCache(threadContextKey(conversationId));
      invalidateCache("mailbox:threads:");
      return true;
    } catch (e) {
      setActionErr((e as Error)?.message || "That did not work. Try again.");
      return false;
    } finally {
      setBusy(null);
    }
  };

  const head = (
    <div className="sticky top-0 z-10 flex items-center gap-2 px-4 py-2 border-b border-slate-200 bg-inherit backdrop-blur">
      <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-600 flex-1">Details</h2>
      {onClose ? (
        <button type="button" onClick={onClose} aria-label="Close details" title="Close (Esc)"
          className="p-1 rounded text-slate-400 hover:text-slate-700 hover:bg-slate-200/60"><X className="h-4 w-4" /></button>
      ) : null}
    </div>
  );

  if (!data) {
    return (
      <div>
        {head}
        <div className="p-4">
        {error
          ? <ErrorBlock compact>{error} <button type="button" onClick={refresh} className="underline ml-1">Retry</button></ErrorBlock>
          : <LoadingState />}
        </div>
      </div>
    );
  }

  return (
    <div>
    {head}
    <div className="p-4 space-y-5 text-sm">
      {actionErr ? <ErrorBlock compact>{actionErr}</ErrorBlock> : null}
      {error ? <ErrorBlock compact tone="warning">Could not refresh: {error}</ErrorBlock> : null}
      <PartySection ctx={data} busy={busy} readOnly={readOnly}
        onSetThread={(p) => run("party", () => setThreadParty(conversationId, p))}
        onSetDomain={(d, p) => run(`domain:${d}`, () => setDomainParty(d, p))} />
      <ShipmentsSection shipments={data.shipments} busy={busy} readOnly={readOnly}
        onDismiss={(linkId) => run(`dismiss:${linkId}`, () => dismissLink(linkId))}
        prefill={prefill}
        onLink={(id) => run("link", () => linkShipment(conversationId, id))} />
      <NotInFpxSection items={data.not_in_fpx ?? []} readOnly={readOnly}
        onLink={(value) => setPrefill((p) => ({ value, n: (p?.n ?? 0) + 1 }))} />
      <TasksSection tasks={data.tasks} />
      <RelatedSection threads={data.related_threads} onOpen={onOpenThread} />
    </div>
    </div>
  );
}

function SectionTitle({ icon: Icon, children, count }: { icon: typeof Users; children: string; count?: number }) {
  return (
    <h3 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-slate-500 mb-2">
      <Icon className="h-3.5 w-3.5" /> {children}
      {count ? <span className="ml-1 rounded-full bg-slate-100 text-slate-600 px-1.5 text-[10px]">{count}</span> : null}
    </h3>
  );
}

const selectCls = "text-xs rounded-md ring-1 ring-slate-200 bg-white px-1.5 py-1 focus:outline-none focus:ring-violet-400 disabled:opacity-50";

function PartySection({ ctx, busy, readOnly, onSetThread, onSetDomain }: {
  ctx: ThreadContext;
  busy: string | null;
  readOnly: boolean;
  onSetThread: (p: Choice) => Promise<boolean>;
  onSetDomain: (domain: string, p: Choice) => Promise<boolean>;
}) {
  const party = asParty(ctx.party?.party);
  const source = ctx.party?.source ? SOURCE_LABEL[ctx.party.source] || ctx.party.source : null;
  return (
    <section>
      <SectionTitle icon={Users}>Party</SectionTitle>
      <div className="flex items-center gap-2 flex-wrap">
        <PartyTag party={party} className="text-xs" />
        {!readOnly ? (
          <select
            aria-label="Change party"
            value=""
            disabled={busy === "party"}
            onChange={(e) => { if (e.target.value) void onSetThread(e.target.value as Choice); }}
            className={selectCls}
          >
            <option value="">Change…</option>
            {PARTY_CHOICES.filter((c) => c.id !== party).map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
          </select>
        ) : null}
        {busy === "party" ? <Loader2 className="h-3.5 w-3.5 animate-spin text-slate-400" /> : null}
      </div>
      {source || ctx.party?.reason ? (
        <p className="mt-1 text-xs text-slate-500">
          {source ? <span>{source}{ctx.party?.set_by && ctx.party.source === "person" ? ` (${ctx.party.set_by})` : ""}</span> : null}
          {source && ctx.party?.reason ? " · " : null}
          {ctx.party?.reason || null}
        </p>
      ) : null}
      {readOnly ? (
        ctx.sender_domains?.some((d) => d.party) ? (
          <ul className="mt-2 space-y-1">
            {ctx.sender_domains.filter((d) => d.party).map((d) => (
              <li key={d.domain} className="flex items-center gap-1.5 flex-wrap text-xs text-slate-600">
                <span className="font-medium text-slate-800 break-all">{d.domain}</span>
                <span>is always</span>
                <PartyTag party={d.party} />
              </li>
            ))}
          </ul>
        ) : null
      ) : ctx.sender_domains?.length ? (
        <ul className="mt-2 space-y-1.5">
          {ctx.sender_domains.map((d) => (
            <li key={d.domain} className="flex items-center gap-1.5 flex-wrap text-xs text-slate-600">
              <span>Always treat <span className="font-medium text-slate-800 break-all">{d.domain}</span> as</span>
              <select
                aria-label={`Party for ${d.domain}`}
                value={d.party || ""}
                disabled={busy === `domain:${d.domain}`}
                onChange={(e) => { if (e.target.value) void onSetDomain(d.domain, e.target.value as Choice); }}
                className={selectCls}
              >
                {!d.party ? <option value="">not set</option> : null}
                {PARTY_CHOICES.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
              </select>
              {busy === `domain:${d.domain}` ? <Loader2 className="h-3.5 w-3.5 animate-spin text-slate-400" /> : null}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

function ShipmentsSection({ shipments, busy, readOnly, prefill, onDismiss, onLink }: {
  shipments: ContextShipment[];
  busy: string | null;
  readOnly: boolean;
  prefill: { value: string; n: number } | null;
  onDismiss: (linkId: string) => Promise<boolean>;
  onLink: (shipmentId: string) => Promise<boolean>;
}) {
  const [input, setInput] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!prefill) return;
    setInput(prefill.value);
    inputRef.current?.focus();
    inputRef.current?.scrollIntoView({ block: "nearest" });
  }, [prefill]);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const id = input.trim().replace(/^#/, "");
    if (!id) return;
    if (await onLink(id)) setInput("");
  };
  return (
    <section>
      <SectionTitle icon={Package} count={shipments.length}>Shipments</SectionTitle>
      {shipments.length ? (
        <ul className="space-y-2">
          {shipments.map((s) => <ShipmentCard key={s.link_id || s.shipment_id} s={s} busy={busy === `dismiss:${s.link_id}`} onDismiss={readOnly ? undefined : () => onDismiss(s.link_id)} />)}
        </ul>
      ) : <p className="text-xs text-slate-500">No shipments linked yet.</p>}
      {!readOnly ? <form onSubmit={submit} className="mt-2 flex items-center gap-1.5">
        <label className="sr-only" htmlFor="mailbox-link-shipment">Link a shipment</label>
        <input
          id="mailbox-link-shipment"
          ref={inputRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Link a shipment (shipment id)"
          className="min-w-0 flex-1 text-xs rounded-md ring-1 ring-slate-200 bg-white px-2 py-1.5 focus:outline-none focus:ring-violet-400"
        />
        <button type="submit" disabled={!input.trim() || busy === "link"}
          className="shrink-0 inline-flex items-center gap-1 text-xs px-2 py-1.5 rounded-md bg-violet-600 text-white hover:bg-violet-700 disabled:opacity-50">
          {busy === "link" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />} Link
        </button>
      </form> : null}
    </section>
  );
}

function ShipmentCard({ s, busy, onDismiss }: { s: ContextShipment; busy: boolean; onDismiss?: () => void }) {
  const lane = [s.origin, s.destination].filter(Boolean).join(" → ");
  const matched = s.matched_on ? MATCHED_LABEL[s.matched_on] || s.matched_on : null;
  return (
    <li className="rounded-lg ring-1 ring-slate-200 bg-white px-3 py-2">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="font-semibold text-slate-900">Shipment {s.shipment_id}</div>
          {s.shipment_status ? (
            <span className="inline-block mt-0.5 rounded-full bg-slate-100 text-slate-700 ring-1 ring-slate-200 px-2 py-0.5 text-[11px] font-medium">{s.shipment_status}</span>
          ) : null}
        </div>
        {onDismiss ? (
          <button type="button" onClick={onDismiss} disabled={busy}
            title="Not this shipment: hide the link" aria-label={`Unlink shipment ${s.shipment_id}`}
            className="shrink-0 p-0.5 rounded text-slate-400 hover:text-rose-600 hover:bg-rose-50 disabled:opacity-50">
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <X className="h-3.5 w-3.5" />}
          </button>
        ) : null}
      </div>
      <dl className="mt-1.5 grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5 text-xs">
        {s.customer_name ? <><dt className="text-slate-400">Customer</dt><dd className="text-slate-700 break-words">{s.customer_name}</dd></> : null}
        {s.carrier_name ? <><dt className="text-slate-400">Carrier</dt><dd className="text-slate-700 break-words">{s.carrier_name}{s.mode ? ` · ${s.mode}` : ""}</dd></> : null}
        {s.tracking_number ? <><dt className="text-slate-400">Tracking</dt><dd className="text-slate-700 break-all">{s.tracking_number}</dd></> : null}
        {lane ? <><dt className="text-slate-400">Lane</dt><dd className="text-slate-700 break-words">{lane}</dd></> : null}
        {s.pickup_date ? <><dt className="text-slate-400">Pickup</dt><dd className="text-slate-700">{fmtDate(s.pickup_date)}</dd></> : null}
        {s.delivery_date
          ? <><dt className="text-slate-400">Delivered</dt><dd className="text-slate-700">{fmtDate(s.delivery_date)}</dd></>
          : s.estimated_arrival ? <><dt className="text-slate-400">ETA</dt><dd className="text-slate-700">{fmtDate(s.estimated_arrival)}</dd></> : null}
      </dl>
      {s.logged_at ? (
        <div className="mt-1.5 inline-flex items-center gap-1 text-[11px] font-medium text-emerald-700"
          title="This email was added to the shipment's notes">
          <CheckCircle2 className="h-3 w-3 shrink-0" />
          <span>Logged on shipment · <span title={fmtDateTime(s.logged_at)}>{fmtRelative(s.logged_at)}</span></span>
        </div>
      ) : null}
      <div className="mt-1.5 flex items-center gap-2 text-[11px] text-slate-500">
        {matched ? (
          <span className="inline-flex items-center gap-1 min-w-0" title={s.matched_text || undefined}>
            <Link2 className="h-3 w-3 shrink-0" />
            <span className="truncate">{s.source === "person" && s.matched_on !== "manual" ? "linked by hand" : `matched on ${matched}`}{s.matched_text && s.matched_on !== "manual" ? ` ${s.matched_text}` : ""}</span>
          </span>
        ) : null}
        <Link to={`/tracking/${encodeURIComponent(s.shipment_id)}`} className="ml-auto shrink-0 inline-flex items-center gap-0.5 text-violet-700 hover:underline font-medium">
          Open shipment <ArrowRight className="h-3 w-3" />
        </Link>
      </div>
    </li>
  );
}

function NotInFpxSection({ items, readOnly, onLink }: {
  items: NotInFpx[];
  readOnly: boolean;
  onLink: (value: string) => void;
}) {
  if (!items.length) return null;
  return (
    <section>
      <SectionTitle icon={SearchX} count={items.length}>Not in FPX</SectionTitle>
      <p className="mb-2 text-xs text-slate-500">Numbers in these emails that match no FPX shipment.</p>
      <ul className="space-y-1.5">
        {items.map((n) => (
          <li key={n.value} className="flex items-center gap-2 text-xs">
            <span className="min-w-0 truncate rounded-md bg-slate-100 ring-1 ring-slate-200 px-1.5 py-0.5 font-mono text-slate-800" title={`${n.kind}: ${n.value}`}>
              <span className="text-slate-500">{KIND_LABEL[n.kind] || n.kind}</span> {n.value}
            </span>
            <Link to={`/tracking?q=${encodeURIComponent(n.value)}`} title={`Search shipments for ${n.value}`}
              className="ml-auto shrink-0 inline-flex items-center gap-0.5 text-violet-700 hover:underline font-medium">
              <Search className="h-3 w-3" /> Search
            </Link>
            {!readOnly ? (
              <button type="button" onClick={() => onLink(n.value)} title="Put this number in the Link a shipment box"
                className="shrink-0 inline-flex items-center gap-0.5 text-violet-700 hover:underline font-medium">
                <Link2 className="h-3 w-3" /> Link
              </button>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}

function taskStatusClass(status: string | null): string {
  const s = (status || "").toLowerCase();
  if (s === "done" || s === "completed" || s === "closed" || s === "resolved") return "bg-emerald-100 text-emerald-700 ring-emerald-200";
  if (s === "blocked" || s === "waiting") return "bg-amber-100 text-amber-800 ring-amber-200";
  if (s === "in_progress" || s === "doing") return "bg-sky-100 text-sky-800 ring-sky-200";
  return "bg-slate-100 text-slate-700 ring-slate-200";
}

function TasksSection({ tasks }: { tasks: ContextTask[] }) {
  return (
    <section>
      <SectionTitle icon={ListChecks} count={tasks.length}>Tasks</SectionTitle>
      {tasks.length ? (
        <ul className="space-y-1.5">
          {tasks.map((t) => (
            <li key={t.id}>
              <Link to={`/tasks/v2/${encodeURIComponent(t.id)}`}
                className="block rounded-lg ring-1 ring-slate-200 bg-white px-3 py-2 hover:bg-slate-50 hover:ring-violet-200">
                <div className="text-slate-900 text-sm break-words">{t.title || "(untitled task)"}</div>
                <div className="mt-1 flex items-center gap-1.5 flex-wrap text-[11px] text-slate-500">
                  {t.status ? (
                    <span className={`rounded-full px-2 py-0.5 font-semibold ring-1 ${taskStatusClass(t.status)}`}>{t.status.replace(/_/g, " ")}</span>
                  ) : null}
                  <span>{t.assigned_to || "Unassigned"}</span>
                  {t.due_at ? <span title={fmtDateTime(t.due_at)}>· due {fmtDate(t.due_at)}</span> : null}
                  <span className="ml-auto">Shipment {t.shipment_id}</span>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      ) : <p className="text-xs text-slate-500">No tasks on the linked shipments.</p>}
    </section>
  );
}

function RelatedSection({ threads, onOpen }: { threads: ThreadContext["related_threads"]; onOpen: (c: string) => void }) {
  return (
    <section>
      <SectionTitle icon={Mail} count={threads.length}>Related conversations</SectionTitle>
      {threads.length ? (
        <ul className="space-y-1.5">
          {threads.map((t) => (
            <li key={t.conversation_id}>
              <button type="button" onClick={() => onOpen(t.conversation_id)}
                className="w-full text-left rounded-lg ring-1 ring-slate-200 bg-white px-3 py-2 hover:bg-slate-50 hover:ring-violet-200">
                <div className="text-sm text-slate-900 truncate">{t.subject || "(no subject)"}</div>
                <div className="mt-1 flex items-center gap-1.5 flex-wrap">
                  <ThreadStatusBadge status={t.status} />
                  <PartyTag party={t.party} />
                  <span className="ml-auto text-[11px] text-slate-500" title={fmtDateTime(t.last_message_at)}>{fmtRelative(t.last_message_at)}</span>
                </div>
              </button>
            </li>
          ))}
        </ul>
      ) : <p className="text-xs text-slate-500">No other conversations about these shipments.</p>}
    </section>
  );
}
