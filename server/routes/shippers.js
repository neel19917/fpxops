import { Router } from "express";
import { mailboxAccess, NO_ACCESS_ERROR } from "./mailbox.js";

// Shippers view — one dashboard per shipper (fpx_shipments.customer_name):
// tracking, tasks and Support Mailbox emails. Mounted at /api/shippers on the
// authenticated api router. Read-only: no writes, no logAudit.
//
// Email data needs Support Mailbox access: callers with access "none" get
// email fields as null on list/detail and 403 mailbox_no_access on /emails.

// lib/shippers.js loaded lazily so a missing/broken lib never stops the server
// from booting (and tests inject their own deps).
let libPromise = null;
function lib() {
  if (!libPromise) libPromise = import("../lib/shippers.js");
  return libPromise;
}
const fromLib = (name) => async (...args) => (await lib())[name](...args);

// ---------- pure helpers (exported for tests) ----------

// "none" | "view" | "draft". Admins → draft; signed-in users → their
// mailbox_access (missing → draft); API keys → view.
export function emailAccess(req) {
  return mailboxAccess(req);
}

export const LIST_SORTS = ["shipments", "name", "open_tasks", "exceptions", "awaiting_reply", "last_email"];
export const SHIPMENT_STATUSES = ["active", "in_transit", "exceptions", "delivered", "all"];
export const TASK_STATUSES = ["open", "done", "all"];
export const EMAIL_STATUSES = ["all", "awaiting_reply", "responded"];
export const EMAIL_DAYS = ["7", "30", "90", "all"];
const MAX_Q = 200;
const MAX_KEY = 500;

const bad = (msg) => ({ error: msg });

function one(v) {
  return Array.isArray(v) ? v[0] : v;
}

function present(v) {
  return v != null && String(v).trim() !== "";
}

function parseQ(raw) {
  const v = one(raw);
  if (!present(v)) return { value: "" };
  const s = String(v).trim();
  if (s.length > MAX_Q) return bad(`q must be at most ${MAX_Q} characters`);
  return { value: s };
}

function parseEnum(raw, allowed, name, dflt) {
  const v = one(raw);
  if (!present(v)) return { value: dflt };
  const s = String(v).trim().toLowerCase();
  if (!allowed.includes(s)) return bad(`${name} must be one of: ${allowed.join(", ")}`);
  return { value: s };
}

function parseInt0(raw, name, { min, max, dflt }) {
  const v = one(raw);
  if (!present(v)) return { value: dflt };
  const s = String(v).trim();
  if (!/^\d+$/.test(s)) return bad(`${name} must be a whole number`);
  const n = Number(s);
  if (n < min || n > max) return bad(`${name} must be between ${min} and ${max}`);
  return { value: n };
}

// Express has already decoded the :key segment once.
export function parseKey(raw) {
  const v = one(raw);
  if (!present(v)) return bad("shipper key is required");
  const s = String(v);
  if (s.length > MAX_KEY) return bad("shipper key is too long");
  return { value: s };
}

function collect(parts) {
  const out = {};
  for (const [k, r] of Object.entries(parts)) {
    if (r.error) return { error: r.error };
    out[k] = r.value;
  }
  return out;
}

export function parseListQuery(q = {}) {
  return collect({
    q: parseQ(q.q),
    sort: parseEnum(q.sort, LIST_SORTS, "sort", "shipments"),
  });
}

export function parseShipmentsQuery(q = {}) {
  return collect({
    status: parseEnum(q.status, SHIPMENT_STATUSES, "status", "active"),
    q: parseQ(q.q),
    limit: parseInt0(q.limit, "limit", { min: 1, max: 200, dflt: 50 }),
    offset: parseInt0(q.offset, "offset", { min: 0, max: 1_000_000, dflt: 0 }),
  });
}

