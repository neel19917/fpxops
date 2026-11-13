// "Scrape finished" emails via Resend, to everyone subscribed on the Scraping
// page (fpx_user_profiles.scrape_email: off | all | failed).
//
// Env (Railway → fpx-browser):
//   SALESOS_EMAIL_KEY  preferred — a Sales OS email-relay key (fpk_…, scope email:send). When set,
//                      mail goes through Sales OS (POST /api/email-relay/send) and this service
//                      holds no Resend credential. The relay only delivers to staff addresses.
//   SALESOS_EMAIL_URL  default "https://api.freightpopsales.com/api/email-relay/send"
//   RESEND_API_KEY     fallback — used only when SALESOS_EMAIL_KEY is not set. With neither,
//                      sending is skipped (logged once)
//   NOTIFY_FROM        default "FPX <fpx@updates.freightpopsales.com>" (a verified Resend domain).
//                      Via the relay only its name and mailbox are used; the domain is Sales OS's.
//   DASHBOARD_URL    default "https://fpxpress.netlify.app"

const SB_URL = (process.env.SUPABASE_URL || "").replace(/\/$/, "");
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const RESEND_KEY = process.env.RESEND_API_KEY || "";
const FROM = process.env.NOTIFY_FROM || "FPX <fpx@updates.freightpopsales.com>";
const RELAY_KEY = process.env.SALESOS_EMAIL_KEY || "";
const RELAY_URL = process.env.SALESOS_EMAIL_URL || "https://api.freightpopsales.com/api/email-relay/send";
const DASH = (process.env.DASHBOARD_URL || "https://fpxpress.netlify.app").replace(/\/$/, "");

let warned = false;

