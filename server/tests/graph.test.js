import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { classify, classifyRouter } from "../nodes/classify.js";
import { analyzeWithAI } from "../nodes/analyze.js";
import {
  parseResponse,
  parseRouter,
  extractJsonObject,
  coerceActionRequired,
  deriveActionRequired,
} from "../nodes/parse.js";
import { summarize } from "../nodes/summarize.js";
import { buildGraph } from "../graph.js";

function makeShipment(overrides = {}) {
  return {
    _trackingNumber: overrides._trackingNumber || "TRK" + Math.floor(Math.random() * 99999),
    "SHIPMENT STATUS": overrides["SHIPMENT STATUS"] || "Delivered",
    "CARRIER NAME": overrides["CARRIER NAME"] || "Test Carrier",
    MODE: overrides.MODE || "LTL",
    COMMENTS: overrides.COMMENTS || "",
    "PICKUP DATE": "2026-03-20",
    "UPDATED ETA": "2026-03-25",
    ...overrides,
  };
}

function makeFakeModel(responseText) {
  return {
    invoke: mock.fn(async () => ({
      content: typeof responseText === "function" ? responseText() : responseText,
    })),
  };
}

// ========= Test 1: classify -- all routine =========
describe("classify", () => {
  it("routes all routine shipments correctly", () => {
    const shipments = [
      makeShipment({ "SHIPMENT STATUS": "Delivered" }),
      makeShipment({ "SHIPMENT STATUS": "In Transit" }),
      makeShipment({ "SHIPMENT STATUS": "Booked" }),
      makeShipment({ "SHIPMENT STATUS": "Scheduled/Tendered" }),
      makeShipment({ "SHIPMENT STATUS": "Delivered" }),
    ];

    const result = classify({ shipments });
    assert.equal(result.classified.routine.length, 5);
    assert.equal(result.classified.ambiguous.length, 0);
    assert.equal(result.classified.critical.length, 0);

    const route = classifyRouter({ classified: result.classified });
    assert.equal(route, "markNoAction");
  });

  // ========= Test 2: classify -- all critical =========
  it("routes all critical shipments correctly", () => {
    const shipments = [
      makeShipment({ "SHIPMENT STATUS": "Issue", COMMENTS: "Shipment delayed at hub" }),
      makeShipment({ "SHIPMENT STATUS": "Issue", COMMENTS: "Delivery refused by consignee" }),
      makeShipment({ "SHIPMENT STATUS": "Issue", COMMENTS: "Package damaged" }),
    ];

    const result = classify({ shipments });
    assert.equal(result.classified.critical.length, 3);
    assert.equal(result.classified.routine.length, 0);
    assert.equal(result.classified.ambiguous.length, 0);

    const route = classifyRouter({ classified: result.classified });
    assert.equal(route, "analyzeWithAI");
  });

  // ========= Test 3: classify -- mixed bag =========
  it("correctly partitions mixed shipments", () => {
    const shipments = [
      makeShipment({ "SHIPMENT STATUS": "Delivered" }),
      makeShipment({ "SHIPMENT STATUS": "Delivered" }),
      makeShipment({ "SHIPMENT STATUS": "Delivered" }),
      makeShipment({ "SHIPMENT STATUS": "Delivered" }),
      makeShipment({ "SHIPMENT STATUS": "In Transit" }),
      makeShipment({ "SHIPMENT STATUS": "In Transit" }),
      makeShipment({ "SHIPMENT STATUS": "In Transit" }),
      makeShipment({ "SHIPMENT STATUS": "In Transit", COMMENTS: "delay at terminal" }),
      makeShipment({ "SHIPMENT STATUS": "In Transit", COMMENTS: "missed appointment" }),
      makeShipment({ "SHIPMENT STATUS": "Issue" }),
    ];

    const result = classify({ shipments });
    assert.equal(result.classified.routine.length, 7);
    assert.equal(result.classified.ambiguous.length, 2);
    assert.equal(result.classified.critical.length, 1);

    const route = classifyRouter({ classified: result.classified });
    assert.equal(route, "analyzeWithAI");
  });
});

