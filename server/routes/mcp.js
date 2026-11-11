import { Router } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import * as z from "zod/v4";
import { supabase } from "../lib/supabase.js";
import { hashApiKey, isConnectorOnlyKey } from "../lib/auth.js";
import { loadBoard } from "../lib/taskBoard.js";
import { TASK_SEGMENTS, TASK_FLAGS } from "../lib/taskSegments.js";
import { logGovernance } from "../lib/governance.js";
import { resolveOAuthAccess, PUBLIC_BASE } from "./oauth.js";

// FPX for Claude — a remote MCP server (Streamable HTTP, stateless).
// Read-only: search and read shipments, the focus list, the task board and
// run trends. Each rep connects with their own connector key (made on the
// "Connect Claude" page), so every call is attributable and revocable; the
// key only works here (see isConnectorOnlyKey in lib/auth.js).
//
//   claude.ai / Claude Desktop custom connector:  https://<api>/mcp/<key>
//   clients that send headers:                    POST /mcp  Authorization: Bearer <key>
//
// Every tool call is recorded in the AI governance log (event mcp_call).

export const mcpRouter = Router();

const RATE = new Map(); // key id → [timestamps]
function allow(id, perMin = 60) {
  const now = Date.now();
  const list = (RATE.get(id) || []).filter((t) => now - t < 60_000);
  if (list.length >= perMin) return false;
  list.push(now);
  RATE.set(id, list);
  return true;
}

// The connector key → its owner. Revoked keys, keys that aren't connector
// keys, and disabled accounts are refused.
async function resolveConnector(key) {
  if (!key || !/^fpx_live_[\w-]{20,}$/.test(key)) return null;
  const { data: k } = await supabase.from("fpx_api_keys")
    .select("id, name, scopes, revoked_at, user_id").eq("key_hash", hashApiKey(key)).maybeSingle();
  if (!k || k.revoked_at || !isConnectorOnlyKey(k) || !k.user_id) return null;
  const { data: u } = await supabase.from("fpx_user_profiles")
    .select("id, email, role, enabled").eq("id", k.user_id).maybeSingle();
  if (!u || !u.enabled) return null;
  supabase.from("fpx_api_keys").update({ last_used_at: new Date().toISOString() }).eq("id", k.id).then(() => {});
  return { keyId: k.id, user: { id: u.id, email: u.email, role: u.role } };
}

const trim = (s, n = 200) => (s == null ? null : String(s).length > n ? String(s).slice(0, n) + "…" : String(s));
const json = (v) => ({ content: [{ type: "text", text: JSON.stringify(v, null, 1) }] });
const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

function slim(f = {}) {
  return {
    id: f.id, shipment: f.shipment, tracking: f.tracking, customer: f.customer, carrier: f.carrier, mode: f.mode,
    status: f.status, action_needed: f.action_needed, issue: trim(f.issue, 200), eta: f.eta, delivered: f.delivered,
    appointment: f.appointment, origin: trim(f.origin, 60), destination: trim(f.destination, 60),
    latest_note: f.latest_note ? trim(f.latest_note.note, 160) : undefined, open_tasks: (f.tasks || []).length || undefined,
  };
}

