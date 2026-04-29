import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isCarrierFollowupTitle, isCustomerFollowupTitle } from "../routes/tasks.js";

// Pure title-classification helpers — no DB, no auth, just regex
// against task.title. The detectors are the source of truth for
// which panel a task lands in (carrier vs customer), and the
// auto-prefix in autoCreateActionTasks must keep them consistent
// with what the dashboard renders.

describe("isCarrierFollowupTitle", () => {
  it("matches the canonical Carrier followup: prefix", () => {
    assert.equal(isCarrierFollowupTitle("Carrier followup: missing POD"), true);
  });

  it("matches case-insensitively", () => {
    assert.equal(isCarrierFollowupTitle("CARRIER FOLLOWUP: confirm pickup"), true);
    assert.equal(isCarrierFollowupTitle("carrier followup: foo"), true);
  });

  it("matches both 'follow up' and 'followup' spellings", () => {
    assert.equal(isCarrierFollowupTitle("Carrier follow up: tracking"), true);
    assert.equal(isCarrierFollowupTitle("Need carrier follow-up on this"), true);
  });

  it("does NOT match plain titles missing one of the keywords", () => {
    assert.equal(isCarrierFollowupTitle("Update on shipment"), false);
    assert.equal(isCarrierFollowupTitle("Carrier rejected the pickup"), false); // has carrier, no follow
    assert.equal(isCarrierFollowupTitle("Need a follow-up on the customer"), false); // has follow, no carrier
  });

  it("survives non-string input safely", () => {
    assert.equal(isCarrierFollowupTitle(null), false);
    assert.equal(isCarrierFollowupTitle(undefined), false);
    assert.equal(isCarrierFollowupTitle(42), false);
    assert.equal(isCarrierFollowupTitle({}), false);
  });
});

describe("isCustomerFollowupTitle", () => {
  it("matches the canonical Customer followup: prefix", () => {
    assert.equal(isCustomerFollowupTitle("Customer followup: needs ETA"), true);
  });

  it("excludes titles that ALSO contain 'carrier' (carrier panel takes precedence)", () => {
    // The collision rule: a title with both keywords goes to the
    // carrier panel only. Otherwise the same task would appear in
    // both panels and confuse the bulk-email flow.
    assert.equal(isCustomerFollowupTitle("Customer wants a carrier follow-up"), false);
    assert.equal(isCarrierFollowupTitle("Customer wants a carrier follow-up"), true);
  });

  it("requires both 'customer' and 'follow' in the title", () => {
    assert.equal(isCustomerFollowupTitle("Update the customer"), false); // no follow
    assert.equal(isCustomerFollowupTitle("Follow up shortly"), false);    // no customer
  });

  it("matches 'follow up' / 'followup' / 'follow-up' equally", () => {
    assert.equal(isCustomerFollowupTitle("Customer follow up: status"), true);
    assert.equal(isCustomerFollowupTitle("Customer follow-up scheduled"), true);
    assert.equal(isCustomerFollowupTitle("customer followup needed"), true);
  });

  it("is null/undefined safe", () => {
    assert.equal(isCustomerFollowupTitle(null), false);
    assert.equal(isCustomerFollowupTitle(undefined), false);
    assert.equal(isCustomerFollowupTitle(""), false);
  });
});

describe("collision rule consistency", () => {
  it("a title is never assigned to both panels", () => {
    const samples = [
      "Carrier followup: missing POD",
      "Customer followup: needs ETA",
      "Follow up with the carrier and customer",
      "Customer wants a carrier follow-up",
      "Carrier reply pending",
      "Customer waiting",
      "follow up shortly",
      "",
    ];
    for (const t of samples) {
      const c = isCarrierFollowupTitle(t);
      const u = isCustomerFollowupTitle(t);
      assert.ok(!(c && u), `Title "${t}" matched both detectors — collision rule violated`);
    }
  });
});
