import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { parseShipmentDetail, parseQuoteDetail, describeDetail } from "../lib/shipmentDetail.js";

// The page text as the hosted browser read it for shipment 15325790.
const TEXT = `CLOSE
Shipment Details PRINT SHIPPING LABELS/BOL PRINT DOCUMENTS GENERATE RETURN LABELS EMAIL SHIPPING LABELS/BOL LINK
SHIP DATE
EDIT DETAILS
Change Log
Pickup Request number is 000000000071307670
SHIPMENT CONFIRMATION
CARRIER
FreightPOP Inc / AAA Cooper
ACCOUNT NICKNAME
AAA Cooper / FreightPOP Account
TRACKING
373410950,
RETURN TRACKING
ORDER NUMBER
LOCATION
SHIP FROM *
Welch Packaging,4390 Liberty Street, Aurora, IL, 60504, US
SHIP TO *
TOTAL FOODS,1100 MARLIN CT, WAUKESHA, WI, 53186, US
SHIPMENT DETAILS
QUANTITY
1
TYPE
PALLET
SEE INNER ITEMS
DIMENSION
48 x 40 x 48
WEIGHT
(PER PIECE)
336
In/Lb
Cm/Kg
FREIGHT CLASS
125
NMFC
Description
REFERENCES
boxes
HAZMAT
UN NA ID#
NON STACKABLE
SO NUMBER
PO NUMBER
3531856
REFERENCE3
REFERENCE4
REFERENCE5
REFERENCE6
PRODUCT DETAILS
CARRIER
FREIGHTPOP INC / AAA COOPER
LTL
PAYER
THIRD PARTY
PREPAID (CARRIER ACCOUNT SELECTED WILL BE CHARGED)
TOTAL HANDLING UNITS:
1
TOTAL WEIGHT:
336.00
TOTAL LINEAR FEET:
1
ACCESSORIALS/SERVICES
VIEW
SCHEDULE
REQUEST PICKUP
PICKUP DATE
10/6/2026
READY TIME
08:00 AM
CUTOFF TIME
03:00 PM
DELIVERY DATE
10/07/2026
OPEN TIME
CLOSE TIME
DRIVER TIME IN
DRIVER TIME OUT
TRAILER NUMBER
SEAL NUMBER
QuoteID: 47838535 ShipmentID: 15325790
CONFIRMATION
SHIPMENT QUOTE:
$ 168.26
Quote: 0275266560 DETAILS
SEND CONFIRMATION EMAIL TO:
RESEND
BROKER DETAILS
Shipment Sale:
$ 168.26
Shipment Cost:
$ 155.8
Gross Profit:
$ 12.46
Vendor Name
BROKER NOTES
Transaction does not contain Broker Notes
DOCUMENTS NOTES Transaction does not contain Notes
Add a Non-Conformance`;

const QUOTE = `QUOTE DETAIL
FREIGHT
108.00
FUEL SC
60.26
TOTAL ACCESSORIAL CHARGE
0.00
ACCESSORIALS:
AccessorialCharge
0.00
TOTAL
168.26
CLOSE`;

