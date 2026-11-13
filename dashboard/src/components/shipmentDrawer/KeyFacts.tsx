import type { ReactNode } from "react";
import { ArrowRight } from "lucide-react";
import type { Shipment } from "../../lib/types";
import { fmtDateTime } from "../../lib/format";
import { firstPlace } from "./placeFormat";
import { ActionDispositionControl, type ActionDispositionControlProps } from "./ActionDispositionControl";

// Tone the status pill on common-case strings; default to slate. Best-effort:
// FreightPOP's status vocabulary is open-ended.
export function statusTone(status: string | null | undefined): string {
  const s = String(status || "").toLowerCase();
  if (/issue|except|delay|late|hold/.test(s)) return "bg-amber-100 text-amber-800 ring-amber-200";
  if (/out.?for|deliver/.test(s)) return "bg-emerald-100 text-emerald-800 ring-emerald-200";
  if (/transit|in.?route/.test(s)) return "bg-sky-100 text-sky-800 ring-sky-200";
  if (/pick|tender|book/.test(s)) return "bg-violet-100 text-violet-800 ring-violet-200";
  if (/cancel|fail/.test(s)) return "bg-rose-100 text-rose-800 ring-rose-200";
  return "bg-slate-100 text-slate-700 ring-slate-200";
}

function Fact({ label, children, title, tone }: { label: string; children: ReactNode; title?: string; tone?: "late" | "good" }) {
  return (
    <div className="min-w-0" title={title}>
      <div className="text-[10px] font-bold uppercase tracking-wider text-slate-500">{label}</div>
      <div className={"text-sm font-medium truncate " + (tone === "late" ? "text-rose-700" : tone === "good" ? "text-emerald-700" : "text-slate-900")}>{children}</div>
    </div>
  );
}

// The handful of facts a rep needs before reading anything else: where the
// shipment stands, whether it needs action, the three dates and the lane.
// Pinned in the drawer header so it's visible on every tab.
export function KeyFacts({ shipment, ...action }: { shipment: Shipment } & Omit<ActionDispositionControlProps, "shipment">) {
  const eta = shipment.updated_eta || shipment.estimated_arrival || shipment.original_eta;
  const etaMs = eta ? Date.parse(eta) : NaN;
  const delivered = !!shipment.delivery_date;
  const pastDue = !delivered && Number.isFinite(etaMs) && etaMs < Date.now();
  const pickedUp = shipment.actual_departure || null;
  // ship_from / ship_to are the address fields; origin / destination can
  // hold unrelated grid text on some rows, so they're only the fallback.
  // The raw strings are scraped and messy (run-together "Name:…Address:…"
  // labels, or a bare label with no value), so they go through parsePlace:
  // "City, ST" for the fact, the cleaned full address for the tooltip.
  const from = firstPlace(shipment.ship_from, shipment.origin);
  const to = firstPlace(shipment.ship_to, shipment.destination);
  return (
    <div className="pb-3">
      <div className="flex items-center gap-2 flex-wrap">
        <span className={`inline-flex items-center text-xs font-semibold px-2.5 py-1 rounded-full ring-1 ${statusTone(shipment.shipment_status)}`}>
          {shipment.shipment_status || "No status"}
        </span>
        <ActionDispositionControl shipment={shipment} {...action} />
      </div>
      <div className="mt-3 grid grid-cols-2 sm:grid-cols-4 gap-x-4 gap-y-2">
        <Fact label="Pickup" title={pickedUp ? `Departed ${fmtDateTime(pickedUp)}` : "Scheduled pickup — no departure recorded"}>
          {fmtDateTime(shipment.pickup_date)}
        </Fact>
        <Fact label={pastDue ? "ETA · past due" : "ETA"} tone={pastDue ? "late" : undefined} title={shipment.original_eta ? `Original ETA ${fmtDateTime(shipment.original_eta)}` : undefined}>
          {fmtDateTime(eta)}
        </Fact>
        <Fact label="Delivered" tone={delivered ? "good" : undefined} title={shipment.signed_by ? `Signed by ${shipment.signed_by}` : undefined}>
          {delivered ? fmtDateTime(shipment.delivery_date) : "Not yet"}
        </Fact>
        <Fact label="Lane" title={`${from?.full || "—"}  →  ${to?.full || "—"}`}>
          <span className="inline-flex items-center gap-1 max-w-full">
            <span className="truncate">{from?.short || "—"}</span>
            <ArrowRight className="h-3 w-3 shrink-0 text-slate-400" />
            <span className="truncate">{to?.short || "—"}</span>
          </span>
        </Fact>
      </div>
    </div>
  );
}
