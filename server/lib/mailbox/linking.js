// Links Support Mailbox threads to FPX shipments and classifies who each
// thread is with (customer | carrier | internal | other).
//
// - Shipment numbers come from the subject + body preview of every message in
//   the thread, plus the stored body_html (as text) of the newest inbound
//   message when it has been cached. Bodies are never fetched from Graph here.
// - Candidates are matched EXACTLY against fpx_shipments (shipment_id,
//   tracking_number, order_number, reference_one..six, pickup_request_number,
//   confirmation_number) with batched in() lists.
// - Links are inserted with "on conflict do nothing", so a link a person
//   dismissed is never re-created. Nothing is ever deleted.
// - Party: sender-domain rules first (fpx_mailbox_domains, person > ai > rule),
//   then internal-only / automated senders, then "the sender looks like the
//   linked shipment's customer / carrier". What is left goes to Claude, ~20
//   threads per call (subject, sender, 300-char preview only). A thread whose
//   party a person set (party_source 'person') is never reclassified.
// - Resumable: fpx_mailbox_thread_meta.last_message_at remembers the thread's
//   last message when it was processed; a thread is processed again only when
//   the view shows a newer one.
import { supabase as realSupabase, isDbReady } from "../supabase.js";
import { callClaude as realCallClaude } from "../anthropic.js";
import { getSettings as realGetSettings } from "../settings.js";
import { emailModelExtras } from "../emailDraft.js";
import { htmlToText } from "./drafts.js";

// Swappable for tests.
export const _deps = {
  supabase: realSupabase,
  callClaude: realCallClaude,
  getSettings: realGetSettings,
};

export const PARTIES = ["customer", "carrier", "internal", "other"];
export const DEFAULT_MAILBOX = "freightsupport@freightpop.com";
export const INTERNAL_DOMAINS = ["freightpop.com"];
export const AI_BATCH = 20;
export const PREVIEW_CHARS = 300;
const VIEW_PAGE = 500;
const MAX_SCAN = 3000;
const CONV_CHUNK = 40;    // conversation ids are long; keep in() URLs short
const VALUE_CHUNK = 40;   // values x 11 columns per or() query
const ID_CHUNK = 200;
const BODY_CHUNK = 25;
const MAX_TEXT_CHARS = 20_000;
const MAX_CANDIDATES = 60;
const MAX_SHIPMENTS_PER_VALUE = 5; // a value shared by more shipments is too vague to link on

const isTestRun = () => Boolean(process.env.NODE_TEST_CONTEXT) || process.env.NODE_ENV === "test"
  || process.execArgv.some((a) => a.startsWith("--test"));
export const mailboxLinkerEnabled = () => isDbReady() && !isTestRun();

const warned = new Map();
function warnOnce(key, message) {
  const now = Date.now();
  if (now - (warned.get(key) || 0) < 10 * 60_000) return;
  warned.set(key, now);
  console.warn(`[FPX] mailbox linker: ${message}`);
}

const chunk = (arr, n) => { const out = []; for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out; };
const threadKey = (connectionId, conversationId) => `${connectionId}\u0000${conversationId}`;
const toMs = (v) => { const t = v ? Date.parse(v) : NaN; return Number.isFinite(t) ? t : null; };

// ---------------------------------------------------------------------------
// Candidate extraction

const KIND_BY_KEYWORD = [
  [/^ship/i, "shipment_id"],
  [/^(pro|track|trk)/i, "tracking"],
  [/^(bol|b\/l|bill)/i, "bol"],
  [/^(p\.?o|purchase)/i, "po"],
  [/^load/i, "load"],
  [/^ref/i, "reference"],
  [/^(pick|pu)/i, "pickup"],
  [/^conf/i, "confirmation"],
];

