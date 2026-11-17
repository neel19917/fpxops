// Search of the invoicing list (GET /audits/erp/invoicing?q=), made cheap.
//
// The fpx_erp_invoicing view joins every one of ~48k shipments to its latest
// approval; an `ilike` over the view (plus one count per step) scanned and
// joined all of them for each search, and ran past the statement timeout.
// Instead the search first finds the matching shipment ids on the base tables
// (trigram indexes, see migrations/2026-11-17_invoicing_search_indexes.sql),
// then reads only those shipments from the view. These helpers are pure: the
// route runs the queries.

/** At most this many shipments are looked at for one search (biggest charge first). */
export const SEARCH_ID_CAP = 2000;
/** Ids per `in (...)` call, to keep each request URL short. */
export const ID_CHUNK = 200;

export const ERP_BUCKETS = ["exported", "approved_ready", "invoice_not_approved", "no_invoice"];

const ID_COLUMNS = ["shipment_id", "tracking_number", "billing_invoice_number"];
const NAME_COLUMNS = ["customer_name", "carrier"];

/** The search text, made safe to put in a quoted PostgREST filter value: no quotes, backslashes or wildcards. */
export function cleanSearchTerm(q) {
  return String(q ?? "")
    .replace(/["\\%*]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 100);
}

/**
 * What kind of search this is.
 *   "id"    one word with a digit in it: a shipment, tracking or invoice number
 *   "word"  one word without digits: could be a name or an id
 *   "text"  several words: a customer or carrier name
 *   "empty" nothing to search for
 */
export function classifyQuery(q) {
  const term = cleanSearchTerm(q);
  if (!term) return { kind: "empty", term };
  if (/\s/.test(term)) return { kind: "text", term };
  if (/\d/.test(term)) return { kind: "id", term };
  return { kind: "word", term };
}

/**
 * Where to look for a search. Every column is matched with `ilike %term%`
 * (an exact or leading match is a part of that).
 *   tx         columns of fpx_erp_transactions → shipment ids
 *   approvals  columns of fpx_audit_approvals → tracking_key → shipment ids
 */
export function searchPlan(q, { cap = SEARCH_ID_CAP } = {}) {
  const { kind, term } = classifyQuery(q);
  if (kind === "empty") return { kind, term, tx: [], approvals: [], cap };
  if (kind === "id") return { kind, term, tx: [...ID_COLUMNS], approvals: ["invoice_number", "tracking_number"], cap };
  if (kind === "word") return { kind, term, tx: [...NAME_COLUMNS, ...ID_COLUMNS], approvals: ["invoice_number"], cap };
  return { kind, term, tx: [...NAME_COLUMNS], approvals: [], cap };
}

/** A PostgREST `or=(...)` body matching `term` anywhere in any of `columns`. */
export function ilikeAny(columns, term) {
  const like = `"%${cleanSearchTerm(term)}%"`;
  return columns.map((c) => `${c}.ilike.${like}`).join(",");
}

/** Lists of ids joined in order, each once, at most `cap`. truncated: there were more. */
export function mergeIds(lists, cap = SEARCH_ID_CAP) {
  const seen = new Set();
  const ids = [];
  let truncated = false;
  for (const list of lists) {
    for (const raw of list || []) {
      if (raw == null) continue;
      const id = String(raw);
      if (!id || seen.has(id)) continue;
      if (ids.length >= cap) { truncated = true; continue; }
      seen.add(id);
      ids.push(id);
    }
  }
  return { ids, truncated };
}

/** `values` in pieces of `size`. */
export function chunk(values, size = ID_CHUNK) {
  const out = [];
  for (let i = 0; i < values.length; i += size) out.push(values.slice(i, i + size));
  return out;
}

/** Biggest charge first (no charge last), then shipment id: the list's order. */
export function compareRows(a, b) {
  const num = (v) => {
    if (v == null || v === "") return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  const ca = num(a.charge);
  const cb = num(b.charge);
  if (ca !== cb) {
    if (ca == null) return 1;
    if (cb == null) return -1;
    return cb - ca;
  }
  const sa = String(a.shipment_id ?? "");
  const sb = String(b.shipment_id ?? "");
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}

/**
 * From the slim view rows of the matched shipments ({ shipment_id, bucket,
 * approved_by_kind, charge }): the count in each step (with `kind` applied, not
 * `bucket`), and the ids of the requested page in list order.
 */
export function pageOfMatches(rows, { kind = "", bucket = "", limit = 200, offset = 0 } = {}) {
  const kept = (rows || []).filter((r) => !kind || r.approved_by_kind === kind);
  const counts = Object.fromEntries(ERP_BUCKETS.map((b) => [b, 0]));
  for (const r of kept) if (Object.hasOwn(counts, r.bucket)) counts[r.bucket] += 1;
  const inStep = (bucket ? kept.filter((r) => r.bucket === bucket) : kept).slice().sort(compareRows);
  return { counts, pageIds: inStep.slice(offset, offset + limit).map((r) => String(r.shipment_id)) };
}

/** True when a database error is a statement timeout (or a cancel for one). */
export function isTimeoutError(e) {
  const msg = String(e?.message ?? e ?? "");
  return e?.code === "57014" || /statement timeout|canceling statement/i.test(msg);
}

export const SEARCH_TIMEOUT_MESSAGE = "Search took too long. Try a shipment, invoice or tracking number.";
