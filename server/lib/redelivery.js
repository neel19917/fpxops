// Deterministic redelivery detector. FPX Directory wants LTL deliveries that
// must be re-attempted flagged explicitly, not left to whether the model
// happens to read it out of the carrier's free-text tracking comment.
//
// The only place this signal exists in the scrape is tracking_comments /
// comments ("Attempted Delivery in MODESTO, CA", "Your delivery will be
// rescheduled", "We tried to deliver to the business, but it was closed").
// There is no status value or date column for it, so we regex the text and
// pair it with delivery_date being empty.
//
// Scope is LTL only (product decision 2026-09-18). Parcel exceptions follow
// a different playbook and parcels are already excluded from the task flow
// by ui.tracking.show_parcels.
//
// Refusals are deliberately NOT a redelivery: a refused shipment needs a
// customer disposition decision (accept / return / claim), not another
// delivery attempt. The generic exception rules in the prompt still catch
// them.

export const REDELIVERY_PATTERN = new RegExp(
  [
    "attempted\\s+deliver",          // "Attempted Delivery in HOUSTON, TX"
    "delivery\\s+attempt",           // "Delivery attempt failed"
    "re-?attempt",
    "re-?deliver",
    "resched",                       // "Your delivery will be rescheduled"
    "tried\\s+to\\s+deliver",        // "We tried to deliver to the business, but it was closed"
    "unable\\s+to\\s+deliver",
    "could\\s+not\\s+(be\\s+)?deliver",
    "missed\\s+deliver",
    "(business|consignee|receiver|customer)\\s+(was\\s+|is\\s+)?(closed|not\\s+available|unavailable)",
    "undeliverable",
    "no\\s+one\\s+(was\\s+)?(available|present|home)",
  ].join("|"),
  "i",
);

export function isLtlMode(mode) {
  return String(mode || "").trim().toLowerCase() === "ltl";
}

// Returns:
//   true  — LTL, comments describe a failed/rescheduled delivery, not delivered
//   false — LTL with comments present but no redelivery language, or already delivered
//   null  — not LTL, or no comment text at all (could not evaluate)
// `src` must carry normalized snake_case columns (fpx_shipments row or a
// mapShipment() result).
// Task-title convention for the redelivery pair. Both the carrier task
// ("Carrier followup: Redelivery — ...") and the customer-notify task
// ("Customer followup: Redelivery — notify customer ...") carry the word so
// /tasks search on "Redelivery" finds both and the task builder can tell
// whether a shipment already has redelivery tasks.
export const REDELIVERY_TAG = "Redelivery — ";
// Match the structured tag only, not the word anywhere in the title. Older
// free-text auto-tasks ("...arrange redelivery with the carrier") would
// otherwise count as an existing redelivery task and suppress the pair.
const REDELIVERY_TITLE_RE = /^(carrier|customer) followup:\s*redelivery — /i;
export function isRedeliveryTitle(title) {
  return typeof title === "string" && REDELIVERY_TITLE_RE.test(title);
}

function ts(v) {
  if (v === null || v === undefined || v === "") return null;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : t;
}

function commentText(r) {
  return [r?.tracking_comments, r?.comments]
    .filter((v) => typeof v === "string" && v.trim())
    .join(" / ")
    .trim()
    .toLowerCase();
}

// Did the redelivery fail AGAIN between the prior scrape (`prev`, the
// fpx_shipments row before upsert) and this scrape (`next`, the mapShipment
// result)? Only meaningful when the shipment already has redelivery tasks;
// the caller checks that. A second failed attempt in the same city produces
// the *identical* carrier comment ("Attempted Delivery in MODESTO, CA"), so
// text change alone is not enough — we also treat the shipment coming back
// off "Out For Delivery" without a delivery date, or a new updated ETA,
// while the comment still says "attempted" as a new failure event.
// Re-entering the redelivery state (prev comment was "Out for delivery",
// next is "Attempted" again) counts too.
//
// The carrier's last-modified stamp alone is NOT a failure signal: it is
// date-only and ticks on any edit to the record. On 373410034 (2026-09-21)
// it ticked as the shipment went back OUT for delivery and spawned an
// "(attempt 2)" pair before anything had failed.
function isOutForDelivery(r) {
  return /out\s+for\s+delivery/i.test(String(r?.shipment_status || ""));
}

export function isNewFailureEvent(prev, next) {
  if (!prev || !next) return false;
  if (detectRedelivery(next) !== true) return false;
  if (detectRedelivery(prev) !== true) return true;
  if (commentText(prev) !== commentText(next)) return true;
  if (isOutForDelivery(prev) && !isOutForDelivery(next)) return true;
  const pe = ts(prev.updated_eta);
  const ne = ts(next.updated_eta);
  if (pe !== null && ne !== null && ne !== pe) return true;
  return false;
}

export function detectRedelivery(src) {
  if (!src || !isLtlMode(src.mode)) return null;
  const text = [src.tracking_comments, src.comments]
    .filter((v) => typeof v === "string" && v.trim())
    .join(" / ");
  if (!text) return null;
  const delivered = src.delivery_date !== null && src.delivery_date !== undefined && src.delivery_date !== "";
  if (delivered) return false;
  return REDELIVERY_PATTERN.test(text);
}