async function subscribers(ok) {
  const want = ok ? "in.(all)" : "in.(all,failed)";
  const res = await fetch(`${SB_URL}/rest/v1/fpx_user_profiles?select=email,full_name&enabled=eq.true&scrape_email=${want}`, {
    headers: { apikey: SB_KEY, authorization: `Bearer ${SB_KEY}` },
  });
  if (!res.ok) throw new Error(`Supabase ${res.status}`);
  return (await res.json()).filter((u) => u.email);
}

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const num = (n) => (n == null ? "—" : Number(n).toLocaleString("en-US"));
const MODE_LABEL = { LTL: "LTL", Truckload: "FTL", Parcel: "Parcel" };
const dur = (ms) => { const m = Math.round((ms || 0) / 60000); return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`; };

function delta(b, a, goodWhenDown) {
  if (b == null || a == null) return "";
  const d = a - b;
  if (!d) return `<span style="color:#64748b">no change</span>`;
  const color = goodWhenDown == null ? "#334155" : (d > 0) === !goodWhenDown ? "#047857" : "#be123c";
  return `<span style="color:${color}">${d > 0 ? "+" : "−"}${num(Math.abs(d))}</span>`;
}

function rows(list) {
  return list.map(([label, b, a, goodWhenDown]) =>
    `<tr><td style="padding:4px 12px 4px 0;color:#475569">${esc(label)}</td>` +
    `<td style="padding:4px 12px;text-align:right">${num(b)}</td><td style="padding:4px 4px;color:#94a3b8">→</td>` +
    `<td style="padding:4px 12px;text-align:right;font-weight:600">${num(a)}</td><td style="padding:4px 0">${delta(b, a, goodWhenDown)}</td></tr>`).join("");
}

function table(title, list) {
  const shown = list.filter(([, b, a]) => b != null || a != null);
  if (!shown.length) return "";
  return `<h3 style="margin:20px 0 6px;font-size:14px;color:#0f172a">${esc(title)}</h3>` +
    `<table style="border-collapse:collapse;font-size:13px">` +
    `<tr style="color:#94a3b8;font-size:11px"><td></td><td style="padding:0 12px;text-align:right">BEFORE</td><td></td><td style="padding:0 12px;text-align:right">AFTER</td><td></td></tr>${rows(shown)}</table>`;
}

export function buildRunEmail(run) {
  const ok = !!run.ok;
  const modes = run.modes?.length ? run.modes.map((m) => MODE_LABEL[m] || m).join(" + ") : "All modes";
  const kind = run.source === "schedule" ? `Scheduled${run.scheduleName ? ` (${run.scheduleName})` : ""}` : "Manual";
  const c = run.counts || {};
  const fb = run.fpBefore || {}, fa = run.fpAfter || {};
  const tb = run.tasksBefore || {}, ta = run.tasksAfter || {};
  const seg = (s, k) => (s.by_segment ? s.by_segment[k] ?? 0 : undefined);
  const flag = (s, k) => (s.by_flag ? s.by_flag[k] ?? 0 : undefined);
  const disp = (s, k) => (s.dispositions ? s.dispositions[k] ?? 0 : undefined);
  const subject = ok
    ? `FPX refresh done — ${num(c.saved)} saved${c.changed ? `, ${num(c.changed)} changed` : ""}${run.modes?.length ? ` (${modes})` : ""}`
    : `FPX refresh FAILED${run.modes?.length ? ` (${modes})` : ""} — ${String(run.note || "").slice(0, 80)}`;

  const html = `<!doctype html><html><body style="margin:0;background:#f8fafc;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#0f172a">
<div style="max-width:620px;margin:0 auto;padding:24px">
  <div style="background:#fff;border:1px solid #e2e8f0;border-radius:14px;padding:22px">
    <div style="font-size:12px;color:#7c3aed;font-weight:600;letter-spacing:.04em">FPX · REFRESH ALL</div>
    <h2 style="margin:6px 0 4px;font-size:20px">${ok ? "✅ Refresh finished" : "⚠️ Refresh failed"}</h2>
    <div style="font-size:13px;color:#475569">${esc(kind)} · ${esc(modes)} · ran as ${esc(run.user)} · took ${dur(run.durationMs)}</div>
    <p style="font-size:13px;color:#334155;margin:12px 0 0">${esc(run.note)}</p>
    ${ok ? `<table style="margin-top:14px;font-size:13px;border-collapse:collapse"><tr>
      <td style="padding:8px 14px 8px 0"><div style="color:#64748b;font-size:11px">SAVED</div><div style="font-size:18px;font-weight:700">${num(c.saved)}</div></td>
      <td style="padding:8px 14px"><div style="color:#64748b;font-size:11px">CHANGED</div><div style="font-size:18px;font-weight:700">${num(c.changed)}</div></td>
      <td style="padding:8px 14px"><div style="color:#64748b;font-size:11px">ARCHIVED</div><div style="font-size:18px;font-weight:700">${num(c.archived)}</div></td>
      <td style="padding:8px 14px"><div style="color:#64748b;font-size:11px">UPLOAD ERRORS</div><div style="font-size:18px;font-weight:700">${num(c.uploadErrors)}</div></td>
    </tr></table>` : ""}
    ${table("FreightPOP dashboard", [
      ["Total", fb.TOTAL, fa.TOTAL], ["Booked", fb.BOOKED, fa.BOOKED], ["In transit", fb["IN TRANSIT"], fa["IN TRANSIT"]],
      ["Issues", fb.ISSUES, fa.ISSUES, true], ["Out for delivery", fb["OUT FOR DELIVERY"], fa["OUT FOR DELIVERY"]],
    ])}
    ${table("Task board", [
      ["Active tasks", tb.active, ta.active, true], ["Needs attention", tb.needs_attention, ta.needs_attention, true],
      ["Carrier follow-ups", seg(tb, "carrier"), seg(ta, "carrier"), true], ["Customer follow-ups", seg(tb, "customer"), seg(ta, "customer"), true],
      ["Storage risk", seg(tb, "storage_risk"), seg(ta, "storage_risk"), true], ["Redelivery", seg(tb, "redelivery"), seg(ta, "redelivery"), true],
      ["Likely resolved", flag(tb, "resolved_upstream"), flag(ta, "resolved_upstream")], ["Stale data", flag(tb, "stale"), flag(ta, "stale"), true],
    ])}
    ${table("Shipments behind active tasks", [
      ["In transit", disp(tb, "IN TRANSIT"), disp(ta, "IN TRANSIT")], ["Out for delivery", disp(tb, "OUT FOR DELIVERY"), disp(ta, "OUT FOR DELIVERY")],
      ["Issue", disp(tb, "ISSUE"), disp(ta, "ISSUE"), true], ["Delivered", disp(tb, "DELIVERED"), disp(ta, "DELIVERED")],
    ])}
    <div style="margin-top:22px">
      <a href="${DASH}/scraping" style="display:inline-block;background:#7c3aed;color:#fff;text-decoration:none;padding:9px 16px;border-radius:9px;font-size:13px;font-weight:600">Open the Scraping page</a>
      <a href="${DASH}/tasks" style="display:inline-block;margin-left:8px;color:#7c3aed;text-decoration:none;padding:9px 6px;font-size:13px;font-weight:600">Tasks board →</a>
    </div>
  </div>
  <p style="font-size:11px;color:#94a3b8;text-align:center;margin-top:14px">You get this because you subscribed on FPX → Scraping. Change it there any time.</p>
</div></body></html>`;

  const text = [
    ok ? "Refresh finished" : "Refresh FAILED",
    `${kind} · ${modes} · ran as ${run.user} · took ${dur(run.durationMs)}`,
    run.note,
    ok ? `Saved ${num(c.saved)} · changed ${num(c.changed)} · archived ${num(c.archived)} · upload errors ${num(c.uploadErrors)}` : "",
    fa.TOTAL != null ? `FreightPOP: total ${num(fb.TOTAL)} → ${num(fa.TOTAL)}, issues ${num(fb.ISSUES)} → ${num(fa.ISSUES)}` : "",
    ta.active != null ? `Tasks: active ${num(tb.active)} → ${num(ta.active)}, needs attention ${num(tb.needs_attention)} → ${num(ta.needs_attention)}` : "",
    `${DASH}/scraping`,
    "You get this because you subscribed on FPX → Scraping.",
  ].filter(Boolean).join("\n");

  return { subject, html, text };
}

// "FPX <fpx@updates.example.com>" → { fromName: "FPX", fromLocal: "fpx" }. The relay
// picks the domain itself, so only the name and the mailbox travel.
export function relaySender(from) {
  const m = String(from || "").match(/^\s*"?([^"<]*?)"?\s*<\s*([^@\s<>]+)@[^>]+>\s*$/);
  if (m) return { fromName: m[1].trim() || "FPX", fromLocal: m[2].toLowerCase() };
  const bare = String(from || "").match(/^\s*([^@\s<>]+)@\S+\s*$/);
  return { fromName: "FPX", fromLocal: bare ? bare[1].toLowerCase() : "fpx" };
}

// One request per person (no shared To: list), in sequence so a long subscriber
// list stays under the relay's per-minute limit for as long as possible. Returns
// { sent, failed: [{ email, status, error }] }. Never throws.
export async function sendViaRelay(subs, { subject, html, text }, fetchImpl = fetch) {
  const sender = relaySender(FROM);
  const out = { sent: 0, failed: [] };
  for (const u of subs) {
    try {
      const res = await fetchImpl(RELAY_URL, {
        method: "POST",
        headers: { "x-api-key": RELAY_KEY, "content-type": "application/json" },
        body: JSON.stringify({ to: [u.email], subject, html, text, ...sender }),
      });
      if (res.ok) { out.sent++; continue; }
      const body = await res.text();
      out.failed.push({ email: u.email, status: res.status, error: body.slice(0, 200) });
      // A bad key or a spent limit fails the same way for everyone: stop, don't hammer.
      if ([401, 403, 429, 503].includes(res.status)) break;
    } catch (e) {
      out.failed.push({ email: u.email, status: 0, error: e.message });
    }
  }
  return out;
}

// Called after every finished run. Never throws.
export async function notifyRunDone(run) {
  try {
    if (!SB_URL || !SB_KEY) return;
    const subs = await subscribers(!!run.ok);
    if (!subs.length) return;
    if (!RELAY_KEY && !RESEND_KEY) {
      if (!warned) { warned = true; console.warn(`[notify] ${subs.length} subscriber(s) but neither SALESOS_EMAIL_KEY nor RESEND_API_KEY is set — not emailing`); }
      return;
    }
    const { subject, html, text } = buildRunEmail(run);
    if (RELAY_KEY) {
      const r = await sendViaRelay(subs.slice(0, 100), { subject, html, text });
      console.log(`[notify] Sales OS relay: emailed ${r.sent} of ${subs.length} subscriber(s) about run ${run.id} (${run.ok ? "done" : "failed"})`);
      for (const f of r.failed) console.warn(`[notify] relay ${f.status} for ${f.email}: ${f.error}`);
      return;
    }
    // One email per person (no shared To: list), up to 100 per batch call.
    const batch = subs.slice(0, 100).map((u) => ({ from: FROM, to: [u.email], subject, html, text }));
    const res = await fetch("https://api.resend.com/emails/batch", {
      method: "POST",
      headers: { authorization: `Bearer ${RESEND_KEY}`, "content-type": "application/json" },
      body: JSON.stringify(batch),
    });
    const body = await res.text();
    if (!res.ok) console.warn(`[notify] Resend ${res.status}: ${body.slice(0, 200)}`);
    else console.log(`[notify] emailed ${batch.length} subscriber(s) about run ${run.id} (${run.ok ? "done" : "failed"})`);
  } catch (e) {
    console.warn("[notify] failed:", e.message);
  }
}
