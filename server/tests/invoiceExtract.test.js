import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  DOC_TYPES, docTypeOf, isDocPath, mimeOf, docGroupOf, planFiles,
  parseAmount, parseDate, normalizeExtraction, chunkText, chunksForRow,
  costUsd, EXTRACTION_SCHEMA, EXTRACTED_COLS, fileBlock, buildRequest, extractDocument, ExtractError,
} from "../lib/invoiceExtract.js";

// These tests cover the reading rules with every kind of document read.
process.env.INVOICE_OCR_DOC_TYPES = "all";

// The file names the hosted browser saves today (shipment id 15612931).
const SAVED = [
  "invoices/15612931-1.png",
  "invoices/15612931-invoice.pdf",
  "invoices/15612931-view-1.png",
  "invoices/15612931-view-details-1.png",
  "invoices/15612931-view-print-rate-confirmation-1.png",
  "invoices/15612931-view-print-rate-confirmation-file.pdf",
  "invoices/15612931-view-print-shipping-labels-bol-1.png",
  "invoices/15612931-view-print-shipping-labels-bol-file.pdf",
  "invoices/15612931-view-print-shipping-labels-bol-file-2.pdf",
  "invoices/15612931-view-view-1.png",
  "invoices/15612931-view-broker-notes-1.png",
  "invoices/15612931-view-change-log-1.png",
];

describe("docTypeOf", () => {
  it("names each kind of saved file the way the dashboard's tabs do", () => {
    assert.deepEqual(SAVED.map(docTypeOf), [
      "invoice", "invoice", "shipment_details", "quote", "rate_confirmation", "rate_confirmation",
      "bol", "bol", "bol", "accessorials", "documents", "other",
    ]);
    for (const t of SAVED.map(docTypeOf)) assert.ok(DOC_TYPES.includes(t));
    assert.equal(docTypeOf("invoices/1-view-documents-1.png"), "documents");
    assert.equal(docTypeOf("invoices/1-view-print-documents-1.png"), "documents");
    // The View button's picture ends in "-view-1.png" too; it is accessorials, not the details page.
    assert.equal(docTypeOf("invoices/15612931-view-view-1.png"), "accessorials");
    assert.equal(docTypeOf("invoices/15612931-view-12.png"), "shipment_details");
    assert.equal(docTypeOf(null), "invoice"); // no "-view-" part; planFiles refuses the path itself
  });
});

describe("paths and types", () => {
  it("accepts only files in the invoices folder", () => {
    assert.equal(isDocPath("invoices/15612931-invoice.pdf"), true);
    for (const bad of ["invoices/../x.pdf", "other/1.pdf", "invoices/a/b.pdf", "invoices/1", "", null, 5]) {
      assert.equal(isDocPath(bad), false, String(bad));
    }
  });

  it("knows what Claude can be given", () => {
    assert.equal(mimeOf("invoices/1.pdf"), "application/pdf");
    assert.equal(mimeOf("invoices/1.PNG"), "image/png");
    assert.equal(mimeOf("invoices/1.jpeg"), "image/jpeg");
    assert.equal(mimeOf("invoices/1.txt"), "text/plain");
    assert.equal(mimeOf("invoices/1.xlsx"), null);
    assert.equal(mimeOf("invoices/1.zip"), null);
  });

  it("groups a picture with the PDF of the same document", () => {
    assert.equal(docGroupOf("invoices/15612931-1.png"), "15612931");
    assert.equal(docGroupOf("invoices/15612931-invoice.pdf"), "15612931");
    assert.equal(docGroupOf("invoices/15612931-view-1.png"), "15612931-view");
    assert.equal(docGroupOf("invoices/15612931-view-print-rate-confirmation-1.png"), "15612931-view-print-rate-confirmation");
    assert.equal(docGroupOf("invoices/15612931-view-print-shipping-labels-bol-file-3.pdf"), "15612931-view-print-shipping-labels-bol");
  });
});

