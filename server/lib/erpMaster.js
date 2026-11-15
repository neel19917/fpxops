// Master Excel files of everything kept from FreightPOP, in FreightPOP's own
// export format: one workbook of every shipment (Transactions > History
// Report) and one of every approved invoice (Audit > Recently Approved /
// History). Built from the Supabase tables, with the columns in the order
// FreightPOP's own export has them (read from the newest stored export).
import { readXlsx } from "./xlsxRead.js";
import { writeXlsx } from "./xlsxWrite.js";

export const ERP_MASTERS = {
  transactions: {
    table: "fpx_erp_transaction_rows", key: "row_key", sort: "shipped_date",
    object: "masters/transactions-master.xlsx", label: "FreightPOP-Transactions-Master",
    view: "fpx_freightpop_transactions_export",
  },
  approvals: {
    table: "fpx_audit_approvals", key: "approval_key", sort: "approved_date",
    object: "masters/audit-approvals-master.xlsx", label: "FreightPOP-Audit-Approvals-Master",
    view: "fpx_freightpop_audit_export",
  },
};

async function loadAll(supabase, m) {
  const rows = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase.from(m.table).select(`${m.key}, data`)
      .order(m.sort, { ascending: false, nullsFirst: false }).order(m.key, { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    for (const r of data || []) rows.push(r.data || {});
    if (!data || data.length < PAGE) break;
  }
  return rows;
}

// The header row of FreightPOP's newest stored export of that kind, or [].
async function exportHeaders(supabase, bucket, which) {
  try {
    const { data: audits } = await supabase.from("fpx_invoice_audits").select("id")
      .eq("shipment_type", "erp_pending").order("created_at", { ascending: false }).limit(4);
    let best = [];
    for (const a of audits || []) {
      let names = ["full.xlsx"];
      if (which === "approvals") {
        const { data: files } = await supabase.storage.from(bucket).list(String(a.id), { limit: 200 });
        names = (files || []).map((f) => f.name).filter((n) => /^audit-history.*\.xlsx$/i.test(n)).slice(-6);
      }
      for (const name of names) {
        const { data: blob, error } = await supabase.storage.from(bucket).download(`${a.id}/${name}`);
        if (error || !blob) continue;
        try {
          const { headers } = readXlsx(Buffer.from(await blob.arrayBuffer()));
          if (headers.length > best.length) best = headers;
        } catch { /* not readable: try the next */ }
        if (which === "transactions" && best.length) return best;
      }
      if (best.length >= 40) return best;
    }
    return best;
  } catch {
    return [];
  }
}

// → { buf, rows, columns } and keeps a copy in Storage (never fails on that).
export async function buildErpMaster(supabase, bucket, which) {
  const m = ERP_MASTERS[which];
  if (!m) throw new Error("unknown master");
  const [rows, fromFile] = await Promise.all([loadAll(supabase, m), exportHeaders(supabase, bucket, which)]);
  // FreightPOP's order first, then any column the stored rows have besides.
  const columns = [];
  const seen = new Set();
  const add = (c) => { const k = String(c); if (k && !seen.has(k)) { seen.add(k); columns.push(k); } };
  fromFile.forEach(add);
  const extra = new Set();
  for (const r of rows) for (const k of Object.keys(r)) if (!seen.has(k)) extra.add(k);
  [...extra].sort().forEach(add);
  // Blank cells are left out of the sheet, as Excel would have them.
  const out = rows.map((r) => {
    const o = {};
    for (const c of columns) { const v = r[c]; if (v !== "" && v !== null && v !== undefined) o[c] = v; }
    return o;
  });
  const buf = writeXlsx(columns, out);
  let stored = false;
  try {
    const { error } = await supabase.storage.from(bucket).upload(m.object, buf, {
      contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", upsert: true,
    });
    stored = !error;
  } catch { /* the download still works */ }
  return { buf, rows: rows.length, columns, stored };
}

// Every row of the History Report as FreightPOP gives it. A parcel shipment
// has one row per package, so fpx_erp_transactions (one row per shipment)
// cannot hold them all; fpx_erp_transaction_rows does. `mapped(row)` is
// erpStore's transactionRow. → rows for an upsert on row_key.
export function transactionPieceRows(reportRows, mapped, { shipmentType, seenAt } = {}) {
  const out = new Map();
  const count = new Map();
  for (const r of Array.isArray(reportRows) ? reportRows : []) {
    const t = r && typeof r === "object" ? mapped(r) : null;
    if (!t) continue;
    const base = `${t.shipment_id}|${t.tracking_key || t.tracking_number || ""}`;
    const n = count.get(base) || 0;
    count.set(base, n + 1);
    const row_key = n ? `${base}|${n + 1}` : base;
    out.set(row_key, {
      row_key, shipment_id: t.shipment_id, tracking_number: t.tracking_number ?? null,
      shipped_date: t.shipped_date ?? null, shipment_type: shipmentType || t.shipment_type || null,
      data: r, last_seen_at: seenAt || new Date().toISOString(),
    });
  }
  return [...out.values()];
}

// Never throws. → { upserted, failed }
export async function upsertPieceRows(supabase, rows) {
  let upserted = 0, failed = 0;
  for (let i = 0; i < rows.length; i += 500) {
    const part = rows.slice(i, i + 500);
    try {
      const { error } = await supabase.from("fpx_erp_transaction_rows").upsert(part, { onConflict: "row_key" });
      if (error) failed += part.length; else upserted += part.length;
    } catch { failed += part.length; }
  }
  return { upserted, failed };
}