// keyword, optional "#"/"no"/"number"/"id", optional separator, then a token
// that must contain digits.
const KEYWORD_RE = /(?<![A-Za-z])(ship(?:ment)?|pro|tracking|track|trk|bol|b\/l|bill\s+of\s+lading|p\.?\s?o\.?|purchase\s+order|load|ref(?:erence)?|pick\s*-?\s*up|pu|conf(?:irmation)?)\s*(?:#|no\.?|num(?:ber)?|ids?)?\s*[:#.\-]?\s*#?\s*([A-Za-z0-9][A-Za-z0-9\-]{2,24})/gi;
const BARE_RE = /(?<![A-Za-z0-9.\/$\-])(\d{6,12})(?![A-Za-z0-9]|[.,]\d|-\d)/g;

// Text removed before scanning: things that look like numbers but are not
// shipment references.
const SCRUB = [
  /https?:\/\/\S+/gi,
  /\bwww\.\S+/gi,
  /[^\s<>()"']+@[^\s<>()"']+/g,                                         // email addresses
  /\b(?:support\s+)?(?:ticket|case|incident)\s*(?:#|no\.?|number)?\s*:?\s*\d+/gi,
  /\b(?:company|customer|client|account|acct|user|employee|tax|ein)\s*(?:id|#|no\.?|number)\s*:?\s*\d+/gi,
  /\b(?:phone|tel|telephone|cell|mobile|fax|ph|direct|office|main|call)\b\.?\s*(?:#|no\.?)?\s*:?\s*\+?[\d\s().-]{7,}\d/gi,
  /(?:\+?1[\s.-]?)?\(\d{3}\)\s*\d{3}[\s.-]\d{4}\b/g,                       // (555) 123-4567
  /(?<![\dA-Za-z])(?:\+?1[\s.-])?\d{3}[.-]\d{3}[.-]\d{4}(?!\d)/g,        // 555-123-4567, 555.123.4567
  /\$\s?[\d,]+(?:\.\d+)?/g,                                             // money
  /\b\d[\d,]*\.\d{2}\b/g,
  /\b[\d,]+(?:\.\d+)?\s?(?:usd|cad|dollars)\b/gi,
  /\b\d{1,4}[\/.-]\d{1,2}[\/.-]\d{1,4}\b/g,                              // dates
  /\b\d{1,2}:\d{2}(?::\d{2})?\b/g,                                      // times
];

function looksLikeDate8(v) {
  if (!/^\d{8}$/.test(v)) return false;
  const y = +v.slice(0, 4), m = +v.slice(4, 6), d = +v.slice(6, 8);
  return y >= 2000 && y <= 2039 && m >= 1 && m <= 12 && d >= 1 && d <= 31;
}

export function normalizeValue(v) {
  return String(v || "").replace(/\s+/g, "").replace(/^#+/, "").replace(/[-.]+$/, "").replace(/^[-.]+/, "");
}

function kindFor(keyword) {
  for (const [re, kind] of KIND_BY_KEYWORD) if (re.test(keyword)) return kind;
  return "number";
}

// text -> [{ kind, value }] (unique by value; a keyword kind beats "number").
export function extractCandidates(text) {
  let s = String(text || "");
  if (!s) return [];
  if (s.length > MAX_TEXT_CHARS) s = s.slice(0, MAX_TEXT_CHARS);
  for (const re of SCRUB) s = s.replace(re, " ");
  const out = new Map();
  const add = (kind, raw) => {
    const value = normalizeValue(raw);
    if (value.length < 4 || value.length > 25) return;
    const digits = (value.match(/\d/g) || []).length;
    if (digits < 4) return;
    if (/^\d+$/.test(value) && (value.length === 5 || looksLikeDate8(value))) return; // zip-like / yyyymmdd
    if (/^0+$/.test(value)) return;
    const prev = out.get(value);
    if (!prev || (prev.kind === "number" && kind !== "number")) out.set(value, { kind, value });
  };
  for (const m of s.matchAll(KEYWORD_RE)) add(kindFor(m[1]), m[2]);
  for (const m of s.matchAll(BARE_RE)) add("number", m[1]);
  return [...out.values()].slice(0, MAX_CANDIDATES);
}

// ---------------------------------------------------------------------------
// Shipment matching

export const MATCH_COLUMNS = [
  ["shipment_id", "shipment_id"],
  ["tracking_number", "tracking_number"],
  ["order_number", "order_number"],
  ["pickup_request_number", "pickup_number"],
  ["confirmation_number", "confirmation_number"],
  ["reference_one", "reference"],
  ["reference_two", "reference"],
  ["reference_three", "reference"],
  ["reference_four", "reference"],
  ["reference_five", "reference"],
  ["reference_six", "reference"],
];
const MATCH_RANK = { shipment_id: 0, tracking_number: 1, order_number: 2, pickup_number: 3, confirmation_number: 4, reference: 5, manual: 6 };
const SHIPMENT_SELECT = ["shipment_id", "customer_name", "company_name", "carrier", "carrier_name", ...MATCH_COLUMNS.map(([c]) => c).filter((c) => c !== "shipment_id")].join(", ");

// Postgrest or() value list; values are [A-Za-z0-9-] after extraction but
// quote anyway.
const pgList = (vals) => vals.map((v) => `"${String(v).replace(/["\\]/g, "")}"`).join(",");

// values -> Map(value -> [{ shipment_id, matched_on, customer_name, company_name, carrier_name }])
export async function lookupValues(values) {
  const db = _deps.supabase;
  const uniq = [...new Set((values || []).map(normalizeValue).filter(Boolean))];
  const byValue = new Map();
  for (const part of chunk(uniq, VALUE_CHUNK)) {
    const set = new Set(part);
    const filter = MATCH_COLUMNS.map(([c]) => `${c}.in.(${pgList(part)})`).join(",");
    const { data, error } = await db.from("fpx_shipments").select(SHIPMENT_SELECT).or(filter).limit(1000);
    if (error) throw new Error(`shipments not read: ${error.message}`);
    for (const row of data || []) {
      if (!row?.shipment_id) continue;
      const sid = String(row.shipment_id);
      for (const [col, matchedOn] of MATCH_COLUMNS) {
        const v = row[col] == null ? "" : String(row[col]).trim();
        if (!v || !set.has(v)) continue;
        const list = byValue.get(v) || [];
        if (!list.some((x) => x.shipment_id === sid && x.matched_on === matchedOn)) {
          list.push({
            shipment_id: sid, matched_on: matchedOn,
            customer_name: row.customer_name || null, company_name: row.company_name || null,
            carrier_name: row.carrier_name || row.carrier || null,
          });
        }
        byValue.set(v, list);
      }
    }
  }
  // Too many shipments share this value (a generic reference): unless it is a
  // shipment id itself, don't link on it.
  for (const [v, list] of byValue) {
    const ships = new Set(list.map((x) => x.shipment_id));
    if (ships.size > MAX_SHIPMENTS_PER_VALUE) {
      const exact = list.filter((x) => x.matched_on === "shipment_id");
      if (exact.length) byValue.set(v, exact); else byValue.delete(v);
    }
  }
  return byValue;
}

// One entry per shipment, the best match kind first (shipment id > tracking > ...).
export function bestMatches(candidates, byValue) {
  const best = new Map();
  for (const c of candidates || []) {
    const value = normalizeValue(c?.value ?? c);
    for (const hit of byValue.get(value) || []) {
      const prev = best.get(hit.shipment_id);
      if (!prev || MATCH_RANK[hit.matched_on] < MATCH_RANK[prev.matched_on]) {
        best.set(hit.shipment_id, { ...hit, matched_text: value });
      }
    }
  }
  return [...best.values()];
}

// candidates -> [{ shipment_id, matched_on, matched_text }]
export async function matchShipments(candidates) {
  const byValue = await lookupValues((candidates || []).map((c) => c?.value ?? c));
  return bestMatches(candidates, byValue).map(({ shipment_id, matched_on, matched_text }) => ({ shipment_id, matched_on, matched_text }));
}

// ---------------------------------------------------------------------------
// Party classification (rules)

const SOURCE_RANK = { person: 3, ai: 2, rule: 1 };
export const FREEMAIL = new Set([
  "gmail.com", "googlemail.com", "yahoo.com", "ymail.com", "hotmail.com", "outlook.com", "live.com", "msn.com",
  "aol.com", "icloud.com", "me.com", "mac.com", "comcast.net", "att.net", "sbcglobal.net", "verizon.net",
  "proton.me", "protonmail.com", "gmx.com", "mail.com", "zoho.com", "bellsouth.net", "cox.net", "charter.net",
]);
const AUTOMATED_LOCAL = /^(no[-_.]?reply|do[-_.]?not[-_.]?reply|donotreply|notifications?|notify|alerts?|mailer[-_.]?daemon|postmaster|bounces?|newsletters?|news|marketing|automated|system|auto[-_.]?confirm|digest|updates?)([-_.+].*)?$/i;
const NAME_STOP = new Set(["inc", "llc", "ltd", "co", "corp", "corporation", "company", "the", "group", "holdings", "usa", "us", "lp", "llp", "plc", "and", "of"]);
const NAME_GENERIC = new Set([
  "freight", "logistics", "transport", "transportation", "express", "trucking", "lines", "supply", "services", "service",
  "solutions", "systems", "industries", "international", "products", "manufacturing", "distribution", "global",
  "america", "american", "national", "north", "south", "east", "west", "enterprises", "carriers", "carrier", "shipping",
]);

export const emailDomain = (addr) => {
  const s = String(addr || "").trim().toLowerCase();
  const at = s.lastIndexOf("@");
  return at > 0 ? s.slice(at + 1).replace(/[>\s]+$/, "") : null;
};
const localPart = (addr) => { const s = String(addr || "").trim().toLowerCase(); const at = s.lastIndexOf("@"); return at > 0 ? s.slice(0, at) : s; };

// "mail.xpo.com" -> ["mail.xpo.com", "xpo.com"]
export function domainLookupKeys(domain) {
  const labels = String(domain || "").toLowerCase().split(".").filter(Boolean);
  const out = [];
  for (let i = 0; i <= labels.length - 2; i++) out.push(labels.slice(i).join("."));
  return out;
}

// "acme-widgets.co.uk" -> "acmewidgets"
export function domainRoot(domain) {
  const labels = String(domain || "").toLowerCase().split(".").filter(Boolean);
  if (labels.length < 2) return labels[0] || "";
  let i = labels.length - 2;
  if (labels.length >= 3 && /^(co|com|net|org|gov|ac)$/.test(labels[i]) && labels[labels.length - 1].length === 2) i -= 1;
  return labels[i].replace(/[^a-z0-9]/g, "");
}

function nameTokens(name) {
  return String(name || "").toLowerCase().replace(/&/g, " ").split(/[^a-z0-9]+/).filter((t) => t && !NAME_STOP.has(t));
}

// Does a company name look like this sender domain root / display name?
export function resembles(name, { root = "", displayName = "" } = {}) {
  const tokens = nameTokens(name);
  if (!tokens.length || tokens.every((t) => NAME_GENERIC.has(t))) return false;
  const compact = tokens.join("");
  if (root && root.length >= 4 && compact.length >= 4 && (root.includes(compact) || compact.includes(root))) return true;
  if (root && tokens.some((t) => t.length >= 5 && !NAME_GENERIC.has(t) && root.includes(t))) return true;
  const disp = nameTokens(displayName).join("");
  if (disp && compact.length >= 5 && disp.includes(compact)) return true;
  return false;
}

function recipientsOf(list) {
  if (!Array.isArray(list)) return [];
  return list.map((r) => {
    const ea = r?.emailAddress || r || {};
    return { address: ea.address || null, name: ea.name || null };
  }).filter((r) => r.address);
}

function toDomainMap(domains) {
  if (domains instanceof Map) return domains;
  const m = new Map();
  if (Array.isArray(domains)) for (const d of domains) { if (d?.domain) m.set(String(d.domain).toLowerCase(), d); }
  else if (domains && typeof domains === "object") for (const [k, v] of Object.entries(domains)) m.set(k.toLowerCase(), v);
  return m;
}
function domainEntry(map, domain) {
  for (const key of domainLookupKeys(domain)) {
    const v = map.get(key);
    if (v) return typeof v === "string" ? { domain: key, party: v, source: "rule" } : { domain: key, source: "rule", ...v };
  }
  return null;
}

// The people on the other side of a thread: inbound senders; for a thread
// with nothing inbound, the recipients of the outbound messages.
export function threadParties(messages = [], mailbox = DEFAULT_MAILBOX) {
  const mb = String(mailbox || "").toLowerCase();
  const seen = new Map();
  const add = (address, name) => {
    const a = String(address || "").trim().toLowerCase();
    if (!a || a === mb || !a.includes("@")) return;
    const prev = seen.get(a);
    if (prev) { prev.count += 1; return; }
    seen.set(a, { address: a, name: name || null, domain: emailDomain(a), count: 1 });
  };
  const inbound = messages.filter((m) => m?.direction === "in");
  if (inbound.length) for (const m of inbound) add(m.from_address, m.from_name);
  else for (const m of messages) for (const r of [...recipientsOf(m?.to_recipients), ...recipientsOf(m?.cc_recipients)]) add(r.address, r.name);
  return [...seen.values()];
}

// classifyParty(messages, links, { domains, shipments, mailbox })
//   links: [{ shipment_id, dismissed?, customer_name?, company_name?, carrier_name? }]
//   domains: Map|object|array of domain -> { party, source }
//   shipments: Map|array of { shipment_id, customer_name, company_name, carrier_name }
// -> { party, source, reason, domain? }  (party 'unknown', source null = ask the AI)
export function classifyParty(messages = [], links = [], { domains, shipments, mailbox = DEFAULT_MAILBOX } = {}) {
  const dmap = toDomainMap(domains);
  const parties = threadParties(messages, mailbox);
  if (!parties.length) return { party: "unknown", source: null, reason: "No sender on the thread" };

  const mbDomain = emailDomain(mailbox);
  const isInternal = (d) => !d || d === mbDomain || INTERNAL_DOMAINS.some((x) => d === x || d.endsWith(`.${x}`))
    || domainEntry(dmap, d)?.party === "internal";
  const external = parties.filter((p) => !isInternal(p.domain));
  if (!external.length) return { party: "internal", source: "rule", reason: "Only FreightPOP people on the thread" };

  // Known sender domains: the strongest source wins, then the most messages.
  let best = null;
  for (const p of external) {
    const e = domainEntry(dmap, p.domain);
    if (!e || !PARTIES.includes(e.party)) continue;
    const rank = SOURCE_RANK[e.source] || 1;
    if (!best || rank > best.rank || (rank === best.rank && p.count > best.count)) best = { ...e, rank, count: p.count };
  }
  if (best) {
    const by = best.source === "person" ? "set by a person" : best.source === "ai" ? "learned earlier" : "known domain";
    return { party: best.party, source: best.source === "ai" ? "ai" : "rule", reason: `Sender domain ${best.domain} is ${best.party} (${by})`, domain: best.domain };
  }

  if (external.every((p) => AUTOMATED_LOCAL.test(localPart(p.address)))) {
    return { party: "other", source: "rule", reason: `Automated sender (${external[0].address})` };
  }

  // Unknown domain: does the sender look like a linked shipment's customer or carrier?
  const smap = shipments instanceof Map ? shipments
    : new Map((Array.isArray(shipments) ? shipments : []).filter((s) => s?.shipment_id).map((s) => [String(s.shipment_id), s]));
  const linked = (links || []).filter((l) => l && !l.dismissed && l.shipment_id)
    .map((l) => ({ ...(smap.get(String(l.shipment_id)) || {}), ...l }));
  for (const p of external) {
    const root = p.domain && !FREEMAIL.has(p.domain) ? domainRoot(p.domain) : "";
    for (const s of linked) {
      for (const name of [s.customer_name, s.company_name]) {
        if (name && resembles(name, { root, displayName: p.name })) {
          return { party: "customer", source: "rule", reason: `Sender ${p.domain} matches shipment ${s.shipment_id} customer ${name}` };
        }
      }
      if (s.carrier_name && resembles(s.carrier_name, { root, displayName: p.name })) {
        return { party: "carrier", source: "rule", reason: `Sender ${p.domain} matches shipment ${s.shipment_id} carrier ${s.carrier_name}` };
      }
    }
  }
  return { party: "unknown", source: null, reason: null };
}

// ---------------------------------------------------------------------------
// Party classification (AI)

// items: [{ subject, from_name, from_address, preview, linked_count }]
export function buildPartyPrompt(items) {
  const blocks = items.map((t, idx) => [
    `[${idx + 1}]`,
    `From: ${t.from_name ? `${t.from_name} <${t.from_address || ""}>` : (t.from_address || "(unknown)")}`,
    `Subject: ${String(t.subject || "(no subject)").slice(0, 200)}`,
    `Preview: ${String(t.preview || "").replace(/\s+/g, " ").trim().slice(0, PREVIEW_CHARS) || "(empty)"}`,
    t.linked_count ? `Linked FPX shipments: ${t.linked_count}` : null,
  ].filter(Boolean).join("\n"));
  return `Classify these ${items.length} email threads from the FreightPOP support inbox.\n\n${blocks.join("\n\n")}\n\nReturn the JSON array now.`;
}

// Model text -> Map(index 1..n -> { party, reason })
export function parsePartyResponse(text, n) {
  const out = new Map();
  let s = String(text || "").trim().replace(/^```[a-z]*\s*/i, "").replace(/```\s*$/, "");
  const start = s.indexOf("["), end = s.lastIndexOf("]");
  if (start < 0 || end <= start) return out;
  let arr;
  try { arr = JSON.parse(s.slice(start, end + 1)); } catch { return out; }
  if (!Array.isArray(arr)) return out;
  arr.forEach((o, idx) => {
    const i = Number.isInteger(o?.i) ? o.i : Number.parseInt(o?.i, 10) || idx + 1;
    const party = String(o?.party || "").toLowerCase().trim();
    if (i < 1 || i > n || !PARTIES.includes(party)) return;
    out.set(i, { party, reason: String(o?.reason || "").replace(/\s+/g, " ").trim().slice(0, 200) || null });
  });
  return out;
}

// items -> Map(index 0..n-1 -> { party, reason }); never throws.
export async function classifyWithAi(items) {
  const results = new Map();
  if (!items?.length) return { results, errors: [] };
  const settings = await _deps.getSettings("prompt.mailbox_party.system", "prompt.mailbox_party.model");
  const systemPrompt = String(settings["prompt.mailbox_party.system"] || "");
  const model = settings["prompt.mailbox_party.model"] || "claude-haiku-4-5";
  const extras = emailModelExtras(model);
  const errors = [];
  for (let off = 0; off < items.length; off += AI_BATCH) {
    const batch = items.slice(off, off + AI_BATCH);
    try {
      const r = await _deps.callClaude({
        systemPrompt,
        userMessage: buildPartyPrompt(batch),
        maxTokens: extras ? 4000 : 1500,
        modelOverride: model,
        extraBody: extras,
        metadata: { kind: "other", metadata: { subkind: "mailbox_party", threads: batch.length } },
      });
      if (r?.error) { errors.push(r.error); continue; }
      const parsed = parsePartyResponse(r?.text, batch.length);
      for (const [i, v] of parsed) results.set(off + i - 1, v);
    } catch (e) {
      errors.push(e?.message || String(e));
    }
  }
  return { results, errors };
}

// ---------------------------------------------------------------------------
// DB helpers

async function loadMailboxes() {
  const { data, error } = await _deps.supabase.from("fpx_mailbox_connections").select("id, mailbox");
  if (error) throw new Error(`connections not read: ${error.message}`);
  return new Map((data || []).map((c) => [c.id, c.mailbox]));
}

function groupByConnection(threads) {
  const m = new Map();
  for (const t of threads) {
    if (!m.has(t.connection_id)) m.set(t.connection_id, []);
    m.get(t.connection_id).push(t);
  }
  return m;
}

const META_SELECT = "connection_id, conversation_id, party, party_source, party_reason, party_set_by, linked_at, last_message_at";

async function loadMeta(threads) {
  const out = new Map();
  for (const [cid, list] of groupByConnection(threads)) {
    for (const part of chunk([...new Set(list.map((t) => t.conversation_id))], CONV_CHUNK)) {
      const { data, error } = await _deps.supabase.from("fpx_mailbox_thread_meta").select(META_SELECT)
        .eq("connection_id", cid).in("conversation_id", part);
      if (error) throw new Error(`thread meta not read: ${error.message}`);
      for (const r of data || []) out.set(threadKey(r.connection_id, r.conversation_id), r);
    }
  }
  return out;
}

const THREAD_SELECT = "connection_id, conversation_id, subject, last_message_at, preview, last_from_name, last_from_address";

export function isDirty(thread, meta) {
  if (!meta || !meta.last_message_at || !meta.linked_at) return true;
  const a = toMs(thread.last_message_at), b = toMs(meta.last_message_at);
  return a != null && (b == null || a > b);
}

// Newest first. Scans up to MAX_SCAN view rows, keeps up to `limit` threads
// that need processing.
async function scanDirty({ sinceIso, beforeIso, limit }) {
  const picked = [];
  let scanned = 0, cursor = null, exhausted = false;
  for (let off = 0; scanned < MAX_SCAN && picked.length < limit; off += VIEW_PAGE) {
    let q = _deps.supabase.from("fpx_mailbox_threads").select(THREAD_SELECT);
    if (sinceIso) q = q.gte("last_message_at", sinceIso);
    if (beforeIso) q = q.lte("last_message_at", beforeIso);
    const { data, error } = await q.order("last_message_at", { ascending: false })
      .order("conversation_id", { ascending: true }).range(off, off + VIEW_PAGE - 1);
    if (error) throw new Error(`threads not read: ${error.message}`);
    const rows = data || [];
    const meta = rows.length ? await loadMeta(rows) : new Map();
    let seen = 0;
    for (const r of rows) {
      scanned += 1;
      seen += 1;
      cursor = r.last_message_at || cursor;
      const m = meta.get(threadKey(r.connection_id, r.conversation_id)) || null;
      if (isDirty(r, m)) picked.push({ ...r, meta: m });
      if (picked.length >= limit) break;
    }
    // The window is done when its last page was read to the end.
    if (rows.length < VIEW_PAGE) { exhausted = seen === rows.length; break; }
  }
  return { threads: picked, cursor, exhausted, scanned };
}

const MESSAGE_SELECT = "id, connection_id, conversation_id, direction, subject, from_address, from_name, to_recipients, cc_recipients, body_preview, received_at, sent_at";

async function loadMessages(threads) {
  const byThread = new Map();
  for (const [cid, list] of groupByConnection(threads)) {
    for (const part of chunk([...new Set(list.map((t) => t.conversation_id))], 20)) {
      const { data, error } = await _deps.supabase.from("fpx_mailbox_messages").select(MESSAGE_SELECT)
        .eq("connection_id", cid).in("conversation_id", part).eq("removed_in_outlook", false).limit(1000);
      if (error) throw new Error(`messages not read: ${error.message}`);
      for (const m of data || []) {
        const k = threadKey(m.connection_id, m.conversation_id);
        if (!byThread.has(k)) byThread.set(k, []);
        byThread.get(k).push(m);
      }
    }
  }
  return byThread;
}

async function loadBodies(messageIds) {
  const out = new Map();
  for (const part of chunk(messageIds, BODY_CHUNK)) {
    const { data, error } = await _deps.supabase.from("fpx_mailbox_messages").select("id, body_html")
      .in("id", part).not("body_html", "is", null);
    if (error) { warnOnce("bodies", `bodies not read: ${error.message}`); continue; }
    for (const r of data || []) if (r.body_html) out.set(r.id, r.body_html);
  }
  return out;
}

async function loadLinks(threads) {
  const out = new Map();
  for (const [cid, list] of groupByConnection(threads)) {
    for (const part of chunk([...new Set(list.map((t) => t.conversation_id))], CONV_CHUNK)) {
      const { data, error } = await _deps.supabase.from("fpx_mailbox_links").select("connection_id, conversation_id, shipment_id, dismissed")
        .eq("connection_id", cid).in("conversation_id", part);
      if (error) throw new Error(`links not read: ${error.message}`);
      for (const r of data || []) {
        const k = threadKey(r.connection_id, r.conversation_id);
        if (!out.has(k)) out.set(k, []);
        out.get(k).push(r);
      }
    }
  }
  return out;
}

async function loadShipmentNames(ids) {
  const out = new Map();
  for (const part of chunk([...new Set(ids)], ID_CHUNK)) {
    const { data, error } = await _deps.supabase.from("fpx_shipments")
      .select("shipment_id, customer_name, company_name, carrier, carrier_name").in("shipment_id", part);
    if (error) { warnOnce("shipnames", `shipments not read: ${error.message}`); continue; }
    for (const r of data || []) if (r.shipment_id) out.set(String(r.shipment_id), { ...r, carrier_name: r.carrier_name || r.carrier || null });
  }
  return out;
}

async function loadDomains(domains) {
  const keys = [...new Set(domains.flatMap((d) => domainLookupKeys(d)))];
  const out = new Map();
  for (const part of chunk(keys, ID_CHUNK)) {
    const { data, error } = await _deps.supabase.from("fpx_mailbox_domains").select("domain, party, source").in("domain", part);
    if (error) throw new Error(`domains not read: ${error.message}`);
    for (const r of data || []) out.set(String(r.domain).toLowerCase(), r);
  }
  return out;
}

const msgAt = (m) => m?.received_at || m?.sent_at || "";

function threadText(messages, bodies) {
  const parts = [];
  const subjects = new Set();
  for (const m of messages) {
    if (m.subject && !subjects.has(m.subject)) { subjects.add(m.subject); parts.push(m.subject); }
    if (m.body_preview) parts.push(m.body_preview);
  }
  const newestIn = newestInbound(messages);
  if (newestIn && bodies.has(newestIn.id)) parts.push(htmlToText(bodies.get(newestIn.id)).slice(0, MAX_TEXT_CHARS));
  return parts.join("\n").slice(0, MAX_TEXT_CHARS);
}

function newestInbound(messages) {
  let best = null;
  for (const m of messages) if (m.direction === "in" && (!best || String(msgAt(m)) > String(msgAt(best)))) best = m;
  return best;
}

// ---------------------------------------------------------------------------
// Processing

// threads: [{ connection_id, conversation_id, last_message_at, subject, preview,
//   last_from_name, last_from_address, meta }]
// -> { processed, linked, classified }
export async function processThreads(threads, { ai = true, now = new Date().toISOString() } = {}) {
  if (!threads?.length) return { processed: 0, linked: 0, classified: 0 };
  const db = _deps.supabase;
  const mailboxes = await loadMailboxes();
  const messagesBy = await loadMessages(threads);

  // Bodies of the newest inbound message, when already cached.
  const newestIds = [];
  for (const t of threads) {
    const n = newestInbound(messagesBy.get(threadKey(t.connection_id, t.conversation_id)) || []);
    if (n) newestIds.push(n.id);
  }
  const bodies = newestIds.length ? await loadBodies(newestIds) : new Map();

  // Candidates -> shipments.
  const candBy = new Map();
  const allValues = new Set();
  for (const t of threads) {
    const k = threadKey(t.connection_id, t.conversation_id);
    const msgs = messagesBy.get(k) || [];
    const text = msgs.length ? threadText(msgs, bodies) : [t.subject, t.preview].filter(Boolean).join("\n");
    const cands = extractCandidates(text);
    candBy.set(k, cands);
    for (const c of cands) allValues.add(c.value);
  }
  const byValue = allValues.size ? await lookupValues([...allValues]) : new Map();

  // New auto links (on conflict do nothing: a dismissed link stays dismissed).
  const existing = await loadLinks(threads);
  const shipInfo = new Map();
  const newLinks = [];
  for (const t of threads) {
    const k = threadKey(t.connection_id, t.conversation_id);
    const have = new Set((existing.get(k) || []).map((l) => String(l.shipment_id)));
    for (const hit of bestMatches(candBy.get(k), byValue)) {
      shipInfo.set(hit.shipment_id, hit);
      if (have.has(hit.shipment_id)) continue;
      have.add(hit.shipment_id);
      newLinks.push({
        connection_id: t.connection_id, conversation_id: t.conversation_id, shipment_id: hit.shipment_id,
        matched_on: hit.matched_on, matched_text: hit.matched_text, source: "auto",
      });
      if (!existing.has(k)) existing.set(k, []);
      existing.get(k).push({ connection_id: t.connection_id, conversation_id: t.conversation_id, shipment_id: hit.shipment_id, dismissed: false });
    }
  }
  for (const part of chunk(newLinks, ID_CHUNK)) {
    const { error } = await db.from("fpx_mailbox_links")
      .upsert(part, { onConflict: "connection_id,conversation_id,shipment_id", ignoreDuplicates: true });
    if (error) throw new Error(`links not saved: ${error.message}`);
  }

  // Party.
  const needNames = [];
  for (const list of existing.values()) for (const l of list) if (!l.dismissed && !shipInfo.has(String(l.shipment_id))) needNames.push(String(l.shipment_id));
  const names = needNames.length ? await loadShipmentNames(needNames) : new Map();
  for (const [id, v] of shipInfo) names.set(id, v);

  const toClassify = threads.filter((t) => t.meta?.party_source !== "person");
  const senderDomains = new Set();
  for (const t of toClassify) {
    const msgs = messagesBy.get(threadKey(t.connection_id, t.conversation_id)) || [];
    for (const p of threadParties(msgs, mailboxes.get(t.connection_id) || DEFAULT_MAILBOX)) if (p.domain) senderDomains.add(p.domain);
  }
  const domains = senderDomains.size ? await loadDomains([...senderDomains]) : new Map();

  const results = new Map();
  const aiItems = [];
  for (const t of toClassify) {
    const k = threadKey(t.connection_id, t.conversation_id);
    const msgs = messagesBy.get(k) || [];
    const mailbox = mailboxes.get(t.connection_id) || DEFAULT_MAILBOX;
    const r = classifyParty(msgs, existing.get(k) || [], { domains, shipments: names, mailbox });
    results.set(k, r);
    if (r.party === "unknown" && ai && msgs.length) {
      const n = newestInbound(msgs) || [...msgs].sort((a, b) => String(msgAt(b)).localeCompare(String(msgAt(a))))[0];
      const parties = threadParties(msgs, mailbox);
      aiItems.push({
        key: k, parties,
        subject: n?.subject || t.subject, from_name: n?.from_name || t.last_from_name, from_address: n?.from_address || t.last_from_address,
        preview: n?.body_preview || t.preview,
        linked_count: (existing.get(k) || []).filter((l) => !l.dismissed).length,
      });
    }
  }

  if (aiItems.length) {
    const { results: aiRes, errors } = await classifyWithAi(aiItems);
    if (errors.length) warnOnce("ai", `party AI: ${errors[0]}`);
    const learned = new Map();
    aiItems.forEach((it, idx) => {
      const v = aiRes.get(idx);
      if (!v) return;
      results.set(it.key, { party: v.party, source: "ai", reason: v.reason || "Classified by AI" });
      // Learn the sender domain for customers and carriers when the thread has
      // exactly one external, non-freemail domain nobody has classified yet.
      if (v.party !== "customer" && v.party !== "carrier") return;
      const ext = [...new Set(it.parties.map((p) => p.domain).filter((d) => d && !INTERNAL_DOMAINS.includes(d)))];
      if (ext.length !== 1 || FREEMAIL.has(ext[0]) || domainEntry(domains, ext[0]) || learned.has(ext[0])) return;
      learned.set(ext[0], { domain: ext[0], party: v.party, source: "ai", set_by: "linker", updated_at: now });
    });
    if (learned.size) {
      const { error } = await db.from("fpx_mailbox_domains")
        .upsert([...learned.values()], { onConflict: "domain", ignoreDuplicates: true });
      if (error) warnOnce("learn", `domains not saved: ${error.message}`);
    }
  }

  // Meta. Person-set threads only get the processing marks.
  const metaRows = [];
  const personRows = [];
  let classified = 0;
  for (const t of threads) {
    const k = threadKey(t.connection_id, t.conversation_id);
    const marks = { connection_id: t.connection_id, conversation_id: t.conversation_id, linked_at: now, last_message_at: t.last_message_at || null, updated_at: now };
    if (t.meta?.party_source === "person") { personRows.push(marks); continue; }
    let r = results.get(k) || { party: "unknown", source: null, reason: null };
    if (r.party === "unknown" && t.meta?.party && t.meta.party !== "unknown") {
      r = { party: t.meta.party, source: t.meta.party_source || null, reason: t.meta.party_reason || null }; // keep the earlier answer
    }
    if (r.party !== "unknown") classified += 1;
    metaRows.push({ ...marks, party: r.party, party_source: r.source || null, party_reason: r.reason || null, party_set_by: null });
  }
  for (const rows of [metaRows, personRows]) {
    for (const part of chunk(rows, ID_CHUNK)) {
      const { error } = await db.from("fpx_mailbox_thread_meta").upsert(part, { onConflict: "connection_id,conversation_id" });
      if (error) throw new Error(`thread meta not saved: ${error.message}`);
    }
  }
  return { processed: threads.length, linked: newLinks.length, classified };
}

// Threads whose last message is newer than their last processing (or never
// processed), newest first.
//   sinceDays  only threads with a message in the last N days (null = all time)
//   before     only threads whose last message is at or before this ISO time
//              (the older pass's cursor)
// -> { processed, linked, classified, scanned, cursor, exhausted, error? }. Never throws.
export async function linkThreads({ sinceDays = 30, limit = 200, before = null, ai = true } = {}) {
  try {
    const lim = Math.max(1, Math.min(500, Number(limit) || 200));
    const sinceIso = sinceDays == null ? null : new Date(Date.now() - Number(sinceDays) * 86_400_000).toISOString();
    const scan = await scanDirty({ sinceIso, beforeIso: before || null, limit: lim });
    const res = await processThreads(scan.threads, { ai });
    return { ...res, scanned: scan.scanned, cursor: scan.cursor, exhausted: scan.exhausted };
  } catch (e) {
    const msg = e?.message || String(e);
    warnOnce("link", msg);
    return { processed: 0, linked: 0, classified: 0, scanned: 0, cursor: null, exhausted: false, error: msg };
  }
}

// After a person changes a domain's party: re-run classification (and
// linking) for every thread with a sender from that domain or its
// subdomains. Threads whose party a person set are left alone.
// -> { threads, processed, linked, classified, error? }. Never throws.
export async function classifyDomainChange(domain) {
  const d = String(domain || "").trim().toLowerCase().replace(/^@/, "");
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(d)) return { threads: 0, processed: 0, linked: 0, classified: 0, error: "invalid domain" };
  try {
    const db = _deps.supabase;
    const { data, error } = await db.from("fpx_mailbox_messages").select("connection_id, conversation_id")
      .or(`from_address.ilike.*@${d},from_address.ilike.*.${d}`).eq("removed_in_outlook", false).limit(5000);
    if (error) throw new Error(`messages not read: ${error.message}`);
    const keys = new Map();
    for (const r of data || []) if (r.conversation_id) keys.set(threadKey(r.connection_id, r.conversation_id), r);
    const pairs = [...keys.values()];
    const totals = { threads: pairs.length, processed: 0, linked: 0, classified: 0 };
    for (const [cid, list] of groupByConnection(pairs)) {
      for (const part of chunk(list.map((r) => r.conversation_id), CONV_CHUNK)) {
        const { data: rows, error: e2 } = await db.from("fpx_mailbox_threads").select(THREAD_SELECT)
          .eq("connection_id", cid).in("conversation_id", part);
        if (e2) throw new Error(`threads not read: ${e2.message}`);
        if (!rows?.length) continue;
        const meta = await loadMeta(rows);
        const threads = rows.map((r) => ({ ...r, meta: meta.get(threadKey(r.connection_id, r.conversation_id)) || null }));
        const res = await processThreads(threads);
        totals.processed += res.processed; totals.linked += res.linked; totals.classified += res.classified;
      }
    }
    return totals;
  } catch (e) {
    const msg = e?.message || String(e);
    warnOnce("domain", msg);
    return { threads: 0, processed: 0, linked: 0, classified: 0, error: msg };
  }
}

// ---------------------------------------------------------------------------
// Worker

export const LINKER_TICK_LIMIT = 200;
export const RECENT_DAYS = 30;
const state = { running: null, olderCursor: null, olderDone: false };

// One tick: the last 30 days first; once nothing there is left, older mail
// (all time) a page at a time, newest first. At most LINKER_TICK_LIMIT
// threads per tick. Never throws.
export async function linkerTick({ limit = LINKER_TICK_LIMIT } = {}) {
  if (state.running) return state.running;
  state.running = (async () => {
    try {
      const recent = await linkThreads({ sinceDays: RECENT_DAYS, limit });
      const out = { recent, older: null };
      if (recent.error || !recent.exhausted || recent.processed >= limit || state.olderDone) return out;
      const before = state.olderCursor || new Date(Date.now() - RECENT_DAYS * 86_400_000).toISOString();
      const older = await linkThreads({ sinceDays: null, before, limit: limit - recent.processed });
      out.older = older;
      if (!older.error) {
        if (older.cursor) state.olderCursor = older.cursor;
        if (older.exhausted) state.olderDone = true;
      }
      return out;
    } catch (e) {
      warnOnce("tick", e?.message || String(e));
      return { error: e?.message || String(e) };
    } finally {
      state.running = null;
    }
  })();
  return state.running;
}

export function _resetLinkerState() { state.running = null; state.olderCursor = null; state.olderDone = false; }

// Call once after the server starts listening. Every 2 minutes. Off without a
// database, under node --test and with NODE_ENV=test.
let timer = null;
export function startMailboxLinker({ intervalMs = 2 * 60_000, firstRunMs = 60_000 } = {}) {
  try {
    if (!mailboxLinkerEnabled()) return false;
    if (timer) return true;
    const tick = () => { linkerTick().catch(() => {}); };
    setTimeout(tick, firstRunMs).unref();
    timer = setInterval(tick, intervalMs);
    timer.unref();
    return true;
  } catch (e) {
    warnOnce("start", `linker not started: ${e?.message || e}`);
    return false;
  }
}
