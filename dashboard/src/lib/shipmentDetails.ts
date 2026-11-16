import { apiUrl, getAccessTokenOrWait } from "./api";

// Client for the "FreightPOP details" drawer tab. A hosted browser reads
// FreightPOP's Shipment Details page for one shipment and the server stores the
// result. These calls only read that stored record and ask for a fresh read;
// nothing here changes anything in FreightPOP.

export interface ShipmentDetailsAccessorial { name: string; amount: number | null }

export interface ShipmentDetails {
  shipment_id: string; quote_id: string | null;
  carrier: string | null; account_nickname: string | null; tracking_number: string | null; vendor_name: string | null;
  service: string | null; payer: string | null; confirmation: string | null;
  ship_from: string | null; ship_to: string | null;
  // Dates and times are text exactly as FreightPOP shows them, e.g. "11/16/2026".
  pickup_date: string | null; delivery_date: string | null; ready_time: string | null; cutoff_time: string | null;
  quantity: number | null; package_type: string | null; dimension: string | null; weight_per_piece: number | null;
  freight_class: string | null; nmfc: string | null; description: string | null; so_number: string | null; po_number: string | null;
  total_units: number | null; total_weight: number | null; linear_feet: number | null;
  shipment_quote: number | null; quote_number: string | null;
  sale: number | null; cost: number | null; gross_profit: number | null;
  quote_freight: number | null; quote_fuel: number | null; quote_accessorial_total: number | null; quote_total: number | null;
  quote_accessorials: ShipmentDetailsAccessorial[] | null;
  captured_at: string; // ISO time of the read
  captured_by: string | null;
}

export type ShipmentDetailsJobStatus = "pending" | "claimed" | "done" | "error";

export interface ShipmentDetailsJob {
  id: string;
  status: ShipmentDetailsJobStatus;
  requested_at: string;
  completed_at: string | null;
  note: string | null;
}

export interface ShipmentDetailsResponse {
  details: ShipmentDetails | null; // null = never read from FreightPOP
  job: ShipmentDetailsJob | null; // the latest read request for this shipment
  can_refresh: boolean; // false when FPX does not know the shipment's FreightPOP quote id
  reason?: string | null; // why it can't be refreshed, a sentence to show
}

export interface ShipmentDetailsRefreshResponse { request: { id: string; status: string } }

async function call<T>(path: string, method: "GET" | "POST"): Promise<T> {
  const token = await getAccessTokenOrWait();
  const res = await fetch(`${apiUrl}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    if (body?.error) throw new Error(String(body.error));
    throw new Error(`The server returned ${res.status}`);
  }
  return res.json() as Promise<T>;
}

/** The stored FreightPOP details for a shipment, plus its latest read request. */
export function fetchShipmentDetails(shipmentId: string): Promise<ShipmentDetailsResponse> {
  return call(`/api/shipment-details/${encodeURIComponent(shipmentId)}`, "GET");
}

/** Ask the hosted browser to read the shipment's details from FreightPOP again. */
export function requestShipmentDetailsRefresh(shipmentId: string): Promise<ShipmentDetailsRefreshResponse> {
  return call(`/api/shipment-details/${encodeURIComponent(shipmentId)}/refresh`, "POST");
}

export function isReadRunning(job: ShipmentDetailsJob | null | undefined): boolean {
  return job?.status === "pending" || job?.status === "claimed";
}
