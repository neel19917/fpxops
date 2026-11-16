// Turns the text of FreightPOP's Shipment Details page (and of its Quote
// Detail panel) into the named fields kept in fpx_shipment_details. The page
// is read as plain text, one label or value per line; a value belongs to the
// label above it and ends at the next label.

const LABELS = new Set([
  "SHIPMENT DETAILS", "PRINT SHIPPING LABELS/BOL", "CANCEL SHIPMENT", "PRINT DOCUMENTS", "GENERATE RETURN LABELS",
  "EMAIL SHIPPING LABELS/BOL LINK", "CHANGE LOG", "EDIT DETAILS", "SHIP DATE", "SHIPMENT CONFIRMATION",
  "CARRIER", "ACCOUNT NICKNAME", "TRACKING", "RETURN TRACKING", "ORDER NUMBER", "LOCATION", "SHIP FROM", "SHIP TO",
  "QUANTITY", "TYPE", "SEE INNER ITEMS", "DIMENSION", "WEIGHT", "(PER PIECE)", "WEIGHT (PER PIECE)", "IN/LB", "CM/KG",
  "FREIGHT CLASS", "NMFC", "DESCRIPTION", "REFERENCES", "HAZMAT", "UN NA ID#", "NON STACKABLE", "SO NUMBER", "PO NUMBER",
  "REFERENCE3", "REFERENCE4", "REFERENCE5", "REFERENCE6", "PRODUCT DETAILS", "PAYER", "ACCOUNT DETAILS",
  "TOTAL HANDLING UNITS", "TOTAL WEIGHT", "TOTAL LINEAR FEET", "ACCESSORIALS/SERVICES", "VIEW", "SCHEDULE", "REQUEST PICKUP",
  "PICKUP DATE", "READY TIME", "CUTOFF TIME", "DELIVERY DATE", "OPEN TIME", "CLOSE TIME", "DRIVER TIME IN", "DRIVER TIME OUT",
  "TRAILER NUMBER", "SEAL NUMBER", "CONFIRMATION", "SHIPMENT QUOTE", "SEND CONFIRMATION EMAIL TO", "RESEND", "BROKER DETAILS",
  "SHIPMENT SALE", "SHIPMENT COST", "GROSS PROFIT", "VENDOR NAME", "PRINT RATE CONFIRMATION", "BROKER NOTES", "DOCUMENTS",
  "NOTES", "FILE A CLAIM", "ADD A NON-CONFORMANCE", "CLOSE",
]);

// "SHIP FROM *" / "Shipment Sale:" → "SHIP FROM" / "SHIPMENT SALE"
const norm = (line) => String(line || "").replace(/[*:]\s*$/, "").replace(/\s+/g, " ").trim().toUpperCase();
const isLabel = (line) => LABELS.has(norm(line)) || /^QUOTEID:/i.test(line) || /^QUOTE:\s/i.test(line) || /^TRANSACTION DOES NOT CONTAIN/i.test(line);

export function toNumber(v) {
  if (v == null) return null;
  const text = String(v).replace(/[$,\s]/g, "");
  if (text === "" || !/^-?\d*\.?\d+$/.test(text)) return null;
  const n = Number(text);
  return Number.isFinite(n) ? n : null;
}
const textOrNull = (v, max = 500) => {
  const t = String(v ?? "").replace(/\s+/g, " ").trim();
  return t ? t.slice(0, max) : null;
};

/** The lines under the nth line that reads `label`, up to the next label. */
function under(lines, label, nth = 1) {
  const want = norm(label);
  let seen = 0;
  for (let i = 0; i < lines.length; i++) {
    if (norm(lines[i]) !== want) continue;
    if (++seen !== nth) continue;
    const out = [];
    for (let j = i + 1; j < lines.length && !isLabel(lines[j]); j++) out.push(lines[j]);
    return out;
  }
  return [];
}

/** { freight, fuel, accessorial_total, total, accessorials: [{ name, amount }] } from the Quote Detail panel's text. */
export function parseQuoteDetail(text) {
  const lines = String(text || "").split("\n").map((l) => l.trim()).filter(Boolean);
  const start = lines.findIndex((l) => /^QUOTE DETAIL$/i.test(l));
  const out = { freight: null, fuel: null, accessorial_total: null, total: null, accessorials: [] };
  if (start < 0) return out;
  const body = lines.slice(start + 1);
  const end = body.findIndex((l) => /^CLOSE$/i.test(l));
  const rows = end >= 0 ? body.slice(0, end) : body;
  let inList = false;
  for (let i = 0; i < rows.length; i++) {
    const label = rows[i];
    const amount = toNumber(rows[i + 1]);
    if (/^ACCESSORIALS:?$/i.test(label)) { inList = true; continue; }
    if (amount == null) continue; // a heading, or a value already taken
    if (/^FREIGHT$/i.test(label)) out.freight = amount;
    else if (/^FUEL(\s*SC|\s*SURCHARGE)?$/i.test(label)) out.fuel = amount;
    else if (/^TOTAL ACCESSORIAL/i.test(label)) out.accessorial_total = amount;
    else if (/^TOTAL$/i.test(label)) { out.total = amount; inList = false; }
    else if (inList || toNumber(label) == null) out.accessorials.push({ name: label.slice(0, 120), amount });
    i++;
  }
  return out;
}

