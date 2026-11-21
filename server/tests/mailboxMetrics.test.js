import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  messageHost, buildRepIndex, attributeRep, periodStarts, monthKey, computeMetrics, cleanPreview,
  businessDaysBetween, LIKELY_REP_HOSTS, SHARED_REP, UNMATCHED_REP, dedupeMessages, neverSeenCandidates,
} from "../lib/mailbox/metrics.js";

// Friday 2026-11-20 04:00 PST
const NOW = new Date("2026-11-20T12:00:00Z");
const HOUR = 3_600_000;
const DAY = 86_400_000;
const mid = (host, n = 1) => `<MSG${n}@${host}.NAMP220.PROD.OUTLOOK.COM>`;

const SHAUN_HOST = "SA1P220MB1626";
const inboundInternal = [
  { from_address: "shaunz@freightpop.com", from_name: "Shaun Zimmerman", internet_message_id: mid(SHAUN_HOST) },
  { from_address: "support@freightpop.com", from_name: "Support", internet_message_id: mid("SYS0001") },
  { from_address: "MicrosoftExchange329e71ec88ae4615bbc36ab6ce41109e@freightpop.com", from_name: "Exchange", internet_message_id: mid("SYS0002") },
  { from_address: "someone@customer.com", from_name: "Cust", internet_message_id: mid("EXT0001") },
];

let seq = 0;
function msg(over) {
  seq += 1;
  return {
    id: `m${seq}`, direction: "in", folder: "inbox", conversation_id: "c1",
    received_at: null, sent_at: null, internet_message_id: mid("EXT0001", seq),
    from_address: "cust@customer.com", from_name: "Cust", subject: "Hello", body_preview: "hi",
    ...over,
  };
}
const inAt = (at, over = {}) => msg({ direction: "in", received_at: new Date(at).toISOString(), ...over });
const outAt = (at, over = {}) => msg({
  direction: "out", folder: "sentitems", sent_at: new Date(at).toISOString(),
  from_address: "freightsupport@freightpop.com", from_name: "FP Freight Support", ...over,
});

describe("messageHost", () => {
  it("parses the Exchange host", () => {
    assert.equal(messageHost("<abc.def@SA1P220MB1626.NAMP220.PROD.OUTLOOK.COM>"), "SA1P220MB1626");
    assert.equal(messageHost("<x@ph7p220mb0857.namprd.outlook.com>"), "PH7P220MB0857");
    assert.equal(messageHost("<x@localhost>"), "LOCALHOST");
  });
  it("returns null without a host", () => {
    assert.equal(messageHost(null), null);
    assert.equal(messageHost(""), null);
    assert.equal(messageHost("<no-at-sign>"), null);
  });
});

describe("rep attribution", () => {
  const idx = buildRepIndex({ inboundInternal });
  it("auto-confirms hosts from internal senders and skips system senders", () => {
    assert.deepEqual(idx.hostToRep.get(SHAUN_HOST), { rep: "Shaun Zimmerman", email: "shaunz@freightpop.com", confidence: "confirmed" });
    assert.equal(idx.hostToRep.has("SYS0001"), false);
    assert.equal(idx.hostToRep.has("SYS0002"), false);
    assert.equal(idx.hostToRep.has("EXT0001"), false);
  });
  it("confirmed match", () => {
    assert.deepEqual(attributeRep({ folder: "inbox", internet_message_id: mid(SHAUN_HOST) }, idx),
      { rep: "Shaun Zimmerman", email: "shaunz@freightpop.com", confidence: "confirmed" });
  });
  it("likely match from the hard-coded map", () => {
    assert.ok(LIKELY_REP_HOSTS.CC6P220MB712026);
    assert.deepEqual(attributeRep({ folder: "inbox", internet_message_id: mid("CC6P220MB712026") }, idx),
      { rep: "Victor Z", email: "victorz@freightpop.com", confidence: "likely" });
  });
  it("confirmed data overrides a likely host", () => {
    const i2 = buildRepIndex({ inboundInternal: [{ from_address: "victorz@freightpop.com", from_name: "Victor Zamora", internet_message_id: mid("PH7P220MB0857") }] });
    assert.equal(i2.hostToRep.get("PH7P220MB0857").confidence, "confirmed");
    assert.equal(i2.hostToRep.get("PH7P220MB0857").rep, "Victor Zamora");
    assert.equal(i2.hostToRep.get("DM4P220MB0867").confidence, "likely");
  });
  it("sentitems on a known rep host stays with the rep (sent-as copy saved by Exchange)", () => {
    assert.equal(attributeRep({ folder: "sentitems", internet_message_id: mid(SHAUN_HOST) }, idx).rep, "Shaun Zimmerman");
    assert.deepEqual(attributeRep({ folder: "sentitems", internet_message_id: mid("ZZ8P220MB0002") }, idx),
      { rep: SHARED_REP, email: null, confidence: "unknown" });
  });
  it("unknown inbox host is unmatched", () => {
    assert.deepEqual(attributeRep({ folder: "inbox", internet_message_id: mid("ZZ9P220MB0001") }, idx),
      { rep: UNMATCHED_REP, email: null, confidence: "unknown" });
  });
});

