import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronRight, Loader2, RefreshCw, UploadCloud } from "lucide-react";
import { ErrorBlock } from "../ErrorBlock";
import { InvoicePill } from "../GetInvoiceModal";
import { fmtDate, fmtDateTime, fmtNum, fmtRelative } from "../../lib/format";
import { PUSH_MAX, getPushCandidates, pushToErp, type PushCandidates, type PushGroup } from "../../lib/invoiceFlow";
import { errorText, fmtMoney } from "./notExported/format";

// Step 5: press FreightPOP's Get Invoice for approved shipments FreightPOP
// hasn't exported yet. Pressing it is what pushes a shipment into FreightPOP's
// NetSuite; FPX only presses the button. Whether it arrived is FreightPOP's own
// Exported to ERP flag, read on the next Pull.
//
// Human in the loop: the person sees each run's list, can untick any shipment,
// ticks "I reviewed this list", presses Push to ERP and then confirms.

const ACTIVE_POLL_MS = 15_000;

const PRIMARY = "inline-flex items-center gap-2 px-3.5 py-2 rounded-lg bg-violet-600 text-white hover:bg-violet-700 text-sm font-medium disabled:opacity-40 disabled:cursor-not-allowed";
const QUIET = "inline-flex items-center gap-2 px-3.5 py-2 rounded-lg bg-white text-slate-700 ring-1 ring-slate-300 hover:bg-slate-50 text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed";

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

const SOURCE_LABEL: Record<string, string> = {
  push_to_erp: "from Push to ERP",
  pipeline: "after a pull",
  manual: "from a run's Get invoices",
};

type Result = { ok: boolean; text: string };

export default function PushToErpSection({ version, onChanged }: { version?: number; onChanged?: () => void } = {}) {
  const [data, setData] = useState<PushCandidates | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  // Only one run can be pushed at a time.
  const [busyAudit, setBusyAudit] = useState<string | null>(null);
  const mounted = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const load = useCallback(async () => {
    try {
      const d = await getPushCandidates();
      if (!mounted.current) return;
      setData(d);
      setError(null);
    } catch (e) {
      if (mounted.current) setError(errorText(e, "The list could not be loaded."));
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, []);

  // Load on mount and whenever the page's summary changes (e.g. after a Pull).
  useEffect(() => { void load(); }, [load, version]);

  const active = data?.active ?? null;
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => { void load(); }, ACTIVE_POLL_MS);
    return () => clearInterval(id);
  }, [active, load]);

  const retry = () => { setLoading(true); setError(null); void load(); };

  async function push(group: PushGroup, shipmentIds: string[], repush: boolean): Promise<boolean> {
    setBusyAudit(group.audit_id);
    setResult(null);
    try {
      const res = await pushToErp(group.audit_id, shipmentIds, repush);
      if (!mounted.current) return true;
      const n = res.count ?? shipmentIds.length;
      setResult({ ok: true, text: `Queued — the hosted browser is pressing Get Invoice for ${fmtNum(n)} ${plural(n, "shipment", "shipments")} from Run #${group.run_number ?? "?"}. They show as exported after the next Pull.` });
      onChanged?.();
      return true;
    } catch (e) {
      if (mounted.current) setResult({ ok: false, text: `Not queued: ${errorText(e, "the request failed")}` });
      return false;
    } finally {
      if (mounted.current) setBusyAudit(null);
      void load();
    }
  }

  const activeReason = active
    ? `Get Invoice run in progress${active.count != null ? ` (${fmtNum(active.count)} ${plural(active.count, "shipment", "shipments")})` : ""}`
    : null;

  return (
    <div className="rounded-2xl ring-1 ring-slate-200 bg-white p-5 space-y-5">
      <div className="flex items-start gap-4">
        <div className="h-10 w-10 shrink-0 rounded-xl bg-violet-50 text-violet-600 flex items-center justify-center">
          <UploadCloud className="h-5 w-5" aria-hidden="true" />
        </div>
        <p className="text-sm text-slate-700 min-w-0">
          Pressing FreightPOP's Get Invoice pushes a shipment into FreightPOP's NetSuite. Push to ERP presses it for the approved shipments FreightPOP hasn't exported yet. They show as exported after the next Pull.
        </p>
      </div>

      {loading && !data ? (
        <div className="flex items-center gap-2 text-sm text-slate-500">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> Loading approved shipments…
        </div>
      ) : error && !data ? (
        <ErrorBlock compact>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span>{error}</span>
            <button type="button" onClick={retry} className="inline-flex items-center gap-1 text-xs font-medium underline">
              <RefreshCw className="h-3 w-3" aria-hidden="true" /> Try again
            </button>
          </div>
        </ErrorBlock>
      ) : data ? (
        <>
          <StatusStrip data={data} activeReason={activeReason} />
          {error ? <ErrorBlock compact tone="warning">Could not refresh: {error}</ErrorBlock> : null}
          {result ? (
            result.ok
              ? <div role="status" className="rounded-lg ring-1 ring-emerald-200 bg-emerald-50 text-emerald-800 px-3 py-2 text-sm">{result.text}</div>
              : <ErrorBlock compact>{result.text}</ErrorBlock>
          ) : null}

          {data.groups.length === 0 ? (
            <p className="text-sm text-slate-500">Nothing approved and waiting — every approved shipment is exported or still needs approval.</p>
          ) : (
            <div className="space-y-3">
              {data.groups.map((g, i) => (
                <GroupCard
                  key={g.audit_id}
                  group={g}
                  defaultOpen={i === 0}
                  blockedReason={activeReason ?? (busyAudit && busyAudit !== g.audit_id ? "Another run is being pushed." : null)}
                  submitting={busyAudit === g.audit_id}
                  onPush={(ids, repush) => push(g, ids, repush)}
                />
              ))}
            </div>
          )}
        </>
      ) : null}
    </div>
  );
}