function buildServer(who) {
  const server = new McpServer({ name: "fpx", version: "1.0.0" }, {
    instructions:
      "FPX is FreightPOP's freight-tracking control station. Use these read-only tools to find shipments, see what needs attention, " +
      "read the task board and see how the FreightPOP dashboard is trending across scrape runs. Shipment numbers (e.g. 15496050) and " +
      "tracking numbers are different identifiers. 'On the dashboard' means seen in FreightPOP's grid in the last day; shipments that " +
      "left it are usually delivered. Nothing here changes data.",
  });

  // Wrap every tool: log the call for governance, then run it.
  const tool = (name, config, fn) => server.registerTool(name, { ...config, annotations: { ...READ_ONLY, title: config.title } }, async (args) => {
    logGovernance({ user: who.user }, {
      event_type: "mcp_call", feature: `mcp.${name}`,
      summary: `Claude connector: ${name}${args && Object.keys(args).length ? ` ${trim(JSON.stringify(args), 120)}` : ""}`,
      metadata: { tool: name, args: args || {}, via: "mcp" },
    });
    try { return await fn(args || {}); }
    catch (e) { return { isError: true, content: [{ type: "text", text: `Error: ${e.message}` }] }; }
  });

  tool("search_shipments", {
    title: "Search shipments",
    description: "Search shipments by shipment #, tracking #, customer, carrier, place, or a description of the problem (e.g. 'held at terminal waiting on appointment'). Optional filters narrow the results. Defaults to shipments on the FreightPOP dashboard.",
    inputSchema: {
      query: z.string().optional().describe("Free text: ids, names, places or a description"),
      status: z.string().optional().describe("In Transit | Booked | Out For Delivery | Issue"),
      action_needed: z.boolean().optional(),
      carrier: z.string().optional(),
      customer: z.string().optional(),
      include_off_dashboard: z.boolean().optional().describe("Also search shipments that left the dashboard (usually delivered)"),
      limit: z.number().int().min(1).max(30).optional().describe("Default 12"),
    },
  }, async ({ query, status, action_needed, carrier, customer, include_off_dashboard = false, limit = 12 }) => {
    let list;
    if (query && query.trim()) {
      const { data, error } = await supabase.rpc("fpx_assistant_search", { p_query: query, p_include_off_dashboard: !!include_off_dashboard, p_limit: 50, p_embedding: null });
      if (error) throw new Error(error.message);
      list = (data || []).map((r) => r.facts);
    } else {
      let q = supabase.from("fpx_assistant_index").select("facts").order("focus_score", { ascending: false }).limit(200);
      if (!include_off_dashboard) q = q.eq("on_dashboard", true);
      if (status) q = q.ilike("status", status);
      if (action_needed != null) q = q.eq("action_needed", action_needed);
      if (carrier) q = q.ilike("carrier", `%${carrier}%`);
      if (customer) q = q.ilike("customer", `%${customer}%`);
      const { data, error } = await q;
      if (error) throw new Error(error.message);
      list = (data || []).map((r) => r.facts);
    }
    const lc = (v) => String(v || "").toLowerCase();
    list = list.filter((f) => (!status || lc(f.status) === lc(status)) && (action_needed == null || !!f.action_needed === action_needed)
      && (!carrier || lc(f.carrier).includes(lc(carrier))) && (!customer || lc(f.customer).includes(lc(customer))));
    return json({ count: list.length, shown: Math.min(limit, list.length), shipments: list.slice(0, limit).map(slim) });
  });

  tool("get_shipment", {
    title: "Shipment detail",
    description: "Everything FPX knows about one shipment: status, ETA, AI issue and recommendation, tracking comments, open tasks and the latest note. Give a shipment #, tracking # or internal id.",
    inputSchema: { shipment: z.string().optional(), tracking: z.string().optional(), id: z.string().optional() },
  }, async ({ shipment, tracking, id }) => {
    if (!shipment && !tracking && !id) return json({ error: "Give shipment, tracking or id" });
    let q = supabase.from("fpx_assistant_index").select("facts").limit(1);
    q = id ? q.eq("shipment_uuid", id) : shipment ? q.eq("shipment_id", shipment) : q.eq("tracking_number", tracking);
    const { data } = await q;
    if (data?.[0]) return json(data[0].facts);
    let s = supabase.from("fpx_shipments_latest").select("id, shipment_id, tracking_number, customer_name, carrier_name, carrier, mode, shipment_status, action_required, ai_issue, ai_recommendation, updated_eta, estimated_arrival, delivery_date, appointment_date, origin, destination, tracking_comments, scraped_at, archived_at").limit(1);
    s = id ? s.eq("id", id) : shipment ? s.eq("shipment_id", shipment) : s.eq("tracking_number", tracking);
    const { data: rows, error } = await s;
    if (error) throw new Error(error.message);
    if (!rows?.[0]) return json({ error: "Not found" });
    const r = rows[0];
    return json({
      id: r.id, shipment: r.shipment_id, tracking: r.tracking_number, customer: r.customer_name, carrier: r.carrier_name || r.carrier,
      mode: r.mode, status: r.shipment_status, action_needed: r.action_required === "YES", issue: r.ai_issue, recommendation: r.ai_recommendation,
      eta: r.updated_eta || r.estimated_arrival, delivered: r.delivery_date, appointment: r.appointment_date, origin: r.origin,
      destination: r.destination, tracking_comments: trim(r.tracking_comments, 400), last_seen: r.scraped_at, archived: !!r.archived_at,
      on_dashboard: false,
    });
  });

  tool("focus_list", {
    title: "What to focus on",
    description: "Open tasks whose shipment is still on the FreightPOP dashboard, ranked by urgency (action needed, Issue status, past ETA and not delivered, blocked, task age). Use for 'what should we work on'.",
    inputSchema: {
      assignee: z.string().optional().describe("Only tasks assigned to this person (email or name fragment)"),
      limit: z.number().int().min(1).max(40).optional().describe("Default 15"),
    },
  }, async ({ assignee, limit = 15 }) => {
    const { data, error } = await supabase.from("fpx_assistant_index").select("facts, focus_score")
      .gt("open_tasks", 0).eq("on_dashboard", true).order("focus_score", { ascending: false }).limit(1000);
    if (error) throw new Error(error.message);
    const who = assignee ? assignee.toLowerCase() : null;
    const items = [];
    for (const r of data || []) for (const t of r.facts.tasks || []) {
      if (who && !String(t.assigned_to || "").toLowerCase().includes(who)) continue;
      items.push({ task_id: t.task_id, task: trim(t.task, 140), task_status: t.status, assigned_to: t.assigned_to, age_days: t.age_days, urgency: Math.round(r.focus_score), shipment: slim(r.facts) });
    }
    return json({ open_tasks_on_dashboard: items.length, top: items.slice(0, limit) });
  });

  tool("dashboard_summary", {
    title: "Dashboard summary",
    description: "Shipments on the FreightPOP dashboard by status, how many need action, and which carriers have the most action-needed shipments.",
    inputSchema: {},
  }, async () => {
    // Counted in the database (a plain select is capped at 1,000 rows).
    const { data, error } = await supabase.rpc("fpx_assistant_summary");
    if (error) throw new Error(error.message);
    const s = data || {};
    return json({ ...s, action_needed_by_carrier: Object.fromEntries(Object.entries(s.action_needed_by_carrier || {}).sort((a, b) => b[1] - a[1])) });
  });

  tool("task_board", {
    title: "Task board",
    description: "The Tasks board in numbers: active tasks, needs attention, tasks by segment (carrier / customer follow-ups, storage risk, redelivery, return/claim, other), health flags (likely resolved, stale, aging, duplicate…) and by owner.",
    inputSchema: {},
  }, async () => {
    const board = await loadBoard({ includeClosed: false });
    return json({
      ...board.summary, by_carrier: undefined, by_customer: undefined,
      segments: TASK_SEGMENTS.map((x) => ({ id: x.id, label: x.label, description: x.description })),
      flags: TASK_FLAGS.map((x) => ({ id: x.id, label: x.label, description: x.description })),
    });
  });

  tool("list_tasks", {
    title: "List tasks",
    description: "Active tasks on the board with their shipment, optionally filtered by segment, health flag, owner or carrier.",
    inputSchema: {
      segment: z.enum(["redelivery", "return_claim", "storage_risk", "carrier", "customer", "other"]).optional(),
      flag: z.enum(["resolved_upstream", "stale", "duplicate", "repeat", "aging", "unassigned", "blocked"]).optional(),
      assignee: z.string().optional(),
      carrier: z.string().optional(),
      limit: z.number().int().min(1).max(50).optional().describe("Default 20"),
    },
  }, async ({ segment, flag, assignee, carrier, limit = 20 }) => {
    const board = await loadBoard({ includeClosed: false });
    const lc = (v) => String(v || "").toLowerCase();
    const rows = board.rows.filter((r) => (!segment || r.seg.segment === segment) && (!flag || r.seg.flags.includes(flag))
      && (!assignee || lc(r.task.assigned_to).includes(lc(assignee)))
      && (!carrier || lc(r.shipment?.carrier_name || r.shipment?.carrier).includes(lc(carrier))));
    return json({
      count: rows.length,
      tasks: rows.slice(0, limit).map((r) => ({
        task_id: r.task.id, title: trim(r.task.title, 160), status: r.task.status, assigned_to: r.task.assigned_to, created_at: r.task.created_at,
        segment: r.seg.segment, flags: r.seg.flags,
        shipment: r.shipment ? { id: r.shipment.id, shipment: r.shipment.shipment_id, tracking: r.shipment.tracking_number, customer: r.shipment.customer_name, carrier: r.shipment.carrier_name || r.shipment.carrier, status: r.shipment.shipment_status, eta: r.shipment.updated_eta } : null,
      })),
    });
  });

  tool("run_trends", {
    title: "Run trends",
    description: "FreightPOP dashboard totals (Total, Booked, In Transit, Issues, Out for Delivery) and the task board, before and after each recent scrape run — for spotting trends.",
    inputSchema: { limit: z.number().int().min(1).max(30).optional().describe("Most recent runs, default 10") },
  }, async ({ limit = 10 }) => {
    const { data, error } = await supabase.from("fpx_scrape_runs")
      .select("started_at, finished_at, ok, source, schedule_name, fp_before, fp_after, tasks_before, tasks_after, counts")
      .or("fp_before.not.is.null,fp_after.not.is.null,tasks_before.not.is.null")
      .order("started_at", { ascending: false }).limit(limit);
    if (error) throw new Error(error.message);
    const t = (s) => (s ? { active: s.active, needs_attention: s.needs_attention, by_segment: s.by_segment, dispositions: s.dispositions } : null);
    return json({
      runs: (data || []).map((r) => ({
        started_at: r.started_at, finished_at: r.finished_at, ok: r.ok, source: r.source, schedule: r.schedule_name,
        saved: r.counts?.saved ?? null, freightpop_before: r.fp_before, freightpop_after: r.fp_after,
        tasks_before: t(r.tasks_before), tasks_after: t(r.tasks_after),
      })),
    });
  });

  return server;
}

