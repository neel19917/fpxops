import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  _deps, extractCandidates, matchShipments, classifyParty, buildPartyPrompt, parsePartyResponse, processThreads,
  linkThreads, classifyDomainChange, startMailboxLinker, isDirty, domainRoot, domainLookupKeys, resembles, threadParties,
  PREVIEW_CHARS,
} from "../lib/mailbox/linking.js";

const MB = "freightsupport@freightpop.com";
const CONN = "11111111-1111-4111-8111-111111111111";

// ---------- a tiny chainable Supabase fake ----------
function fakeSupabase(handler) {
  const calls = [];
  return {
    calls,
    from(table) {
      const q = { table, ops: [] };
      calls.push(q);
      const b = { then(res, rej) { return Promise.resolve().then(() => handler(q)).then(res, rej); } };
      for (const op of ["select", "eq", "neq", "in", "or", "not", "ilike", "gte", "lte", "order", "range", "limit", "maybeSingle", "insert", "update", "upsert"]) {
        b[op] = (...args) => { q.ops.push([op, ...args]); return b; };
      }
      return b;
    },
  };
}
const op = (q, name) => q.ops.find((o) => o[0] === name);

const saved = { ..._deps };
afterEach(() => { Object.assign(_deps, saved); });

describe("extractCandidates (real subjects)", () => {
  const vals = (s) => extractCandidates(s).map((c) => `${c.kind}:${c.value}`);
  it("finds carrier PROs, ship ids and POs", () => {
    assert.deepEqual(vals("RE: ABF 349993297"), ["number:349993297"]);
    assert.deepEqual(vals("NEw FTL Tender shipID15812122"), ["shipment_id:15812122"]);
    assert.deepEqual(vals("RE: New FTLs 15802752"), ["number:15802752"]);
    assert.deepEqual(vals("Re: BOL REQUEST PO#023489077"), ["po:023489077"]);
    assert.deepEqual(vals("RE: ABF Customs Documents 049987229"), ["number:049987229"]);
  });
  it("drops ticket numbers and company ids", () => {
    assert.deepEqual(vals("Re: Support Ticket# 74702- Unable to print BOL"), []);
    assert.deepEqual(vals("Fwd: 74705FW: Joe's A/C, Company ID 18498 cannot log in"), []);
    assert.deepEqual(vals("Support Ticket #1234567 opened"), []);
  });
  it("drops phones, money, dates, zips, urls and emails", () => {
    assert.deepEqual(vals("Call 949-555-1234 or (714) 555-9876. Phone: 9495551234"), []);
    assert.deepEqual(vals("Invoice $1,234,567.00 total 2345678.90 due 11/20/2026 or 2026-11-20"), []);
    assert.deepEqual(vals("Ship to Irvine CA 92618"), []);
    assert.deepEqual(vals("ref 20261120"), []);
    assert.deepEqual(vals("https://track.example.com/123456789 bob123456@acme.com"), []);
  });
  it("reads keyworded alphanumeric values and normalizes them", () => {
    assert.deepEqual(vals("PRO # 12345-678 Pickup# PU12345 Conf: ABC98765 BOL: #7788990 Load 4455667"),
      ["tracking:12345-678", "pickup:PU12345", "confirmation:ABC98765", "bol:7788990", "load:4455667"]);
    assert.deepEqual(vals("Shipment 15812122 and again 15812122"), ["shipment_id:15812122"]);
    assert.deepEqual(vals("tracking number: 1Z999AA10123456784"), ["tracking:1Z999AA10123456784"]);
  });
  it("is empty for empty input", () => {
    assert.deepEqual(extractCandidates(""), []);
    assert.deepEqual(extractCandidates(null), []);
  });
});