function StatusStrip({ data, activeReason }: { data: PushCandidates; activeReason: string | null }) {
  const { active, last } = data;
  return (
    <div className="rounded-lg bg-slate-50 ring-1 ring-slate-200 px-4 py-3 text-sm space-y-1.5">
      <div className="text-slate-900">
        <span className="font-semibold tabular-nums">{fmtNum(data.total)}</span>{" "}
        {plural(data.total, "shipment", "shipments")} approved and ready to export
      </div>
      {active ? (
        <div className="flex items-center gap-2 text-violet-800 font-medium">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          <span>{activeReason}</span>
          <span className="text-xs font-normal text-slate-500">
            {active.status === "pending" ? "waiting to start" : "running"} · requested {fmtRelative(active.requested_at)}
            {active.requested_by ? ` by ${active.requested_by}` : ""} · this updates every 15 seconds
          </span>
        </div>
      ) : last ? (
        <div className="text-xs text-slate-600">
          Last Get Invoice run: {last.completed_at ? <span title={fmtDateTime(last.completed_at)}>{fmtRelative(last.completed_at)}</span> : "time unknown"}
          {last.count != null ? ` · ${fmtNum(last.count)} ${plural(last.count, "shipment", "shipments")}` : ""}
          {` · ${SOURCE_LABEL[last.source] ?? last.source}`}
          {last.status && last.status !== "done" ? ` · ${last.status}` : ""}
        </div>
      ) : (
        <div className="text-xs text-slate-500">No Get Invoice run yet.</div>
      )}
      {data.unassigned > 0 ? (
        <div className="text-xs text-amber-800">
          {fmtNum(data.unassigned)} approved {plural(data.unassigned, "shipment isn't", "shipments aren't")} in any known run and can't be pushed until a new Pull.
        </div>
      ) : null}
    </div>
  );
}