describe("periodStarts / monthKey", () => {
  it("PT midnight on a date after DST ended (month start is in PDT)", () => {
    const s = periodStarts(NOW);
    assert.equal(s.today.toISOString(), "2026-11-20T08:00:00.000Z");
    assert.equal(s.week.toISOString(), "2026-11-16T08:00:00.000Z");
    assert.equal(s.month.toISOString(), "2026-11-01T07:00:00.000Z");
  });
  it("Sunday belongs to the week starting the previous Monday", () => {
    const s = periodStarts(new Date("2026-11-22T20:00:00Z")); // Sunday noon PST
    assert.equal(s.today.toISOString(), "2026-11-22T08:00:00.000Z");
    assert.equal(s.week.toISOString(), "2026-11-16T08:00:00.000Z");
  });
  it("Monday is its own week start", () => {
    const s = periodStarts(new Date("2026-11-16T09:00:00Z")); // Mon 01:00 PST
    assert.equal(s.week.toISOString(), "2026-11-16T08:00:00.000Z");
  });
  it("spring-forward week", () => {
    const s = periodStarts(new Date("2026-03-10T12:00:00Z")); // Tue 05:00 PDT
    assert.equal(s.today.toISOString(), "2026-03-10T07:00:00.000Z");
    assert.equal(s.week.toISOString(), "2026-03-09T07:00:00.000Z");
    assert.equal(s.month.toISOString(), "2026-03-01T08:00:00.000Z");
    const sun = periodStarts(new Date("2026-03-08T20:00:00Z")); // DST day itself
    assert.equal(sun.today.toISOString(), "2026-03-08T08:00:00.000Z");
    assert.equal(sun.week.toISOString(), "2026-03-02T08:00:00.000Z");
  });
  it("UTC late evening is still the PT day/month", () => {
    const s = periodStarts(new Date("2026-12-01T05:00:00Z")); // Nov 30 21:00 PST
    assert.equal(s.month.toISOString(), "2026-11-01T07:00:00.000Z");
    assert.equal(monthKey(new Date("2026-12-01T05:00:00Z")), "2026-11");
    assert.equal(monthKey(new Date("2026-12-01T09:00:00Z")), "2026-12");
  });
});

describe("cleanPreview", () => {
  it("strips the Caution banner and collapses whitespace", () => {
    const t = "Caution: This email originated outside FreightPOP. Do not click links unless you\n recognize the sender and verify the message.   Hi team,\n\n  please   update PRO 123.";
    assert.equal(cleanPreview(t), "Hi team, please update PRO 123.");
  });
  it("caps at 160 chars and handles empty", () => {
    const out = cleanPreview("x".repeat(500));
    assert.ok(out.length <= 160);
    assert.equal(cleanPreview(null), null);
    assert.equal(cleanPreview("   "), null);
  });
});

describe("businessDaysBetween", () => {
  it("skips weekends and does not count today", () => {
    const fri = new Date("2026-11-20T20:00:00Z");
    assert.equal(businessDaysBetween(fri, new Date("2026-11-23T18:00:00Z")), 0); // Fri -> Mon
    assert.equal(businessDaysBetween(new Date("2026-11-19T20:00:00Z"), new Date("2026-11-24T18:00:00Z")), 2); // Thu -> Tue
  });
});