// ========= Test 4: markNoAction -- stamps routine rows =========
describe("markNoAction (via graph)", () => {
  it("stamps routine shipments with NO action", async () => {
    const fakeModel = makeFakeModel("");
    const graph = buildGraph();
    const shipments = [
      makeShipment({ "SHIPMENT STATUS": "Delivered" }),
      makeShipment({ "SHIPMENT STATUS": "In Transit" }),
      makeShipment({ "SHIPMENT STATUS": "Booked" }),
      makeShipment({ "SHIPMENT STATUS": "Delivered" }),
      makeShipment({ "SHIPMENT STATUS": "Scheduled/Tendered" }),
    ];

    const result = await graph.invoke({ shipments, _model: fakeModel });
    assert.equal(result.analyzed.length, 5);
    for (const row of result.analyzed) {
      assert.equal(row._actionRequired, "NO");
      assert.match(row._aiIssue, /on track/i);
      assert.equal(row._needsActionSheet, false);
    }
    assert.equal(fakeModel.invoke.mock.calls.length, 1, "Only summary call");
  });
});

// ========= Test 5: analyzeWithAI -- normal response =========
describe("analyzeWithAI", () => {
  it("attaches AI response to ambiguous shipments", async () => {
    const aiResponse = JSON.stringify({
      actionRequired: true,
      issue: "Late ETA — shipment delayed at origin terminal",
      recommendation: "Contact carrier for updated ETA and notify customer",
    });
    const fakeModel = makeFakeModel(aiResponse);

    const classified = {
      routine: [],
      ambiguous: [
        makeShipment({ "SHIPMENT STATUS": "In Transit", COMMENTS: "delay reported" }),
        makeShipment({ "SHIPMENT STATUS": "In Transit", COMMENTS: "exception noted" }),
      ],
      critical: [],
    };

    const result = await analyzeWithAI({ classified, _model: fakeModel });
    assert.equal(result._aiResults.length, 2);
    for (const r of result._aiResults) {
      assert.equal(r._aiRawAnalysis, aiResponse);
    }
    assert.equal(fakeModel.invoke.mock.calls.length, 2);
  });
});

// ========= Test 6: parseResponse -- valid JSON =========
describe("parseResponse", () => {
  it("parses valid AI JSON response", () => {
    const aiText = '{"actionRequired":false,"issue":"None - shipment is on track","recommendation":"No action needed"}';
    const results = [
      { ...makeShipment(), _aiRawAnalysis: aiText },
    ];

    const state = { _aiResults: results, analyzed: [], _retryCount: 0 };
    const parsed = parseResponse(state);
    assert.equal(parsed.analyzed.length, 1);
    assert.equal(parsed.analyzed[0]._actionRequired, "NO");
    assert.match(parsed.analyzed[0]._aiIssue, /on track/i);
    assert.equal(parsed.retryQueue.length, 0);
  });

  // ========= Test 7: parseResponse -- malformed JSON triggers retry =========
  it("queues malformed response for retry", () => {
    const brokenText = 'Sure! Here is the analysis: {"actionRequired": true or false, "issue"...';
    const results = [
      { ...makeShipment(), _aiRawAnalysis: brokenText },
    ];

    const state = { _aiResults: results, analyzed: [], _retryCount: 0 };
    const parsed = parseResponse(state);
    assert.equal(parsed.analyzed.length, 0);
    assert.equal(parsed.retryQueue.length, 1);

    const route = parseRouter(parsed);
    assert.equal(route, "retryAnalysis");
  });
});

// ========= Test 8: retryAnalysis -- succeeds on second attempt =========
describe("retry logic (via graph)", () => {
  it("retries and succeeds on second attempt", async () => {
    let callCount = 0;
    const fakeModel = {
      invoke: mock.fn(async () => {
        callCount++;
        if (callCount <= 1) {
          return { content: "This is not valid JSON at all {broken" };
        }
        return {
          content: JSON.stringify({
            actionRequired: true,
            issue: "Shipment delayed at terminal",
            recommendation: "Contact carrier",
          }),
        };
      }),
    };

    const shipments = [
      makeShipment({ "SHIPMENT STATUS": "In Transit", COMMENTS: "delay" }),
    ];

    const graph = buildGraph();
    const result = await graph.invoke({ shipments, _model: fakeModel });

    const nonRoutine = result.analyzed.filter(
      (r) => r._actionRequired !== "NO" || r._classification !== "routine"
    );
    assert.ok(nonRoutine.length >= 1);
    assert.equal(
      result.errors.filter((e) => e._actionRequired === "ERROR").length,
      0,
      "No errors after successful retry"
    );
  });
});

