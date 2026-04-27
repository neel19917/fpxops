import type { ReactNode } from "react";
import type { Shipment } from "./types";
import { ActionBadge } from "../components/Badge";
import { fmtDate, fmtDateTime, fmtRelative } from "./format";

// Single source of truth for the Tracking-page table columns. Adding a
// column = adding an entry here. Visibility + order are user-configurable
// via the column selector and persisted to localStorage.
export interface ShipmentColumn {
  id: string;
  label: string;
  defaultVisible: boolean;
  // td extra classes (width, truncation, alignment)
  tdClass?: string;
  // optional title attr on td (for tooltip on truncated cells)
  title?: (r: Shipment) => string | undefined;
  render: (r: Shipment) => ReactNode;
}

const dash = (v: string | null | undefined) => (v ? v : "—");
const yesNo = (v: boolean | null) => (v === true ? "Yes" : v === false ? "No" : "—");

export const SHIPMENT_COLUMNS: ShipmentColumn[] = [
  // Default-visible (current 8)
  { id: "scraped",   label: "Scraped",  defaultVisible: true, tdClass: "text-slate-500 whitespace-nowrap",
    title: (r) => fmtDateTime(r.scraped_at), render: (r) => fmtRelative(r.scraped_at) },
  { id: "tracking",  label: "Tracking", defaultVisible: true, tdClass: "font-medium whitespace-nowrap",
    render: (r) => dash(r.tracking_number) },
  { id: "customer",  label: "Customer", defaultVisible: true, tdClass: "whitespace-nowrap",
    render: (r) => dash(r.customer_name) },
  { id: "carrier",   label: "Carrier",  defaultVisible: true, tdClass: "whitespace-nowrap",
    render: (r) => dash(r.carrier_name || r.carrier) },
  { id: "status",    label: "Status",   defaultVisible: true,
    render: (r) => dash(r.shipment_status) },
  { id: "action",    label: "Action",   defaultVisible: true,
    render: (r) => <ActionBadge action={r.action_required} size="sm" /> },
  { id: "issue",     label: "Issue",    defaultVisible: true, tdClass: "max-w-[320px] truncate",
    title: (r) => r.ai_issue || "", render: (r) => dash(r.ai_issue) },
  { id: "delivery",  label: "Delivery", defaultVisible: true, tdClass: "whitespace-nowrap text-slate-600",
    render: (r) => fmtDate(r.delivery_date) },

  // Default-hidden — opt-in via the column selector
  { id: "order_number",          label: "Order #",         defaultVisible: false, tdClass: "whitespace-nowrap",
    render: (r) => dash(r.order_number) },
  { id: "company_name",          label: "Company",         defaultVisible: false, tdClass: "whitespace-nowrap",
    render: (r) => dash(r.company_name) },
  { id: "shipment_date",         label: "Ship Date",       defaultVisible: false, tdClass: "whitespace-nowrap text-slate-600",
    render: (r) => fmtDate(r.shipment_date) },
  { id: "pickup_date",           label: "Pickup Date",     defaultVisible: false, tdClass: "whitespace-nowrap text-slate-600",
    render: (r) => fmtDate(r.pickup_date) },
  { id: "updated_eta",           label: "Updated ETA",     defaultVisible: false, tdClass: "whitespace-nowrap text-slate-600",
    render: (r) => fmtDate(r.updated_eta) },
  { id: "original_eta",          label: "Original ETA",    defaultVisible: false, tdClass: "whitespace-nowrap text-slate-600",
    render: (r) => fmtDate(r.original_eta) },
  { id: "appointment_set",       label: "Appt Set",        defaultVisible: false, tdClass: "whitespace-nowrap",
    render: (r) => yesNo(r.appointment_set) },
  { id: "appointment_date",      label: "Appt Date",       defaultVisible: false, tdClass: "whitespace-nowrap text-slate-600",
    render: (r) => fmtDate(r.appointment_date) },
  { id: "required_arrival_date", label: "Required Arrival",defaultVisible: false, tdClass: "whitespace-nowrap text-slate-600",
    render: (r) => fmtDate(r.required_arrival_date) },
  { id: "ready_time",            label: "Ready Time",      defaultVisible: false, tdClass: "whitespace-nowrap",
    render: (r) => dash(r.ready_time) },
  { id: "cut_off_time",          label: "Cut Off",         defaultVisible: false, tdClass: "whitespace-nowrap",
    render: (r) => dash(r.cut_off_time) },
  { id: "shipper_spot_quote",    label: "Spot Quote",      defaultVisible: false, tdClass: "whitespace-nowrap",
    render: (r) => dash(r.shipper_spot_quote) },
  { id: "spot_quote_fulfilled_by", label: "Spot Quote By", defaultVisible: false, tdClass: "whitespace-nowrap",
    render: (r) => dash(r.spot_quote_fulfilled_by) },
  { id: "pickup_tendered",       label: "Pickup Tendered", defaultVisible: false, tdClass: "whitespace-nowrap",
    render: (r) => dash(r.pickup_tendered) },
  { id: "tracking_comments",     label: "Track. Comments", defaultVisible: false, tdClass: "max-w-[280px] truncate",
    title: (r) => r.tracking_comments || "", render: (r) => dash(r.tracking_comments) },
  { id: "updated_via",           label: "Updated Via",     defaultVisible: false, tdClass: "whitespace-nowrap",
    render: (r) => dash(r.updated_via) },
  { id: "last_modified_at",      label: "Last Modified",   defaultVisible: false, tdClass: "whitespace-nowrap text-slate-600",
    render: (r) => fmtDate(r.last_modified_at) },
  { id: "mode",                  label: "Mode",            defaultVisible: false, tdClass: "whitespace-nowrap",
    render: (r) => dash(r.mode) },
  { id: "service",               label: "Service",         defaultVisible: false, tdClass: "whitespace-nowrap",
    render: (r) => dash(r.service) },
  { id: "account_manager",       label: "Account Mgr",     defaultVisible: false, tdClass: "whitespace-nowrap",
    render: (r) => dash(r.account_manager) },
  { id: "customer_id",           label: "Customer ID",     defaultVisible: false, tdClass: "whitespace-nowrap",
    render: (r) => dash(r.customer_id) },
  { id: "shipment_id",           label: "Shipment ID",     defaultVisible: false, tdClass: "whitespace-nowrap",
    render: (r) => dash(r.shipment_id) },
  { id: "created_by",            label: "Runner",          defaultVisible: false, tdClass: "whitespace-nowrap",
    render: (r) => dash(r.created_by) },
  { id: "seen_count",            label: "Seen",            defaultVisible: false, tdClass: "whitespace-nowrap text-slate-500",
    render: (r) => String(r.seen_count ?? 0) },
  { id: "reference_one",         label: "Ref 1",           defaultVisible: false, tdClass: "whitespace-nowrap",
    render: (r) => dash(r.reference_one) },
  { id: "reference_two",         label: "Ref 2",           defaultVisible: false, tdClass: "whitespace-nowrap",
    render: (r) => dash(r.reference_two) },
  { id: "reference_three",       label: "Ref 3",           defaultVisible: false, tdClass: "whitespace-nowrap",
    render: (r) => dash(r.reference_three) },
  { id: "reference_four",        label: "Ref 4",           defaultVisible: false, tdClass: "whitespace-nowrap",
    render: (r) => dash(r.reference_four) },
  { id: "reference_five",        label: "Ref 5",           defaultVisible: false, tdClass: "whitespace-nowrap",
    render: (r) => dash(r.reference_five) },
  { id: "reference_six",         label: "Ref 6",           defaultVisible: false, tdClass: "whitespace-nowrap",
    render: (r) => dash(r.reference_six) },
];

