// FreightPOP details tab: shows what the hosted browser last read from
// FreightPOP's Shipment Details page for this shipment (carrier, sale / cost /
// gross profit, the quote breakdown, the shipment lines) and lets the user ask
// for a fresh read. It only reads; nothing here changes anything in FreightPOP.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { AlertTriangle, Loader2, RefreshCw } from "lucide-react";
import { fmtDateTime } from "../../lib/format";
import {
  fetchShipmentDetails,
  isReadRunning,
  requestShipmentDetailsRefresh,
  type ShipmentDetails,
  type ShipmentDetailsResponse,
} from "../../lib/shipmentDetails";
import { Field, Section } from "../Drawer";
import { ScrapeHistory } from "../ScrapeHistory";

const POLL_MS = 5000;
// A read in progress survives a few failed checks in a row before the tab
// stops polling and asks the user to try again.
const MAX_POLL_FAILURES = 3;

const money = (n: number | null | undefined): string =>
  n == null ? "—" : Number(n).toLocaleString(undefined, { style: "currency", currency: "USD" });
const num = (n: number | null | undefined): string | null => (n == null ? null : Number(n).toLocaleString());
const text = (s: string | null | undefined): string | null => {
  const t = (s ?? "").trim();
  return t ? t : null;
};

export function FreightPopDetailsTab({ shipmentId }: { shipmentId: string | null }) {
  // Everything is stored with the shipment id it belongs to, so a response
  // for a shipment that is no longer open is never shown.
  const [loaded, setLoaded] = useState<{ id: string; res: ShipmentDetailsResponse } | null>(null);
  const [loadErr, setLoadErr] = useState<{ id: string; message: string } | null>(null);
  const [refreshErr, setRefreshErr] = useState<{ id: string; message: string } | null>(null);
  const [requestingId, setRequestingId] = useState<string | null>(null);
  // Bumped to fetch again now (Try again, or right after a refresh request).
  const [nonce, setNonce] = useState(0);
  // The shipment currently shown; null once the tab unmounts.
  const currentId = useRef<string | null>(shipmentId);
  const runningRef = useRef(false);

  useEffect(() => {
    currentId.current = shipmentId;
    if (!shipmentId) return;
    let cancelled = false;
    let timer: number | undefined;
    let failures = 0;
    const check = () => {
      fetchShipmentDetails(shipmentId).then((res) => {
        if (cancelled) return;
        failures = 0;
        runningRef.current = isReadRunning(res.job);
        setLoaded({ id: shipmentId, res });
        setLoadErr(null);
        if (runningRef.current) timer = window.setTimeout(check, POLL_MS);
      }).catch((e) => {
        if (cancelled) return;
        failures += 1;
        if (runningRef.current && failures < MAX_POLL_FAILURES) {
          timer = window.setTimeout(check, POLL_MS);
          return;
        }
        setLoadErr({ id: shipmentId, message: (e as Error).message });
      });
    };
    check();
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [shipmentId, nonce]);

  useEffect(() => {
    return () => { currentId.current = null; runningRef.current = false; };
  }, []);

  if (!shipmentId) {
    return (
      <p className="text-sm text-slate-600">
        This shipment has no FreightPOP shipment id, so FPX cannot read its details from FreightPOP.
      </p>
    );
  }

  const res = loaded?.id === shipmentId ? loaded.res : null;
  const getErr = loadErr?.id === shipmentId ? loadErr.message : null;
  const postErr = refreshErr?.id === shipmentId ? refreshErr.message : null;
  const requesting = requestingId === shipmentId;

  const retryLoad = () => { setLoadErr(null); setNonce((n) => n + 1); };

  const refresh = async () => {
    if (requesting) return;
    const id = shipmentId;
    setRequestingId(id);
    setRefreshErr(null);
    try {
      const { request } = await requestShipmentDetailsRefresh(id);
      if (currentId.current !== id) return;
      // Show the read as running straight away, then let the poll take over.
      runningRef.current = true;
      setLoaded((prev) => prev && prev.id === id
        ? { id, res: { ...prev.res, job: { id: request.id, status: "pending", requested_at: new Date().toISOString(), completed_at: null, note: null } } }
        : prev);
      setLoadErr(null);
      setNonce((n) => n + 1);
    } catch (e) {
      if (currentId.current === id) setRefreshErr({ id, message: (e as Error).message });
    } finally {
      setRequestingId((cur) => (cur === id ? null : cur));
    }
  };

  if (!res) {
    if (getErr) {
      return (
        <ErrorBox message={`FPX could not load this shipment's FreightPOP details. ${getErr}`} onRetry={retryLoad} />
      );
    }
    return (
      <div role="status" className="space-y-3" aria-label="Loading FreightPOP details">
        <p className="text-sm text-slate-500 inline-flex items-center gap-2">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          Loading…
        </p>
        <div className="h-24 rounded-xl bg-slate-100 animate-pulse" />
        <div className="h-32 rounded-xl bg-slate-100 animate-pulse" />
      </div>
    );
  }

  const { details, job } = res;
  const reading = requesting || isReadRunning(job);
  const jobFailed = !reading && job?.status === "error";
  const canRefresh = res.can_refresh;
  const reason = text(res.reason);
  const buttonLabel = details ? "Read again" : "Read from FreightPOP";

  const readButton = (label: string) => (
    <button
      type="button"
      onClick={refresh}
      disabled={reading || !canRefresh}
      className="shrink-0 text-xs px-2.5 py-1 rounded-md bg-sky-50 text-sky-700 ring-1 ring-sky-200 hover:bg-sky-100 disabled:opacity-50 disabled:cursor-not-allowed inline-flex items-center gap-1.5"
    >
      <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
      {label}
    </button>
  );

  return (
    <>
      <div className="mb-4 space-y-2">
        <div className="flex items-center justify-between gap-3">
          {reading ? (
            <p role="status" className="text-sm text-slate-600 inline-flex items-center gap-2">
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              Reading from FreightPOP…
            </p>
          ) : details ? (
            <p className="text-sm text-slate-600" title={new Date(details.captured_at).toLocaleString()}>
              Read from FreightPOP {fmtDateTime(details.captured_at)}
            </p>
          ) : (
            <p className="text-sm text-slate-600">FPX has not read this shipment's details from FreightPOP yet.</p>
          )}
          {/* A failed read offers Try again in the error itself. */}
          {jobFailed && canRefresh ? null : readButton(buttonLabel)}
        </div>

        {!canRefresh && reason ? <p className="text-xs text-slate-500">{reason}</p> : null}

        {jobFailed ? (
          <ErrorBox
            message={text(job?.note) || "The last read from FreightPOP did not finish."}
            onRetry={canRefresh ? refresh : undefined}
          />
        ) : null}
        {postErr ? <ErrorBox message={`FPX could not ask for a new read. ${postErr}`} /> : null}
        {getErr ? <ErrorBox message={`FPX could not check for new details. ${getErr}`} onRetry={retryLoad} /> : null}
      </div>

      {details ? <DetailsBody d={details} /> : null}
      {/* When it was read, and what each later read changed. */}
      {details ? <ScrapeHistory source="shipment_details" entityKey={shipmentId} refreshKey={details.captured_at} /> : null}
    </>
  );
}

function ErrorBox({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div role="alert" className="rounded-lg bg-rose-50 ring-1 ring-rose-200 px-3 py-2 text-sm text-rose-800 flex items-start gap-2">
      <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" aria-hidden="true" />
      <span className="flex-1 min-w-0 break-words">{message}</span>
      {onRetry ? (
        <button
          type="button"
          onClick={onRetry}
          className="shrink-0 text-xs px-2 py-0.5 rounded-md bg-white ring-1 ring-rose-200 text-rose-700 hover:bg-rose-100"
        >
          Try again
        </button>
      ) : null}
    </div>
  );
}

type Pair = [label: string, value: ReactNode | null];

// Label/value pairs in a two-column grid. A pair with no value is left out.
function Pairs({ pairs }: { pairs: Pair[] }) {
  const shown = pairs.filter(([, v]) => v != null && v !== "");
  if (!shown.length) return <p className="text-sm text-slate-500">FreightPOP shows nothing here.</p>;
  return (
    <div className="grid grid-cols-2 gap-x-4 gap-y-3">
      {shown.map(([label, value]) => <Field key={label} label={label}>{value}</Field>)}
    </div>
  );
}

function Card({ children, quiet = false }: { children: ReactNode; quiet?: boolean }) {
  return (
    <div className={"rounded-xl ring-1 ring-slate-200 p-4 " + (quiet ? "bg-slate-50" : "bg-white")}>{children}</div>
  );
}

function DetailsBody({ d }: { d: ShipmentDetails }) {
  const margin = d.sale != null && d.gross_profit != null && d.sale !== 0 ? (d.gross_profit / d.sale) * 100 : null;
  const pickupTimes = [
    text(d.ready_time) ? `ready ${text(d.ready_time)}` : null,
    text(d.cutoff_time) ? `cutoff ${text(d.cutoff_time)}` : null,
  ].filter(Boolean).join(", ");
  const pickup = text(d.pickup_date)
    ? `${text(d.pickup_date)}${pickupTimes ? ` (${pickupTimes})` : ""}`
    : pickupTimes || null;
  const quantity = [num(d.quantity), text(d.package_type)].filter(Boolean).join(" ") || null;
  const accessorials = (d.quote_accessorials || []).filter((a) => text(a.name) || a.amount != null);

  return (
    <>
      <Section title="Sale, cost and gross profit">
        <Card>
          <dl className="grid grid-cols-3 gap-3">
            <Figure label="Shipment sale" value={money(d.sale)} />
            <Figure label="Shipment cost" value={money(d.cost)} />
            <Figure
              label="Gross profit"
              value={money(d.gross_profit)}
              tone={d.gross_profit == null ? undefined : d.gross_profit < 0 ? "bad" : "good"}
              note={margin == null ? null : `${margin.toFixed(1)}% margin`}
            />
          </dl>
        </Card>
      </Section>

      <Section title="Carrier">
        <Card>
          <Pairs pairs={[
            ["Carrier", text(d.carrier)],
            ["Account nickname", text(d.account_nickname)],
            ["Vendor name", text(d.vendor_name)],
            ["Service", text(d.service)],
            ["Tracking number", text(d.tracking_number)],
            ["Payer", text(d.payer)],
            ["Confirmation", text(d.confirmation)],
          ]} />
        </Card>
      </Section>

      <Section title="Quote details">
        <Card>
          <div className="grid grid-cols-2 gap-x-4 gap-y-3 mb-3">
            {text(d.quote_number) ? <Field label="Quote number">{text(d.quote_number)}</Field> : null}
            <Field label="Shipment quote"><span className="tabular-nums">{money(d.shipment_quote)}</span></Field>
          </div>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-[11px] font-medium text-slate-500 uppercase tracking-wide">
                <th scope="col" className="text-left font-medium pb-1">Charge</th>
                <th scope="col" className="text-right font-medium pb-1">Amount</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 border-t border-slate-200">
              <QuoteRow label="Freight" amount={d.quote_freight} />
              <QuoteRow label="Fuel surcharge" amount={d.quote_fuel} />
              {accessorials.map((a, i) => (
                <QuoteRow key={`${a.name}-${i}`} label={text(a.name) || "Accessorial"} amount={a.amount} indent />
              ))}
              <QuoteRow label="Total accessorials" amount={d.quote_accessorial_total} />
            </tbody>
            <tfoot>
              <tr className="border-t border-slate-300 font-semibold text-slate-900">
                <th scope="row" className="text-left py-1.5 font-semibold">Total</th>
                <td className="text-right py-1.5 tabular-nums">{money(d.quote_total)}</td>
              </tr>
            </tfoot>
          </table>
        </Card>
      </Section>

      <section className="mb-6">
        <h3 className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">Shipment</h3>
        <Card quiet>
          <Pairs pairs={[
            ["Ship from", text(d.ship_from) ? <span className="whitespace-pre-line">{text(d.ship_from)}</span> : null],
            ["Ship to", text(d.ship_to) ? <span className="whitespace-pre-line">{text(d.ship_to)}</span> : null],
            ["Pickup date", pickup],
            ["Delivery date", text(d.delivery_date)],
            ["Quantity", quantity],
            ["Dimension", text(d.dimension)],
            ["Weight per piece", num(d.weight_per_piece)],
            ["Freight class", text(d.freight_class)],
            ["NMFC", text(d.nmfc)],
            ["Description", text(d.description)],
            ["SO number", text(d.so_number)],
            ["PO number", text(d.po_number)],
            ["Total handling units", num(d.total_units)],
            ["Total weight", num(d.total_weight)],
            ["Linear feet", num(d.linear_feet)],
          ]} />
        </Card>
      </section>
    </>
  );
}

function Figure({ label, value, note, tone }: { label: string; value: string; note?: string | null; tone?: "good" | "bad" }) {
  const color = tone === "bad" ? "text-rose-700" : tone === "good" ? "text-emerald-700" : "text-slate-900";
  return (
    <div className="min-w-0">
      <dt className="text-[11px] font-medium text-slate-500 uppercase tracking-wide">{label}</dt>
      <dd className={"text-xl font-semibold tabular-nums break-words " + color}>{value}</dd>
      {note ? <dd className="text-xs text-slate-500 tabular-nums">{note}</dd> : null}
    </div>
  );
}

function QuoteRow({ label, amount, indent = false }: { label: string; amount: number | null; indent?: boolean }) {
  return (
    <tr className="text-slate-800">
      <th scope="row" className={"text-left font-normal py-1.5 " + (indent ? "pl-4 text-slate-600" : "")}>{label}</th>
      <td className="text-right py-1.5 tabular-nums">{money(amount)}</td>
    </tr>
  );
}