describe("matchShipments", () => {
  it("batches values into or() queries and keeps the best match per shipment", async () => {
    const rows = [
      { shipment_id: "15812122", tracking_number: "349993297", customer_name: "Acme" },
      { shipment_id: "222", order_number: "023489077", reference_two: "349993297" },
    ];
    const sb = fakeSupabase((q) => ({ data: rows, error: null }));
    _deps.supabase = sb;
    const cands = [{ value: "349993297" }, { value: "023489077" }, { value: "15812122" }];
    const out = await matchShipments(cands);
    const by = Object.fromEntries(out.map((r) => [r.shipment_id, r]));
    assert.equal(by["15812122"].matched_on, "shipment_id");
    assert.equal(by["15812122"].matched_text, "15812122");
    assert.equal(by["222"].matched_on, "order_number");
    assert.equal(sb.calls.length, 1);
    assert.match(op(sb.calls[0], "or")[1], /shipment_id\.in\.\("349993297","023489077","15812122"\)/);
    assert.match(op(sb.calls[0], "or")[1], /reference_six\.in/);
  });

  it("chunks long value lists and skips values shared by many shipments", async () => {
    const values = Array.from({ length: 90 }, (_, i) => ({ value: String(1000000 + i) }));
    const sb = fakeSupabase((q) => {
      const many = Array.from({ length: 8 }, (_, i) => ({ shipment_id: `S${i}`, reference_one: "1000000" }));
      return { data: [...many, { shipment_id: "X", tracking_number: "1000001" }], error: null };
    });
    _deps.supabase = sb;
    const out = await matchShipments(values);
    assert.equal(sb.calls.length, 3); // 40 + 40 + 10
    assert.deepEqual(out.map((r) => r.shipment_id), ["X"]);
  });
});

describe("classifyParty rules", () => {
  const inMsg = (from_address, extra = {}) => ({ direction: "in", from_address, from_name: extra.name || null, subject: "s", ...extra });
  const outMsg = (to) => ({ direction: "out", from_address: MB, to_recipients: to.map((a) => ({ name: null, address: a })) });
  const domains = new Map([
    ["freightpop.com", { party: "internal", source: "rule" }],
    ["xpo.com", { party: "carrier", source: "rule" }],
    ["acme.com", { party: "customer", source: "person" }],
    ["vendor.io", { party: "other", source: "ai" }],
  ]);

  it("internal-only threads are internal", () => {
    const r = classifyParty([inMsg("joe@freightpop.com"), outMsg(["amy@freightpop.com"])], [], { domains, mailbox: MB });
    assert.equal(r.party, "internal");
    assert.equal(r.source, "rule");
  });
  it("uses the domain table, including parent domains", () => {
    assert.equal(classifyParty([inMsg("ops@xpo.com")], [], { domains, mailbox: MB }).party, "carrier");
    assert.equal(classifyParty([inMsg("ops@mail.xpo.com")], [], { domains, mailbox: MB }).party, "carrier");
    const ai = classifyParty([inMsg("bob@vendor.io")], [], { domains, mailbox: MB });
    assert.deepEqual([ai.party, ai.source], ["other", "ai"]);
  });
  it("a person-set domain beats a rule domain", () => {
    const r = classifyParty([inMsg("ops@xpo.com"), inMsg("ops@xpo.com"), inMsg("buyer@acme.com")], [], { domains, mailbox: MB });
    assert.equal(r.party, "customer");
    assert.match(r.reason, /acme\.com/);
  });
  it("automated senders are other", () => {
    const r = classifyParty([inMsg("no-reply@someapp.com"), inMsg("notifications@other.com")], [], { domains, mailbox: MB });
    assert.equal(r.party, "other");
  });
  it("matches the sender to a linked shipment's customer or carrier", () => {
    const shipments = [{ shipment_id: "1", customer_name: "Joe's A/C Supply, Inc.", carrier_name: "Big Rig Trucking" }];
    const links = [{ shipment_id: "1" }];
    assert.equal(classifyParty([inMsg("pat@joesac.com")], links, { domains, shipments, mailbox: MB }).party, "customer");
    assert.equal(classifyParty([inMsg("d@bigrigtrucking.net")], links, { domains, shipments, mailbox: MB }).party, "carrier");
    // dismissed links don't count
    assert.equal(classifyParty([inMsg("pat@joesac.com")], [{ shipment_id: "1", dismissed: true }], { domains, shipments, mailbox: MB }).party, "unknown");
    // freemail: the domain root is ignored
    assert.equal(classifyParty([inMsg("joesac@gmail.com")], links, { domains, shipments, mailbox: MB }).party, "unknown");
  });
  it("outbound-only threads look at recipients; unknown otherwise", () => {
    assert.equal(classifyParty([outMsg(["ops@xpo.com"])], [], { domains, mailbox: MB }).party, "carrier");
    const r = classifyParty([inMsg("someone@newco.com")], [], { domains, mailbox: MB });
    assert.deepEqual([r.party, r.source], ["unknown", null]);
    assert.equal(classifyParty([], [], { domains, mailbox: MB }).party, "unknown");
  });
  it("helpers", () => {
    assert.equal(domainRoot("acme-widgets.co.uk"), "acmewidgets");
    assert.equal(domainRoot("mail.estes-express.com"), "estesexpress");
    assert.deepEqual(domainLookupKeys("a.b.xpo.com"), ["a.b.xpo.com", "b.xpo.com", "xpo.com"]);
    assert.equal(resembles("Logistics Inc", { root: "acmelogistics" }), false); // generic words alone don't match
    assert.equal(threadParties([inMsg(MB), inMsg("A@X.com"), inMsg("a@x.com")], MB).length, 1);
  });
});

