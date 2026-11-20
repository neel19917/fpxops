// Inline (cid:) images of support-mailbox messages.
//
// Outlook bodies reference embedded images as <img src="cid:image001.png@01DA…">.
// A browser cannot load those, so on first open of a message we fetch its
// inline attachments from Graph once, store them in the private Storage
// bucket "mailbox-cache" at <message row id>/<sanitized content id>, and
// record them in fpx_mailbox_inline_images. Every open then only re-signs
// (one createSignedUrls call per message, 1 day) and rewrites the cid: refs.
// body_html stays stored with its cid: refs. Nothing here deletes anything.
import { supabase } from "../supabase.js";
import { graphFetch, mailboxPath } from "./graph.js";

export const BUCKET = "mailbox-cache";
export const TABLE = "fpx_mailbox_inline_images";
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_IMAGES_PER_MESSAGE = 30;
export const SIGNED_URL_SECONDS = 24 * 60 * 60;

// Swappable in tests.
export const _deps = {
  supabase,
  graphFetch: (...a) => graphFetch(...a),
};

const warned = new Map();
function warnOnce(key, message) {
  const now = Date.now();
  if (now - (warned.get(key) || 0) < 10 * 60_000) return;
  warned.set(key, now);
  console.warn(`[FPX] support mailbox images: ${message}`);
}

// ---------------------------------------------------------------------------
// Pure helpers

// "<Image001.PNG@01DA.ABC>" -> "image001.png@01da.abc"
export function normalizeCid(cid) {
  let s = String(cid ?? "").trim();
  try { s = decodeURIComponent(s); } catch { /* keep as is */ }
  s = s.replace(/^cid:/i, "").trim().replace(/^<+/, "").replace(/>+$/, "").trim();
  return s.toLowerCase();
}

// File-name-safe Storage object name for a content id.
export function sanitizeCid(cid) {
  const n = normalizeCid(cid).replace(/[^a-z0-9._@-]/g, "_").replace(/^\.+/, "_").slice(0, 200);
  return n || "_";
}

export const localPart = (cid) => normalizeCid(cid).split("@")[0];

export const storagePathFor = (messageId, cid) => `${messageId}/${sanitizeCid(cid)}`;

