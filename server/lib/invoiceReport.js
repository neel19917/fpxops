// "Not exported to ERP" report for Isaac: every shipment FPX has from
// FreightPOP's Transactions History Report whose Exported to ERP flag is not
// set (all time), as an Excel in FreightPOP's own column layout with FPX's
// columns at the end, plus an email after each pull.
//
//   buildNotExportedRows({ q, status })  rows for the list / Excel
//   buildNotExportedWorkbook()           { buffer, filename, count }
//   getReportRecipients()                fpx_settings "invoices.report_recipients"
//   sendNotExportedReport({ auditId, reason })
//       Excel → Storage erp-pulls/reports/<YYYY-MM-DD>/<filename> (only that
//       day's path is ever replaced) → 7-day signed link → one email per
//       recipient. Never throws.
//
// Email env (same names as browser-service/src/notify.js):
//   SALESOS_EMAIL_KEY  preferred — Sales OS email relay (link only: the relay's
//                      payload has no attachments that we know of)
//   SALESOS_EMAIL_URL  default "https://api.freightpopsales.com/api/email-relay/send"
//   RESEND_API_KEY     fallback — Resend; the Excel is attached
//   NOTIFY_FROM        default "FPX <fpx@updates.freightpopsales.com>"
//   DASHBOARD_URL      default "https://fpxpress.netlify.app"
import { supabase } from "./supabase.js";
import { getSetting } from "./settings.js";
import { readXlsx, unzip } from "./xlsxRead.js";
import { writeXlsx, zip } from "./xlsxWrite.js";

export const REPORT_BUCKET = "erp-pulls";
export const DEFAULT_RECIPIENTS = ["isaacs@freightpop.com"];
export const SIGNED_URL_SECONDS = 7 * 24 * 60 * 60;
export const REPORT_TZ = "America/Los_Angeles";
const XLSX_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const ID_CHUNK = 200;
const PAGE = 1000;

export const STATUSES = ["no_invoice", "invoice_not_approved", "approved_ready"];
export const STATUS_LABELS = {
  no_invoice: "No invoice",
  invoice_not_approved: "Invoice not approved",
  approved_ready: "Approved – ready to export",
  exported: "Exported to ERP",
};
export const FPX_COLUMNS = ["FPX Status", "Approved by", "Documents saved", "Last pulled", "Run #"];

// ── pure helpers ─────────────────────────────────────────────────────────────

export function statusLabel(status) {
  return STATUS_LABELS[status] || String(status || "");
}

// The same rule as the fpx_erp_invoicing view's `bucket`, for a row the view
// did not return.
export function bucketOf(tx = {}, approval = null) {
  if (tx.exported_to_erp === true) return "exported";
  if (approval || Number(tx.approved_invoice_amount || 0) !== 0) return "approved_ready";
  if (Number(tx.not_approved_invoice_amount || 0) !== 0) return "invoice_not_approved";
  return "no_invoice";
}

