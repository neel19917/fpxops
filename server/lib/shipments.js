// Map a scraped extension row (arbitrary keys) into an fpx_shipments record.
// Unknown keys are preserved verbatim in raw_data.

const toNum = (v) => {
  if (v == null || v === "") return null;
  const x = Number(String(v).replace(/[$,]/g, ""));
  return Number.isFinite(x) ? x : null;
};
const toIso = (v) => {
  if (!v) return null;
  const d = new Date(v);
  return isNaN(d) ? null : d.toISOString();
};
const pick = (raw, keys) => {
  for (const k of keys) {
    const v = raw[k];
    if (v !== undefined && v !== null && v !== "") return v;
  }
  return null;
};

// Some scraped fields (signed_by, comments, status, pickup_response) get
// polluted with the full modal text when the page layout nests labels inside
// a parent that contains everything. The scraper's fallback `parent.textContent`
// grabs the whole blob. Detect that here and drop it; cap reasonable fields
// to a readable length.
const MODAL_BLOB_MARKERS = ["Tracking Number:", "Ship From:", "Ship To:", "Carrier:", "Service:", "Number of Pieces:", "Total Weight:"];
function cleanField(v, opts = {}) {
  if (v === null || v === undefined) return null;
  let s = String(v).replace(/\s+/g, " ").trim();
  if (!s) return null;
  const hits = MODAL_BLOB_MARKERS.filter((m) => s.includes(m)).length;
  if (hits >= 3) return null;                                  // full-modal blob — drop
  // Strings that are pure label residue from a stripped sibling — e.g.
  // "Delivered Date: Event History:" — are not real values.
  if (/^(Status|Delivered Date|Date|Event History|Notes|Details)\s*:/i.test(s) && s.length < 80) {
    return null;
  }
  const max = opts.maxLen ?? 300;
  if (s.length > max) s = s.slice(0, max).replace(/\s+\S*$/, "") + "…";
  return s;
}

// FreightPOP returns shipment origin/destination as a single comma-separated
// blob like "ASSOCIATED PACKAGING, INC., 435 Calvert Dr, Gallatin, TN, 37066, US".
// We don't get a clean customer_name field, so guess it: take leading comma
// segments that don't start with a digit. Stops at the first street-address
// segment. Returns null if nothing usable.
export function guessCustomerNameFromAddress(addr) {
  if (!addr || typeof addr !== "string") return null;
  const parts = addr.split(",").map((p) => p.trim()).filter(Boolean);
  const out = [];
  for (const p of parts) {
    if (/^\d/.test(p)) break;            // street number — stop
    if (/\b(US|USA|CA|MX)\b/i.test(p) && p.length <= 3) break;
    out.push(p);
  }
  if (!out.length) return null;
  // Strip trailing entity suffix punctuation oddities like "INC." -> keep as-is.
  return out.join(", ");
}

export function mapShipment(raw, runnerName) {
  if (!raw || typeof raw !== "object") return null;
  const explicitCustomer = pick(raw, ["Customer Name", "CUSTOMER NAME", "Customer"]);
  const origin = pick(raw, ["Ship From", "Origin"]);
  const destination = pick(raw, ["Ship To", "Destination"]);
  const guessedCustomer = explicitCustomer || guessCustomerNameFromAddress(origin);
  return {
    created_by: runnerName || null,
    tracking_number: pick(raw, ["_trackingNumber", "Tracking Number", "TRACKING"]),
    shipment_id: pick(raw, ["Shipment ID", "SHIPMENT ID", "shipment_id"]),
    customer_name: guessedCustomer,
    customer_id: pick(raw, ["Customer ID", "CUSTOMER ID"]),
    account_manager: pick(raw, ["Account Manager", "ACCOUNT MANAGER"]),
    carrier: pick(raw, ["CARRIER", "Carrier"]),
    carrier_name: pick(raw, ["CARRIER NAME", "Carrier Name"]),
    mode: pick(raw, ["MODE", "Mode"]),
    shipment_status: cleanField(pick(raw, ["SHIPMENT STATUS", "Shipment Status", "Status"]), { maxLen: 80 }),
    comments: cleanField(pick(raw, ["COMMENTS", "Comments"]), { maxLen: 500 }),
    pickup_response: cleanField(pick(raw, ["PICKUP RESPONSE", "Pickup Response"]), { maxLen: 200 }),
    pickup_request_number: cleanField(pick(raw, ["PICKUP REQUEST NUMBER"]), { maxLen: 60 }),
    confirmation_number: cleanField(pick(raw, ["CONFIRMATION NUMBER"]), { maxLen: 60 }),
    pickup_date: toIso(pick(raw, ["PICKUP DATE", "Pickup Date"])),
    updated_eta: toIso(pick(raw, ["UPDATED ETA", "Updated ETA"])),
    estimated_departure: toIso(pick(raw, ["ESTIMATED DEPARTURE DATE"])),
    actual_departure: toIso(pick(raw, ["ACTUAL DEPARTURE DATE"])),
    estimated_arrival: toIso(pick(raw, ["ESTIMATED ARRIVAL DATE"])),
    actual_arrival: toIso(pick(raw, ["ACTUAL ARRIVAL DATE"])),
    delivery_date: toIso(pick(raw, ["DELIVERY DATE", "Delivery Date"])),
    signed_by: cleanField(pick(raw, ["SIGNED BY", "Signed By"]), { maxLen: 80 }),
    booking_date: toIso(pick(raw, ["BOOKING DATE"])),
    inbound_customs_date: toIso(pick(raw, ["INBOUND CUSTOMS DATE"])),
    port_departure_date: toIso(pick(raw, ["PORT DEPARTURE DATE"])),
    outbound_customs_date: toIso(pick(raw, ["OUTBOUND CUSTOMS DATE"])),
    on_board_date: toIso(pick(raw, ["ON-BOARD DATE"])),
    longitude: toNum(pick(raw, ["LONGITUDE"])),
    latitude: toNum(pick(raw, ["LATITUDE"])),
    origin,
    destination,
    ship_from: pick(raw, ["Ship From"]),
    ship_to: pick(raw, ["Ship To"]),
    service: pick(raw, ["Service"]),
    shipment_marked_up_rate: toNum(pick(raw, ["Shipment Marked Up Rate"])),
    shipment_rate_without_markup: toNum(pick(raw, ["Shipment Rate Without Markup"])),
    shipment_gross_profit: toNum(pick(raw, ["Shipment Gross Profit"])),
    total_weight: toNum(pick(raw, ["Total Weight", "TOTAL WEIGHT"])),
    total_packages: toNum(pick(raw, ["Total Packages", "TOTAL PACKAGES"])),
    action_required: pick(raw, ["_actionRequired"]),
    ai_issue: pick(raw, ["_aiIssue"]),
    ai_recommendation: pick(raw, ["_aiRecommendation"]),
    raw_data: raw,
    scraped_at: new Date().toISOString(),
  };
}

export function mapShipmentsBulk(rows, runnerName) {
  return (rows || []).map((r) => mapShipment(r, runnerName)).filter((r) => r && r.tracking_number);
}
