import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// Ask FPX embeddings with Supabase's built-in gte-small model (384 dims).
// Deployed as the `fpx-embed` Edge Function (verify_jwt off — see Auth).
//
// Auth: the caller's own key is used for every database call, and the
// functions it calls are granted to service_role only, so only the FPX
// server (service key) can embed or read. verify_jwt is off because the
// project's new-style secret keys aren't JWTs; this check replaces it.
//
// POST { mode: "pending", limit? }  -> embed ONE small batch of index records
//                                     whose text changed; the caller loops
//                                     (edge functions cap CPU per request)
// POST { mode: "query", text }      -> embedding for one search query

const session = new Supabase.ai.Session("gte-small");
const MAX_CHARS = 1200; // gte-small reads ~512 tokens

async function embed(text: string): Promise<number[]> {
  const out = await session.run(text.slice(0, MAX_CHARS), { mean_pool: true, normalize: true });
  return Array.from(out as Float32Array | number[]);
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return Response.json({ error: "POST only" }, { status: 405 });
  const key = req.headers.get("apikey") || (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!key) return Response.json({ error: "Missing key" }, { status: 401 });
  const sb = createClient(Deno.env.get("SUPABASE_URL")!, key, { auth: { persistSession: false } });
  const { data: ok, error: authErr } = await sb.rpc("fpx_assistant_embed_auth");
  if (authErr || ok !== true) return Response.json({ error: "Not allowed" }, { status: 403 });

  let body: { mode?: string; text?: string; limit?: number } = {};
  try { body = await req.json(); } catch { /* empty */ }

  if (body.mode === "query") {
    const text = String(body.text || "").trim();
    if (!text) return Response.json({ error: "text required" }, { status: 400 });
    return Response.json({ embedding: await embed(text) });
  }

  const started = Date.now();
  const limit = Math.max(1, Math.min(Number(body.limit) || 6, 12));
  const { data: rows, error } = await sb.rpc("fpx_assistant_embed_queue", { p_limit: limit });
  if (error) return Response.json({ error: error.message }, { status: 500 });
  if (!rows?.length) return Response.json({ embedded: 0, more: false, ms: Date.now() - started });
  const out = [];
  for (const r of rows as { shipment_uuid: string; doc: string; doc_hash: string }[]) {
    out.push({ shipment_uuid: r.shipment_uuid, doc_hash: r.doc_hash, embedding: JSON.stringify(await embed(r.doc)) });
  }
  const { error: e2 } = await sb.rpc("fpx_assistant_set_embeddings", { p_rows: out });
  if (e2) return Response.json({ error: e2.message }, { status: 500 });
  return Response.json({ embedded: out.length, more: rows.length === limit, ms: Date.now() - started });
});
