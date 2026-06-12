import * as XLSX from "xlsx-js-style";
import type { Shipment } from "./types";

interface ExportColumn {
  key: keyof Shipment;
  label: string;
  width?: number;
  // Optional Excel cell number format. When set, cells in this column receive
  // the format (e.g. dollar, date) so Excel renders them appropriately.
  z?: string;
}

const FMT = {
  date: "yyyy-mm-dd",
  datetime: "yyyy-mm-dd hh:mm",
  usd: '"$"#,##0.00;[Red]-"$"#,##0.00',
};

const COLUMNS: ExportColumn[] = [
  { key: "scraped_at",                 label: "Scraped At",          width: 20, z: FMT.datetime },
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
  { key: "action_required",            label: "Action",              width: 14 },
  { key: "action_source",              label: "Action Source",       width: 14 },
  { key: "ai_issue",                   label: "AI Issue",            width: 50 },
  { key: "ai_recommendation",          label: "AI Recommendation",   width: 50 },
  { key: "ship_from",                  label: "Origin",              width: 26 },
  { key: "ship_to",                    label: "Destination",         width: 26 },
  { key: "shipment_date",              label: "Ship Date",           width: 14, z: FMT.date },
  { key: "pickup_date",                label: "Pickup",              width: 18, z: FMT.date },
  { key: "updated_eta",                label: "Updated ETA",         width: 18, z: FMT.date },
  { key: "original_eta",               label: "Original ETA",        width: 18, z: FMT.date },
  { key: "delivery_date",              label: "Delivery",            width: 18, z: FMT.date },
  { key: "appointment_set",            label: "Appt Set",            width: 10 },
  { key: "appointment_date",           label: "Appt Date",           width: 14, z: FMT.date },
  { key: "required_arrival_date",      label: "Required Arrival",    width: 16, z: FMT.date },
  { key: "shipment_marked_up_rate",    label: "Rate (Marked Up)",    width: 16, z: FMT.usd },
  { key: "shipment_rate_without_markup", label: "Rate",              width: 14, z: FMT.usd },
  { key: "shipment_gross_profit",      label: "Gross Profit",        width: 14, z: FMT.usd },
  { key: "signed_by",                  label: "Signed By",           width: 18 },
  { key: "tracking_comments",          label: "Tracking Comments",   width: 40 },
  { key: "notes",                      label: "Operator Notes",      width: 50 },
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

// Action-driven row tints — match the dashboard's ActionBadge palette.
const ROW_FILLS: Record<string, string> = {
  YES: "FFE4E6",       // rose-100
  NO: "D1FAE5",        // emerald-100
  RESOLVED: "EDE9FE",  // violet-100
  ERROR: "FEF3C7",     // amber-100
};

function fmtVal(v: unknown): string | number | boolean | null {
  if (v == null) return "";
  if (typeof v === "boolean") return v ? "Yes" : "No";
  if (typeof v === "number" || typeof v === "string") return v;
  if (v instanceof Date) return v.toISOString();
  return String(v);
}

// Best-effort coercion: ISO date strings → real Date so Excel applies the
// number format correctly. Returns the original value otherwise.
function maybeDate(v: unknown): Date | unknown {
  if (typeof v !== "string" || v.length < 8) return v;
  if (!/^\d{4}-\d{2}-\d{2}/.test(v)) return v;
  const d = new Date(v);
  return isNaN(d.getTime()) ? v : d;
}

export function exportShipmentsXlsx(rows: Shipment[]): void {
  const wb = XLSX.utils.book_new();

  // ---- Cover sheet ----
  const cover: (string | number)[][] = [
    ["FreightPOP — FPX Control Station Shipment Export"],
    [""],
    ["Generated", new Date().toLocaleString()],
    ["Total shipments", rows.length],
    [""],
    ["Source", "FPX Control Station"],
    ["Sheet", "Shipments"],
  ];
  const wsCover = XLSX.utils.aoa_to_sheet(cover);
  wsCover["!cols"] = [{ wch: 24 }, { wch: 60 }];
  wsCover["!merges"] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: 1 } }];
  // Title cell — bold, large, FPX brand-ish navy fill.
  const titleCell = wsCover["A1"];
  if (titleCell) {
    titleCell.s = {
      font: { bold: true, sz: 16, color: { rgb: "FFFFFF" } },
      fill: { fgColor: { rgb: "0F172A" } }, // slate-900
      alignment: { horizontal: "center", vertical: "center" },
    };
    wsCover["!rows"] = [{ hpx: 28 }];
  }
  // Label cells bold.
  for (const ref of ["A3", "A4", "A6", "A7"]) {
    if (wsCover[ref]) wsCover[ref].s = { font: { bold: true } };
  }
  XLSX.utils.book_append_sheet(wb, wsCover, "Cover");

  // ---- Shipments sheet ----
  const headerLabels = COLUMNS.map((c) => c.label);
  const data: (string | number | boolean | null | Date | unknown)[][] = [headerLabels];
  for (const r of rows) {
    data.push(COLUMNS.map((c) => {
      const raw = r[c.key];
      // For date-formatted columns, coerce ISO strings → Date for proper rendering.
      if (c.z === FMT.date || c.z === FMT.datetime) return maybeDate(raw);
      return fmtVal(raw);
    }));
  }
  const ws = XLSX.utils.aoa_to_sheet(data);
  ws["!cols"] = COLUMNS.map((c) => ({ wch: c.width ?? Math.max(c.label.length + 2, 14) }));

  // Freeze the header row so it stays visible while scrolling.
  ws["!freeze"] = { xSplit: 0, ySplit: 1 };
  // xlsx-js-style honors the same `!freeze`; some viewers also look at !views.
  // Provide both for compatibility.
  ws["!views"] = [{ state: "frozen", topLeftCell: "A2", ySplit: 1 }];

  // Header row styling — bold white on slate-900, autofilter intact.
  for (let c = 0; c < COLUMNS.length; c += 1) {
    const ref = XLSX.utils.encode_cell({ r: 0, c });
    if (ws[ref]) {
      ws[ref].s = {
        font: { bold: true, color: { rgb: "FFFFFF" } },
        fill: { fgColor: { rgb: "0F172A" } },
        alignment: { horizontal: "left", vertical: "center" },
      };
    }
  }
  ws["!autofilter"] = {
    ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: 0, c: COLUMNS.length - 1 } }),
  };

  // Per-row tint based on action_required, plus per-column number formats.
  const actionColIdx = COLUMNS.findIndex((c) => c.key === "action_required");
  for (let i = 0; i < rows.length; i += 1) {
    const rowExcel = i + 1; // header is row 0
    const rawAction = rows[i]?.action_required;
    const action = String(rawAction || "").toUpperCase();
    const fill = ROW_FILLS[action];
    for (let c = 0; c < COLUMNS.length; c += 1) {
      const ref = XLSX.utils.encode_cell({ r: rowExcel, c });
      const cell = ws[ref];
      if (!cell) continue;
      // Apply column number format.
      if (COLUMNS[c].z) cell.z = COLUMNS[c].z;
      // Tint the whole row when an action_required tint is defined.
      if (fill) {
        cell.s = {
          ...(cell.s || {}),
          fill: { fgColor: { rgb: fill } },
        };
      }
      // Make the action column itself bold so the status pops.
      if (c === actionColIdx) {
        cell.s = { ...(cell.s || {}), font: { ...((cell.s && cell.s.font) || {}), bold: true } };
      }
    }
  }

  XLSX.utils.book_append_sheet(wb, ws, "Shipments");

  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  XLSX.writeFile(wb, `freightpop-shipments-${ts}.xlsx`);
}