// ========= Test 9: retryAnalysis -- exhausted (max retries) =========
describe("retry exhaustion", () => {
  it("marks ERROR after max retries", async () => {
    const fakeModel = {
      invoke: mock.fn(async () => ({
        content: "I cannot provide valid JSON response %%% broken",
      })),
    };

    const shipments = [
      makeShipment({ "SHIPMENT STATUS": "In Transit", COMMENTS: "delay at hub" }),
    ];

    const graph = buildGraph();
    const result = await graph.invoke({ shipments, _model: fakeModel });

    const errors = result.analyzed.filter((r) => r._actionRequired === "ERROR");
    assert.ok(errors.length >= 1, "At least one ERROR after exhausted retries");
  });
});

// ========= Test 10: end-to-end -- full pipeline =========
describe("end-to-end graph", () => {
  it("processes mixed shipments through the full pipeline", async () => {
    const aiResponses = {
      ambiguous: JSON.stringify({
        actionRequired: true,
        issue: "Shipment delayed — missed pickup window",
        recommendation: "Reschedule pickup and notify customer",
      }),
      critical: JSON.stringify({
        actionRequired: true,
        issue: "Delivery refused by consignee — wrong address",
        recommendation: "Contact customer to confirm address and reroute",
      }),
    };

    let claudeCallCount = 0;
    const fakeModel = {
      invoke: mock.fn(async (messages) => {
        claudeCallCount++;
        const text = messages.map((m) => m.content).join(" ");
        if (/summary|aggregate|executive/i.test(text)) {
          return { content: "Executive Summary: 3 of 8 shipments need attention." };
        }
        if (/URGENT|critical/i.test(text)) {
          return { content: aiResponses.critical };
        }
        return { content: aiResponses.ambiguous };
      }),
    };

    const shipments = [
      makeShipment({ _trackingNumber: "R1", "SHIPMENT STATUS": "Delivered" }),
      makeShipment({ _trackingNumber: "R2", "SHIPMENT STATUS": "Delivered" }),
      makeShipment({ _trackingNumber: "R3", "SHIPMENT STATUS": "In Transit" }),
      makeShipment({ _trackingNumber: "R4", "SHIPMENT STATUS": "Booked" }),
      makeShipment({ _trackingNumber: "R5", "SHIPMENT STATUS": "Delivered" }),
      makeShipment({
        _trackingNumber: "A1",
        "SHIPMENT STATUS": "In Transit",
        COMMENTS: "delay reported at origin",
      }),
      makeShipment({
        _trackingNumber: "A2",
        "SHIPMENT STATUS": "In Transit",
        COMMENTS: "missed appointment",
      }),
      makeShipment({
        _trackingNumber: "C1",
        "SHIPMENT STATUS": "Issue",
        COMMENTS: "refused by consignee",
      }),
    ];

    const graph = buildGraph();
    const result = await graph.invoke({ shipments, _model: fakeModel });

    assert.equal(result.analyzed.length, 8, "All 8 shipments analyzed");

    for (const row of result.analyzed) {
      assert.ok(
        row._actionRequired === "YES" || row._actionRequired === "NO" || row._actionRequired === "ERROR",
        `Row ${row._trackingNumber} has valid _actionRequired: ${row._actionRequired}`
      );
      assert.ok(row._aiIssue, `Row ${row._trackingNumber} has _aiIssue`);
    }

    const routineRows = result.analyzed.filter((r) => r._actionRequired === "NO");
    assert.equal(routineRows.length, 5, "5 routine shipments have NO action");

    assert.ok(result.summary.length > 0, "Summary is non-empty");

    assert.ok(
      result.errors.length === 0,
      "No errors in clean run"
    );

    const routineTrackingNums = new Set(["R1", "R2", "R3", "R4", "R5"]);
    const aiCalls = fakeModel.invoke.mock.calls;
    for (const call of aiCalls) {
      const msgs = call.arguments[0];
      const text = Array.isArray(msgs) ? msgs.map((x) => x.content || "").join("") : "";
      if (/summary|aggregate|executive/i.test(text)) continue;
      for (const rtn of routineTrackingNums) {
        if (text.includes(`"_trackingNumber":"${rtn}"`)) {
          assert.fail(`Routine shipment ${rtn} should not have been sent to Claude for analysis`);
        }
      }
    }
  });
});