// Distinct cid references in an HTML body, normalized, in order of appearance.
const CID_ATTR_RE = /(\b(?:src|background)\s*=\s*)(["']?)cid:([^"'\s>]+)\2/gi;
const CID_CSS_RE = /(url\(\s*)(["']?)cid:([^"')\s]+)\2(\s*\))/gi;
export function extractCids(html) {
  const out = [];
  const seen = new Set();
  for (const re of [CID_ATTR_RE, CID_CSS_RE]) {
    re.lastIndex = 0;
    for (const m of String(html || "").matchAll(re)) {
      const n = normalizeCid(m[3]);
      if (n && !seen.has(n)) { seen.add(n); out.push(n); }
    }
  }
  return out;
}

// Finds the entry whose content id matches a reference. Exact (case-insensitive,
// <> stripped) first, then with or without the @domain part on either side.
export function matchCid(ref, entries, keyOf = (e) => e.content_id) {
  const r = normalizeCid(ref);
  if (!r) return null;
  const rs = sanitizeCid(r);
  for (const e of entries) {
    const k = normalizeCid(keyOf(e));
    if (k === r || sanitizeCid(k) === rs) return e;
  }
  const rl = localPart(r);
  if (!rl) return null;
  for (const e of entries) {
    const k = normalizeCid(keyOf(e));
    // "abc" vs "abc@x" either way; also the sanitized forms (Storage names).
    if (localPart(k) === rl || localPart(sanitizeCid(k)) === localPart(rs)) {
      if (!r.includes("@") || !k.includes("@")) return e;
    }
  }
  return null;
}

// Replaces cid: refs that resolve(cid) maps to a url. Unknown cids stay.
export function replaceCids(html, resolve) {
  const sub = (whole, pre, q, cid, post, css) => {
    const url = resolve(cid);
    if (!url) return whole;
    // Attributes get quoted; inside css url() keep the original (possibly no) quote.
    const quote = css ? q : (q || '"');
    return `${pre}${quote}${url.replace(/"/g, "&quot;")}${quote}${post}`;
  };
  return String(html ?? "")
    .replace(CID_ATTR_RE, (w, pre, q, cid) => sub(w, pre, q, cid, "", false))
    .replace(CID_CSS_RE, (w, pre, q, cid, post) => sub(w, pre, q, cid, post, true));
}

// Picks attachments worth caching: referenced from the body (even when Graph
// says isInline=false, which Outlook sometimes does), or inline images.
export function pickAttachments(list, html) {
  const refs = extractCids(html);
  const picked = [];
  for (const a of list || []) {
    if (!a?.id || !a.contentId) continue;
    const type = String(a["@odata.type"] || "");
    if (type && !/fileAttachment$/i.test(type)) continue;
    const referenced = refs.some((r) => matchCid(r, [a], (x) => x.contentId));
    const inlineImage = a.isInline === true && /^image\//i.test(String(a.contentType || ""));
    if (!referenced && !inlineImage) continue;
    if (Number(a.size) > MAX_IMAGE_BYTES) continue;
    picked.push(a);
    if (picked.length >= MAX_IMAGES_PER_MESSAGE) break;
  }
  return picked;
}

const isMissingTable = (error) => {
  const m = `${error?.code || ""} ${error?.message || ""}`;
  return /42P01|PGRST205|does not exist|could not find the table/i.test(m);
};

// ---------------------------------------------------------------------------
// Storage

let bucketReady = null;
export const _resetBucket = () => { bucketReady = null; };
async function ensureBucket() {
  if (!bucketReady) {
    bucketReady = (async () => {
      const sb = _deps.supabase;
      const { data, error } = await sb.storage.getBucket(BUCKET);
      if (data && !error) return true;
      const { error: cErr } = await sb.storage.createBucket(BUCKET, { public: false });
      if (cErr && !/exist/i.test(cErr.message || "")) throw new Error(`bucket ${BUCKET} not created: ${cErr.message}`);
      return true;
    })().catch((e) => { bucketReady = null; throw e; });
  }
  return bucketReady;
}

// What is cached for a message: [{ content_id, storage_path }]. DB rows when the
// table exists, else the Storage folder listing (names are sanitized cids).
export async function listCached(messageId) {
  const sb = _deps.supabase;
  const { data, error } = await sb.from(TABLE).select("content_id, storage_path").eq("message_id", messageId);
  if (!error) return data || [];
  if (!isMissingTable(error)) warnOnce("list", `cached image list not read: ${error.message}`);
  const { data: files, error: lErr } = await sb.storage.from(BUCKET).list(String(messageId), { limit: 100 });
  if (lErr) return [];
  return (files || []).filter((f) => f?.name && f.id !== null)
    .map((f) => ({ content_id: f.name, storage_path: `${messageId}/${f.name}` }));
}

// ---------------------------------------------------------------------------
// Cache (fetch once)

const inflight = new Map(); // message id -> Promise<void>
const attempted = new Set(); // message ids already fetched this process (even with nothing to cache)
export const _resetState = () => { inflight.clear(); attempted.clear(); };

async function doCache(conn, row) {
  const base = `${mailboxPath(conn.mailbox)}/messages/${encodeURIComponent(row.graph_id)}/attachments`;
  const listed = await _deps.graphFetch(conn, `${base}?$select=id,contentId,contentType,size,name,isInline`);
  const picked = pickAttachments(listed?.value, row.body_html);
  if (!picked.length) return;
  await ensureBucket();
  const sb = _deps.supabase;
  const records = [];
  for (const a of picked) {
    try {
      const full = await _deps.graphFetch(conn, `${base}/${encodeURIComponent(a.id)}`);
      if (!full?.contentBytes) continue;
      const buf = Buffer.from(full.contentBytes, "base64");
      if (buf.length > MAX_IMAGE_BYTES) continue;
      const path = storagePathFor(row.id, a.contentId);
      const contentType = a.contentType || full.contentType || "application/octet-stream";
      const { error } = await sb.storage.from(BUCKET).upload(path, buf, { contentType, upsert: true });
      if (error) { warnOnce("upload", `image not stored: ${error.message}`); continue; }
      records.push({ message_id: row.id, content_id: normalizeCid(a.contentId), storage_path: path, content_type: contentType, size: buf.length });
    } catch (e) {
      warnOnce("fetch", `inline image not fetched: ${e?.message || e}`);
    }
  }
  if (!records.length) return;
  const { error } = await sb.from(TABLE).upsert(records, { onConflict: "message_id,content_id" });
  if (error && !isMissingTable(error)) warnOnce("record", `inline images not recorded: ${error.message}`);
}

// Fetches a message's inline images from Graph into Storage. One fetch per
// message at a time; later calls in this process are no-ops. Never throws.
export async function cacheInlineImages(conn, messageRow) {
  const id = messageRow?.id;
  if (!id || !conn || !messageRow.graph_id) return;
  if (inflight.has(id)) return inflight.get(id);
  if (attempted.has(id)) return;
  const p = (async () => {
    try {
      await doCache(conn, messageRow);
      attempted.add(id);
    } catch (e) {
      warnOnce("cache", `inline images not cached: ${e?.message || e}`);
    } finally {
      inflight.delete(id);
    }
  })();
  inflight.set(id, p);
  return p;
}

// ---------------------------------------------------------------------------
// Rewrite (every open)

// Signs cached images in one batch and swaps their cid: refs. Never throws;
// on any failure the HTML comes back unchanged.
export async function rewriteCidImages(html, messageRow, { cached } = {}) {
  try {
    const refs = extractCids(html);
    if (!refs.length || !messageRow?.id) return html;
    const entries = cached ?? await listCached(messageRow.id);
    if (!entries.length) return html;
    const byRef = new Map();
    for (const r of refs) {
      const e = matchCid(r, entries);
      if (e?.storage_path) byRef.set(r, e.storage_path);
    }
    if (!byRef.size) return html;
    const paths = [...new Set(byRef.values())];
    const { data, error } = await _deps.supabase.storage.from(BUCKET).createSignedUrls(paths, SIGNED_URL_SECONDS);
    if (error) { warnOnce("sign", `image urls not signed: ${error.message}`); return html; }
    const urlByPath = new Map();
    for (const d of data || []) if (d?.signedUrl && !d.error) urlByPath.set(d.path, d.signedUrl);
    return replaceCids(html, (cid) => urlByPath.get(byRef.get(normalizeCid(cid))) || null);
  } catch (e) {
    warnOnce("rewrite", `cid images not rewritten: ${e?.message || e}`);
    return html;
  }
}

// getBodyHtml's helper: first open fetches into the cache, later opens only re-sign.
// conn may be the connection or an async function returning it (loaded only
// when a fetch is needed).
export async function withInlineImages(conn, messageRow) {
  const html = messageRow?.body_html;
  if (!html || !/cid:/i.test(html)) return html;
  try {
    const refs = extractCids(html);
    if (!refs.length) return html;
    let cached = await listCached(messageRow.id);
    // Anything cached means the message was fetched before: only re-sign.
    // (A cid with no matching attachment must not cost a Graph call per open.)
    if (!cached.length && conn && !attempted.has(messageRow.id)) {
      const c = typeof conn === "function" ? await conn() : conn;
      if (c) await cacheInlineImages(c, messageRow);
      cached = await listCached(messageRow.id);
    }
    return await rewriteCidImages(html, messageRow, { cached });
  } catch (e) {
    warnOnce("with", `inline images skipped: ${e?.message || e}`);
    return html;
  }
}