describe("party AI prompt", () => {
  it("sends subject, sender and a capped preview only", () => {
    const p = buildPartyPrompt([{ subject: "Help", from_name: "Ann", from_address: "ann@x.com", preview: "y".repeat(2000), linked_count: 2 }]);
    assert.match(p, /\[1\]\nFrom: Ann <ann@x\.com>\nSubject: Help\nPreview: y+/);
    assert.ok(!p.includes("y".repeat(PREVIEW_CHARS + 1)));
    assert.match(p, /Linked FPX shipments: 2/);
  });
  it("parses the JSON array, tolerating fences and dropping bad rows", () => {
    const m = parsePartyResponse('```json\n[{"i":1,"party":"Customer","reason":"asks about labels"},{"i":2,"party":"vendor"},{"i":9,"party":"other"},{"i":3,"party":"carrier"}]\n```', 3);
    assert.deepEqual(m.get(1), { party: "customer", reason: "asks about labels" });
    assert.equal(m.has(2), false);
    assert.equal(m.has(9), false);
    assert.equal(m.get(3).party, "carrier");
    assert.equal(parsePartyResponse("no json here", 2).size, 0);
  });
});

describe("processThreads", () => {
  const T = (id, last) => ({ connection_id: CONN, conversation_id: id, last_message_at: last, subject: null, preview: null });
  let sb, aiCalls;
  beforeEach(() => {
    aiCalls = [];
    const msgs = [
      { id: "m1", connection_id: CONN, conversation_id: "c1", direction: "in", subject: "NEw FTL Tender shipID15812122", from_address: "ops@xpo.com", body_preview: "", received_at: "2026-11-19T00:00:00Z" },
      { id: "m2", connection_id: CONN, conversation_id: "c2", direction: "in", subject: "RE: ABF 349993297", from_address: "pat@newco.com", body_preview: "please help", received_at: "2026-11-19T00:00:00Z" },
      { id: "m3", connection_id: CONN, conversation_id: "c3", direction: "in", subject: "Re: BOL REQUEST PO#023489077", from_address: "amy@person-set.com", body_preview: "", received_at: "2026-11-19T00:00:00Z" },
    ];
    sb = fakeSupabase((q) => {
      switch (q.table) {
        case "fpx_mailbox_connections": return { data: [{ id: CONN, mailbox: MB }], error: null };
        case "fpx_mailbox_messages":
          if (op(q, "not")) return { data: [{ id: "m2", body_html: "<p>Also PRO 77788899</p>" }], error: null };
          return { data: msgs, error: null };
        case "fpx_shipments":
          if (op(q, "or")) return { data: [
            { shipment_id: "15812122" }, { shipment_id: "500", tracking_number: "349993297", customer_name: "Zeta Corp" },
            { shipment_id: "600", order_number: "023489077" }, { shipment_id: "700", tracking_number: "77788899" },
          ], error: null };
          return { data: [], error: null };
        case "fpx_mailbox_links":
          if (op(q, "upsert")) return { data: null, error: null };
          return { data: [{ connection_id: CONN, conversation_id: "c3", shipment_id: "600", dismissed: true }], error: null };
        case "fpx_mailbox_domains":
          if (op(q, "upsert")) return { data: null, error: null };
          return { data: [{ domain: "xpo.com", party: "carrier", source: "rule" }], error: null };
        case "fpx_mailbox_thread_meta": return { data: null, error: null };
        default: return { data: null, error: null };
      }
    });
    _deps.supabase = sb;
    _deps.getSettings = async () => ({ "prompt.mailbox_party.system": "SYS", "prompt.mailbox_party.model": "claude-haiku-4-5" });
    _deps.callClaude = async (args) => { aiCalls.push(args); return { text: '[{"i":1,"party":"customer","reason":"asks for help"}]' }; };
  });

  it("links, never re-creates dismissed links, classifies and keeps person-set parties", async () => {
    const threads = [T("c1", "2026-11-19T00:00:00Z"), T("c2", "2026-11-19T00:00:00Z"),
      { ...T("c3", "2026-11-19T00:00:00Z"), meta: { party: "customer", party_source: "person" } }];
    const res = await processThreads(threads, { now: "2026-11-20T00:00:00Z" });
    assert.deepEqual(res, { processed: 3, linked: 3, classified: 2 });

    const linkUp = sb.calls.find((q) => q.table === "fpx_mailbox_links" && op(q, "upsert"));
    const [rows, opts] = op(linkUp, "upsert").slice(1);
    assert.deepEqual(opts, { onConflict: "connection_id,conversation_id,shipment_id", ignoreDuplicates: true });
    assert.deepEqual(rows.map((r) => `${r.conversation_id}:${r.shipment_id}:${r.matched_on}`).sort(),
      ["c1:15812122:shipment_id", "c2:500:tracking_number", "c2:700:tracking_number"]);

    // One AI call for the one unknown thread, preview-only payload, logged as mailbox_party.
    assert.equal(aiCalls.length, 1);
    assert.equal(aiCalls[0].modelOverride, "claude-haiku-4-5");
    assert.equal(aiCalls[0].metadata.metadata.subkind, "mailbox_party");
    assert.match(aiCalls[0].userMessage, /pat@newco\.com/);
    assert.ok(!aiCalls[0].userMessage.includes("77788899")); // body text is not sent to the AI

    // Learned domain saved with source 'ai', never overwriting.
    const dom = sb.calls.find((q) => q.table === "fpx_mailbox_domains" && op(q, "upsert"));
    assert.deepEqual(op(dom, "upsert")[1].map((d) => [d.domain, d.party, d.source]), [["newco.com", "customer", "ai"]]);
    assert.equal(op(dom, "upsert")[2].ignoreDuplicates, true);

    const metaUps = sb.calls.filter((q) => q.table === "fpx_mailbox_thread_meta" && op(q, "upsert")).map((q) => op(q, "upsert")[1]);
    const full = metaUps[0], person = metaUps[1];
    assert.deepEqual(full.map((r) => [r.conversation_id, r.party, r.party_source]), [["c1", "carrier", "rule"], ["c2", "customer", "ai"]]);
    assert.deepEqual(person.map((r) => r.conversation_id), ["c3"]);
    assert.equal("party" in person[0], false);
    assert.equal(person[0].last_message_at, "2026-11-19T00:00:00Z");
  });

  it("keeps the earlier party when the AI fails", async () => {
    _deps.callClaude = async () => ({ error: "overloaded" });
    await processThreads([{ ...T("c2", "2026-11-19T00:00:00Z"), meta: { party: "other", party_source: "ai", party_reason: "old" } }]);
    const meta = sb.calls.find((q) => q.table === "fpx_mailbox_thread_meta" && op(q, "upsert"));
    assert.deepEqual(op(meta, "upsert")[1].map((r) => [r.party, r.party_reason]), [["other", "old"]]);
  });

  it("does nothing for an empty list", async () => {
    assert.deepEqual(await processThreads([]), { processed: 0, linked: 0, classified: 0 });
    assert.equal(sb.calls.length, 0);
  });
});