describe("computeMetrics", () => {
  const idx = buildRepIndex({ inboundInternal });
  const T = NOW.getTime();
  const base = () => {
    seq = 0;
    return [
      // conversation c1: inbound this morning then a reply from Shaun's mailbox (copy)
      inAt(T - 3 * HOUR, { conversation_id: "c1" }),
      outAt(T - 2 * HOUR, { conversation_id: "c1", folder: "inbox", internet_message_id: mid(SHAUN_HOST, 101) }),
      // conversation c2: new outbound from the shared mailbox on Tuesday, then a customer reply
      outAt(Date.parse("2026-11-17T18:00:00Z"), { conversation_id: "c2" }),
      inAt(Date.parse("2026-11-17T20:00:00Z"), { conversation_id: "c2", subject: "RE: quote" }),
      // c3: conversation with inbound before the window -> reply
      outAt(Date.parse("2026-11-03T18:00:00Z"), { conversation_id: "c3", folder: "inbox", internet_message_id: mid("CC6P220MB712026", 103) }),
      // c4: customer replied to something we never saw
      inAt(Date.parse("2026-11-05T18:00:00Z"), { conversation_id: "c4", subject: "RE: your shipment", body_preview: "Caution: This email originated outside FreightPOP. blah verify the message. Thanks!" }),
      // c5: internal RE: with no outbound -> not a never-seen reply
      inAt(Date.parse("2026-11-06T18:00:00Z"), { conversation_id: "c5", subject: "RE: internal", from_address: "allenj@freightpop.com" }),
      // October: unmatched sender, and an inbound
      inAt(Date.parse("2026-10-10T18:00:00Z"), { conversation_id: "c6" }),
      outAt(Date.parse("2026-10-11T18:00:00Z"), { conversation_id: "c6", folder: "inbox", internet_message_id: mid("ZZ9P220MB0001", 106) }),
      // just before the month boundary in PT (Oct 31 23:30 PDT = Nov 1 06:30Z) -> October
      inAt(Date.parse("2026-11-01T06:30:00Z"), { conversation_id: "c7" }),
    ];
  };
  const threads = [
    { conversation_id: "c4", status: "awaiting_reply", last_inbound_at: "2026-11-05T18:00:00Z" },
    { conversation_id: "c2", status: "awaiting_reply", last_inbound_at: "2026-11-17T20:00:00Z" },
    { conversation_id: "c1", status: "responded", last_inbound_at: new Date(T - 3 * HOUR).toISOString() },
    { conversation_id: "old", status: "awaiting_reply", last_inbound_at: "2026-10-01T18:00:00Z" },
  ];
  const run = (over = {}) => computeMetrics({
    now: NOW, messages: base(), threads, inboundInternal, lastSyncAt: "2026-11-20T11:55:00Z",
    removedEverCount: 3, months: 3, priorInboundConversations: new Set(["c3"]), ...over,
  });

  it("periods: reply vs new outbound and awaiting", () => {
    const m = run();
    const [today, week, month] = m.periods;
    assert.equal(today.period, "today");
    assert.deepEqual({ ...today, start: undefined }, {
      period: "today", start: undefined, received: 1, sent: 1, replies: 1, conversationsReplied: 1, newOutbound: 0, inboundConversations: 1, awaiting: 0,
    });
    assert.equal(week.sent, 2);
    assert.equal(week.replies, 1);
    assert.equal(week.newOutbound, 1); // c2 started by the team
    assert.equal(week.received, 2);
    assert.equal(week.awaiting, 1);
    assert.equal(month.sent, 3);
    assert.equal(month.replies, 2); // c1 + c3 (prior inbound)
    assert.equal(month.conversationsReplied, 2);
    assert.equal(month.received, 4);
    assert.equal(month.awaiting, 2);
    assert.equal(month.start, "2026-11-01T07:00:00.000Z");
    assert.equal(m.lastSyncAt, "2026-11-20T11:55:00.000Z");
    assert.equal(m.mailbox, "freightsupport@freightpop.com");
  });

  it("without prior-inbound info, c3 is new outbound", () => {
    const m = run({ priorInboundConversations: undefined });
    assert.equal(m.periods[2].replies, 1);
    assert.equal(m.periods[2].newOutbound, 2);
  });

  it("reps", () => {
    const m = run();
    const by = Object.fromEntries(m.reps.map((r) => [r.rep, r]));
    assert.equal(by["Shaun Zimmerman"].confidence, "confirmed");
    assert.equal(by["Shaun Zimmerman"].today, 1);
    assert.equal(by["Shaun Zimmerman"].monthReplies, 1);
    assert.equal(by["Victor Z"].confidence, "likely");
    assert.equal(by["Victor Z"].month, 1);
    assert.equal(by["Victor Z"].week, 0);
    assert.equal(by[SHARED_REP].week, 1);
    assert.equal(by[SHARED_REP].monthReplies, 0);
    assert.equal(by[UNMATCHED_REP].month, 0);
    assert.equal(by[UNMATCHED_REP].lastSentAt, "2026-10-11T18:00:00.000Z");
    // people first, shared/unmatched last
    assert.ok(m.reps.findIndex((r) => r.rep === SHARED_REP) > m.reps.findIndex((r) => r.rep === "Victor Z"));
  });

  it("monthly buckets oldest to newest in PT", () => {
    const m = run();
    assert.deepEqual(m.monthly.map((b) => b.month), ["2026-09", "2026-10", "2026-11"]);
    assert.deepEqual(m.monthly[1], { month: "2026-10", received: 2, sent: 1, replies: 1, byRep: { [UNMATCHED_REP]: 1 } });
    assert.equal(m.monthly[2].sent, 3);
    assert.equal(m.monthly[2].received, 4);
    assert.deepEqual(m.monthly[2].byRep, { "Shaun Zimmerman": 1, [SHARED_REP]: 1, "Victor Z": 1 });
    assert.equal(m.monthly[0].sent, 0);
  });

  it("latest: newest first, max 10, previews cleaned", () => {
    const m = run();
    assert.equal(m.latest.length, 10);
    assert.equal(m.latest[0].direction, "out");
    assert.equal(m.latest[0].rep, "Shaun Zimmerman");
    assert.equal(m.latest[1].rep, null);
    const c4 = m.latest.find((l) => l.subject === "RE: your shipment");
    assert.equal(c4.preview, "Thanks!");
  });

  it("gaps that fire", () => {
    const m = run();
    const g = Object.fromEntries(m.gaps.map((x) => [x.id.split(":")[0], x]));
    assert.equal(g["sent-copies-missing"].metric, 2);
    assert.match(g["sent-copies-missing"].detail, /2 of 3 sends this month/);
    assert.match(g["sent-copies-missing"].fix, /MessageCopyForSentAsEnabled \$true/);
    assert.equal(g["replies-never-seen"].metric, 1); // c4 only (c2 has outbound, c5 internal)
    assert.equal(g["no-rep-identity"].metric, 1);
    assert.equal(g["rep-unconfirmed"].owner, "Support team");
    assert.match(g["rep-unconfirmed"].title, /Victor Z/);
    assert.equal(g["awaiting-backlog"].metric, 2);
    assert.match(g["awaiting-backlog"].detail, /1 of them may already be answered/);
    assert.equal(g["rep-quiet"], undefined);
    assert.equal(g["removed-never-tracked"], undefined);
  });

  it("removed-never-tracked fires only at zero", () => {
    assert.ok(run({ removedEverCount: 0 }).gaps.some((x) => x.id === "removed-never-tracked"));
    assert.ok(!run({ removedEverCount: null }).gaps.some((x) => x.id === "removed-never-tracked"));
  });

  it("no gaps on a clean month", () => {
    seq = 0;
    const msgs = [
      inAt(T - 5 * HOUR, { conversation_id: "x1", subject: "Need help" }),
      outAt(T - 4 * HOUR, { conversation_id: "x1", folder: "inbox", internet_message_id: mid(SHAUN_HOST, 1) }),
    ];
    const m = computeMetrics({ now: NOW, messages: msgs, threads: [], inboundInternal, removedEverCount: 5, months: 1 });
    // only sent-copies-missing (the reply was seen via copy)
    assert.deepEqual(m.gaps.map((x) => x.id), ["sent-copies-missing"]);
    assert.equal(m.monthly.length, 1);
  });

  describe("rep-quiet", () => {
    const sendsEndingAt = (lastMs, n = 12) => {
      seq = 0;
      const out = [];
      for (let i = 0; i < n; i += 1) {
        out.push(outAt(lastMs - i * DAY, { conversation_id: `q${i}`, folder: "inbox", internet_message_id: mid(SHAUN_HOST, i) }));
      }
      return out;
    };
    it("does not fire over a weekend", () => {
      const now = new Date("2026-11-23T18:00:00Z"); // Monday 10:00 PST
      const last = Date.parse("2026-11-20T22:00:00Z"); // Friday afternoon
      const m = computeMetrics({ now, messages: sendsEndingAt(last), inboundInternal, removedEverCount: 1 });
      assert.ok(!m.gaps.some((x) => x.id.startsWith("rep-quiet")));
    });
    it("fires after 2 business days without a send", () => {
      const now = new Date("2026-11-24T18:00:00Z"); // Tuesday
      const last = Date.parse("2026-11-19T22:00:00Z"); // Thursday -> Fri, Mon missed
      const m = computeMetrics({ now, messages: sendsEndingAt(last), inboundInternal, removedEverCount: 1 });
      const g = m.gaps.find((x) => x.id.startsWith("rep-quiet"));
      assert.ok(g);
      assert.match(g.detail, /Shaun Zimmerman sent 12 emails in the last 30 days/);
      assert.match(g.detail, /2 business days/);
      assert.match(g.detail, /Thu, Nov 19/);
    });
    it("needs at least 10 sends in 30 days", () => {
      const now = new Date("2026-11-24T18:00:00Z");
      const last = Date.parse("2026-11-19T22:00:00Z");
      const m = computeMetrics({ now, messages: sendsEndingAt(last, 9), inboundInternal, removedEverCount: 1 });
      assert.ok(!m.gaps.some((x) => x.id.startsWith("rep-quiet")));
    });
    it("never fires for the shared mailbox", () => {
      seq = 0;
      const last = Date.parse("2026-11-19T22:00:00Z");
      const msgs = Array.from({ length: 12 }, (_, i) => outAt(last - i * DAY, { conversation_id: `s${i}` }));
      const m = computeMetrics({ now: new Date("2026-11-24T18:00:00Z"), messages: msgs, inboundInternal, removedEverCount: 1 });
      assert.ok(!m.gaps.some((x) => x.id.startsWith("rep-quiet")));
    });
  });
});