describe("planFiles", () => {
  it("reads PDFs, skips the picture of the same document, and returns every file once", () => {
    const plan = planFiles([...SAVED, SAVED[0], "  "]);
    assert.equal(plan.length, SAVED.length);
    const by = Object.fromEntries(plan.map((p) => [p.file, p]));
    assert.equal(by["invoices/15612931-invoice.pdf"].action, "process");
    assert.equal(by["invoices/15612931-1.png"].action, "skip");
    assert.match(by["invoices/15612931-1.png"].reason, /15612931-invoice\.pdf/);
    assert.equal(by["invoices/15612931-view-print-rate-confirmation-1.png"].action, "skip");
    assert.equal(by["invoices/15612931-view-print-shipping-labels-bol-1.png"].action, "skip");
    for (const f of SAVED.filter((x) => x.endsWith(".pdf"))) assert.equal(by[f].action, "process", f);
    // Pictures with no PDF beside them are read.
    for (const f of ["invoices/15612931-view-1.png", "invoices/15612931-view-details-1.png", "invoices/15612931-view-view-1.png"]) {
      assert.equal(by[f].action, "process", f);
      assert.equal(by[f].reason, null);
    }
  });

  it("reads the picture when it is all there is", () => {
    assert.deepEqual(planFiles(["invoices/7-1.png"]).map((p) => [p.doc_type, p.action]), [["invoice", "process"]]);
  });

  it("counts a PDF already recorded for the shipment", () => {
    const [p] = planFiles(["invoices/7-1.png"], ["invoices/7-invoice.pdf"]);
    assert.equal(p.action, "skip");
  });

  it("does not let another shipment's PDF hide a picture", () => {
    const plan = planFiles(["invoices/7-1.png", "invoices/8-invoice.pdf"]);
    assert.deepEqual(plan.map((p) => p.action), ["process", "process"]);
  });

  it("records, with a reason, what it cannot read", () => {
    const plan = planFiles(["invoices/7-view-download-file.xlsx", "elsewhere/7.pdf"]);
    assert.deepEqual(plan.map((p) => p.action), ["skip", "skip"]);
    assert.match(plan[0].reason, /\.xlsx/);
    assert.match(plan[1].reason, /invoices folder/);
    assert.deepEqual(planFiles(null), []);
  });
});

describe("parseAmount", () => {
  it("reads printed amounts", () => {
    assert.equal(parseAmount("$1,234.56"), 1234.56);
    assert.equal(parseAmount("USD 1,000"), 1000);
    assert.equal(parseAmount("(12.00)"), -12);
    assert.equal(parseAmount("12.00-"), -12);
    assert.equal(parseAmount("-12.5"), -12.5);
    assert.equal(parseAmount("45.10 CR"), -45.1);
    assert.equal(parseAmount("1,250 lbs"), 1250);
    assert.equal(parseAmount(".5"), 0.5);
    assert.equal(parseAmount(0), 0);
    assert.equal(parseAmount("0.00"), 0);
  });
  it("gives null, not a guess, for anything else", () => {
    for (const bad of ["", "  ", "TBD", "12/14", "1.2.3", "10 - 20", null, undefined, NaN, {}]) {
      assert.equal(parseAmount(bad), null, String(bad));
    }
  });
});

describe("parseDate", () => {
  it("reads the forms US freight documents print", () => {
    assert.equal(parseDate("2026-11-03"), "2026-11-03");
    assert.equal(parseDate("2026-11-03T14:05:00Z"), "2026-11-03");
    assert.equal(parseDate("11/03/2026"), "2026-11-03");
    assert.equal(parseDate("11/3/26"), "2026-11-03");
    assert.equal(parseDate("11-03-2026 02:15 PM"), "2026-11-03");
    assert.equal(parseDate("Nov 3, 2026"), "2026-11-03");
    assert.equal(parseDate("November 3rd, 2026"), "2026-11-03");
    assert.equal(parseDate("3 Nov 2026"), "2026-11-03");
    assert.equal(parseDate("03-Nov-26"), "2026-11-03");
  });
  it("gives null for a date that is not one", () => {
    for (const bad of ["", "02/30/2026", "13/40/2026", "soon", "Net 30", "2026", null, 20261103]) {
      assert.equal(parseDate(bad), null, String(bad));
    }
  });
});

