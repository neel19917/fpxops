// How sure FPX is that a shipment's carrier invoice approval is right, from
// what it holds about that shipment: the History Report row, the approval
// read from FreightPOP's Audit page, and the record the hosted browser saved
// (View Shipment and its buttons, the customer invoice). Rules only: the same
// inputs always give the same score.
//
// Every shipment starts at 100. Each thing that is missing, does not match or
// calls for a second look takes points off. Below the threshold (90 unless
// APPROVAL_CONFIDENCE_MIN says otherwise) the shipment needs a person.

export const APPROVAL_CONFIDENCE_MIN = (() => {
  const n = Number(process.env.APPROVAL_CONFIDENCE_MIN);
  return Number.isFinite(n) && n > 0 && n <= 100 ? n : 90;
})();

const num = (v) => {
  if (v == null || v === "") return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const text = String(v).trim();
  const n = Number(text.replace(/[$,\s()]/g, ""));
  if (text === "" || !Number.isFinite(n)) return null;
  return /^\(.*\)$/.test(text) ? -n : n;
};
const money = (n) => `$${Math.abs(n).toFixed(2)}`;
const near = (a, b) => Math.abs(a - b) <= 0.01;

// "Shipment Sale:\n$ 168.26" → 168.26, from the text of the View Shipment window.
function moneyAfter(text, label) {
  const m = new RegExp(`${label}\\s*:?\\s*\\$?\\s*([\\d,]+(?:\\.\\d+)?)`, "i").exec(String(text || ""));
  return m ? num(m[1]) : null;
}

/**
 * @param {object} row       a fpx_invoice_audit_rows row of an ERP pull
 * @param {object|null} view the shipment's fpx_shipment_records row of kind "view_shipment"
 * @param {object|null} approval the shipment's fpx_audit_approvals row (by tracking number)
 * @returns {{ confidence, pass, missing: string[], issues: string[], cautions: string[] }}
 */
export function checkApproval(row, view = null, approval = null, threshold = APPROVAL_CONFIDENCE_MIN) {
  const raw = row?.raw && typeof row.raw === "object" ? row.raw : {};
  const ap = raw.approval && typeof raw.approval === "object" ? raw.approval : null;
  const apData = approval?.data && typeof approval.data === "object" ? approval.data : {};
  const missing = [];  // evidence FPX does not hold
  const issues = [];   // something that does not match
  const cautions = []; // matches, but worth a second look
  let score = 100;
  const take = (points, list, text) => { score -= points; list.push(text); };

  // ── The money ──
  const invoice = num(approval?.invoice_amount) ?? num(ap?.amount) ?? num(row?.bill_amount);
  const cost = num(row?.shipment_cost) ?? num(approval?.quote_amount);
  const charge = num(raw.charge);
  const gp = num(raw.gross_profit);
  if (invoice == null) take(40, missing, "Carrier invoice amount");
  if (cost == null) take(25, missing, "Quoted carrier cost");
  if (invoice != null && cost != null && !near(invoice, cost)) {
    const diff = invoice - cost;
    take(30, issues, `Carrier invoice is ${money(diff)} ${diff > 0 ? "over" : "under"} the quoted cost (${money(invoice)} against ${money(cost)})`);
  }
  if (charge != null && cost != null && gp != null && !near(charge, cost + gp)) {
    take(10, issues, `Customer charge ${money(charge)} is not cost ${money(cost)} plus gross profit ${money(gp)}`);
  }

  // ── The approval ──
  const approved = ap?.status === "approved" || !!approval;
  const approver = String(approval?.approved_by ?? ap?.approved_by ?? "").trim();
  if (!approved || !approver) take(15, missing, "Who approved the carrier invoice");
  if (/^(true|yes)$/i.test(String(apData["Is Forced Approved"] ?? ""))) take(5, cautions, "The approval was forced");
  const invoiceNo = String(approval?.invoice_number ?? ap?.invoice ?? "");
  if (/dup|corr|rev/i.test(invoiceNo)) take(5, cautions, `Corrected or duplicate invoice number (${invoiceNo})`);
  const invoiceCount = num(apData["Number of Invoices for Tracking Number"]) ?? num(ap?.matches);
  if (invoiceCount != null && invoiceCount > 1) take(15, cautions, `${invoiceCount} carrier invoices for this tracking number`);
  if (approval && !String(apData["POD Date"] ?? "").trim()) take(5, missing, "Proof of delivery date");

  // ── The saved record ──
  const shots = Array.isArray(raw.get_invoice?.shots) ? raw.get_invoice.shots.map(String) : [];
  const viewFiles = Array.isArray(view?.files) ? view.files.map(String) : [];
  const files = [...shots, ...viewFiles];
  if (!files.some((f) => /-invoice(-\d+)?\.pdf$/.test(f) && !/-view-/.test(f))) take(10, missing, "Customer invoice PDF (Get Invoice)");
  if (!view) {
    take(15, missing, "Shipment details (View Shipment)");
  } else {
    const data = view.data && typeof view.data === "object" ? view.data : {};
    const buttons = Array.isArray(data.buttons) ? data.buttons : [];
    const opened = (re) => buttons.find((b) => re.test(String(b?.label || "")) && String(b?.did || "").startsWith("opened"));
    if (!opened(/^details$/i)) take(5, missing, "Quote breakdown (freight, fuel, accessorials)");
    if (!viewFiles.some((f) => /labels-bol.*\.pdf$/.test(f))) take(5, missing, "Bill of lading");
    if (!viewFiles.some((f) => /rate-confirmation.*\.pdf$/.test(f))) take(5, missing, "Rate confirmation");
    const text = String(view.text ?? data.text ?? "");
    const sale = moneyAfter(text, "Shipment Sale");
    const viewCost = moneyAfter(text, "Shipment Cost");
    if (sale != null && charge != null && !near(sale, charge)) take(10, issues, `View Shipment shows a sale of ${money(sale)}; the report shows ${money(charge)}`);
    if (viewCost != null && cost != null && !near(viewCost, cost)) take(10, issues, `View Shipment shows a cost of ${money(viewCost)}; the report shows ${money(cost)}`);
  }

  const confidence = Math.max(0, Math.min(100, Math.round(score)));
  return { confidence, pass: confidence >= threshold, missing, issues, cautions };
}
