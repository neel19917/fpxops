// How old each source FPX read for a shipment is, and whether that is too old
// to trust. Computed in code so the assistant never guesses an age.
//
//   tracking          fpx_shipments.scraped_at                       stale after 6 h
//   erp_transactions  fpx_erp_transactions.last_seen_at              stale after 36 h
//   audit_approvals   fpx_audit_approvals.last_seen_at (newest)      stale after 36 h
//   shipment_details  fpx_shipment_details.captured_at               stale after 72 h
//   documents         fpx_invoice_documents.extracted_at (newest)    no threshold

export const STALE_HOURS = {
  tracking: 6,
  erp_transactions: 36,
  audit_approvals: 36,
  shipment_details: 72,
  documents: null,
};

// Where to go to refresh each source in the dashboard (a navigate page).
export const REFRESH_PAGE = {
  tracking: "scraping",
  erp_transactions: "invoices",
  audit_approvals: "invoices",
  shipment_details: "scraping",
  documents: "invoice_reading",
};

const LABEL = {
  tracking: "Tracking",
  erp_transactions: "ERP data",
  audit_approvals: "Invoice approvals",
  shipment_details: "Shipment details",
  documents: "Invoice documents",
};

/** Plain words for an age in hours: "40 minutes", "5 hours", "3 days". */
export function ageWords(hours) {
  if (hours == null || !Number.isFinite(hours)) return null;
  if (hours < 1) return `${Math.max(1, Math.round(hours * 60))} minutes`;
  if (hours < 48) { const h = Math.round(hours); return `${h} hour${h === 1 ? "" : "s"}`; }
  const d = Math.round(hours / 24);
  return `${d} day${d === 1 ? "" : "s"}`;
}

/** One source: { read_at, age_hours, stale, stale_after_hours, note }. */
export function sourceFreshness(source, readAt, now = Date.now()) {
  const threshold = Object.prototype.hasOwnProperty.call(STALE_HOURS, source) ? STALE_HOURS[source] : null;
  const t = readAt ? Date.parse(readAt) : NaN;
  if (!Number.isFinite(t)) {
    return { source, label: LABEL[source] || source, read_at: null, age_hours: null, stale: false, stale_after_hours: threshold, note: "never read" };
  }
  const age = Math.max(0, (now - t) / 3_600_000);
  const stale = threshold != null && age > threshold;
  return {
    source,
    label: LABEL[source] || source,
    read_at: new Date(t).toISOString(),
    age_hours: Math.round(age * 10) / 10,
    stale,
    stale_after_hours: threshold,
    refresh_page: REFRESH_PAGE[source] || null,
    note: `${LABEL[source] || source} last read ${ageWords(age)} ago${stale ? " — may be out of date" : ""}`,
  };
}

/**
 * All sources for one shipment. readTimes: { tracking, erp_transactions, ... }
 * (ISO strings or null). Returns { sources: {...}, any_stale, stale: [...],
 * oldest_stale_hours, summary }.
 */
export function freshness(readTimes = {}, now = Date.now()) {
  const sources = {};
  for (const key of Object.keys(STALE_HOURS)) {
    if (key in readTimes) sources[key] = sourceFreshness(key, readTimes[key], now);
  }
  const stale = Object.values(sources).filter((s) => s.stale);
  const oldest = stale.reduce((m, s) => Math.max(m, s.age_hours || 0), 0);
  return {
    sources,
    any_stale: stale.length > 0,
    stale: stale.map((s) => s.source),
    oldest_stale_hours: stale.length ? oldest : null,
    summary: stale.length
      ? stale.map((s) => s.note).join("; ")
      : "Every source was read recently enough.",
  };
}
