import Anthropic from "@anthropic-ai/sdk";

// "Ask FPX" — an ops assistant for the dashboard, on the Claude API.
//
// Two kinds of tools:
//   * data tools  — run here against Supabase (read-only): what to focus on,
//                   search shipments, one shipment's detail, a summary.
//   * UI tools    — not executed here; collected and returned to the browser,
//                   which performs them (navigate, filter the Tracking list,
//                   open a shipment or task drawer).
//
// The browser keeps the conversation and sends it back each turn exactly as
// returned (append-only — required so thinking blocks stay valid).

const MODEL = "claude-opus-5-5";
const MAX_STEPS = 8;              // tool round-trips per user message
const OFF_DASHBOARD_MS = 24 * 3600_000;

const SB_URL = (process.env.SUPABASE_URL || "").replace(/\/$/, "");
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
export const assistantEnabled = !!(process.env.ANTHROPIC_API_KEY && SB_URL && SB_KEY);

const client = assistantEnabled ? new Anthropic() : null;

async function sb(pathAndQuery) {
  const res = await fetch(`${SB_URL}/rest/v1/${pathAndQuery}`, {
    headers: { apikey: SB_KEY, authorization: `Bearer ${SB_KEY}` },
  });
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

const enc = encodeURIComponent;
const trim = (s, n = 280) => (s == null ? null : String(s).length > n ? String(s).slice(0, n) + "…" : String(s));

// Shipments count as "on the FreightPOP dashboard" when seen within 24h of
// the newest scrape (FreightPOP drops delivered shipments; archiving only
// happens after a complete sweep, so the table holds many stale rows).
let cutoffCache = { at: 0, value: null };
async function dashboardCutoff() {
  if (Date.now() - cutoffCache.at < 60_000) return cutoffCache.value;
  const rows = await sb("fpx_shipments_latest?select=scraped_at&order=scraped_at.desc&limit=1");
  const newest = rows?.[0]?.scraped_at ? Date.parse(rows[0].scraped_at) : Date.now();
  cutoffCache = { at: Date.now(), value: new Date(newest - OFF_DASHBOARD_MS).toISOString() };
  return cutoffCache.value;
}

const SHIP_COLS = "id,shipment_id,tracking_number,customer_name,carrier_name,carrier,mode,shipment_status,action_required,ai_issue,ai_recommendation,updated_eta,estimated_arrival,delivery_date,appointment_date,destination,scraped_at";

function compactShipment(s) {
  return {
    id: s.id,                         // internal id — use for open_shipment
    shipment: s.shipment_id,          // FreightPOP shipment number
    tracking: s.tracking_number,
    customer: s.customer_name,
    carrier: s.carrier_name || s.carrier,
    mode: s.mode,
    status: s.shipment_status,
    action_needed: s.action_required === "YES",
    issue: trim(s.ai_issue, 220),
    eta: s.updated_eta || s.estimated_arrival || null,
    delivered: s.delivery_date || null,
    appointment: s.appointment_date || null,
    destination: s.destination,
    last_seen: s.scraped_at,
  };
}

// ---------------- data tools ----------------

async function toolFocusList({ limit = 40, assignee } = {}) {
  const cutoff = await dashboardCutoff();
  const tasks = await sb(
    `fpx_shipment_tasks?select=id,shipment_id,tracking_number,title,status,assigned_to,created_at,due_at` +
    `&archived_at=is.null&status=in.(open,in_progress,blocked)&order=created_at.asc&limit=1000` +
    (assignee ? `&assigned_to=ilike.*${enc(assignee)}*` : ""),
  );
  const ids = [...new Set(tasks.map((t) => t.shipment_id).filter(Boolean))];
  const ships = new Map();
  for (let i = 0; i < ids.length; i += 150) {
    const chunk = ids.slice(i, i + 150);
    for (const s of await sb(`fpx_shipments?select=${SHIP_COLS}&id=in.(${chunk.join(",")})`)) ships.set(s.id, s);
  }
  const rows = tasks
    .map((t) => ({ t, s: ships.get(t.shipment_id) }))
    .filter(({ s }) => !s || !s.scraped_at || s.scraped_at >= cutoff);  // drop shipments that left the dashboard
  // A cheap pre-rank so the model sees the likeliest candidates first; the
  // model makes the real call from the facts.
  const now = Date.now();
  const score = ({ t, s }) => {
    let x = 0;
    if (s?.action_required === "YES") x += 40;
    if (s?.shipment_status === "Issue") x += 30;
    const eta = Date.parse(s?.updated_eta || s?.estimated_arrival || "");
    if (Number.isFinite(eta) && eta < now && !s?.delivery_date) x += 25;
    if (t.status === "blocked") x += 10;
    x += Math.min(20, (now - Date.parse(t.created_at)) / 86_400_000 * 2);
    return x;
  };
  rows.sort((a, b) => score(b) - score(a));
  return {
    open_tasks_on_dashboard: rows.length,
    left_dashboard_excluded: tasks.length - rows.length,
    candidates: rows.slice(0, Math.min(60, limit)).map(({ t, s }) => ({
      task_id: t.id, task: trim(t.title, 160), task_status: t.status, assigned_to: t.assigned_to,
      task_age_days: Math.round((now - Date.parse(t.created_at)) / 86_400_000 * 10) / 10,
      shipment: s ? compactShipment(s) : { tracking: t.tracking_number },
    })),
  };
}

async function toolSearchShipments({ query, status, action_needed, carrier, customer, include_off_dashboard = false, limit = 25 } = {}) {
  const parts = [`select=${SHIP_COLS}`, `order=scraped_at.desc`, `limit=${Math.min(50, limit)}`];
  if (!include_off_dashboard) parts.push(`scraped_at=gte.${enc(await dashboardCutoff())}`);
  if (status) parts.push(`shipment_status=ilike.${enc(status)}`);
  if (action_needed === true) parts.push("action_required=eq.YES");
  if (action_needed === false) parts.push("action_required=eq.NO");
  if (carrier) parts.push(`or=(carrier_name.ilike.*${enc(carrier)}*,carrier.ilike.*${enc(carrier)}*)`);
  if (customer) parts.push(`customer_name=ilike.*${enc(customer)}*`);
  if (query) {
    const q = enc(String(query).replace(/[(),*]/g, " ").trim());
    parts.push(`or=(tracking_number.ilike.*${q}*,shipment_id.ilike.*${q}*,customer_name.ilike.*${q}*,carrier_name.ilike.*${q}*,destination.ilike.*${q}*)`);
  }
  const rows = await sb(`fpx_shipments_latest?${parts.join("&")}`);
  return { count: rows.length, shipments: rows.map(compactShipment) };
}

async function toolGetShipment({ shipment, tracking, id } = {}) {
  let q;
  if (id) q = `id=eq.${enc(id)}`;
  else if (shipment) q = `shipment_id=eq.${enc(shipment)}`;
  else if (tracking) q = `tracking_number=eq.${enc(tracking)}`;
  else return { error: "Give shipment, tracking or id" };
  const rows = await sb(`fpx_shipments_latest?select=${SHIP_COLS},ship_from,ship_to,origin,comments,tracking_comments,pickup_response&${q}&limit=1`);
  const s = rows[0];
  if (!s) return { error: "Not found (it may have been archived)" };
  const tasks = await sb(`fpx_shipment_tasks?select=id,title,status,assigned_to,created_at&shipment_id=eq.${s.id}&archived_at=is.null&order=created_at.desc&limit=10`);
  return {
    ...compactShipment(s),
    recommendation: trim(s.ai_recommendation, 400),
    origin: s.origin, ship_from: trim(s.ship_from, 120), ship_to: trim(s.ship_to, 120),
    tracking_comments: trim(s.tracking_comments, 300), pickup_response: trim(s.pickup_response, 160),
    on_dashboard: !s.scraped_at || s.scraped_at >= (await dashboardCutoff()),
    tasks: tasks.map((t) => ({ task_id: t.id, task: trim(t.title, 160), status: t.status, assigned_to: t.assigned_to, created_at: t.created_at })),
  };
}

async function toolSummary() {
  const cutoff = await dashboardCutoff();
  const rows = await sb(`fpx_shipments_latest?select=shipment_status,action_required,carrier_name&scraped_at=gte.${enc(cutoff)}&limit=5000`);
  const by = (k) => rows.reduce((m, r) => ((m[r[k] || "(none)"] = (m[r[k] || "(none)"] || 0) + 1), m), {});
  const carriers = Object.entries(rows.filter((r) => r.action_required === "YES")
    .reduce((m, r) => ((m[r.carrier_name || "(unknown)"] = (m[r.carrier_name || "(unknown)"] || 0) + 1), m), {}))
    .sort((a, b) => b[1] - a[1]).slice(0, 8);
  return { on_dashboard: rows.length, by_status: by("shipment_status"), action_needed: by("action_required").YES || 0, action_needed_by_carrier: Object.fromEntries(carriers) };
}

const DATA_TOOLS = {
  focus_list: toolFocusList,
  search_shipments: toolSearchShipments,
  get_shipment: toolGetShipment,
  dashboard_summary: toolSummary,
};

// ---------------- UI tools (performed by the browser) ----------------

const UI_TOOLS = new Set(["open_shipment", "open_task", "filter_shipments", "navigate"]);

const PAGES = ["tracking", "tasks", "ops", "scraping", "notes", "analyses", "gp", "invoice"];

const obj = (properties, required = []) => ({ type: "object", properties, required, additionalProperties: false });

const TOOLS = [
  {
    name: "focus_list",
    description: "Open tasks whose shipment is still on the FreightPOP dashboard, pre-ranked by urgency signals (action needed, Issue status, past-ETA undelivered, task age). Use for 'what should I focus on' questions. Returns candidates with their shipment facts.",
    input_schema: obj({
      limit: { type: "integer", description: "How many candidates (max 60). Default 40." },
      assignee: { type: "string", description: "Only tasks assigned to this person (email or name fragment)." },
    }),
  },
  {
    name: "search_shipments",
    description: "Search shipments on the FreightPOP dashboard by free text (tracking #, shipment #, customer, carrier, destination) and/or filters.",
    input_schema: obj({
      query: { type: "string" },
      status: { type: "string", description: "In Transit | Booked | Out For Delivery | Issue" },
      action_needed: { type: "boolean" },
      carrier: { type: "string" },
      customer: { type: "string" },
      include_off_dashboard: { type: "boolean", description: "Also search shipments that left the dashboard (usually delivered). Default false." },
      limit: { type: "integer", description: "Max 50. Default 25." },
    }),
  },
  {
    name: "get_shipment",
    description: "Full detail for one shipment (by FreightPOP shipment number, tracking number, or internal id), including its open tasks.",
    input_schema: obj({ shipment: { type: "string" }, tracking: { type: "string" }, id: { type: "string" } }),
  },
  {
    name: "dashboard_summary",
    description: "Counts of shipments on the dashboard by status, how many need action, and which carriers have the most action-needed shipments.",
    input_schema: obj({}),
  },
  {
    name: "open_shipment",
    description: "Open a shipment's detail drawer in the user's dashboard. Needs the internal id from a search/focus/get result.",
    input_schema: obj({ id: { type: "string" }, label: { type: "string", description: "e.g. the shipment number, for the confirmation chip" } }, ["id"]),
  },
  {
    name: "open_task",
    description: "Open a task in the dashboard's task walk.",
    input_schema: obj({ task_id: { type: "string" }, label: { type: "string" } }, ["task_id"]),
  },
  {
    name: "filter_shipments",
    description: "Show the Tracking page filtered. Set every filter you want in ONE call; omitted fields are cleared. For 'action needed' views set action to \"YES\". customer must be an exact customer name from results.",
    input_schema: obj({
      query: { type: "string", description: "Free-text search box (tracking #, shipment #, customer, carrier…)" },
      action: { type: "string", enum: ["YES", "NO", "ERROR"], description: "YES = action needed, NO = on track" },
      customer: { type: "string" },
    }),
  },
  {
    name: "navigate",
    description: "Go to a dashboard page.",
    input_schema: obj({ page: { type: "string", enum: PAGES } }, ["page"]),
  },
].map((t) => ({ ...t, strict: true }));

const SYSTEM = `You are "Ask FPX", the operations assistant inside the FPX Control Station dashboard used by FreightPOP's freight support team. Reps track customer shipments (LTL, truckload, parcel), follow up with carriers and customers, and work a queue of tasks the AI raises.

What you do:
- Tell the rep what to focus on, and why, in plain words. Lead with the few shipments that need a person today: action needed, Issue status, missed delivery appointments, out for delivery past ETA with no delivery, stale tasks. Say what to do next (call the carrier, update the customer, book an appointment).
- Find shipments and answer questions about them from the data tools. Never invent shipment facts; if the data doesn't say, say so.
- Drive the dashboard when it helps: open a shipment or task, filter the Tracking list, or go to a page. When the rep asks to see/open/show something, do it with the UI tools rather than only describing it. Opening is cheap — open the one they asked about. For a list, prefer filter_shipments.

Data notes:
- "On the dashboard" means seen in FreightPOP's dashboard grid recently. Shipments that left it are usually delivered; ignore them unless asked.
- Shipment numbers (e.g. 15665897) and tracking numbers are different identifiers. open_shipment and open_task need internal ids from tool results.
- Every open task is marked "high" priority, so priority alone doesn't rank anything — use the shipment facts.

Style: short and scannable. For focus lists, a numbered list of at most 5–7 items: shipment number · customer · carrier — the problem — the next step. Use names and numbers, not internal ids. No preamble.`;

// One user turn. history: prior Anthropic.MessageParam[] exactly as returned
// by previous calls. Returns { messages, reply, actions, usage }.
export async function chat({ history = [], message, who, context }) {
  if (!assistantEnabled) throw new Error("Assistant not configured (ANTHROPIC_API_KEY / Supabase)");
  const messages = [...history];
  const ctx = context ? `\n\n[Dashboard context: ${trim(JSON.stringify(context), 600)}]` : "";
  messages.push({ role: "user", content: `${message}${ctx}` });
  const actions = [];
  const usage = { input: 0, output: 0, cache_read: 0 };

  for (let step = 0; step < MAX_STEPS; step++) {
    const response = await client.beta.messages.create({
      model: MODEL,
      max_tokens: 16000,
      // Opt-in server-side fallback if a request is declined by a safeguard.
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      cache_control: { type: "ephemeral" },
      output_config: { effort: "low" }, // chat: fast, fewer tool calls
      system: `${SYSTEM}\n\nThe rep you're helping is ${who?.email || "a team member"}. Today is ${new Date().toISOString().slice(0, 10)}.`,
      tools: TOOLS,
      messages,
    });
    usage.input += response.usage?.input_tokens || 0;
    usage.output += response.usage?.output_tokens || 0;
    usage.cache_read += response.usage?.cache_read_input_tokens || 0;
    messages.push({ role: "assistant", content: response.content });

    if (response.stop_reason === "refusal") {
      return { messages, reply: "I can't help with that one.", actions, usage };
    }
    if (response.stop_reason === "pause_turn") continue;
    if (response.stop_reason !== "tool_use") {
      const reply = response.content.filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
      return { messages, reply, actions, usage };
    }

    const results = [];
    for (const block of response.content.filter((b) => b.type === "tool_use")) {
      let out;
      try {
        if (UI_TOOLS.has(block.name)) {
          const action = { type: block.name, ...block.input };
          // Keep only the latest action of each kind (one filter, one open).
          const i = actions.findIndex((a) => a.type === action.type);
          if (i >= 0) actions.splice(i, 1);
          actions.push(action);
          out = { done: true, applied: block.input, note: "Applied in the rep's dashboard exactly as shown in `applied`. Don't call it again for the same request." };
        } else if (DATA_TOOLS[block.name]) {
          out = await DATA_TOOLS[block.name](block.input || {});
        } else {
          out = { error: `Unknown tool ${block.name}` };
        }
        results.push({ type: "tool_result", tool_use_id: block.id, content: JSON.stringify(out) });
      } catch (e) {
        results.push({ type: "tool_result", tool_use_id: block.id, is_error: true, content: String(e.message || e) });
      }
    }
    messages.push({ role: "user", content: results });
  }
  return { messages, reply: "That took more steps than I allow per question — try narrowing it down.", actions, usage };
}