// What the model returns for a carrier invoice (every value a string).
const MODEL_JSON = {
  invoice_number: " 4471002938 ", invoice_date: "2026-11-03", due_date: "12/03/2026",
  carrier: "XPO Logistics Freight, Inc.", carrier_scac: "cnwy",
  bill_to: "FPX Logistics  1 Main St, Irvine, CA 92618", remit_to: "XPO, PO Box 5160, Portland, OR",
  ship_from: "Acme Tools, Modesto, CA", ship_to: "Bolt Supply, Reno, NV",
  tracking_number: "537-123456", bol_number: "BOL88121", po_number: "PO-7781, PO-7782", so_number: "", quote_number: "N/A",
  terms: "Net 30", currency: "usd",
  subtotal: "$1,000.00", fuel_surcharge: "215.50", accessorial_total: "75.00", discount: "(100.00)", tax: "", total: "$1,190.50",
  weight: "1,250 lbs", pieces: "4", freight_class: "70",
  line_items: [
    { description: "Line haul", quantity: "1", rate: "1,000.00", amount: "$1,000.00" },
    { description: "Liftgate delivery", quantity: "", rate: "", amount: "75.00" },
    { description: "", quantity: "", rate: "", amount: "" },
  ],
  fields: [
    { label: "Pickup Date", value: "10/29/2026" },
    { label: "Service Level", value: "Standard" },
    { label: "Pickup Date", value: "10/30/2026" },
    { label: "Service Level", value: "Standard" },
    { label: "Empty", value: "" },
  ],
  raw_text: "XPO LOGISTICS\r\nINVOICE 4471002938\r\nTOTAL DUE $1,190.50",
  summary: "XPO invoice 4471002938 to FPX for a Modesto to Reno shipment, total $1,190.50.",
  confidence: 0.93,
  warnings: ["Page 2 is cut off at the bottom"],
};