export const COLUMN_PREFS_LS_KEY = "fpx.shipmentColumns.v1";

export interface ColumnPrefs {
  visibleIds: string[];
  orderIds: string[];
}

export function defaultColumnPrefs(): ColumnPrefs {
  return {
    visibleIds: SHIPMENT_COLUMNS.filter((c) => c.defaultVisible).map((c) => c.id),
    orderIds: SHIPMENT_COLUMNS.map((c) => c.id),
  };
}

export function loadColumnPrefs(): ColumnPrefs {
  if (typeof window === "undefined") return defaultColumnPrefs();
  try {
    const raw = window.localStorage.getItem(COLUMN_PREFS_LS_KEY);
    if (!raw) return defaultColumnPrefs();
    const parsed = JSON.parse(raw) as Partial<ColumnPrefs>;
    const known = new Set(SHIPMENT_COLUMNS.map((c) => c.id));
    // Drop unknown ids (registry shrunk); append any new ids that landed since
    // last save (registry grew) so a deploy doesn't strand brand-new columns.
    const orderIds: string[] = [];
    const seen = new Set<string>();
    for (const id of parsed.orderIds || []) {
      if (known.has(id) && !seen.has(id)) { orderIds.push(id); seen.add(id); }
    }
    for (const c of SHIPMENT_COLUMNS) {
      if (!seen.has(c.id)) orderIds.push(c.id);
    }
    const visibleIds = (parsed.visibleIds || []).filter((id) => known.has(id));
    return { visibleIds, orderIds };
  } catch {
    return defaultColumnPrefs();
  }
}

export function saveColumnPrefs(prefs: ColumnPrefs): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(COLUMN_PREFS_LS_KEY, JSON.stringify(prefs));
  } catch {
    // localStorage may be full or disabled; failing silently is fine here.
  }
}
