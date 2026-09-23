// Plain-English brief for one shipment.
//
// The drawer's AI summary ("Storage risk: freight has been held at
// destination terminal (NAG) for 18.8 hours… exceeding XPO LTL's 48-hour
// storage hold limit") is written for operators. Leadership and customers'
// account managers asked for something a non-technical reader can act on:
// what happened, why it matters, what to do, by when.
//
// Accuracy guardrails, because this text will be read by people who can't
// check it against the raw record:
//   1. The model only sees a structured fact sheet (buildPlainFacts) — no
//      raw scrape blob — and is told to use nothing else.
//   2. Strict JSON output, normalised by normalizePlainSummary.
//   3. crossCheck() extracts every date, dollar amount, hour figure and
//      long number from the prose and verifies it appears in the fact
//      sheet. Anything it can't find is returned as `unverified` so the UI
//      can flag it instead of presenting it as truth.
//   4. Cached on fpx_ai_analyses per shipment; regenerated only when the
//      shipment has been re-analysed or a newer note exists.

import { callClaude } from "./anthropic.js";
import { getSettings } from "./settings.js";

const HOUR = 3_600_000;

function fmtDate(iso) {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  const d = new Date(t);
  return `${String(d.getUTCMonth() + 1).padStart(2, "0")}/${String(d.getUTCDate()).padStart(2, "0")}/${d.getUTCFullYear()}`;
}
function hoursAgo(iso, nowMs) {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(t) ? Math.round(((nowMs - t) / HOUR) * 10) / 10 : null;
}

// Structured fact sheet. Every value the model may cite lives here, in the
// same formatting the prose is expected to use (MM/DD/YYYY dates, whole or
// one-decimal hours) so crossCheck can match them back.
export function buildPlainFacts({ ship, tasks = [], notes = [], triggers = {}, people = {}, now = Date.now() }) {
  const activeTasks = tasks.filter((t) => ["open", "in_progress", "blocked"].includes(t.status));
  const latestNote = notes[0] || null;
  // Owners are stored as emails; the brief should say "Victor", not
  // "victorz@freightpop.com".
  const nameOf = (who) => (who ? (people[String(who).toLowerCase()] || people[who] || who) : null);
  return {
    shipment: {
      tracking_number: ship.tracking_number,
      fpx_shipment_id: ship.shipment_id,
      customer: ship.customer_name,
      carrier: ship.carrier_name || ship.carrier,
      mode: ship.mode,
      status: ship.shipment_status,
      origin: ship.origin || ship.ship_from,
      destination: ship.destination || ship.ship_to,
      pickup_date: fmtDate(ship.pickup_date),
      original_eta: fmtDate(ship.original_eta),
      current_eta: fmtDate(ship.updated_eta),
      appointment_date: fmtDate(ship.appointment_date),
      appointment_set: ship.appointment_set ?? null,
      delivered_on: fmtDate(ship.delivery_date),
      carrier_comment: ship.tracking_comments || null,
      last_scraped_hours_ago: hoursAgo(ship.scraped_at, now),
      last_analyzed_hours_ago: hoursAgo(ship.last_analyzed_at, now),
    },
    ai_read: {
      action_required: ship.action_required,
      who_must_act: ship.action_target,
      issue: ship.ai_issue,
      recommendation: ship.ai_recommendation,
    },
    signals: {
      redelivery_needed: triggers.redelivery_needed ?? null,
      storage_risk: triggers.storage_risk ?? null,
      storage_carrier_charges_after_hours: triggers.storage_hold_limit_hours ?? null,
      at_destination_since: fmtDate(triggers.at_destination_since),
      hold_hours_so_far: triggers.hold_hours_so_far ?? null,
      hold_hours_at_appointment: triggers.hold_hours_at_appointment ?? null,
      eta_passed_no_arrival: triggers.eta_passed_no_arrival ?? null,
      appointment_passed_no_delivery: triggers.appointment_passed_no_delivery ?? null,
      days_since_last_carrier_update: triggers.days_since_last_status ?? null,
    },
    open_tasks: activeTasks.slice(0, 6).map((t) => ({
      title: t.title, status: t.status, owner: nameOf(t.assigned_to), created: fmtDate(t.created_at),
    })),
    latest_note: latestNote ? { by: nameOf(latestNote.created_by), on: fmtDate(latestNote.created_at), text: String(latestNote.body || "").slice(0, 400) } : null,
    today: fmtDate(new Date(now).toISOString()),
  };
}

