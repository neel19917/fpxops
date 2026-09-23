// Storage-charge risk on LTL delivery holds.
//
// Ask from Allen + Victor (2026-09-23): XPO bills storage when freight sits
// at the destination terminal more than ~48h waiting for a delivery
// appointment. Freight lands Friday, appointment is Monday → storage. They
// want the agent to flag it early so the customer can either pull the
// appointment in or knowingly accept the charge.
//
// The grid has no "arrived at destination" column (actual_arrival is 0%
// populated), but the extension already captures the carrier's full event
// history as one flattened string in raw_data.Details:
//
//   "Carrier Status Code Status Status Comment Status Date City State
//    Longitude Latitude Unloaded from trailerUnloaded from trailer09/21/2026
//    07:09:00North AugustaSCHeld for appointment from NAGHeld for
//    appointment from NAG09/21/2026 07:09:00North AugustaSC…"
//
// Each event is <status><status comment><MM/DD/YYYY HH:MM:SS><City><ST>
// with no delimiters, so we anchor on the timestamps: the text between two
// timestamps is the previous event's city/state plus the next event's
// status text. That is good enough to regex for "arrived at destination".
//
// Pure functions only; no supabase.

import { isLtlMode } from "./redelivery.js";

export const STORAGE_TAG = "Storage risk — ";
const STORAGE_TITLE_RE = /^(carrier|customer) followup:\s*storage risk — /i;
export function isStorageRiskTitle(title) {
  return typeof title === "string" && STORAGE_TITLE_RE.test(title);
}

// Carrier phrases that mean "the freight is at the delivering terminal and
// is waiting". Kept to phrases seen in production Details strings; "en route
// to destination" deliberately does not match ("at destination" ≠ "to
// destination").
export const DESTINATION_PATTERN = new RegExp(
  [
    "arrived\\s+at\\s+destination",             // SAIA / SEFL "Arrived at Destination Terminal"
    "arrived\\s+at\\s+(the\\s+)?deliver(y|ing)", // "Arrived at delivering facility."
    "\\bat\\s+destination\\b",                   // XPO "At destination"
    "appointment\\s+required\\s+at\\s+destination",
    "held\\s+for\\s+appointment",                // XPO "Held for appointment from NAG"
    "held\\s+on\\s+trap\\s+trailer",             // XPO consolidated-delivery hold
    "closed\\s+for\\s+delivery",                 // XPO: on the delivery dock, day closed
    // NOT "staged to dock location" / "unloaded from trailer": XPO logs
    // those at origin and interim terminals too (seen on "At origin" rows
    // during the 2026-09-23 preview).
    "available\\s+for\\s+delivery",
    "at\\s+delivery\\s+terminal",
    "destination\\s+arrival",
  ].join("|"),
  "i",
);

const EVENT_TS_RE = /(\d{2})\/(\d{2})\/(\d{4}) (\d{2}):(\d{2}):(\d{2})/g;

// Flattened Details string → [{ text, at, atIso }] oldest first. Timestamps
// are the carrier's local wall clock; we read them as UTC, which is the same
// convention the rest of the row uses (appointment_date "05:00+00" is really
// a local 5am), so hour math between them stays consistent.
export function parseCarrierEvents(details) {
  return parseCarrierEventsWithTail(details).events;
}

// Same, plus the text after the last timestamp. The extension has been
// storing Details truncated to ~300 chars with a trailing "…", so the
// oldest captured event is usually cut off before its timestamp — and for
// a shipment that has been sitting for days, that cut-off event is often
// the arrival we are looking for. The tail lets the caller bound it.
export function parseCarrierEventsWithTail(details) {
  if (typeof details !== "string" || !details.trim()) return { events: [], tail: "" };
  const out = [];
  let prevEnd = 0;
  for (const m of details.matchAll(EVENT_TS_RE)) {
    const [, mm, dd, yyyy, HH, MM, SS] = m;
    const at = Date.UTC(Number(yyyy), Number(mm) - 1, Number(dd), Number(HH), Number(MM), Number(SS));
    if (!Number.isFinite(at)) continue;
    const text = details.slice(prevEnd, m.index).trim();
    out.push({ text, at, atIso: new Date(at).toISOString() });
    prevEnd = m.index + m[0].length;
  }
  // Strip the previous event's trailing "CityST" is not possible without
  // delimiters; the tail is only ever regex-matched, so that's fine.
  const tail = details.slice(prevEnd).replace(/…$/, "").trim();
  out.sort((a, b) => a.at - b.at);
  return { events: out, tail };
}