// ========= Test 11: classify -- unknown status goes to ambiguous =========
describe("classify (extended)", () => {
  it("sends unknown status to ambiguous", () => {
    const shipments = [
      makeShipment({ "SHIPMENT STATUS": "PickupUnverified" }),
    ];
    const result = classify({ shipments });
    assert.equal(result.classified.ambiguous.length, 1);
    assert.equal(result.classified.routine.length, 0);
    assert.equal(result.classified.critical.length, 0);
  });

  // ========= Test 12: classify -- Out for Delivery is routine =========
  it("recognizes Out for Delivery as routine", () => {
    const shipments = [
      makeShipment({ "SHIPMENT STATUS": "Out for Delivery" }),
    ];
    const result = classify({ shipments });
    assert.equal(result.classified.routine.length, 1);
    assert.equal(result.classified.ambiguous.length, 0);
  });

  // ========= Test 20: classify -- exception keyword in routine status promotes to ambiguous =========
  it("promotes routine status with exception keyword to ambiguous", () => {
    const shipments = [
      makeShipment({ "SHIPMENT STATUS": "Delivered", COMMENTS: "return initiated by customer" }),
    ];
    const result = classify({ shipments });
    assert.equal(result.classified.ambiguous.length, 1);
    assert.equal(result.classified.routine.length, 0);
  });
});

// ========= Test 13: analyzeWithAI -- API error returns ERROR row =========
describe("analyzeWithAI (error handling)", () => {
  it("returns ERROR row when model throws", async () => {
    const failModel = {
      invoke: mock.fn(async () => { throw new Error("API rate limit exceeded"); }),
    };
    const classified = {
      routine: [],
      ambiguous: [makeShipment({ "SHIPMENT STATUS": "In Transit", COMMENTS: "delay" })],
      critical: [],
    };
    const result = await analyzeWithAI({ classified, _model: failModel });
    assert.equal(result._aiResults.length, 1);
    assert.equal(result._aiResults[0]._actionRequired, "ERROR");
    assert.match(result._aiResults[0]._aiIssue, /rate limit/i);
  });
});

// ========= Test 14: parseResponse -- JSON inside markdown code fence =========
describe("parseResponse (code fence)", () => {
  it("extracts JSON from markdown code fence", () => {
    const aiText = '```json\n{"actionRequired":true,"issue":"Delayed at terminal","recommendation":"Call carrier"}\n```';
    const results = [{ ...makeShipment(), _aiRawAnalysis: aiText }];
    const state = { _aiResults: results, analyzed: [], _retryCount: 0 };
    const parsed = parseResponse(state);
    assert.equal(parsed.analyzed.length, 1);
    assert.equal(parsed.analyzed[0]._actionRequired, "YES");
    assert.match(parsed.analyzed[0]._aiIssue, /Delayed/);
    assert.equal(parsed.retryQueue.length, 0);
  });
});

// ========= Test 15: parseResponse -- coercion of various actionRequired values =========
describe("coerceActionRequired", () => {
  it("coerces truthy values to YES", () => {
    assert.equal(coerceActionRequired("yes"), "YES");
    assert.equal(coerceActionRequired("true"), "YES");
    assert.equal(coerceActionRequired(1), "YES");
    assert.equal(coerceActionRequired("y"), "YES");
    assert.equal(coerceActionRequired(true), "YES");
  });

  it("coerces falsy values to NO", () => {
    assert.equal(coerceActionRequired("no"), "NO");
    assert.equal(coerceActionRequired("false"), "NO");
    assert.equal(coerceActionRequired(0), "NO");
    assert.equal(coerceActionRequired("n"), "NO");
    assert.equal(coerceActionRequired(false), "NO");
  });
});