async function handle(req, res, key) {
  // A signed-in Claude (OAuth access token) or a personal connector key.
  const who = key?.startsWith("fpx_oat_") ? await resolveOAuthAccess(key) : await resolveConnector(key);
  if (!who) {
    // Tells Claude where to sign in (OAuth discovery, RFC 9728).
    res.set("WWW-Authenticate", `Bearer resource_metadata="${PUBLIC_BASE}/.well-known/oauth-protected-resource", scope="fpx.read"`);
    return res.status(401).json({ jsonrpc: "2.0", error: { code: -32001, message: key ? "Your FPX sign-in has expired or was revoked — reconnect FPX in Claude." : "Sign in to FPX to use this connector." }, id: null });
  }
  if (!allow(who.keyId)) {
    return res.status(429).json({ jsonrpc: "2.0", error: { code: -32002, message: "Too many requests — slow down." }, id: null });
  }
  const server = buildServer(who);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => { transport.close(); server.close(); });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (e) {
    console.error("[mcp] error:", e.message);
    if (!res.headersSent) res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
  }
}

const bearer = (req) => /^Bearer\s+(.+)$/i.exec(req.header("authorization") || "")?.[1] || null;
const notAllowed = (_req, res) => res.status(405).json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null });

mcpRouter.post("/", (req, res) => handle(req, res, bearer(req)));
mcpRouter.post("/:key", (req, res) => handle(req, res, req.params.key));
mcpRouter.get("/", notAllowed);
mcpRouter.get("/:key", notAllowed);
mcpRouter.delete("/", notAllowed);
mcpRouter.delete("/:key", notAllowed);