function GroupCard({ group, defaultOpen, blockedReason, submitting, onPush }: {
  group: PushGroup;
  defaultOpen: boolean;
  blockedReason: string | null;
  submitting: boolean;
  onPush: (shipmentIds: string[], repush: boolean) => Promise<boolean>;
}) {
  const [open, setOpen] = useState(defaultOpen);
  // Track what was unticked so shipments that appear on a refresh start ticked.
  // Shipments that already had Get Invoice pressed or requested may already be
  // in NetSuite, so they start unticked (and again whenever one newly shows
  // as pressed); ticking one back on is a deliberate re-push.
  const pressedIds = useMemo(
    () => group.shipments.filter((s) => s.get_invoice?.status === "requested" || s.get_invoice?.status === "done").map((s) => s.shipment_id),
    [group.shipments],
  );
  const seenPressed = useRef<Set<string>>(new Set(pressedIds));
  const [unticked, setUnticked] = useState<Set<string>>(() => new Set(pressedIds));
  useEffect(() => {
    const fresh = pressedIds.filter((id) => !seenPressed.current.has(id));
    if (!fresh.length) return;
    for (const id of fresh) seenPressed.current.add(id);
    setUnticked((prev) => new Set([...prev, ...fresh]));
  }, [pressedIds]);
  const [reviewed, setReviewed] = useState(false);
  const [confirming, setConfirming] = useState(false);

  const ids = useMemo(() => [...new Set(group.shipments.map((s) => s.shipment_id).filter(Boolean))], [group.shipments]);
  const signature = ids.join(",");
  // A changed list needs a fresh review.
  const lastSignature = useRef(signature);
  useEffect(() => {
    if (lastSignature.current === signature) return;
    lastSignature.current = signature;
    setReviewed(false);
    setConfirming(false);
  }, [signature]);

  const chosen = useMemo(() => ids.filter((id) => !unticked.has(id)), [ids, unticked]);
  const count = chosen.length;
  const totalCharge = useMemo(
    () => group.shipments.filter((s) => !unticked.has(s.shipment_id)).reduce((t, s) => t + (s.charge ?? 0), 0),
    [group.shipments, unticked],
  );
  const runLabel = `Run #${group.run_number ?? "?"}`;

  const disabledReason = blockedReason
    ?? (count === 0 ? "Tick at least one shipment"
      : count > PUSH_MAX ? `Pick up to ${PUSH_MAX} shipments at a time`
      : !reviewed ? "Tick \"I reviewed this list\" first"
      : null);
  const canPush = !disabledReason && !submitting;

  function toggle(id: string) {
    setUnticked((prev) => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n; });
    setConfirming(false);
  }
  function setAll(on: boolean) {
    // "All" never re-ticks shipments already pressed; those are ticked one by one.
    setUnticked(on ? new Set(pressedIds) : new Set(ids));
    setConfirming(false);
  }

  const repushCount = useMemo(() => chosen.filter((id) => pressedIds.includes(id)).length, [chosen, pressedIds]);

  async function confirm() {
    const ok = await onPush(chosen, repushCount > 0);
    setConfirming(false);
    if (ok) setReviewed(false);
  }

  const fresh = ids.filter((id) => !pressedIds.includes(id));
  const allOn = fresh.length > 0 && fresh.every((id) => !unticked.has(id));

  return (
    <div className="rounded-xl ring-1 ring-slate-200 overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="w-full flex items-center gap-2 px-4 py-3 bg-slate-50 hover:bg-slate-100 text-left text-sm"
      >
        {open ? <ChevronDown className="h-4 w-4 text-slate-500" aria-hidden="true" /> : <ChevronRight className="h-4 w-4 text-slate-500" aria-hidden="true" />}
        <span className="font-medium text-slate-900">{runLabel}</span>
        <span className="text-slate-500">
          · pulled {group.pulled_at ? fmtDate(group.pulled_at) : "—"} · {fmtNum(group.shipments.length)} {plural(group.shipments.length, "shipment", "shipments")}
        </span>
      </button>

      {open ? (
        <div className="p-4 space-y-3">
          <div className="flex flex-wrap items-baseline gap-x-6 gap-y-1">
            <div>
              <span className="text-xl font-semibold text-slate-900 tabular-nums">{fmtNum(count)}</span>
              <span className="text-sm text-slate-600 ml-1.5">ticked</span>
            </div>
            <div>
              <span className="text-xl font-semibold text-slate-900 tabular-nums">{fmtMoney(totalCharge)}</span>
              <span className="text-sm text-slate-600 ml-1.5">in charges</span>
            </div>
            {count !== ids.length ? (
              <button type="button" onClick={() => setAll(true)} className="text-xs text-sky-700 hover:text-sky-900 underline">
                {fmtNum(ids.length - count)} unticked. Tick all again
              </button>
            ) : null}
          </div>

          <div className="rounded-xl ring-1 ring-slate-200 overflow-auto max-h-[45vh]">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 sticky top-0 z-10 shadow-[0_1px_0_0_rgb(226_232_240)]">
                <tr className="text-left text-[11px] uppercase tracking-wide text-slate-500">
                  <th className="px-3 py-2 w-8">
                    <input
                      type="checkbox"
                      checked={allOn}
                      onChange={(e) => setAll(e.target.checked)}
                      disabled={submitting}
                      aria-label="Include every shipment"
                      className="rounded border-slate-300 text-violet-600"
                    />
                  </th>
                  <th className="px-3 py-2 font-medium">Shipment</th>
                  <th className="px-3 py-2 font-medium">Customer</th>
                  <th className="px-3 py-2 font-medium">Carrier</th>
                  <th className="px-3 py-2 font-medium text-right">Charge</th>
                  <th className="px-3 py-2 font-medium whitespace-nowrap">Invoice #</th>
                  <th className="px-3 py-2 font-medium whitespace-nowrap">Approved by</th>
                  <th className="px-3 py-2 font-medium whitespace-nowrap">Get Invoice</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {group.shipments.map((s) => {
                  const on = !unticked.has(s.shipment_id);
                  return (
                    <tr
                      key={s.shipment_id}
                      onClick={() => { if (!submitting) toggle(s.shipment_id); }}
                      className={"cursor-pointer " + (!on ? "opacity-50" : s.get_invoice && s.get_invoice.status !== "not_started" ? "bg-amber-50/60" : "hover:bg-slate-50")}
                    >
                      <td className="px-3 py-1.5">
                        <input
                          type="checkbox"
                          checked={on}
                          onChange={() => toggle(s.shipment_id)}
                          onClick={(e) => e.stopPropagation()}
                          disabled={submitting}
                          aria-label={`Include shipment ${s.shipment_id}`}
                          className="rounded border-slate-300 text-violet-600"
                        />
                      </td>
                      <td className="px-3 py-1.5 font-medium text-slate-900 whitespace-nowrap">{s.shipment_id}</td>
                      <td className="px-3 py-1.5">{s.customer || "—"}</td>
                      <td className="px-3 py-1.5">{s.carrier || "—"}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums whitespace-nowrap">{fmtMoney(s.charge)}</td>
                      <td className="px-3 py-1.5 whitespace-nowrap">{s.invoice_number || "—"}</td>
                      <td className="px-3 py-1.5">{s.approved_by || "—"}</td>
                      <td className="px-3 py-1.5"><InvoicePill state={s.get_invoice} /></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="text-xs text-slate-500">Shaded rows already had Get Invoice pressed or requested. Untick them unless you mean to press it again.</p>

          {count > PUSH_MAX ? (
            <div className="text-sm text-rose-700">Pick up to {PUSH_MAX} shipments at a time. Untick {fmtNum(count - PUSH_MAX)} to continue.</div>
          ) : null}

          {confirming ? (
            <div role="alertdialog" aria-label="Confirm Push to ERP" className="rounded-xl ring-1 ring-violet-200 bg-violet-50 p-3 flex flex-wrap items-center justify-between gap-3">
              <div className="text-sm text-violet-900 font-medium">
                Press Get Invoice for {fmtNum(count)} {plural(count, "shipment", "shipments")} from {runLabel}? This pushes them into NetSuite.
                {repushCount > 0 && (
                  <span className="block mt-1 font-medium text-rose-700">
                    {fmtNum(repushCount)} of them already had Get Invoice pressed and may already be in NetSuite. They will be pressed again.
                  </span>
                )}
              </div>
              <div className="flex items-center gap-2">
                <button type="button" className={QUIET} onClick={() => setConfirming(false)} disabled={submitting}>Cancel</button>
                <button type="button" className={PRIMARY} onClick={confirm} disabled={!canPush}>
                  {submitting ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : null}
                  {submitting ? "Queuing…" : "Confirm"}
                </button>
              </div>
            </div>
          ) : (
            <div className="flex items-center justify-between gap-3 flex-wrap border-t border-slate-100 pt-3">
              <label className="inline-flex items-center gap-2 text-sm text-slate-800 cursor-pointer">
                <input
                  type="checkbox"
                  checked={reviewed}
                  onChange={(e) => setReviewed(e.target.checked)}
                  disabled={submitting}
                  className="rounded border-slate-300 text-violet-600"
                />
                I reviewed this list
              </label>
              <div className="flex items-center gap-3">
                {blockedReason ? <span className="text-xs text-slate-500">{blockedReason}</span> : null}
                <button
                  type="button"
                  className={PRIMARY}
                  onClick={() => setConfirming(true)}
                  disabled={!canPush}
                  title={disabledReason ?? undefined}
                >
                  <UploadCloud className="h-4 w-4" aria-hidden="true" />
                  Push to ERP
                </button>
              </div>
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}
