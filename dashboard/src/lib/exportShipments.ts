import * as XLSX from "xlsx";
import type { Shipment } from "./types";

interface ExportColumn {
  key: keyof Shipment;
  label: string;
  width?: number;
}

const COLUMNS: ExportColumn[] = [
  { key: "scraped_at",                 label: "Scraped At",          width: 20 },
  { key: "tracking_number",            label: "Tracking #",          width: 20 },
  { key: "shipment_id",                label: "Shipment ID",         width: 14 },
  { key: "order_number",               label: "Order #",             width: 14 },
  { key: "customer_name",              label: "Customer",            width: 28 },
  { key: "company_name",               label: "Company",             width: 24 },
  { key: "carrier_name",               label: "Carrier Name",        width: 22 },
  { key: "carrier",                    label: "Carrier (Code)",      width: 16 },
  { key: "mode",                       label: "Mode",                width: 12 },
  { key: "service",                    label: "Service",             width: 16 },
  { key: "shipment_status",            label: "Status",              width: 18 },
  { key: "action_required",            label: "Action",              width: 12 },
  { key: "action_source",              label: "Action Source",       width: 14 },
  { key: "ai_issue",                   label: "AI Issue",            width: 50 },
  { key: "ai_recommendation",          label: "AI Recommendation",   width: 50 },
  { key: "ship_from",                  label: "Origin",              width: 26 },
  { key: "ship_to",                    label: "Destination",         width: 26 },
  { key: "shipment_date",              label: "Ship Date",           width: 14 },
  { key: "pickup_date",                label: "Pickup",              width: 18 },
  { key: "updated_eta",                label: "Updated ETA",         width: 18 },
  { key: "original_eta",               label: "Original ETA",        width: 18 },
  { key: "delivery_date",              label: "Delivery",            width: 18 },
  { key: "appointment_set",            label: "Appt Set",            width: 10 },
  { key: "appointment_date",           label: "Appt Date",           width: 14 },
  { key: "required_arrival_date",      label: "Required Arrival",    width: 16 },
  { key: "shipment_marked_up_rate",    label: "Rate (Marked Up)",    width: 16 },
  { key: "shipment_rate_without_markup", label: "Rate",              width: 14 },
  { key: "shipment_gross_profit",      label: "Gross Profit",        width: 14 },
  { key: "signed_by",                  label: "Signed By",           width: 18 },
  { key: "tracking_comments",          label: "Tracking Comments",   width: 40 },
  { key: "account_manager",            label: "Account Manager",     width: 22 },
  { key: "created_by",                 label: "Runner",              width: 18 },
  { key: "seen_count",                 label: "Seen Count",          width: 10 },
  { key: "ready_time",                 label: "Ready Time",          width: 14 },
  { key: "cut_off_time",               label: "Cut Off",             width: 14 },
  { key: "reference_one",              label: "Ref 1",               width: 14 },
  { key: "reference_two",              label: "Ref 2",               width: 14 },
  { key: "reference_three",            label: "Ref 3",               width: 14 },
  { key: "reference_four",             label: "Ref 4",               width: 14 },
  { key: "reference_five",             label: "Ref 5",               width: 14 },
  { key: "reference_six",              label: "Ref 6",               width: 14 },
];

function fmtVal(v: unknown): string | number | boolean | null {
  if (v == null) return "";
  if (typeof v === "boolean") return v ? "Yes" : "No";
  if (typeof v === "number" || typeof v === "string") return v;
  if (v instanceof Date) return v.toISOString();
  return String(v);
}

export function exportShipmentsXlsx(rows: Shipment[]): void {
  const wb = XLSX.utils.book_new();

  // Branded cover sheet — title + run metadata. Community xlsx can't paint
  // cell colors, so the branding is in the text + a wide first column that
  // makes it read like a banner.
  const cover: (string | number)[][] = [
    ["FreightPOP — FPXpress Shipment Export"],
    [""],
    ["Generated", new Date().toLocaleString()],
    ["Total shipments", rows.length],
    [""],
    ["Source", "FPXpress dashboard"],
    ["Sheet", "Shipments"],
  ];
  const wsCover = XLSX.utils.aoa_to_sheet(cover);
  wsCover["!cols"] = [{ wch: 22 }, { wch: 60 }];
  wsCover["!merges"] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: 1 } }];
  XLSX.utils.book_append_sheet(wb, wsCover, "Cover");

  const headerLabels = COLUMNS.map((c) => c.label);
  const data: (string | number | boolean | null)[][] = [headerLabels];
  for (const r of rows) {
    data.push(COLUMNS.map((c) => fmtVal(r[c.key])));
  }
  const ws = XLSX.utils.aoa_to_sheet(data);
  ws["!cols"] = COLUMNS.map((c) => ({ wch: c.width ?? Math.max(c.label.length + 2, 14) }));
  ws["!autofilter"] = {
    ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: 0, c: COLUMNS.length - 1 } }),
  };
  XLSX.utils.book_append_sheet(wb, ws, "Shipments");

  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  XLSX.writeFile(wb, `freightpop-shipments-${ts}.xlsx`);
}