const EMAIL_RE = /^[^\s@,;<>"]+@[^\s@,;<>"]+\.[^\s@,;<>"]+$/;

// "a@x.com, B@x.com; a@x.com" | ["a@x.com"] → ["a@x.com", "b@x.com"].
// Invalid entries are dropped; nothing valid → the default list.
export function parseRecipients(value, fallback = DEFAULT_RECIPIENTS) {
  let list = [];
  if (Array.isArray(value)) list = value;
  else if (typeof value === "string") {
    const s = value.trim();
    if (s.startsWith("[")) {
      try { const j = JSON.parse(s); if (Array.isArray(j)) list = j; } catch { list = s.split(/[,;\s]+/); }
    } else list = s.split(/[,;\s]+/);
  }
  const out = [];
  for (const raw of list) {
    const e = String(raw ?? "").trim().replace(/^<|>$/g, "").toLowerCase();
    if (e && EMAIL_RE.test(e) && !out.includes(e)) out.push(e);
  }
  return out.length ? out : [...fallback];
}

const toNum = (v) => {
  if (v === null || v === undefined || v === "") return 0;
  const n = typeof v === "number" ? v : Number(String(v).replace(/[$,\s]/g, ""));
  return Number.isFinite(n) ? n : 0;
};
const round2 = (n) => Math.round(n * 100) / 100;

// Biggest charge first; ties by shipment id. Returns a new array.
export function sortByChargeDesc(rows) {
  return [...(rows || [])].sort((a, b) => toNum(b.charge) - toNum(a.charge)
    || String(a.shipment_id ?? "").localeCompare(String(b.shipment_id ?? ""), "en", { numeric: true }));
}

// → { total, no_invoice, invoice_not_approved, approved_ready, charge_total,
//     cost_total, by_status: { <status>: { count, charge, cost } } }
export function summarizeRows(rows) {
  const by_status = {};
  for (const s of STATUSES) by_status[s] = { count: 0, charge: 0, cost: 0 };
  let charge_total = 0, cost_total = 0;
  for (const r of rows || []) {
    const s = by_status[r.status] ? r.status : "no_invoice";
    const c = toNum(r.charge), k = toNum(r.cost);
    by_status[s].count++;
    by_status[s].charge += c;
    by_status[s].cost += k;
    charge_total += c;
    cost_total += k;
  }
  for (const s of STATUSES) { by_status[s].charge = round2(by_status[s].charge); by_status[s].cost = round2(by_status[s].cost); }
  return {
    total: (rows || []).length,
    no_invoice: by_status.no_invoice.count,
    invoice_not_approved: by_status.invoice_not_approved.count,
    approved_ready: by_status.approved_ready.count,
    charge_total: round2(charge_total),
    cost_total: round2(cost_total),
    by_status,
  };
}

// Calendar day in `tz` (Pacific by default) → "YYYY-MM-DD".
export function reportDay(date = new Date(), tz = REPORT_TZ) {
  const d = date instanceof Date ? date : new Date(date);
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
  } catch {
    return d.toISOString().slice(0, 10);
  }
}

export function reportFilename(date = new Date()) {
  return `FPX-not-exported-to-ERP-${reportDay(date)}.xlsx`;
}

// Storage path of the day's report. Only this path is ever upserted, so a
// re-send the same day replaces that day's file and no other.
export function reportObjectPath(date = new Date()) {
  return `reports/${reportDay(date)}/${reportFilename(date)}`;
}

// Free-text match on the ids and names people search by.
export function matchesQuery(row, q) {
  const term = String(q ?? "").trim().toLowerCase();
  if (!term) return true;
  const hay = [row.shipment_id, row.tracking, row.customer, row.carrier, row.invoice_number, row.approved_by]
    .filter((v) => v !== null && v !== undefined).map((v) => String(v).toLowerCase());
  return term.split(/\s+/).every((w) => hay.some((h) => h.includes(w)));
}

// FreightPOP's header order first, then any other column the stored rows have
// (sorted), then FPX's columns.
export function reportColumns(fpHeaders, rows) {
  const columns = [];
  const seen = new Set(FPX_COLUMNS);
  const add = (c) => { const k = String(c ?? "").trim(); if (k && !seen.has(k)) { seen.add(k); columns.push(k); } };
  (fpHeaders || []).forEach(add);
  const extra = new Set();
  for (const r of rows || []) for (const k of Object.keys(r?.data || {})) if (!seen.has(k)) extra.add(k);
  [...extra].sort().forEach(add);
  return [...columns, ...FPX_COLUMNS];
}

// A report row → the Excel row object (blank cells left out).
export function sheetRow(row, columns) {
  const o = {};
  const data = row.data || {};
  for (const c of columns) {
    const v = data[c];
    if (v !== "" && v !== null && v !== undefined) o[c] = v;
  }
  o["FPX Status"] = statusLabel(row.status);
  if (row.approved_by) o["Approved by"] = row.approved_by;
  o["Documents saved"] = row.docs_saved ? "Yes" : "No";
  if (row.last_pulled_at) o["Last pulled"] = String(row.last_pulled_at).slice(0, 10);
  if (row.run_number !== null && row.run_number !== undefined) o["Run #"] = row.run_number;
  return o;
}