describe("linkThreads / worker", () => {
  it("isDirty compares the thread's last message with the processed one", () => {
    assert.equal(isDirty({ last_message_at: "2026-11-19T00:00:00Z" }, null), true);
    assert.equal(isDirty({ last_message_at: "2026-11-19T00:00:00Z" }, { linked_at: "x", last_message_at: "2026-11-19T00:00:00Z" }), false);
    assert.equal(isDirty({ last_message_at: "2026-11-20T00:00:00Z" }, { linked_at: "x", last_message_at: "2026-11-19T00:00:00Z" }), true);
    assert.equal(isDirty({ last_message_at: "2026-11-20T00:00:00Z" }, { linked_at: null, last_message_at: "2026-11-20T00:00:00Z" }), true);
  });

  it("scans the window newest first, skips processed threads and never throws", async () => {
    const view = [
      { connection_id: CONN, conversation_id: "a", last_message_at: "2026-11-19T00:00:00Z" },
      { connection_id: CONN, conversation_id: "b", last_message_at: "2026-11-18T00:00:00Z" },
    ];
    const sb = fakeSupabase((q) => {
      if (q.table === "fpx_mailbox_threads") return { data: view, error: null };
      if (q.table === "fpx_mailbox_thread_meta" && op(q, "select")) return { data: [{ connection_id: CONN, conversation_id: "b", linked_at: "x", last_message_at: "2026-11-18T00:00:00Z" }], error: null };
      if (q.table === "fpx_mailbox_connections") return { data: [{ id: CONN, mailbox: MB }], error: null };
      return { data: [], error: null };
    });
    _deps.supabase = sb;
    _deps.callClaude = async () => ({ error: "no key" });
    _deps.getSettings = async () => ({});
    const r = await linkThreads({ sinceDays: 30, limit: 200 });
    assert.equal(r.error, undefined);
    assert.equal(r.processed, 1);
    assert.equal(r.scanned, 2);
    assert.equal(r.exhausted, true);
    assert.equal(r.cursor, "2026-11-18T00:00:00Z");
    const viewQ = sb.calls.find((q) => q.table === "fpx_mailbox_threads");
    assert.ok(op(viewQ, "gte"));
    assert.deepEqual(op(viewQ, "order").slice(1), ["last_message_at", { ascending: false }]);

    _deps.supabase = fakeSupabase(() => ({ data: null, error: { message: "relation does not exist" } }));
    const bad = await linkThreads({ sinceDays: null, before: "2026-10-01T00:00:00Z" });
    assert.match(bad.error, /relation does not exist/);
  });

  it("classifyDomainChange validates the domain and reprocesses that domain's threads", async () => {
    assert.equal((await classifyDomainChange("not a domain")).error, "invalid domain");
    const sb = fakeSupabase((q) => {
      if (q.table === "fpx_mailbox_messages" && op(q, "or")) return { data: [{ connection_id: CONN, conversation_id: "c9" }], error: null };
      if (q.table === "fpx_mailbox_threads") return { data: [{ connection_id: CONN, conversation_id: "c9", last_message_at: "2026-11-19T00:00:00Z" }], error: null };
      if (q.table === "fpx_mailbox_thread_meta" && op(q, "select")) return { data: [{ connection_id: CONN, conversation_id: "c9", party: "customer", party_source: "person", linked_at: "x" }], error: null };
      if (q.table === "fpx_mailbox_connections") return { data: [{ id: CONN, mailbox: MB }], error: null };
      if (q.table === "fpx_mailbox_messages") return { data: [{ id: "m", connection_id: CONN, conversation_id: "c9", direction: "in", from_address: "x@newco.com", subject: "hi" }], error: null };
      return { data: [], error: null };
    });
    _deps.supabase = sb;
    const r = await classifyDomainChange("NewCo.com");
    assert.deepEqual(r, { threads: 1, processed: 1, linked: 0, classified: 0 });
    assert.equal(op(sb.calls[0], "or")[1], "from_address.ilike.*@newco.com,from_address.ilike.*.newco.com");
    const meta = sb.calls.find((q) => q.table === "fpx_mailbox_thread_meta" && op(q, "upsert"));
    assert.equal("party" in op(meta, "upsert")[1][0], false); // person-set party untouched
  });

  it("the worker is off under node --test", () => {
    assert.equal(startMailboxLinker(), false);
  });
});