it("likely host takes the confirmed name for the same email (one row per person)", () => {
  const idx = buildRepIndex({
    inboundInternal: [{ from_address: "victorz@freightpop.com", from_name: "Victor Zarate", internet_message_id: "<a@PH7P220MB0857.NAMP220.PROD.OUTLOOK.COM>" }],
    likely: { CC6P220MB712026: { rep: "Victor Z", email: "victorz@freightpop.com" } },
  });
  const r = attributeRep({ folder: "inbox", direction: "out", internet_message_id: "<b@CC6P220MB712026.NAMP220.PROD.OUTLOOK.COM>" }, idx);
  assert.equal(r.rep, "Victor Zarate");
  assert.equal(r.confidence, "likely");
});

describe("review fixes", () => {
  const idx = buildRepIndex({
    inboundInternal: [{ from_address: "shaunz@freightpop.com", from_name: "Shaun Zimmerman", internet_message_id: "<a@LV8P220MB1687.NAMP220.PROD.OUTLOOK.COM>" }],
    likely: {},
  });
  it("a rep's send saved in Sent Items stays with the rep; unmatched Sent Items is shared", () => {
    assert.equal(attributeRep({ folder: "sentitems", internet_message_id: "<x@LV8P220MB1687.NAMP220.PROD.OUTLOOK.COM>" }, idx).rep, "Shaun Zimmerman");
    assert.equal(attributeRep({ folder: "sentitems", internet_message_id: "<x@SA1P220MB1626.NAMP220.PROD.OUTLOOK.COM>" }, idx).rep, SHARED_REP);
    assert.equal(attributeRep({ folder: "inbox", internet_message_id: "<x@ZZ1P220MB0001.NAMP220.PROD.OUTLOOK.COM>" }, idx).rep, UNMATCHED_REP);
  });
  it("dedupes repeated ids and the same outbound Message-ID in two folders", () => {
    const rows = dedupeMessages([
      { id: "1", direction: "out", folder: "inbox", internet_message_id: "<M@H>" },
      { id: "2", direction: "out", folder: "sentitems", internet_message_id: "<m@h>" },
      { id: "1", direction: "out", folder: "inbox", internet_message_id: "<M@H>" },
      { id: "3", direction: "in", internet_message_id: "<M@H>" },
    ]);
    assert.deepEqual(rows.map((r) => r.id), ["1", "3"]);
  });
  it("computeMetrics counts a two-folder send once and honours outboundEverConversations", () => {
    const now = new Date("2026-11-20T20:00:00Z");
    const messages = [
      { id: "a", direction: "out", folder: "inbox", conversation_id: "c1", sent_at: "2026-11-20T18:00:00Z", internet_message_id: "<1@LV8P220MB1687.X>" },
      { id: "b", direction: "out", folder: "sentitems", conversation_id: "c1", sent_at: "2026-11-20T18:00:00Z", internet_message_id: "<1@LV8P220MB1687.X>" },
      { id: "c", direction: "in", folder: "inbox", conversation_id: "c2", received_at: "2026-11-20T17:00:00Z", from_address: "x@cust.com", subject: "RE: hi" },
    ];
    const base = { now, messages, threads: [], inboundInternal: [{ from_address: "shaunz@freightpop.com", from_name: "Shaun Zimmerman", internet_message_id: "<a@LV8P220MB1687.X>" }], removedEverCount: 1 };
    const m1 = computeMetrics(base);
    assert.equal(m1.periods[0].sent, 1);
    assert.ok(m1.gaps.some((g) => g.id === "replies-never-seen"));
    assert.deepEqual([...neverSeenCandidates(messages)], ["c2"]);
    const m2 = computeMetrics({ ...base, outboundEverConversations: new Set(["c2"]) });
    assert.ok(!m2.gaps.some((g) => g.id === "replies-never-seen"));
  });
});