export function summarySheetRows(summary, { generatedAt = new Date(), windowNote = "" } = {}) {
  const out = STATUSES.map((s) => ({
    Status: statusLabel(s), Shipments: summary.by_status[s].count,
    Charge: summary.by_status[s].charge, Cost: summary.by_status[s].cost,
  }));
  out.push({ Status: "Total not exported", Shipments: summary.total, Charge: summary.charge_total, Cost: summary.cost_total });
  out.push({});
  out.push({ Status: "Generated at", Shipments: new Date(generatedAt).toISOString() });
  if (windowNote) out.push({ Status: "Window", Shipments: windowNote });
  return out;
}

export function windowNote(rows) {
  let min = null, max = null;
  for (const r of rows || []) {
    const d = r.ship_date ? String(r.ship_date).slice(0, 10) : null;
    if (!d) continue;
    if (!min || d < min) min = d;
    if (!max || d > max) max = d;
  }
  const base = "All time: every shipment FPX has saved from FreightPOP's Transactions History Report whose Exported to ERP flag is not set";
  return min ? `${base}. Ship dates ${min} to ${max}.` : `${base}.`;
}

const xmlEsc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// [{ name, headers, rows }] → one workbook with a sheet per entry, in order.
// Each sheet is written by writeXlsx and moved into a shared workbook.
export function writeWorkbook(sheets) {
  const X = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
  const MAIN = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
  const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
  const PKG = "http://schemas.openxmlformats.org/package/2006";
  const first = unzip(writeXlsx(sheets[0].headers, sheets[0].rows));
  const sheetXml = sheets.map((s, i) => (i === 0 ? first : unzip(writeXlsx(s.headers, s.rows))).get("xl/worksheets/sheet1.xml"));
  const n = sheets.length;
  const parts = [
    ["[Content_Types].xml", Buffer.from(`${X}<Types xmlns="${PKG}/content-types">` +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
      sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("") +
      '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
      "</Types>", "utf8")],
    ["_rels/.rels", first.get("_rels/.rels")],
    ["xl/workbook.xml", Buffer.from(`${X}<workbook xmlns="${MAIN}" xmlns:r="${REL}"><sheets>` +
      sheets.map((s, i) => `<sheet name="${xmlEsc(String(s.name).slice(0, 31))}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("") +
      "</sheets></workbook>", "utf8")],
    ["xl/_rels/workbook.xml.rels", Buffer.from(`${X}<Relationships xmlns="${PKG}/relationships">` +
      sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="${REL}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("") +
      `<Relationship Id="rId${n + 1}" Type="${REL}/styles" Target="styles.xml"/></Relationships>`, "utf8")],
    ["xl/styles.xml", first.get("xl/styles.xml")],
    ...sheetXml.map((x, i) => [`xl/worksheets/sheet${i + 1}.xml`, x]),
  ];
  return zip(parts.map(([name, data]) => ({ name, data })));
}

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const num = (n) => Number(n || 0).toLocaleString("en-US");
export const money = (n) => `$${Number(n || 0).toLocaleString("en-US", { maximumFractionDigits: 0 })}`;

// → { subject, html, text }
export function buildReportEmail({ summary, runNumber = null, downloadUrl = "", dashboardUrl = "https://fpxpress.netlify.app", attached = false, date = new Date() }) {
  const run = runNumber !== null && runNumber !== undefined ? ` · Run #${runNumber}` : "";
  const subject = `Not exported to ERP — ${num(summary.total)} shipments (${money(summary.charge_total)})${run}`;
  const page = `${String(dashboardUrl).replace(/\/$/, "")}/invoices`;
  const lines = STATUSES.map((s) => [statusLabel(s), summary.by_status[s].count, summary.by_status[s].charge]);
  const html = `<!doctype html><html><body style="margin:0;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#0f172a;font-size:14px">
<div style="max-width:560px;padding:20px">
<p style="margin:0 0 12px">Shipments in FreightPOP not yet exported to the ERP, as of ${esc(reportDay(date))}${esc(run)}.</p>
<table style="border-collapse:collapse;font-size:14px">
${lines.map(([l, c, ch]) => `<tr><td style="padding:3px 16px 3px 0">${esc(l)}</td><td style="padding:3px 16px;text-align:right">${num(c)}</td><td style="padding:3px 0;text-align:right">${money(ch)}</td></tr>`).join("\n")}
<tr><td style="padding:6px 16px 3px 0;font-weight:600;border-top:1px solid #e2e8f0">Total</td><td style="padding:6px 16px 3px;text-align:right;font-weight:600;border-top:1px solid #e2e8f0">${num(summary.total)}</td><td style="padding:6px 0 3px;text-align:right;font-weight:600;border-top:1px solid #e2e8f0">${money(summary.charge_total)}</td></tr>
</table>
<p style="margin:16px 0 4px">${attached ? "The Excel is attached. " : ""}${downloadUrl ? `<a href="${esc(downloadUrl)}">Download the Excel</a> (link works for 7 days).` : ""}</p>
<p style="margin:4px 0">Open the list in FPX: <a href="${esc(page)}">${esc(page)}</a></p>
<p style="margin:16px 0 0;font-size:12px;color:#64748b">Sent automatically after each pull from FreightPOP.</p>
</div></body></html>`;
  const text = [
    `Shipments in FreightPOP not yet exported to the ERP, as of ${reportDay(date)}${run}.`,
    ...lines.map(([l, c, ch]) => `${l}: ${num(c)} (${money(ch)})`),
    `Total: ${num(summary.total)} (${money(summary.charge_total)})`,
    attached ? "The Excel is attached." : "",
    downloadUrl ? `Download the Excel (7 days): ${downloadUrl}` : "",
    `Open in FPX: ${page}`,
  ].filter(Boolean).join("\n");
  return { subject, html, text };
}

// "FPX <fpx@updates.example.com>" → { fromName, fromLocal } (the relay picks the domain).
export function relaySender(from) {
  const m = String(from || "").match(/^\s*"?([^"<]*?)"?\s*<\s*([^@\s<>]+)@[^>]+>\s*$/);
  if (m) return { fromName: m[1].trim() || "FPX", fromLocal: m[2].toLowerCase() };
  const bare = String(from || "").match(/^\s*([^@\s<>]+)@\S+\s*$/);
  return { fromName: "FPX", fromLocal: bare ? bare[1].toLowerCase() : "fpx" };
}

export function emailTransport(env = process.env) {
  if (env.SALESOS_EMAIL_KEY) return "relay";
  if (env.RESEND_API_KEY) return "resend";
  return null;
}

// ── data ─────────────────────────────────────────────────────────────────────

async function chunked(ids, fn) {
  const out = [];
  for (let i = 0; i < ids.length; i += ID_CHUNK) {
    const { data, error } = await fn(ids.slice(i, i + ID_CHUNK));
    if (error) throw new Error(error.message);
    out.push(...(data || []));
  }
  return out;
}

// audit_id → run_number. {} when fpx_invoice_pipeline is missing.
async function runNumbers() {
  try {
    const { data, error } = await supabase.from("fpx_invoice_pipeline").select("audit_id, run_number").limit(5000);
    if (error) return {};
    const m = {};
    for (const r of data || []) m[r.audit_id] = r.run_number;
    return m;
  } catch { return {}; }
}

// Shipment ids that have saved invoice documents.
async function docsSaved(ids) {
  const saved = new Set();
  try {
    const recs = await chunked(ids, (c) => supabase.from("fpx_shipment_records").select("shipment_id, files")
      .eq("kind", "invoice").in("shipment_id", c));
    for (const r of recs) if (Array.isArray(r.files) && r.files.length) saved.add(String(r.shipment_id));
  } catch { /* leave as not saved */ }
  try {
    const rest = ids.filter((id) => !saved.has(id));
    const docs = await chunked(rest, (c) => supabase.from("fpx_invoice_documents").select("shipment_id").in("shipment_id", c));
    for (const d of docs) saved.add(String(d.shipment_id));
  } catch { /* table missing */ }
  return saved;
}

// All-time not exported shipments, biggest charge first.
export async function buildNotExportedRows({ q, status } = {}) {
  const tx = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase.from("fpx_erp_transactions")
      .select("shipment_id, tracking_number, customer_name, carrier, shipped_date, charge, cost, billing_invoice_number, approved_invoice_amount, not_approved_invoice_amount, exported_to_erp, last_seen_at, last_pull_audit_id, data")
      .or("exported_to_erp.is.null,exported_to_erp.eq.false")
      .order("charge", { ascending: false, nullsFirst: false }).order("shipment_id", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    tx.push(...(data || []));
    if (!data || data.length < PAGE) break;
  }
  const ids = tx.map((t) => String(t.shipment_id));
  const view = new Map();
  for (const v of await chunked(ids, (c) => supabase.from("fpx_erp_invoicing")
    .select("shipment_id, bucket, approved_by, approved_invoice_number").in("shipment_id", c))) view.set(String(v.shipment_id), v);
  const [runs, saved] = await Promise.all([runNumbers(), docsSaved(ids)]);

  let rows = tx.map((t) => {
    const v = view.get(String(t.shipment_id));
    const bucket = v?.bucket || bucketOf(t, null);
    return {
      shipment_id: String(t.shipment_id),
      status: bucket,
      customer: t.customer_name ?? null,
      carrier: t.carrier ?? null,
      tracking: t.tracking_number ?? null,
      ship_date: t.shipped_date ?? null,
      charge: t.charge === null || t.charge === undefined ? null : Number(t.charge),
      cost: t.cost === null || t.cost === undefined ? null : Number(t.cost),
      invoice_number: v?.approved_invoice_number || t.billing_invoice_number || null,
      approved_by: v?.approved_by ?? null,
      docs_saved: saved.has(String(t.shipment_id)),
      last_pulled_at: t.last_seen_at ?? null,
      run_number: t.last_pull_audit_id && runs[t.last_pull_audit_id] !== undefined ? runs[t.last_pull_audit_id] : null,
      data: t.data || {},
    };
  }).filter((r) => r.status !== "exported");
  if (status && status !== "all") rows = rows.filter((r) => r.status === status);
  if (q) rows = rows.filter((r) => matchesQuery(r, q));
  return sortByChargeDesc(rows);
}

// FreightPOP's History Report header order: the export view's columns, or the
// header of the newest stored full.xlsx. [] when neither is there.
async function historyReportHeaders() {
  try {
    const { data, error } = await supabase.from("fpx_freightpop_transactions_export").select("*").limit(1);
    if (!error && data?.[0]) {
      const keys = Object.keys(data[0]);
      if (keys.length >= 5) return keys;
    }
  } catch { /* fall through */ }
  try {
    const { data: audits } = await supabase.from("fpx_invoice_audits").select("id")
      .eq("shipment_type", "erp_pending").order("created_at", { ascending: false }).limit(4);
    for (const a of audits || []) {
      const { data: blob, error } = await supabase.storage.from(REPORT_BUCKET).download(`${a.id}/full.xlsx`);
      if (error || !blob) continue;
      try {
        const { headers } = readXlsx(Buffer.from(await blob.arrayBuffer()));
        if (headers.length) return headers;
      } catch { /* try the next */ }
    }
  } catch { /* none */ }
  return [];
}

async function workbookFrom(rows, now = new Date()) {
  const fp = await historyReportHeaders();
  const columns = reportColumns(fp, rows);
  const summary = summarizeRows(rows);
  const buffer = writeWorkbook([
    { name: "Not exported", headers: columns, rows: rows.map((r) => sheetRow(r, columns)) },
    { name: "Summary", headers: ["Status", "Shipments", "Charge", "Cost"], rows: summarySheetRows(summary, { generatedAt: now, windowNote: windowNote(rows) }) },
  ]);
  return { buffer, filename: reportFilename(now), count: rows.length, summary };
}

export async function buildNotExportedWorkbook() {
  const rows = await buildNotExportedRows();
  const { buffer, filename, count } = await workbookFrom(rows);
  return { buffer, filename, count };
}

export async function getReportRecipients() {
  try {
    return parseRecipients(await getSetting("invoices.report_recipients"));
  } catch {
    return [...DEFAULT_RECIPIENTS];
  }
}

async function markPipeline(auditId, patch) {
  if (!auditId) return;
  try {
    await supabase.from("fpx_invoice_pipeline").update({ ...patch, updated_at: new Date().toISOString() }).eq("audit_id", auditId);
  } catch { /* table missing: nothing to record */ }
}

async function runNumberFor(auditId) {
  try {
    let qb = supabase.from("fpx_invoice_pipeline").select("run_number");
    qb = auditId ? qb.eq("audit_id", auditId) : qb.order("run_number", { ascending: false });
    const { data, error } = await qb.limit(1);
    if (error) return null;
    return data?.[0]?.run_number ?? null;
  } catch { return null; }
}

async function sendOne(transport, to, { subject, html, text }, attachment, fetchImpl) {
  const env = process.env;
  const from = env.NOTIFY_FROM || "FPX <fpx@updates.freightpopsales.com>";
  if (transport === "relay") {
    const url = env.SALESOS_EMAIL_URL || "https://api.freightpopsales.com/api/email-relay/send";
    const res = await fetchImpl(url, {
      method: "POST",
      headers: { "x-api-key": env.SALESOS_EMAIL_KEY, "content-type": "application/json" },
      body: JSON.stringify({ to: [to], subject, html, text, ...relaySender(from) }),
    });
    return res.ok ? null : `${res.status} ${(await res.text()).slice(0, 200)}`;
  }
  const res = await fetchImpl("https://api.resend.com/emails", {
    method: "POST",
    headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({
      from, to: [to], subject, html, text,
      ...(attachment ? { attachments: [{ filename: attachment.filename, content: attachment.buffer.toString("base64") }] } : {}),
    }),
  });
  return res.ok ? null : `${res.status} ${(await res.text()).slice(0, 200)}`;
}

// Never throws. → { sent, recipients, error? }
export async function sendNotExportedReport({ auditId = null, reason = "manual", fetchImpl = fetch } = {}) {
  let recipients = [...DEFAULT_RECIPIENTS];
  try {
    recipients = await getReportRecipients();
    const transport = emailTransport();
    if (!transport) {
      const error = "Email is not configured on the API server (SALESOS_EMAIL_KEY or RESEND_API_KEY)";
      await markPipeline(auditId, { report_email_error: error });
      return { sent: false, recipients, error };
    }

    const now = new Date();
    const rows = await buildNotExportedRows();
    const { buffer, filename, summary } = await workbookFrom(rows, now);

    // Today's path only; other days' files are never touched.
    const path = reportObjectPath(now);
    let downloadUrl = "";
    try {
      const up = await supabase.storage.from(REPORT_BUCKET).upload(path, buffer, { contentType: XLSX_TYPE, upsert: true });
      if (up.error) console.warn("[invoiceReport] upload failed:", up.error.message);
      else {
        const { data, error } = await supabase.storage.from(REPORT_BUCKET).createSignedUrl(path, SIGNED_URL_SECONDS, { download: filename });
        if (!error && data?.signedUrl) downloadUrl = data.signedUrl;
      }
    } catch (e) { console.warn("[invoiceReport] storage failed:", e.message); }

    const attach = transport === "resend";
    const runNumber = await runNumberFor(auditId);
    const mail = buildReportEmail({
      summary, runNumber, downloadUrl, attached: attach, date: now,
      dashboardUrl: process.env.DASHBOARD_URL || "https://fpxpress.netlify.app",
    });

    const failed = [];
    let delivered = 0;
    for (const to of recipients) {
      try {
        const err = await sendOne(transport, to, mail, attach ? { filename, buffer } : null, fetchImpl);
        if (err) failed.push(`${to}: ${err}`); else delivered++;
      } catch (e) { failed.push(`${to}: ${e.message}`); }
    }
    const error = failed.length ? `Not delivered to ${failed.join("; ")}` : undefined;
    if (delivered) await markPipeline(auditId, { report_emailed_at: new Date().toISOString(), report_email_error: error ?? null });
    else await markPipeline(auditId, { report_email_error: error || "Not delivered" });
    console.log(`[invoiceReport] ${reason}: emailed ${delivered} of ${recipients.length} via ${transport} (${rows.length} not exported)`);
    return error ? { sent: delivered > 0, recipients, error } : { sent: true, recipients };
  } catch (e) {
    const error = e?.message || String(e);
    await markPipeline(auditId, { report_email_error: error });
    return { sent: false, recipients, error };
  }
}
