// Ad-hoc: compare per-shipment analysis quality across Haiku / Sonnet / Opus
// on a single real shipment, using the production prompts verbatim.
// Mirrors lib/anthropic.js callClaude() shape (plain call, max_tokens 512) so
// the output reflects what the app would actually produce. No Supabase logging.
import "dotenv/config";
import {
  SYSTEM_PROMPT,
  PER_SHIPMENT_PROMPT,
  PER_SHIPMENT_LOGIC,
} from "../prompts.js";

const MODELS = [
  { id: "claude-haiku-4-5", label: "Haiku 4.5 (current default)", in: 1.0, out: 5.0 },
  { id: "claude-sonnet-4-6", label: "Sonnet 4.6", in: 3.0, out: 15.0 },
  { id: "claude-opus-4-8", label: "Opus 4.8", in: 5.0, out: 25.0 },
];

// Shipment 14177821 / tracking 062935895, reconstructed from the live drawer.
// Today is 2026-06-17; ETA 2026-06-18; clearly in transit toward OKC.
const shipment = {
  shipment_id: "14177821",
  tracking_number: "062935895",
  customer: "Accutemp Products",
  carrier: "ABF",
  mode: "LTL",
  status: "InTransit",
  current_status: "InTransit",
  ship_from: "Accutemp Products Inc, New Haven, IN 46774",
  ship_to: "Stafford Smith Inc, Oklahoma City, OK 73128",
  total_weight: "480",
  created_on: "2026-06-15",
  appointment: "Y",
  appointment_date: "2026-06-18T00:00:00",
  original_eta: "2026-06-18",
  estimated_delivery_date: "2026-06-18",
  delivery_date: "",
  pickup_response: "PickupUnverified - This pickup was received.",
  tracking_events: [
    { code: "TRNST", date: "2026-06-16 15:06:41", comment: "Your shipment is loaded on trailer ABFS 550985 in Dayton, OH for dispatch to Oklahoma City, OK." },
    { code: "DISP", date: "2026-06-16 02:18:34", comment: "Your shipment departed Fort Wayne, IN on 6/15/2026 and will be scheduled for delivery at destination." },
    { code: "ArrivedAtOriginServiceCenter", date: "2026-06-15 20:57:18", comment: "Arrived at ABF service center in Fort Wayne, IN." },
    { code: "PickupUnverified", date: "2026-06-12 17:51:29", comment: "This pickup was received." },
  ],
  _today: "2026-06-17",
};

const userMsg = PER_SHIPMENT_PROMPT
  .replace("{{logic}}", PER_SHIPMENT_LOGIC)
  .replace("{{data}}", JSON.stringify(shipment, null, 2));

async function run(model) {
  const t0 = Date.now();
  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: model.id,
      max_tokens: 512,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: userMsg }],
    }),
  });
  const ms = Date.now() - t0;
  if (!resp.ok) return { model, error: `${resp.status}: ${(await resp.text()).slice(0, 300)}`, ms };
  const j = await resp.json();
  const text = j.content?.[0]?.text || "";
  const inTok = j.usage?.input_tokens || 0;
  const outTok = j.usage?.output_tokens || 0;
  const cost = (inTok * model.in + outTok * model.out) / 1e6;
  return { model, text, inTok, outTok, ms, cost };
}

for (const m of MODELS) {
  const r = await run(m);
  console.log("\n" + "=".repeat(72));
  console.log(`### ${m.label}  [${m.id}]`);
  console.log("=".repeat(72));
  if (r.error) { console.log("ERROR:", r.error); continue; }
  console.log(r.text.trim());
  console.log(`\n— ${r.inTok} in / ${r.outTok} out · ${r.ms}ms · $${r.cost.toFixed(4)}`);
}