describe("normalizeExtraction", () => {
  it("turns the model's strings into typed columns", () => {
    const row = normalizeExtraction(MODEL_JSON);
    assert.equal(row.invoice_number, "4471002938");
    assert.equal(row.invoice_date, "2026-11-03");
    assert.equal(row.due_date, "2026-12-03");
    assert.equal(row.carrier, "XPO Logistics Freight, Inc.");
    assert.equal(row.carrier_scac, "CNWY");
    assert.equal(row.bill_to, "FPX Logistics 1 Main St, Irvine, CA 92618");
    assert.equal(row.so_number, null);
    assert.equal(row.quote_number, null); // "N/A" is not a value
    assert.equal(row.currency, "USD");
    assert.equal(row.subtotal, 1000);
    assert.equal(row.fuel_surcharge, 215.5);
    assert.equal(row.accessorial_total, 75);
    assert.equal(row.discount, -100);
    assert.equal(row.tax, null);
    assert.equal(row.total, 1190.5);
    assert.equal(row.weight, 1250);
    assert.equal(row.pieces, 4);
    assert.equal(row.freight_class, "70");
    assert.deepEqual(row.line_items, [
      { description: "Line haul", quantity: 1, rate: 1000, amount: 1000 },
      { description: "Liftgate delivery", quantity: null, rate: null, amount: 75 },
    ]);
    // Repeated labels keep both values; an exact repeat is kept once; blanks are left out.
    assert.deepEqual(row.fields, { "Pickup Date": "10/29/2026", "Service Level": "Standard", "Pickup Date (2)": "10/30/2026" });
    assert.equal(row.raw_text, "XPO LOGISTICS\nINVOICE 4471002938\nTOTAL DUE $1,190.50");
    assert.equal(row.confidence, 0.93);
    assert.deepEqual(row.warnings, ["Page 2 is cut off at the bottom"]); // 1000 + 215.50 + 75 - 100 = 1190.50
  });

  it("sets every extracted column, so a second reading clears what is gone", () => {
    assert.deepEqual(Object.keys(normalizeExtraction(MODEL_JSON)).sort(), [...EXTRACTED_COLS].sort());
    assert.deepEqual(Object.keys(normalizeExtraction({})).sort(), [...EXTRACTED_COLS].sort());
  });

  it("keeps what it cannot type, as printed, and says so", () => {
    const row = normalizeExtraction({ ...MODEL_JSON, invoice_date: "see attached", total: "TBD", pieces: "2 pallets + 1 box", fields: [] });
    assert.equal(row.invoice_date, null);
    assert.equal(row.total, null);
    assert.equal(row.pieces, null);
    assert.equal(row.fields["invoice_date (as printed)"], "see attached");
    assert.equal(row.fields["total (as printed)"], "TBD");
    assert.equal(row.fields["pieces (as printed)"], "2 pallets + 1 box");
    assert.ok(row.warnings.some((w) => /invoice_date could not be read/.test(w)));
    assert.ok(row.warnings.some((w) => /total could not be read/.test(w)));
  });

  it("flags a total its parts do not add up to, without changing it", () => {
    const row = normalizeExtraction({ ...MODEL_JSON, total: "1,500.00" });
    assert.equal(row.total, 1500);
    assert.ok(row.warnings.some((w) => /add up to 1190\.50 but the total reads 1500\.00/.test(w)));
  });

  it("never throws on junk", () => {
    for (const junk of [null, undefined, "text", 5, [], { line_items: "x", fields: 3, warnings: {}, confidence: "high", raw_text: 9 }]) {
      const row = normalizeExtraction(junk);
      assert.deepEqual(row.line_items, []);
      assert.deepEqual(row.fields, {});
      assert.deepEqual(row.warnings, []);
      assert.equal(row.raw_text, null);
      assert.equal(row.confidence, null);
      assert.equal(row.total, null);
    }
    assert.equal(normalizeExtraction({ confidence: 7 }).confidence, 1);
    assert.equal(normalizeExtraction({ confidence: -1 }).confidence, 0);
    assert.equal(normalizeExtraction({ total: 12.5, pieces: 3 }).total, 12.5);
    assert.equal(normalizeExtraction({ total: 12.5, pieces: 3 }).pieces, 3);
  });
});

describe("chunkText", () => {
  it("returns short text whole and nothing for nothing", () => {
    assert.deepEqual(chunkText("  hello   world "), ["hello world"]);
    assert.deepEqual(chunkText(""), []);
    assert.deepEqual(chunkText(null), []);
  });

  it("cuts long text into overlapping pieces that cover all of it", () => {
    const words = Array.from({ length: 900 }, (_, i) => `w${i}`);
    const chunks = chunkText(words.join(" "));
    assert.ok(chunks.length >= 4);
    for (const c of chunks) assert.ok(c.length <= 1000, `chunk of ${c.length}`);
    const seen = new Set(chunks.flatMap((c) => c.split(" ")));
    for (const w of words) assert.ok(seen.has(w), `${w} is in no chunk`);
    // Each piece starts inside the one before it.
    for (let i = 1; i < chunks.length; i++) assert.ok(chunks[i - 1].includes(chunks[i].split(" ")[1]));
  });

  it("handles text with nowhere to break, and stops at max", () => {
    const chunks = chunkText("x".repeat(3500), { size: 1000, overlap: 100 });
    assert.equal(chunks.join("").length >= 3500, true);
    assert.equal(chunkText("y ".repeat(50_000), { max: 5 }).length, 5);
  });
});

describe("chunksForRow", () => {
  it("leads with what the document is, then the page text", () => {
    const row = normalizeExtraction(MODEL_JSON);
    const [first] = chunksForRow(row, { docType: "invoice" });
    assert.match(first, /^XPO invoice 4471002938 to FPX/);
    assert.match(first, /invoice, number 4471002938, from XPO Logistics Freight, Inc\./);
    assert.match(first, /total 1190\.5 USD/);
    assert.match(first, /Liftgate delivery/);
    assert.match(first, /TOTAL DUE/);
    assert.deepEqual(chunksForRow({}), ["other"]);
  });
});

