// The invoice pipeline: every ERP pull is a numbered run that FPX carries
// forward on its own, one step after another:
//
//   erp_audit request done (FreightPOP's Transactions History Report saved as
//   an erp_pending audit)
//     → stage "approvals": an approval_check for the audit (an approval check
//       already queued, running or done for it is adopted, not repeated)
//     → the not-exported report is emailed (lib/invoiceReport.js; a failure is
//       recorded on the run and never holds it up)
//     → stage "documents": Get Invoice for every not-exported shipment of the
//       run that has no saved documents yet, in batches of up to 200, all View
//       Shipment buttons, no pause after the first; one batch at a time, each
//       batch's completion queues the next
//     → stage "done"
//   An erp_audit request that ends in an error marks its run "failed". An
//   approval check that errors does not stop the run: it goes on to documents.
//   Backfill pulls (note "backfill=1") make no audit and are not runs.
//
// State lives in fpx_invoice_pipeline (migrations/2026-11-20_invoice_pipeline.sql).
// The complete route of routes/ops.js calls onRequestComplete; a 2-minute tick
// (advancePipelines) moves along any run that is waiting, e.g. because another
// approval check or Get Invoice run held the one slot (409), or the server
// restarted mid-way. Nothing here deletes anything, and nothing here throws
// out of onRequestComplete / advancePipelines.
//
// The queue functions come from routes/ops.js and the report from
// lib/invoiceReport.js. Both are loaded when first needed (ops.js imports this
// file, and the report module may be missing), and both can be replaced
// through createInvoicePipeline for tests.

import { supabase } from "./supabase.js";
import { GET_INVOICE_SCOPE, MAX_GET_INVOICE_IDS, isUuid, parseGetInvoiceNote } from "./getInvoice.js";
import { APPROVAL_CHECK_SCOPE } from "./approvalMatch.js";

export const ACTIVE_STAGES = ["pulled", "approvals", "documents"];
const OPEN = ["pending", "claimed"];
const TICK_MS = 2 * 60 * 1000;
// A pull missed by the complete route (the server restarted at that moment)
// is picked up by the tick when it finished within this long.
const RECOVER_WINDOW_MS = 24 * 60 * 60 * 1000;
// The audit is made after the request is claimed; this much slack covers the
// two clocks (API server and database) not agreeing to the second.
const CLOCK_SLACK_MS = 5 * 60 * 1000;
const PAGE = 1000;
const ID_CHUNK = 200;

// ---------- pure helpers ----------

// "backfill=1" in an erp_audit request's note: every row copied, no audit made.
export const isBackfillNote = (note) => /(?:^|;)\s*backfill\s*=\s*1\s*(?:;|$)/i.test(String(note || ""));

// The short audit id the worker puts in its result note:
// "920 of 1,870 report rows not exported to ERP · audit b1064935".
export function auditPrefixFromNote(note) {
  const m = /\baudit\s+([0-9a-f]{8})\b/i.exec(String(note || ""));
  return m ? m[1].toLowerCase() : null;
}