describe("parseShipmentDetail", () => {
  const row = parseShipmentDetail({ shipment_id: "15325790", text: TEXT, quote_text: QUOTE, inputs: { "Vendor Name": "FreightPOP Inc / AAA Cooper" } });

  test("reads the carrier, the money and the quote breakdown", () => {
    assert.equal(row.quote_id, "47838535");
    assert.equal(row.carrier, "FreightPOP Inc / AAA Cooper");
    assert.equal(row.account_nickname, "AAA Cooper / FreightPOP Account");
    assert.equal(row.vendor_name, "FreightPOP Inc / AAA Cooper");
    assert.equal(row.tracking_number, "373410950");
    assert.equal(row.service, "LTL");
    assert.deepEqual([row.sale, row.cost, row.gross_profit, row.shipment_quote], [168.26, 155.8, 12.46, 168.26]);
    assert.equal(row.quote_number, "0275266560");
    assert.deepEqual([row.quote_freight, row.quote_fuel, row.quote_accessorial_total, row.quote_total], [108, 60.26, 0, 168.26]);
    assert.deepEqual(row.quote_accessorials, [{ name: "AccessorialCharge", amount: 0 }]);
  });

  test("reads the shipment itself", () => {
    assert.equal(row.ship_from, "Welch Packaging,4390 Liberty Street, Aurora, IL, 60504, US");
    assert.equal(row.ship_to, "TOTAL FOODS,1100 MARLIN CT, WAUKESHA, WI, 53186, US");
    assert.deepEqual([row.quantity, row.package_type, row.dimension, row.weight_per_piece], [1, "PALLET", "48 x 40 x 48", 336]);
    assert.deepEqual([row.freight_class, row.nmfc, row.description, row.po_number, row.so_number], ["125", null, "boxes", "3531856", null]);
    assert.deepEqual([row.total_units, row.total_weight, row.linear_feet], [1, 336, 1]);
    assert.deepEqual([row.pickup_date, row.ready_time, row.cutoff_time, row.delivery_date], ["10/6/2026", "08:00 AM", "03:00 PM", "10/07/2026"]);
    assert.equal(row.payer, "THIRD PARTY, PREPAID (CARRIER ACCOUNT SELECTED WILL BE CHARGED)");
    assert.equal(row.confirmation, "Pickup Request number is 000000000071307670");
  });

  test("refuses text that is another shipment's page, or no page at all", () => {
    assert.equal(parseShipmentDetail({ shipment_id: "999", text: TEXT }), null);
    assert.equal(parseShipmentDetail({ shipment_id: "15325790", text: "Sign in" }), null);
    assert.equal(parseShipmentDetail({ shipment_id: "", text: TEXT }), null);
  });

  test("an NMFC and a description that both land under REFERENCES are told apart", () => {
    const moved = TEXT.replace("NMFC\nDescription\nREFERENCES\nboxes", "NMFC\nDescription\nREFERENCES\n069100-01\nAir Filters");
    const r = parseShipmentDetail({ shipment_id: "15325790", text: moved });
    assert.deepEqual([r.nmfc, r.description], ["069100-01", "Air Filters"]);
    assert.equal(r.quote_total, null); // no Quote Detail was read
  });

  test("a page opened without the cost keeps no cost or gross profit", () => {
    const r = parseShipmentDetail({ shipment_id: "15325790", text: TEXT, cost_given: false, inputs: { VendorName: "AAA Cooper" } });
    assert.deepEqual([r.sale, r.cost, r.gross_profit, r.vendor_name], [168.26, null, null, "AAA Cooper"]);
  });

  test("a spot-quoted shipment keeps the grid's sale and cost, and the page's beside them", () => {
    const r = parseShipmentDetail({ shipment_id: "15325790", text: TEXT, spot: true, grid_sale: 200, grid_cost: 155.8 });
    assert.deepEqual([r.sale, r.cost, r.gross_profit, r.financials_source], [200, 155.8, 44.2, "grid_spot_quote"]);
    assert.deepEqual(r.data.page_financials, { sale: 168.26, cost: 155.8, gross_profit: 12.46 });
    assert.equal(parseShipmentDetail({ shipment_id: "15325790", text: TEXT }).financials_source, "page");
  });

  test("describes what was read in one line", () => {
    assert.equal(describeDetail(row), "FreightPOP Inc / AAA Cooper · sale $168.26 · cost $155.80 · gross profit $12.46 · quote: freight $108.00 + fuel $60.26 + accessorials $0.00 = $168.26");
  });
});

describe("parseQuoteDetail", () => {
  test("lists each named accessorial", () => {
    const q = parseQuoteDetail("QUOTE DETAIL\nFREIGHT\n129.95\nFUEL SC\n71.79\nTOTAL ACCESSORIAL CHARGE\n45.00\nACCESSORIALS:\nLiftgate Delivery\n30.00\nResidential\n15.00\nTOTAL\n246.74\nCLOSE");
    assert.deepEqual(q, { freight: 129.95, fuel: 71.79, accessorial_total: 45, total: 246.74, accessorials: [{ name: "Liftgate Delivery", amount: 30 }, { name: "Residential", amount: 15 }] });
  });
  test("is empty for text that is not the panel", () => {
    assert.deepEqual(parseQuoteDetail("nothing here"), { freight: null, fuel: null, accessorial_total: null, total: null, accessorials: [] });
  });
});