/**
 * @param {{ shipment_id, quote_id?, text, inputs?, quote_text?, url? }} record what the hosted browser read
 * @returns the row for fpx_shipment_details (without captured_at / captured_by), or null when the
 *          text is not this shipment's Shipment Details page.
 */
export function parseShipmentDetail(record) {
  const shipmentId = String(record?.shipment_id ?? "").trim();
  const text = String(record?.text ?? "");
  if (!shipmentId || !text) return null;
  const ids = /QuoteID:\s*(\d+)\s+ShipmentID:\s*(\d+)/i.exec(text);
  if (!ids || ids[2] !== shipmentId) return null;
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  const first = (label, nth) => textOrNull(under(lines, label, nth)[0]);
  const all = (label, nth) => textOrNull(under(lines, label, nth).join(", "));
  const inputs = record.inputs && typeof record.inputs === "object" ? record.inputs : {};

  // NMFC and Description sit in a grid that reads out of order: a value can
  // land under the REFERENCES heading that follows them.
  const loose = under(lines, "REFERENCES");
  let nmfc = first("NMFC");
  let description = first("DESCRIPTION");
  if (!description && loose.length) description = textOrNull(loose[loose.length - 1]);
  if (!nmfc && loose.length > 1 && /^[\d-]+$/.test(loose[0])) nmfc = loose[0];

  const second = under(lines, "CARRIER", 2); // the carrier again, then its service (LTL, Parcel…)
  const vendorKey = Object.keys(inputs).find((k) => /vendor\s*name/i.test(k));
  // The page shows the cost it is handed when opened; it does not look one up.
  // Opened without it, its cost and gross profit lines are not real figures.
  const costGiven = record.cost_given !== false;
  // A broker spot quote: this page shows the carrier's side only, so the sale
  // and cost FreightPOP's grid holds for the shipment are the ones kept.
  const grid = record.spot === true && toNumber(record.grid_sale) != null && toNumber(record.grid_cost) != null
    ? { sale: toNumber(record.grid_sale), cost: toNumber(record.grid_cost) } : null;
  const pageSale = toNumber(first("SHIPMENT SALE"));
  const pageCost = costGiven ? toNumber(first("SHIPMENT COST")) : null;
  const pageProfit = costGiven ? toNumber(first("GROSS PROFIT")) : null;
  const quote = parseQuoteDetail(record.quote_text);
  const banner = lines.find((l) => /^(Confirmation Number\s*=|Pickup Request number is)/i.test(l));
  const quoteNo = /(?:^|\n)Quote:\s*(\S+)/i.exec(text);

  return {
    shipment_id: shipmentId,
    quote_id: ids[1],
    carrier: first("CARRIER"),
    account_nickname: first("ACCOUNT NICKNAME"),
    tracking_number: textOrNull(String(first("TRACKING") || "").replace(/,\s*$/, "")),
    vendor_name: textOrNull(vendorKey ? inputs[vendorKey] : first("VENDOR NAME")),
    service: textOrNull(second[1]),
    payer: all("PAYER"),
    confirmation: textOrNull(banner),
    ship_from: all("SHIP FROM"),
    ship_to: all("SHIP TO"),
    pickup_date: first("PICKUP DATE"),
    delivery_date: first("DELIVERY DATE"),
    ready_time: first("READY TIME"),
    cutoff_time: first("CUTOFF TIME"),
    quantity: toNumber(first("QUANTITY")),
    package_type: first("TYPE"),
    dimension: first("DIMENSION"),
    weight_per_piece: toNumber(first("(PER PIECE)") ?? first("WEIGHT (PER PIECE)") ?? first("WEIGHT")),
    freight_class: first("FREIGHT CLASS"),
    nmfc,
    description,
    so_number: first("SO NUMBER"),
    po_number: first("PO NUMBER"),
    total_units: toNumber(first("TOTAL HANDLING UNITS")),
    total_weight: toNumber(first("TOTAL WEIGHT")),
    linear_feet: toNumber(first("TOTAL LINEAR FEET")),
    shipment_quote: toNumber(first("SHIPMENT QUOTE")),
    quote_number: quoteNo ? quoteNo[1].slice(0, 80) : null,
    sale: grid ? grid.sale : pageSale,
    cost: grid ? grid.cost : pageCost,
    gross_profit: grid ? Math.round((grid.sale - grid.cost) * 100) / 100 : pageProfit,
    financials_source: grid ? "grid_spot_quote" : "page",
    quote_freight: quote.freight,
    quote_fuel: quote.fuel,
    quote_accessorial_total: quote.accessorial_total,
    quote_total: quote.total,
    quote_accessorials: quote.accessorials,
    raw_text: text.slice(0, 200_000),
    data: { ...(grid ? { page_financials: { sale: pageSale, cost: pageCost, gross_profit: pageProfit } } : {}), inputs, quote_text: String(record.quote_text || "").slice(0, 20_000), url: textOrNull(record.url, 400) },
  };
}

const usd = (n) => (n == null ? "—" : `$${Number(n).toFixed(2)}`);
/** One line saying what was read, for the job's log. */
export function describeDetail(row) {
  return [
    row.carrier || "carrier not read",
    `sale ${usd(row.sale)}`, `cost ${usd(row.cost)}`, `gross profit ${usd(row.gross_profit)}`,
    row.quote_total != null ? `quote: freight ${usd(row.quote_freight)} + fuel ${usd(row.quote_fuel)} + accessorials ${usd(row.quote_accessorial_total)} = ${usd(row.quote_total)}` : "quote breakdown not read",
  ].join(" · ");
}