// "audit=<uuid>" in an approval_check request's note.
export function auditIdFromNote(note) {
  const m = /(?:^|;)\s*audit\s*=\s*([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\s*(?:;|$)/i.exec(String(note || ""));
  return m ? m[1].toLowerCase() : null;
}

// "months=N;type=…" of an erp_audit request's note → { months, shipment_type }.
// A fixed-range pull (from=/to=) has no months.
export function parsePullNote(note) {
  const text = String(note || "");
  const m = /(?:^|;)\s*months\s*=\s*(\d+)/i.exec(text);
  const months = m ? Math.min(12, Math.max(1, Number(m[1]))) : null;
  const t = /(?:^|;)\s*type\s*=\s*(non-parcel|parcel|both)/i.exec(text);
  return { months, shipment_type: t ? t[1].toLowerCase() : "non-parcel" };
}

// Which audit a finished erp_audit request made. `audits` are erp_pending
// audits created after the request was claimed, newest first; `taken` holds
// audit ids that already belong to another request's run. The note's short id
// wins; otherwise (prefixOnly false) the newest audit not taken.
export function pickRunAudit(audits, note, { taken = new Set(), prefixOnly = false } = {}) {
  const list = Array.isArray(audits) ? audits : [];
  const prefix = auditPrefixFromNote(note);
  if (prefix) {
    const hit = list.find((a) => String(a.id).toLowerCase().startsWith(prefix));
    if (hit) return hit;
  }
  if (prefixOnly) return null;
  return list.find((a) => !taken.has(a.id)) || null;
}

// The result of this pipeline's Get Invoice requests on one audit row:
// "done" | "failed" | null (not tried by them, or not reported yet).
export function attemptOf(raw, requestIds) {
  const ours = new Set(requestIds || []);
  const gi = raw && typeof raw === "object" ? raw.get_invoice : null;
  if (!gi || typeof gi !== "object") return null;
  if (ours.has(gi.request_id) && (gi.status === "done" || gi.status === "failed")) return gi.status;
  const hist = Array.isArray(gi.history) ? gi.history : [];
  for (let i = hist.length - 1; i >= 0; i -= 1) {
    const h = hist[i];
    if (ours.has(h?.request_id) && (h.status === "done" || h.status === "failed")) return h.status;
  }
  return null;
}

// How many Get Invoice batches a run may use: one per 200 shipments plus three
// retries for batches that stopped early (a restart, a timeout).
export const maxBatches = (docsTotal) => Math.ceil(Math.max(0, Number(docsTotal) || 0) / MAX_GET_INVOICE_IDS) + 3;

const uniqueIds = (rows) => {
  const out = [];
  const seen = new Set();
  for (const r of rows || []) {
    const id = String(r?.shipment_id ?? "").trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
};

const errText = (e) => String(e?.message || e || "unknown error").slice(0, 500);

// ---------- the pipeline ----------

export function createInvoicePipeline({
  db = supabase,
  queueApprovalCheck = async (...a) => (await import("../routes/ops.js")).queueApprovalCheck(...a),
  queueGetInvoice = async (...a) => (await import("../routes/ops.js")).queueGetInvoice(...a),
  sendReport = async (...a) => (await import("./invoiceReport.js")).sendNotExportedReport(...a),
  now = () => new Date(),
  log = (msg) => console.warn(`[FPX] invoice pipeline: ${msg}`),
} = {}) {
  const iso = () => now().toISOString();

  async function must(query) {
    const { data, error } = await query;
    if (error) throw new Error(error.message || String(error));
    return data;
  }

  const getRow = (auditId) => must(db.from("fpx_invoice_pipeline").select("*").eq("audit_id", auditId).maybeSingle());
  const getRequest = (id) => must(db.from("fpx_scrape_requests").select("*").eq("id", id).maybeSingle());

  async function patch(auditId, fields) {
    const row = await must(db.from("fpx_invoice_pipeline")
      .update({ ...fields, updated_at: iso() }).eq("audit_id", auditId).select().maybeSingle());
    return row;
  }

  // Every row of an audit: { shipment_id, raw }, in the audit's own order.
  async function auditRows(auditId) {
    const rows = [];
    for (let from = 0; ; from += PAGE) {
      const data = await must(db.from("fpx_invoice_audit_rows").select("shipment_id, raw")
        .eq("audit_id", auditId).order("created_at", { ascending: true }).order("id", { ascending: true })
        .range(from, from + PAGE - 1));
      rows.push(...(data || []));
      if (!data || data.length < PAGE) break;
    }
    return rows;
  }

  // Of these shipment ids, the ones still not exported to ERP and with no
  // saved invoice documents, in the order given.
  async function needingDocsOf(ids) {
    if (!ids.length) return [];
    const drop = new Set();
    for (let i = 0; i < ids.length; i += ID_CHUNK) {
      const chunk = ids.slice(i, i + ID_CHUNK);
      const [exported, records, docs] = await Promise.all([
        must(db.from("fpx_erp_transactions").select("shipment_id").in("shipment_id", chunk).eq("exported_to_erp", true)),
        must(db.from("fpx_shipment_records").select("shipment_id, files").in("shipment_id", chunk).eq("kind", "invoice")),
        must(db.from("fpx_invoice_documents").select("shipment_id").in("shipment_id", chunk)),
      ]);
      for (const r of exported || []) drop.add(String(r.shipment_id));
      for (const r of records || []) if (Array.isArray(r.files) && r.files.length) drop.add(String(r.shipment_id));
      for (const r of docs || []) drop.add(String(r.shipment_id));
    }
    return ids.filter((id) => !drop.has(id));
  }

  // Not-exported shipments of the run with no saved invoice documents yet.
  // Throws when the database can't be read (so a failed read is never taken
  // for "nothing left to do").
  async function shipmentsNeedingDocs(auditId) {
    if (!isUuid(String(auditId || ""))) return [];
    return needingDocsOf(uniqueIds(await auditRows(auditId)));
  }

  // The person the hosted browser runs the run's jobs as: whoever asked for
  // the pull, else the audit's run_by.
  async function requesterOf(row) {
    if (row.erp_request_id) {
      const r = await getRequest(row.erp_request_id).catch(() => null);
      if (r?.requested_by) return r.requested_by;
    }
    const a = await must(db.from("fpx_invoice_audits").select("run_by").eq("id", row.audit_id).maybeSingle()).catch(() => null);
    return a?.run_by || null;
  }

  // Erp_pending audits a request could have made: created after it was claimed.
  async function auditsAfter(request) {
    const since = request?.claimed_at || request?.requested_at;
    let q = db.from("fpx_invoice_audits").select("id, created_at, run_by").eq("shipment_type", "erp_pending");
    if (since) q = q.gte("created_at", new Date(new Date(since).getTime() - CLOCK_SLACK_MS).toISOString());
    return (await must(q.order("created_at", { ascending: false }).limit(50))) || [];
  }

  async function resolveRunAudit(request, note, { prefixOnly = false } = {}) {
    const audits = await auditsAfter(request);
    if (!audits.length) return null;
    const owned = await must(db.from("fpx_invoice_pipeline").select("audit_id, erp_request_id")
      .in("audit_id", audits.map((a) => a.id)));
    const taken = new Set((owned || []).filter((p) => p.erp_request_id && p.erp_request_id !== request?.id).map((p) => p.audit_id));
    return pickRunAudit(audits, note, { taken, prefixOnly });
  }

  // Makes the run's row (numbered by the table's sequence) unless it exists.
  async function ensureRun(auditId, fields) {
    const existing = await getRow(auditId);
    if (existing) {
      if (!existing.erp_request_id && fields.erp_request_id) {
        return patch(auditId, { erp_request_id: fields.erp_request_id, months: existing.months ?? fields.months ?? null, shipment_type: existing.shipment_type ?? fields.shipment_type ?? null });
      }
      return existing;
    }
    const { data, error } = await db.from("fpx_invoice_pipeline")
      .insert({ audit_id: auditId, ...fields, created_at: iso(), updated_at: iso() }).select().single();
    if (!error) return data;
    const again = await getRow(auditId); // made at the same moment by the tick
    if (again) return again;
    throw new Error(error.message || String(error));
  }

  // ---- stage: approvals ----

  async function findApprovalCheck(row) {
    const open = await must(db.from("fpx_scrape_requests").select("id, status, note")
      .eq("scope", APPROVAL_CHECK_SCOPE).in("status", OPEN).order("requested_at", { ascending: false }).limit(20));
    const live = (open || []).find((r) => auditIdFromNote(r.note) === row.audit_id);
    if (live) return live;
    // One that already finished for this audit since the pull: its note is
    // now the result text, which names the audit by its short id.
    const prefix = String(row.audit_id).slice(0, 8).toLowerCase();
    let q = db.from("fpx_scrape_requests").select("id, status, note")
      .eq("scope", APPROVAL_CHECK_SCOPE).eq("status", "done");
    if (row.created_at) q = q.gte("completed_at", row.created_at);
    const done = await must(q.order("completed_at", { ascending: false }).limit(20));
    return (done || []).find((r) => auditPrefixFromNote(r.note) === prefix) || null;
  }

  async function sendReportOnce(auditId) {
    const fresh = await getRow(auditId);
    if (!fresh || fresh.report_emailed_at || fresh.report_email_error) return;
    let result;
    try {
      result = await sendReport({ auditId, reason: "after_pull" });
    } catch (e) {
      result = { sent: false, error: errText(e) };
    }
    const sent = result?.sent === true;
    await patch(auditId, sent
      ? { report_emailed_at: iso(), report_email_error: null }
      : { report_email_error: String(result?.error || "Report not sent").slice(0, 500) });
  }

  async function finishApprovals(row, status, error = null) {
    let cur = row;
    if (cur.approval_status !== status || error) {
      cur = await patch(row.audit_id, { approval_status: status, ...(error ? { error: `Approval check: ${String(error).slice(0, 400)}` } : {}) });
    }
    try { await sendReportOnce(row.audit_id); } catch (e) { log(`run ${row.audit_id}: report not recorded (${errText(e)})`); }
    const needing = await shipmentsNeedingDocs(row.audit_id);
    return patch(row.audit_id, { stage: "documents", docs_total: needing.length, docs_done: 0, docs_failed: 0 });
  }

  async function approvalsStep(row) {
    if (row.approval_request_id) {
      const r = await getRequest(row.approval_request_id);
      if (r && OPEN.includes(r.status)) {
        const s = r.status === "claimed" ? "running" : "queued";
        if (s !== row.approval_status) await patch(row.audit_id, { approval_status: s });
        return null;
      }
      if (r?.status === "done") return finishApprovals(row, "done");
      return finishApprovals(row, "error", r ? (r.note || "The approval check failed") : "The approval check request is missing");
    }
    if (row.approval_status === "error") return finishApprovals(row, "error");
    const existing = await findApprovalCheck(row);
    if (existing) {
      return patch(row.audit_id, {
        approval_request_id: existing.id,
        approval_status: existing.status === "claimed" ? "running" : existing.status === "pending" ? "queued" : row.approval_status,
      });
    }
    const out = await queueApprovalCheck({ auditId: row.audit_id }, { requestedBy: await requesterOf(row) });
    if (out?.ok) {
      await patch(row.audit_id, { approval_request_id: out.request.id, approval_status: "queued" });
      return null;
    }
    if (!out || out.status === 409 || !out.status || out.status >= 500) return null; // the tick tries again
    return finishApprovals(row, "error", out.error || `HTTP ${out.status}`);
  }

  // ---- stage: documents ----

  async function documentsStep(row) {
    const ids = Array.isArray(row.doc_request_ids) ? row.doc_request_ids : [];
    const last = ids[ids.length - 1];
    if (last) {
      const r = await getRequest(last);
      if (r && OPEN.includes(r.status)) return null; // this run's batch is still going
    }
    const rows = await auditRows(row.audit_id);
    const attempted = new Set();
    let done = 0;
    let failed = 0;
    for (const r of rows) {
      const id = String(r.shipment_id ?? "").trim();
      if (!id || attempted.has(id)) continue;
      const a = attemptOf(r.raw, ids);
      if (!a) continue;
      attempted.add(id);
      if (a === "done") done += 1; else failed += 1;
    }
    let cur = row;
    if (done !== row.docs_done || failed !== row.docs_failed) {
      cur = await patch(row.audit_id, { docs_done: done, docs_failed: failed });
    }
    const remaining = (await needingDocsOf(uniqueIds(rows))).filter((id) => !attempted.has(id));
    if (!remaining.length) {
      await patch(row.audit_id, { stage: "done" });
      return null;
    }
    if (ids.length >= maxBatches(cur.docs_total)) {
      await patch(row.audit_id, {
        stage: "done",
        error: `Stopped after ${ids.length} Get Invoice runs · ${remaining.length} shipment(s) still have no saved documents`,
      });
      return null;
    }
    const out = await queueGetInvoice({
      auditId: row.audit_id,
      shipmentIds: remaining.slice(0, MAX_GET_INVOICE_IDS),
      pauseAfterFirst: false,
      buttons: null, // every View Shipment button
    }, { requestedBy: await requesterOf(row) });
    if (out?.ok) {
      await patch(row.audit_id, { doc_request_ids: [...ids, out.request.id] });
      return null;
    }
    if (!out || out.status === 409 || !out.status || out.status >= 500) return null; // the tick tries again
    await patch(row.audit_id, { stage: "failed", error: `Get Invoice: ${String(out.error || `HTTP ${out.status}`).slice(0, 400)}` });
    return null;
  }

  // One stage move; returns the row when it moved and can be looked at again.
  async function stepOnce(row) {
    if (row.stage === "pulled") return patch(row.audit_id, { stage: "approvals" });
    if (row.stage === "approvals") return approvalsStep(row);
    if (row.stage === "documents") return documentsStep(row);
    return null;
  }

  // One run at a time per audit inside this process; a call that arrives while
  // the run is being moved makes it go round once more afterwards.
  const moving = new Map();
  async function advanceRun(auditId) {
    if (moving.has(auditId)) { moving.set(auditId, true); return; }
    moving.set(auditId, false);
    try {
      for (let pass = 0; pass < 3; pass += 1) {
        let row = await getRow(auditId);
        for (let i = 0; row && ACTIVE_STAGES.includes(row.stage) && i < 8; i += 1) {
          row = await stepOnce(row);
        }
        if (!moving.get(auditId)) break;
        moving.set(auditId, false);
      }
    } catch (e) {
      log(`run ${auditId}: ${errText(e)}`);
    } finally {
      moving.delete(auditId);
    }
  }

  async function onPullComplete(before, after) {
    if (isBackfillNote(before?.note) || isBackfillNote(after?.note)) return;
    const request = { ...(before || {}), ...(after || {}) };
    const audit = await resolveRunAudit(request, after?.note);
    if (!audit) {
      if (after?.status !== "error") log(`pull ${request.id}: no ERP audit found for it`);
      return;
    }
    const { months, shipment_type } = parsePullNote(before?.note);
    const failed = after?.status === "error";
    const row = await ensureRun(audit.id, {
      erp_request_id: request.id || null, months, shipment_type,
      stage: failed ? "failed" : "approvals",
      ...(failed ? { error: String(after?.note || "The pull failed").slice(0, 500) } : {}),
    });
    if (row && ACTIVE_STAGES.includes(row.stage)) await advanceRun(audit.id);
  }

  // A pull that finished while nobody listened (the server restarted between
  // the worker's report and the pipeline): only one whose note names its
  // audit, so a backfill or an unrelated audit is never taken for it.
  async function recoverMissedPulls() {
    const since = new Date(now().getTime() - RECOVER_WINDOW_MS).toISOString();
    const pulls = await must(db.from("fpx_scrape_requests").select("*")
      .eq("scope", "erp_audit").in("status", ["done", "error"]).gte("completed_at", since)
      .order("completed_at", { ascending: true }).limit(50));
    if (!pulls?.length) return;
    const known = await must(db.from("fpx_invoice_pipeline").select("erp_request_id").in("erp_request_id", pulls.map((p) => p.id)));
    const have = new Set((known || []).map((k) => k.erp_request_id));
    for (const p of pulls) {
      if (have.has(p.id) || !auditPrefixFromNote(p.note) || isBackfillNote(p.note)) continue;
      const audit = await resolveRunAudit(p, p.note, { prefixOnly: true });
      if (!audit || await getRow(audit.id)) continue;
      const failed = p.status === "error";
      await ensureRun(audit.id, {
        erp_request_id: p.id, months: null, shipment_type: null,
        stage: failed ? "failed" : "approvals",
        ...(failed ? { error: String(p.note || "The pull failed").slice(0, 500) } : {}),
      });
    }
  }

  // The tick: every run that is not done or failed gets a look.
  async function advancePipelines() {
    try {
      try { await recoverMissedPulls(); } catch (e) { log(`recovering pulls: ${errText(e)}`); }
      const rows = await must(db.from("fpx_invoice_pipeline").select("audit_id, stage")
        .in("stage", ACTIVE_STAGES).order("created_at", { ascending: true }).limit(50));
      for (const r of rows || []) await advanceRun(r.audit_id);
    } catch (e) {
      log(`tick: ${errText(e)}`);
    }
  }

  // Called by the complete route with the request as it was before the update
  // (its original note) and after it. Never throws.
  async function onRequestComplete(before, after) {
    try {
      const scope = before?.scope || after?.scope;
      if (scope === "erp_audit") {
        await onPullComplete(before, after);
      } else if (scope === APPROVAL_CHECK_SCOPE || scope === GET_INVOICE_SCOPE) {
        const auditId = scope === APPROVAL_CHECK_SCOPE ? auditIdFromNote(before?.note) : parseGetInvoiceNote(before?.note)?.audit_id;
        if (auditId) {
          const row = await getRow(auditId);
          if (row && ACTIVE_STAGES.includes(row.stage)) await advanceRun(auditId);
        }
        // The one slot is free again: a run waiting for it can go.
        await advancePipelines();
      }
    } catch (e) {
      log(`request ${before?.id || after?.id || "?"}: ${errText(e)}`);
    }
  }

  return { onRequestComplete, advancePipelines, advanceRun, shipmentsNeedingDocs, resolveRunAudit };
}

const pipeline = createInvoicePipeline();

export const onRequestComplete = (before, after) => pipeline.onRequestComplete(before, after);
export const advancePipelines = () => pipeline.advancePipelines();
export const shipmentsNeedingDocs = (auditId) => pipeline.shipmentsNeedingDocs(auditId);

// Starts the 2-minute tick (once). Not under node --test, and not when
// INVOICE_PIPELINE=off. Returns whether it is running.
let timer = null;
export function startInvoicePipeline() {
  if (timer) return true;
  if (process.env.NODE_TEST_CONTEXT || process.env.NODE_ENV === "test" || String(process.env.INVOICE_PIPELINE || "").toLowerCase() === "off") return false;
  timer = setInterval(() => { void advancePipelines(); }, TICK_MS);
  timer.unref?.();
  const first = setTimeout(() => { void advancePipelines(); }, 20_000);
  first.unref?.();
  return true;
}