describe("the request", () => {
  const pdf = Buffer.from("%PDF-1.7\n...");

  it("has a schema structured outputs accept: closed objects, every key required, no either-types", () => {
    const walk = (node, path) => {
      if (node.type === "object") {
        assert.equal(node.additionalProperties, false, path);
        assert.deepEqual([...node.required].sort(), Object.keys(node.properties).sort(), path);
        for (const [k, v] of Object.entries(node.properties)) walk(v, `${path}.${k}`);
      } else if (node.type === "array") {
        walk(node.items, `${path}[]`);
      } else {
        assert.ok(["string", "number"].includes(node.type), `${path}: ${JSON.stringify(node.type)}`);
      }
    };
    walk(EXTRACTION_SCHEMA, "$");
    // Every typed column the row has is asked for.
    for (const c of EXTRACTED_COLS) assert.ok(c in EXTRACTION_SCHEMA.properties, c);
  });

  it("sends a PDF as a document and a picture as an image, before the text", () => {
    const d = fileBlock({ bytes: pdf, mime: "application/pdf" });
    assert.equal(d.type, "document");
    assert.deepEqual(d.source, { type: "base64", media_type: "application/pdf", data: pdf.toString("base64") });
    const i = fileBlock({ bytes: Buffer.from([1, 2, 3]), mime: "image/png" });
    assert.deepEqual(i, { type: "image", source: { type: "base64", media_type: "image/png", data: "AQID" } });
    assert.equal(fileBlock({ bytes: Buffer.from("a,b"), mime: "text/csv" }).type, "text");

    const { body } = buildRequest({ model: "claude-opus-5-5", bytes: pdf, mime: "application/pdf", docType: "invoice", shipmentId: "15612931" });
    assert.equal(body.messages[0].content[0].type, "document");
    assert.match(body.messages[0].content[1].text, /carrier invoice.*shipment 15612931/);
    assert.deepEqual(body.output_config.format, { type: "json_schema", schema: EXTRACTION_SCHEMA });
    for (const gone of ["temperature", "top_p", "top_k", "thinking", "tool_choice"]) assert.equal(gone in body, false, gone);
  });

  it("refuses, for good, what cannot be sent", () => {
    for (const bad of [
      { bytes: Buffer.alloc(0), mime: "application/pdf" },
      { bytes: Buffer.from("<html>"), mime: "application/pdf" },
      { bytes: Buffer.alloc(5 * 1024 * 1024 + 1), mime: "image/png" },
      { bytes: Buffer.from("x"), mime: null },
    ]) {
      assert.throws(() => fileBlock(bad), (e) => e instanceof ExtractError && e.permanent === true);
    }
  });

  it("sets effort and the fallback only on models that take them", () => {
    const req = (model) => buildRequest({ model, bytes: pdf, mime: "application/pdf" });
    assert.equal(req("claude-opus-5-5").body.output_config.effort, "low");
    assert.equal(req("claude-opus-5-5").body.fallbacks, "default");
    assert.equal(req("claude-opus-5-5").fallbacks, true);
    assert.equal(req("claude-sonnet-5-5").body.fallbacks, "default");
    assert.equal(req("claude-haiku-5-5").body.output_config.effort, "low");
    assert.equal("fallbacks" in req("claude-haiku-5-5").body, false);
    assert.equal("effort" in req("claude-haiku-4-5-20251001").body.output_config, false);
    assert.equal("fallbacks" in req("claude-haiku-4-5-20251001").body, false);
  });

  it("prices a call", () => {
    assert.equal(costUsd("claude-opus-5-5", 1_000_000, 1_000_000), 24);
    assert.ok(Math.abs(costUsd("claude-haiku-5-5", 5000, 3000) - 0.002) < 1e-9);
    assert.equal(costUsd("some-new-model", 1_000_000, 0), 4); // unknown: Opus 5.5 rates
    assert.equal(costUsd("claude-opus-5-5", null, undefined), 0);
  });
});