function ts(v) {
  if (v === null || v === undefined || v === "") return null;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : t;
}

function detailsOf(src) {
  const raw = src?.raw_data;
  if (raw && typeof raw === "object" && typeof raw.Details === "string") return raw.Details;
  return null;
}

// When did the freight reach the delivering terminal?
//   source "events"           — earliest matching event in raw_data.Details (precise)
//   source "events_truncated" — the destination phrase is in the cut-off tail
//                               of Details (older than every timestamped
//                               event), so arrival is AT OR BEFORE the oldest
//                               timestamp we have; we use that bound. Hold
//                               hours are therefore a floor, not exact.
//   source "comment"          — tracking_comments matches, no usable history;
//                               fall back to last_modified_at (date-only, ±1 day)
//   null                      — no evidence it is at destination
export function detectDestinationArrival(src) {
  const { events, tail } = parseCarrierEventsWithTail(detailsOf(src));
  const hit = events.find((e) => DESTINATION_PATTERN.test(e.text));
  if (hit) return { at: hit.atIso, source: "events" };
  if (events.length && tail && DESTINATION_PATTERN.test(tail)) {
    return { at: events[0].atIso, source: "events_truncated" };
  }
  const comment = [src?.tracking_comments, src?.comments].filter((v) => typeof v === "string").join(" / ");
  if (DESTINATION_PATTERN.test(comment)) {
    const lm = ts(src?.last_modified_at);
    if (lm !== null) return { at: new Date(lm).toISOString(), source: "comment" };
  }
  return null;
}

// "XPO, xpo ltl, saia" → ["xpo", "saia"]; arrays pass through lowercased.
export function parseCarrierList(v) {
  const arr = Array.isArray(v) ? v : String(v || "").split(/[,;\n]/);
  return arr.map((s) => String(s || "").trim().toLowerCase()).filter(Boolean);
}

function carrierMatches(src, carriers) {
  const name = `${src?.carrier_name || ""} ${src?.carrier || ""}`.toLowerCase();
  return carriers.some((c) => name.includes(c));
}

// Returns a flat set of facts for the prompt + task builder:
//   storage_risk            true | false | null (null = could not evaluate: not LTL, or not at destination)
//   storage_carrier_policy  true when the carrier is on the storage list (default: XPO)
//   at_destination_since    ISO or null
//   hold_hours_so_far       hours from arrival to as_of
//   hold_hours_at_appointment  hours from arrival to appointment_date (null without an appointment)
//   storage_hold_limit_hours   the configured threshold
//
// Risk is true when the carrier charges storage AND either the booked
// appointment is more than the limit after arrival, or there is no
// appointment yet and the freight has already sat for half the limit (the
// customer still has time to book something sooner).
export function detectStorageRisk(src, { asOfMs = Date.now(), holdHours = 48, carriers = ["xpo"] } = {}) {
  const limit = Number.isFinite(Number(holdHours)) && Number(holdHours) > 0 ? Number(holdHours) : 48;
  const list = parseCarrierList(carriers);
  const base = {
    storage_risk: null,
    storage_carrier_policy: carrierMatches(src, list),
    at_destination_since: null,
    hold_hours_so_far: null,
    hold_hours_at_appointment: null,
    storage_hold_limit_hours: limit,
  };
  if (!src || !isLtlMode(src.mode)) return base;
  if (ts(src.delivery_date) !== null) return { ...base, storage_risk: false };

  const arrival = detectDestinationArrival(src);
  if (!arrival) return base;
  const arrivedMs = Date.parse(arrival.at);
  const HOUR = 3_600_000;
  const soFar = Math.max(0, Math.round(((asOfMs - arrivedMs) / HOUR) * 10) / 10);
  const appt = ts(src.appointment_date);
  const atAppt = appt === null ? null : Math.round(((appt - arrivedMs) / HOUR) * 10) / 10;

  let risk = false;
  if (base.storage_carrier_policy) {
    if (atAppt !== null) risk = atAppt > limit;
    else risk = soFar >= limit / 2;
  }
  return {
    ...base,
    storage_risk: risk,
    at_destination_since: arrival.at,
    at_destination_source: arrival.source,
    hold_hours_so_far: soFar,
    hold_hours_at_appointment: atAppt,
  };
}
