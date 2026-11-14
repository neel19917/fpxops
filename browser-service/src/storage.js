// Supabase Storage for the Excel files of an ERP pull / approval check:
// private bucket "erp-pulls", objects at <audit_id>/<name>.xlsx (approval
// check: recently-approved.xlsx and audit-history.xlsx). Written with
// the service-role key, like runs.js / settings.js write their tables.
// No dependency: node's fetch.
const SB_URL = (process.env.SUPABASE_URL || "").replace(/\/$/, "");
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

export const ERP_BUCKET = "erp-pulls";
export const storageEnabled = !!(SB_URL && SB_KEY);

const XLSX_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const auth = () => ({ apikey: SB_KEY, authorization: `Bearer ${SB_KEY}` });

// One line for a failed call: "Supabase Storage POST <path> → <status> <body>",
// or the network / timeout reason when there was no answer at all.
const failure = (what, res, text) => new Error(`Supabase Storage POST ${what} → ${res.status} ${String(text || "").replace(/\s+/g, " ").slice(0, 200)}`.trim());
const noAnswer = (what, e) => new Error(`Supabase Storage POST ${what} → ${e?.name === "TimeoutError" ? "timed out" : `no answer (${e?.cause?.code || e?.message || e})`}`);

// Create the bucket if it is missing. Once per process; a failure is not
// remembered, so the next save tries again.
let bucketReady = null;
function ensureBucket() {
  if (!bucketReady) {
    bucketReady = createBucket().catch((e) => { bucketReady = null; throw e; });
  }
  return bucketReady;
}

async function createBucket() {
  let res;
  try {
    res = await fetch(`${SB_URL}/storage/v1/bucket`, {
      method: "POST",
      headers: { ...auth(), "content-type": "application/json" },
      body: JSON.stringify({ id: ERP_BUCKET, name: ERP_BUCKET, public: false }),
      signal: AbortSignal.timeout(20_000),
    });
  } catch (e) { throw noAnswer("bucket", e); }
  if (res.ok) return true;
  const text = await res.text().catch(() => "");
  // "Already exists" comes back as 409, or as 400 with statusCode "409" in the body.
  if (res.status === 409) return true;
  if (res.status === 400 && /already exists|duplicate|"statusCode"\s*:\s*"?409/i.test(text)) return true;
  throw failure("bucket", res, text);
}

// Store one .xlsx at `objectPath` in the bucket (replaces a file already there).
// → { path, bytes }. Throws a short readable Error on any failure.
export async function saveExcel(objectPath, buf) {
  if (!storageEnabled) throw new Error("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set");
  const clean = String(objectPath || "").split("/").filter(Boolean);
  if (!clean.length) throw new Error("Supabase Storage: no object path given");
  if (!Buffer.isBuffer(buf) || !buf.length) throw new Error(`Supabase Storage: nothing to save for ${clean.join("/")}`);
  await ensureBucket();
  const p = clean.join("/");
  const what = `object/${ERP_BUCKET}/${p}`;
  let res;
  try {
    res = await fetch(`${SB_URL}/storage/v1/object/${ERP_BUCKET}/${clean.map(encodeURIComponent).join("/")}`, {
      method: "POST",
      headers: { ...auth(), "x-upsert": "true", "content-type": XLSX_TYPE },
      body: buf,
      signal: AbortSignal.timeout(120_000),
    });
  } catch (e) { throw noAnswer(what, e); }
  if (!res.ok) throw failure(what, res, await res.text().catch(() => ""));
  await res.arrayBuffer().catch(() => {}); // drain
  return { path: p, bytes: buf.length };
}