describe("extractDocument (no network: a stand-in fetch)", () => {
  const pdf = Buffer.from("%PDF-1.7\n...");
  const withKey = async (fn) => {
    const had = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "test-key";
    try { return await fn(); } finally {
      if (had === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = had;
    }
  };
  const reply = (json, status = 200) => async () => new Response(JSON.stringify(json), { status });

  it("says so when there is no key, without calling anything", async () => {
    const had = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      await assert.rejects(
        extractDocument({ bytes: pdf, mime: "application/pdf", modelOverride: "claude-opus-5-5", fetchImpl: () => { throw new Error("called"); } }),
        /ANTHROPIC_API_KEY not configured/);
    } finally { if (had !== undefined) process.env.ANTHROPIC_API_KEY = had; }
  });

  it("returns the JSON, skipping thinking blocks, with tokens and cost", async () => {
    let sent = null;
    const out = await withKey(() => extractDocument({
      bytes: pdf, mime: "application/pdf", docType: "invoice", modelOverride: "claude-opus-5-5",
      fetchImpl: async (url, init) => {
        sent = { url, headers: init.headers, body: JSON.parse(init.body) };
        return new Response(JSON.stringify({
          model: "claude-opus-5-5", stop_reason: "end_turn",
          content: [{ type: "thinking", thinking: "" }, { type: "text", text: JSON.stringify(MODEL_JSON) }],
          usage: { input_tokens: 4000, output_tokens: 2500 },
        }));
      },
    }));
    assert.equal(sent.url, "https://api.anthropic.com/v1/messages");
    assert.equal(sent.headers["x-api-key"], "test-key");
    assert.equal(sent.headers["anthropic-beta"], "server-side-fallback-2026-07-01");
    assert.equal(sent.body.model, "claude-opus-5-5");
    assert.equal(out.extraction.invoice_number, " 4471002938 ");
    assert.equal(out.model, "claude-opus-5-5");
    assert.equal(out.input_tokens, 4000);
    assert.equal(out.output_tokens, 2500);
    assert.ok(Math.abs(out.cost_usd - 0.066) < 1e-9);
    assert.equal(normalizeExtraction(out.extraction).total, 1190.5);
  });

  it("fails for good on a refusal, a cut-off answer and a refused request; and retryably otherwise", async () => {
    const run = (fetchImpl) => withKey(() => extractDocument({ bytes: pdf, mime: "application/pdf", modelOverride: "claude-haiku-5-5", fetchImpl }));
    await assert.rejects(run(reply({ stop_reason: "refusal", content: [], usage: { input_tokens: 10, output_tokens: 0 } })),
      (e) => e.permanent === true && /declined/.test(e.message) && e.meta.input_tokens === 10);
    await assert.rejects(run(reply({ stop_reason: "max_tokens", content: [{ type: "text", text: "{\"invoice_number\": \"4" }], usage: {} })),
      (e) => e.permanent === true && /too long/.test(e.message));
    await assert.rejects(run(reply({ error: { message: "bad schema" } }, 400)), (e) => e.permanent === true && /Claude API 400/.test(e.message));
    await assert.rejects(run(reply({ error: { message: "overloaded" } }, 529)), (e) => e.permanent === false && /Claude API 529/.test(e.message));
    await assert.rejects(run(reply({ stop_reason: "end_turn", content: [{ type: "text", text: "not json" }], usage: {} })),
      (e) => e.permanent === false && /not valid JSON/.test(e.message));
    await assert.rejects(run(async () => { throw new Error("socket hang up"); }), (e) => e.permanent === false && /Could not reach Claude/.test(e.message));
  });
});

it("by default only invoices, BOLs, rate confirmations and quotes are read", () => {
  const before = process.env.INVOICE_OCR_DOC_TYPES;
  delete process.env.INVOICE_OCR_DOC_TYPES;
  try {
    const plan = planFiles(["invoices/1-invoice.pdf", "invoices/1-view-change-log-1.png", "invoices/1-view-print-rate-confirmation-file.pdf"]);
    assert.deepEqual(plan.map((p) => p.action), ["process", "skip", "process"]);
    assert.match(plan[1].reason, /Not read/);
  } finally { process.env.INVOICE_OCR_DOC_TYPES = before; }
});