export function parseTasksQuery(q = {}) {
  return collect({
    status: parseEnum(q.status, TASK_STATUSES, "status", "open"),
    limit: parseInt0(q.limit, "limit", { min: 1, max: 200, dflt: 100 }),
  });
}

export function parseEmailsQuery(q = {}) {
  const r = collect({
    status: parseEnum(q.status, EMAIL_STATUSES, "status", "all"),
    days: parseEnum(q.days, EMAIL_DAYS, "days", "90"),
    limit: parseInt0(q.limit, "limit", { min: 1, max: 200, dflt: 100 }),
  });
  if (r.error) return r;
  return { ...r, days: r.days === "all" ? "all" : Number(r.days) };
}

export function parseTimelineQuery(q = {}) {
  return collect({
    limit: parseInt0(q.limit, "limit", { min: 1, max: 200, dflt: 100 }),
  });
}

export function errStatus(e, fallback = 500) {
  const s = Number(e?.status);
  return Number.isInteger(s) && s >= 400 && s < 600 ? s : fallback;
}

// ---------- router ----------

export function buildShippersRouter(deps = {}) {
  const d = {
    listShippers: fromLib("listShippers"),
    getShipper: fromLib("getShipper"),
    getShipperShipments: fromLib("getShipperShipments"),
    getShipperTasks: fromLib("getShipperTasks"),
    getShipperEmails: fromLib("getShipperEmails"),
    getShipperTimeline: fromLib("getShipperTimeline"),
    ...deps,
  };
  const router = Router();

  // Wrap a handler: 400 on validation errors, err.status (or 500) otherwise.
  const handle = (fn) => async (req, res) => {
    try {
      const out = await fn(req, res);
      if (out && out.error) return res.status(400).json({ error: out.error });
      if (!res.headersSent) res.json(out);
    } catch (e) {
      const status = errStatus(e);
      if (status >= 500) console.error("[shippers]", req.method, req.originalUrl, e?.message || e);
      if (!res.headersSent) res.status(status).json({ error: e?.message || "Shippers request failed" });
    }
  };

  router.get("/", handle(async (req) => {
    const p = parseListQuery(req.query);
    if (p.error) return p;
    const includeEmail = emailAccess(req) !== "none";
    return d.listShippers({ q: p.q, sort: p.sort, includeEmail });
  }));

  router.get("/:key", handle(async (req) => {
    const k = parseKey(req.params.key);
    if (k.error) return k;
    const access = emailAccess(req);
    const out = await d.getShipper(k.value, { includeEmail: access !== "none" });
    return { ...out, email_access: access };
  }));

  router.get("/:key/shipments", handle(async (req) => {
    const k = parseKey(req.params.key);
    if (k.error) return k;
    const p = parseShipmentsQuery(req.query);
    if (p.error) return p;
    return d.getShipperShipments(k.value, { ...p, includeEmail: emailAccess(req) !== "none" });
  }));

  router.get("/:key/tasks", handle(async (req) => {
    const k = parseKey(req.params.key);
    if (k.error) return k;
    const p = parseTasksQuery(req.query);
    if (p.error) return p;
    return d.getShipperTasks(k.value, p);
  }));

  router.get("/:key/emails", handle(async (req, res) => {
    if (emailAccess(req) === "none") {
      res.status(403).json({ error: NO_ACCESS_ERROR, code: "mailbox_no_access" });
      return null;
    }
    const k = parseKey(req.params.key);
    if (k.error) return k;
    const p = parseEmailsQuery(req.query);
    if (p.error) return p;
    return d.getShipperEmails(k.value, p);
  }));

  router.get("/:key/timeline", handle(async (req) => {
    const k = parseKey(req.params.key);
    if (k.error) return k;
    const p = parseTimelineQuery(req.query);
    if (p.error) return p;
    return d.getShipperTimeline(k.value, { limit: p.limit, includeEmail: emailAccess(req) !== "none" });
  }));

  return router;
}

export const shippersRouter = buildShippersRouter();
