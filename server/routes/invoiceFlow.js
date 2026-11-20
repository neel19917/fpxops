// The one Invoices workflow: Pull → Runs → Not exported to ERP → Report for
// Isaac → Push to ERP (coming next). Mounted at /api/invoice-flow on the
// authenticated api router (see index.js).
//   GET  /summary                       counts, newest run, what is running, report recipients
//   GET  /runs?limit=20&offset=0        { runs, total } newest first
//   GET  /runs/:auditId                 { run, files: [{ name, label, url }], docs_count }
//   GET  /runs/:auditId/documents.zip   every saved document of the run
//   GET  /not-exported?status=&q=&limit=50&offset=0   { rows, total } biggest charge first
//   GET  /not-exported.xlsx             the report Isaac gets
//   POST /pull { months, shipment_type }   queues an ERP pull (409 when one is queued or running)
//   POST /report/email                  emails the report now
//   PUT  /report/recipients { recipients }  admins only, @freightpop.com addresses
// The pipeline after each pull (approval check, documents, the emailed report)
// runs in lib/invoicePipeline.js. Nothing here deletes anything or touches FreightPOP.
import { Router } from "express";
import { supabase as realSupabase } from "../lib/supabase.js";
import { logAudit as realLogAudit } from "../lib/audit.js";
import { setSetting } from "../lib/settings.js";
import { createMemoCache, erpHubCache } from "../lib/memoCache.js";
import { zip } from "../lib/xlsxWrite.js";
import {
  NOT_EXPORTED_STATUSES, DEFAULT_RECIPIENTS, RECIPIENTS_KEY,
  isUuid, isAdminReq, validatePull, validateRecipients, toNotExportedRow, activeFrom,
  loadRuns, loadCounts, lastEmailedAt, loadNotExportedPage, pageLookups, loadRunFiles, loadRunDocuments, queueErpPull,
} from "../lib/invoiceFlow.js";

const XLSX_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

// lib/invoiceReport.js is loaded when first used, so this router (and its
// tests) do not depend on it being there.
const report = () => import("../lib/invoiceReport.js");