// ========= Test 16: summarize node -- produces non-empty summary =========
describe("summarize node", () => {
  it("produces non-empty summary from analyzed rows", async () => {
    const fakeModel = makeFakeModel("Overall: 2 shipments need action out of 5 total.");
    const state = {
      analyzed: [
        makeShipment({ _actionRequired: "YES", _aiIssue: "Delay" }),
        makeShipment({ _actionRequired: "YES", _aiIssue: "Refused" }),
        makeShipment({ _actionRequired: "NO", _aiIssue: "None - shipment is on track" }),
        makeShipment({ _actionRequired: "NO", _aiIssue: "None - shipment is on track" }),
        makeShipment({ _actionRequired: "NO", _aiIssue: "None - shipment is on track" }),
      ],
      errors: [],
      _model: fakeModel,
    };
    const result = await summarize(state);
    assert.ok(result.summary.length > 0, "Summary is non-empty");
    assert.match(result.summary, /shipments/i);
  });
});

// ========= Test 17: aggregate -- merges without duplicates =========
describe("aggregate", () => {
  it("does not duplicate routine rows when called with existing routine", async () => {
    const fakeModel = makeFakeModel("Summary");
    const graph = buildGraph();
    const shipments = [
      makeShipment({ "SHIPMENT STATUS": "Delivered" }),
      makeShipment({ "SHIPMENT STATUS": "Delivered" }),
    ];
    const result = await graph.invoke({ shipments, _model: fakeModel });
    assert.equal(result.analyzed.length, 2, "Exactly 2 rows, no duplicates");
  });
});

// ========= Test 18: end-to-end -- 100% routine (only summary call) =========
describe("end-to-end 100% routine", () => {
  it("calls model only once for summary when all shipments are routine", async () => {
    const fakeModel = {
      invoke: mock.fn(async () => ({
        content: "All 10 shipments are on track. No action needed.",
      })),
    };
    const shipments = Array.from({ length: 10 }, (_, i) =>
      makeShipment({ _trackingNumber: `ROUTINE${i}`, "SHIPMENT STATUS": "Delivered" })
    );
    const graph = buildGraph();
    const result = await graph.invoke({ shipments, _model: fakeModel });
    assert.equal(result.analyzed.length, 10);
    assert.equal(fakeModel.invoke.mock.calls.length, 1, "Only 1 call (summary)");
    assert.ok(result.summary.length > 0);
  });
});

// ========= Test 19: end-to-end -- large batch (50 shipments) =========
describe("end-to-end large batch", () => {
  it("handles 50 mixed shipments without error", async () => {
    const aiResponse = JSON.stringify({
      actionRequired: true,
      issue: "Shipment delayed",
      recommendation: "Contact carrier",
    });
    const fakeModel = {
      invoke: mock.fn(async (messages) => {
        const text = Array.isArray(messages)
          ? messages.map((m) => m.content || "").join("")
          : "";
        if (/summary|executive/i.test(text)) {
          return { content: "Summary of 50 shipments." };
        }
        return { content: aiResponse };
      }),
    };

    const shipments = [];
    for (let i = 0; i < 40; i++) {
      shipments.push(makeShipment({ _trackingNumber: `R${i}`, "SHIPMENT STATUS": "Delivered" }));
    }
    for (let i = 0; i < 8; i++) {
      shipments.push(makeShipment({
        _trackingNumber: `A${i}`,
        "SHIPMENT STATUS": "In Transit",
        COMMENTS: "delay noted",
      }));
    }
    for (let i = 0; i < 2; i++) {
      shipments.push(makeShipment({
        _trackingNumber: `C${i}`,
        "SHIPMENT STATUS": "Issue",
        COMMENTS: "refused",
      }));
    }

    const graph = buildGraph();
    const result = await graph.invoke({ shipments, _model: fakeModel });
    assert.equal(result.analyzed.length, 50, "All 50 shipments analyzed");
    assert.equal(result.errors.length, 0, "No errors");
    assert.ok(result.summary.length > 0, "Summary produced");
  });
});
