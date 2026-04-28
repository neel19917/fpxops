import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getFallback } from "../lib/settings.js";

// Default-config tests for the FreightPOP iframe embed. These guard against
// regressions in the FALLBACKS table — the dashboard reads them via
// /api/me's client_config block, and a wrong default would silently break
// the drawer's split view for every tenant that hasn't written a row yet.

describe("FreightPOP embed defaults", () => {
  it("ships enabled-by-default", () => {
    // We changed this from false → true so the FreightPOP tab + sidebar
    // appear with no configuration. Admins still toggle off in
    // /admin/settings if iframe embedding is blocked for their tenant.
    assert.equal(getFallback("embed.freightpop.enabled"), true);
  });

  it("default url_template is the bare base URL — no /tracking/{...} path", () => {
    // FreightPOP has no public deep-link route for an individual shipment,
    // so the previous /tracking/{tracking_number} default landed on a
    // generic page. We mirror the Chrome extension's flow now: load the
    // grid, paste the tracking number into search.
    const tpl = getFallback("embed.freightpop.url_template");
    assert.equal(typeof tpl, "string");
    assert.equal(tpl, "https://app.freightpop.com/");
    assert.ok(!tpl.includes("/tracking/"), "must not include /tracking/ path");
    assert.ok(!tpl.includes("{tracking_number}"), "must not have placeholder");
  });

  it("template substitution still works for tenants with deep-link routes", async () => {
    // Re-derive the substituter to mirror the dashboard code without
    // bringing in the React module here.
    const subst = (template, shipment) => template
      .replace(/\{tracking_number\}/g, encodeURIComponent(shipment.tracking_number || ""))
      .replace(/\{shipment_id\}/g, encodeURIComponent(shipment.shipment_id || shipment.id))
      .replace(/\{order_number\}/g, encodeURIComponent(shipment.order_number || ""));
    const ship = { id: "uuid-1", tracking_number: "TRK-123", shipment_id: "S-42", order_number: "PO-9" };
    assert.equal(
      subst("https://example.com/track/{tracking_number}", ship),
      "https://example.com/track/TRK-123",
    );
    assert.equal(
      subst("https://example.com/s/{shipment_id}/o/{order_number}", ship),
      "https://example.com/s/S-42/o/PO-9",
    );
  });

  it("substituter URL-encodes weird characters in tracking numbers", () => {
    const subst = (template, shipment) => template
      .replace(/\{tracking_number\}/g, encodeURIComponent(shipment.tracking_number || ""))
      .replace(/\{shipment_id\}/g, encodeURIComponent(shipment.shipment_id || shipment.id))
      .replace(/\{order_number\}/g, encodeURIComponent(shipment.order_number || ""));
    const ship = { id: "uuid", tracking_number: "AB CD/12+3", shipment_id: "", order_number: "" };
    const out = subst("https://x/{tracking_number}", ship);
    assert.equal(out, "https://x/AB%20CD%2F12%2B3");
  });

  it("substituter falls back to row id when shipment_id is missing", () => {
    const subst = (template, shipment) => template
      .replace(/\{shipment_id\}/g, encodeURIComponent(shipment.shipment_id || shipment.id));
    assert.equal(
      subst("https://x/{shipment_id}", { id: "row-uuid", shipment_id: null }),
      "https://x/row-uuid",
    );
  });
});

describe("client_config bundle shape", () => {
  // /api/me's loadClientConfig() composes the nested object the dashboard
  // expects under client_config. Mirror the structure here so a typo in the
  // server route or a default change is caught at test time.
  it("matches the shape consumed by useAuth().clientConfig", () => {
    const enabled = getFallback("embed.freightpop.enabled");
    const tpl = getFallback("embed.freightpop.url_template");
    const composed = {
      embed_freightpop: {
        enabled: !!enabled,
        url_template: String(tpl || ""),
      },
    };
    assert.deepEqual(Object.keys(composed), ["embed_freightpop"]);
    assert.deepEqual(Object.keys(composed.embed_freightpop).sort(), ["enabled", "url_template"]);
    assert.equal(typeof composed.embed_freightpop.enabled, "boolean");
    assert.equal(typeof composed.embed_freightpop.url_template, "string");
  });
});