export function buildInvoiceFlowRouter(overrides = {}) {
  const sb = overrides.supabase || realSupabase;
  const runsCache = overrides.runsCache || createMemoCache({ maxEntries: 4 });
  const countsCache = overrides.countsCache || erpHubCache;
  const deps = {
    logAudit: realLogAudit,
    loadRuns: () => runsCache.get("runs", () => loadRuns(sb), { ttlMs: 10_000 }).then((g) => g.value),
    loadCounts: () => countsCache.get("erp:flow:counts", () => loadCounts(sb), { ttlMs: 60_000, staleMs: 10 * 60_000 }).then((g) => g.value),
    // The same queue function POST /api/ops/rescrape {scope:"erp_audit"} uses
    // (it logs the request itself), answering 409 instead of reusing a
    // queued pull. With a Supabase client passed in (tests), lib's copy.
    queuePull: overrides.supabase
      ? (opts) => queueErpPull(sb, opts)
      : async ({ months, shipmentType, req }) => {
        const { queueErpAudit } = await import("./ops.js");
        const out = await queueErpAudit({ months, shipmentType, rejectIfBusy: true }, { req });
        if (out.ok) return { request: out.request, logged: true };
        if (out.status === 409) return { conflict: out.error };
        throw new Error(out.error || "The pull could not be queued");
      },
    getReportRecipients: async () => (await report()).getReportRecipients(),
    buildNotExportedWorkbook: async () => (await report()).buildNotExportedWorkbook(),
    sendNotExportedReport: async (opts) => (await report()).sendNotExportedReport(opts),
    setRecipients: (list, by) => setSetting(RECIPIENTS_KEY, list.join(", "), by),
    ...overrides,
  };
  const router = Router();
  const fail = (res, e) => res.status(500).json({ error: e?.message || String(e) });
  const actor = (req) => req.user?.email || req.apiKey?.name || null;
  const int = (v, fallback, min, max) => {
    const n = Number.parseInt(String(Array.isArray(v) ? v[0] : v ?? ""), 10);
    return Math.min(max, Math.max(min, Number.isFinite(n) ? n : fallback));
  };
  const recipients = async () => {
    try {
      const list = await deps.getReportRecipients();
      return Array.isArray(list) && list.length ? list : [...DEFAULT_RECIPIENTS];
    } catch {
      return [...DEFAULT_RECIPIENTS];
    }
  };

  router.get("/summary", async (_req, res) => {
    try {
      const [{ runs, requests }, counts, to] = await Promise.all([deps.loadRuns(), deps.loadCounts(), recipients()]);
      const done = (requests || []).filter((r) => r.status === "done" && r.completed_at)
        .sort((a, b) => String(b.completed_at).localeCompare(String(a.completed_at)))[0];
      res.set("Cache-Control", "private, no-store");
      res.json({
        not_exported: {
          total: NOT_EXPORTED_STATUSES.reduce((s, b) => s + (counts[b] || 0), 0),
          no_invoice: counts.no_invoice || 0,
          invoice_not_approved: counts.invoice_not_approved || 0,
          approved_ready: counts.approved_ready || 0,
          charge_total: counts.charge_total || 0,
        },
        exported_total: counts.exported || 0,
        latest_run: runs[0] || null,
        active: activeFrom(runs, requests),
        last_pull_at: done?.completed_at || runs[0]?.finished_at || null,
        report: { recipients: to, last_emailed_at: await lastEmailedAt(sb, runs) },
      });
    } catch (e) { fail(res, e); }
  });

  router.get("/runs", async (req, res) => {
    try {
      const limit = int(req.query.limit, 20, 1, 200);
      const offset = int(req.query.offset, 0, 0, 1_000_000);
      const { runs } = await deps.loadRuns();
      res.set("Cache-Control", "private, no-store");
      res.json({ runs: runs.slice(offset, offset + limit), total: runs.length });
    } catch (e) { fail(res, e); }
  });

  const findRun = async (req, res) => {
    const id = String(req.params.auditId || "");
    if (!isUuid(id)) { res.status(404).json({ error: "Run not found" }); return null; }
    const { runs } = await deps.loadRuns();
    const run = runs.find((r) => r.audit_id === id);
    if (!run) { res.status(404).json({ error: "Run not found" }); return null; }
    return run;
  };

  router.get("/runs/:auditId", async (req, res) => {
    try {
      const run = await findRun(req, res);
      if (!run) return;
      const { files, docs_count } = await (deps.loadRunFiles || ((r) => loadRunFiles(sb, r)))(run);
      res.set("Cache-Control", "private, no-store");
      res.json({ run, files, docs_count });
    } catch (e) { fail(res, e); }
  });

  router.get("/runs/:auditId/documents.zip", async (req, res) => {
    try {
      const run = await findRun(req, res);
      if (!run) return;
      const got = await (deps.loadRunDocuments || ((id) => loadRunDocuments(sb, id)))(run.audit_id);
      if (got.tooMany) return res.status(413).json({ error: `This run has ${got.tooMany} saved documents, more than one ZIP can hold.` });
      if (!got.entries.length && !got.missing.length) return res.status(404).json({ error: "No documents were saved for this run yet" });
      const base = `FPX-run-${run.run_number}-documents`;
      const entries = got.entries.map((e) => ({ name: `${base}/${e.name}`, data: e.data }));
      if (got.missing.length) entries.push({ name: `${base}/MISSING-FILES.txt`, data: Buffer.from(`These files could not be read from storage:\n${got.missing.join("\n")}\n`) });
      const buf = zip(entries);
      res.set({ "Content-Type": "application/zip", "Content-Disposition": `attachment; filename="${base}.zip"`, "Content-Length": String(buf.length), "Cache-Control": "private, no-store" });
      res.send(buf);
    } catch (e) { fail(res, e); }
  });

  router.get("/not-exported", async (req, res) => {
    const one = (v) => (Array.isArray(v) ? v[0] : v);
    const status = String(one(req.query.status) ?? "").trim() || "all";
    if (status !== "all" && !NOT_EXPORTED_STATUSES.includes(status)) {
      return res.status(400).json({ error: `status must be all, ${NOT_EXPORTED_STATUSES.join(", ")}` });
    }
    const q = String(one(req.query.q) ?? "").replace(/["\\]/g, "").trim().slice(0, 100);
    const limit = int(req.query.limit, 50, 1, 500);
    const offset = int(req.query.offset, 0, 0, 1_000_000);
    try {
      const [counts, { runs }] = await Promise.all([q ? null : deps.loadCounts().catch(() => null), deps.loadRuns()]);
      const page = await (deps.loadNotExportedPage || ((o) => loadNotExportedPage(sb, o)))({ status, q, limit, offset, counts });
      const ids = page.rows.map((r) => String(r.shipment_id));
      const { docsSaved, lastPull } = await (deps.pageLookups || ((list) => pageLookups(sb, list)))(ids);
      const runNumberByAudit = new Map(runs.map((r) => [r.audit_id, r.run_number]));
      res.set("Cache-Control", "private, no-store");
      res.json({ rows: page.rows.map((v) => toNotExportedRow(v, { docsSaved, lastPull, runNumberByAudit })), total: page.total });
    } catch (e) { fail(res, e); }
  });

  router.get("/not-exported.xlsx", async (_req, res) => {
    try {
      const { buffer, filename } = await deps.buildNotExportedWorkbook();
      res.set({
        "Content-Type": XLSX_TYPE,
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Content-Length": String(buffer.length),
        "Cache-Control": "private, no-store",
      });
      res.send(buffer);
    } catch (e) { fail(res, e); }
  });

  router.post("/pull", async (req, res) => {
    const v = validatePull(req.body || {});
    if (v.error) return res.status(400).json({ error: v.error });
    try {
      const out = await deps.queuePull({ months: v.months, shipmentType: v.shipmentType, requestedBy: actor(req), req });
      if (out.conflict) return res.status(409).json({ error: out.conflict });
      runsCache.invalidate?.("");
      if (!out.logged) deps.logAudit(req, {
        action: "rescrape_request",
        entity_type: "scrape_request",
        entity_id: out.request?.id,
        summary: `Requested ERP pull from Invoices (last ${v.months} month${v.months === 1 ? "" : "s"}, ${v.shipmentType})`,
        metadata: { scope: "erp_audit", months: v.months, shipment_type: v.shipmentType, via: "invoice-flow" },
      });
      res.json({ request: out.request });
    } catch (e) { fail(res, e); }
  });

  router.post("/report/email", async (req, res) => {
    let result;
    try {
      result = await deps.sendNotExportedReport({ reason: "manual" });
    } catch (e) {
      result = { sent: false, recipients: [], error: e?.message || String(e) };
    }
    deps.logAudit(req, {
      action: "invoice_report_email",
      entity_type: "invoice_report",
      entity_id: null,
      summary: result?.sent
        ? `Emailed the not-exported report to ${(result.recipients || []).join(", ")}`
        : `Not-exported report not emailed${result?.error ? `: ${result.error}` : ""}`,
      metadata: { reason: "manual", sent: !!result?.sent, recipients: result?.recipients || [], error: result?.error || null },
    });
    res.json(result);
  });

  router.put("/report/recipients", async (req, res) => {
    if (!isAdminReq(req)) return res.status(403).json({ error: "Admins only" });
    const v = validateRecipients(req.body?.recipients);
    if (v.error) return res.status(400).json({ error: v.error });
    try {
      const before = await recipients();
      await deps.setRecipients(v.recipients, actor(req));
      deps.logAudit(req, {
        action: "update",
        entity_type: "setting",
        entity_id: RECIPIENTS_KEY,
        summary: `Report recipients: ${v.recipients.join(", ")}`,
        before: { recipients: before },
        after: { recipients: v.recipients },
      });
      res.json({ recipients: v.recipients });
    } catch (e) { fail(res, e); }
  });

  return router;
}

export const invoiceFlowRouter = buildInvoiceFlowRouter();