export function extractJson(text) {
  if (!text) return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  for (const c of [fenced?.[1], text.match(/\{[\s\S]*\}/)?.[0]].filter(Boolean)) {
    try { return JSON.parse(c); } catch { /* next */ }
  }
  return null;
}

const URGENCY = new Set(["today", "this_week", "monitor", "none"]);

export function normalizePlainSummary(parsed) {
  const s = (v, n = 600) => (typeof v === "string" ? v.trim().slice(0, n) : "");
  const out = {
    headline: s(parsed?.headline, 200),
    what_happened: s(parsed?.what_happened),
    why_it_matters: s(parsed?.why_it_matters),
    next_steps: [],
    by_when: s(parsed?.by_when, 120),
    urgency: URGENCY.has(parsed?.urgency) ? parsed.urgency : "monitor",
  };
  for (const step of Array.isArray(parsed?.next_steps) ? parsed.next_steps : []) {
    const text = s(typeof step === "string" ? step : step?.step, 240);
    if (!text) continue;
    const who = s(typeof step === "object" ? step?.who : "", 60);
    out.next_steps.push({ step: text, who: who || null });
    if (out.next_steps.length >= 5) break;
  }
  return out;
}

// Every date (MM/DD or MM/DD/YYYY), dollar figure, hour figure ("69.9 hours",
// "48-hour") and 5+ digit number in the prose must appear in the fact
// sheet. Returns the tokens that don't.
export function crossCheck(summary, facts) {
  const prose = [summary.headline, summary.what_happened, summary.why_it_matters, summary.by_when, ...summary.next_steps.map((n) => n.step)].join(" \n ");
  const hay = JSON.stringify(facts).toLowerCase();
  const tokens = new Set();
  for (const m of prose.matchAll(/\b(\d{1,2}\/\d{1,2}(?:\/\d{2,4})?)\b/g)) tokens.add(m[1]);
  for (const m of prose.matchAll(/\$\s?(\d[\d,]*(?:\.\d+)?)/g)) tokens.add(`$${m[1]}`);
  for (const m of prose.matchAll(/\b(\d+(?:\.\d+)?)[\s-]*(?:hours?|hrs?|h)\b/gi)) tokens.add(`${m[1]}h`);
  for (const m of prose.matchAll(/\b(\d{5,})\b/g)) tokens.add(m[1]);

  const unverified = [];
  for (const tok of tokens) {
    if (tok.endsWith("h")) {
      const n = tok.slice(0, -1);
      // hour figures: exact, or the integer part of a one-decimal fact
      const ok = hay.includes(n) || new RegExp(`\\b${n.replace(".", "\\.")}(?:\\.\\d)?\\b`).test(hay);
      if (!ok) unverified.push(`${n} hours`);
    } else if (tok.startsWith("$")) {
      if (!hay.includes(tok.slice(1).replace(/,/g, ""))) unverified.push(tok);
    } else if (tok.includes("/")) {
      // dates: allow MM/DD to match a MM/DD/YYYY fact, and strip leading zeros
      const parts = tok.split("/").map((p) => p.padStart(2, "0"));
      const mmdd = `${parts[0]}/${parts[1]}`;
      if (!hay.includes(mmdd)) unverified.push(tok);
    } else if (!hay.includes(tok)) {
      unverified.push(tok);
    }
  }
  return unverified;
}

export async function runPlainSummary({ facts, callMeta }) {
  const { "prompt.plain_summary.system": systemPrompt, "prompt.plain_summary.model": model } =
    await getSettings("prompt.plain_summary.system", "prompt.plain_summary.model");
  const result = await callClaude({
    systemPrompt,
    userMessage: `Fact sheet (the only source of truth):\n${JSON.stringify(facts, null, 1)}\n\nWrite the brief now. JSON only.`,
    maxTokens: 1500,
    modelOverride: model,
    extraBody: { output_config: { effort: "medium" } },
    metadata: {
      kind: "other",
      tracking_number: facts?.shipment?.tracking_number || null,
      ...(callMeta || {}),
      metadata: { subkind: "plain_summary", ...((callMeta?.metadata) || {}) },
    },
  });
  if (result.error) return { error: result.error };
  const parsed = extractJson(result.text);
  if (!parsed) return { error: "Model did not return JSON", raw: result.text, model: result.model };
  const summary = normalizePlainSummary(parsed);
  return {
    summary,
    unverified: crossCheck(summary, facts),
    model: result.model,
    cost_usd: result.cost_usd,
    analysis_id: result.analysis_id,
  };
}
