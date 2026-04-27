import { useEffect, useState } from "react";
import { ScrollText, RefreshCw, Filter } from "lucide-react";
import { api } from "../lib/api";
import { fmtDateTime } from "../lib/format";
import type { AuditLogEntry } from "../lib/types";

const ACTION_COLOR: Record<string, string> = {
  create: "bg-emerald-100 text-emerald-700",
  bulk_create: "bg-emerald-100 text-emerald-700",
  update: "bg-sky-100 text-sky-700",
  bulk_update: "bg-sky-100 text-sky-700",
  delete: "bg-rose-100 text-rose-700",
  override: "bg-amber-100 text-amber-800",
  auto_task: "bg-violet-100 text-violet-700",
};

const ENTITY_COLOR: Record<string, string> = {
  shipment: "bg-slate-100 text-slate-700",
  task: "bg-sky-100 text-sky-700",
  feedback: "bg-violet-100 text-violet-700",
  api_key: "bg-amber-100 text-amber-700",
  user: "bg-emerald-100 text-emerald-700",
};

export function AuditLogPage() {
  const [entries, setEntries] = useState<AuditLogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [entityType, setEntityType] = useState("");
  const [action, setAction] = useState("");
  const [actorEmail, setActorEmail] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const params: Record<string, string> = {};
      if (entityType) params.entity_type = entityType;
      if (action) params.action = action;
      if (actorEmail) params.actor_email = actorEmail;
      const r = await api.auditLog.list(params);
      setEntries(r.data);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); /* eslint-disable-line */ }, [entityType, action, actorEmail]);

  function toggle(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-semibold flex items-center gap-2"><ScrollText className="h-6 w-6 text-slate-700" /> Audit log</h1>
          <p className="text-sm text-slate-500 mt-0.5">Every shipment upsert, task change, override, and admin action. Most recent first.</p>
        </div>
        <button onClick={load} className="rounded-lg bg-slate-900 text-white text-sm px-3 py-2 flex items-center gap-1.5">
          <RefreshCw className="h-4 w-4" /> Refresh
        </button>
      </div>

      <div className="bg-white border border-slate-200 rounded-xl mb-4 p-3 flex items-center gap-3 flex-wrap">
        <Filter className="h-4 w-4 text-slate-400" />
        <select
          value={entityType}
          onChange={(e) => setEntityType(e.target.value)}
          className="rounded-lg border border-slate-200 px-3 py-1.5 text-sm bg-white"
        >
          <option value="">All entities</option>
          <option value="shipment">Shipments</option>
          <option value="task">Tasks</option>
          <option value="feedback">Feedback</option>
          <option value="api_key">API keys</option>
          <option value="user">Users</option>
        </select>
        <select
          value={action}
          onChange={(e) => setAction(e.target.value)}
          className="rounded-lg border border-slate-200 px-3 py-1.5 text-sm bg-white"
        >
          <option value="">All actions</option>
          <option value="create">Create</option>
          <option value="bulk_create">Bulk create</option>
          <option value="update">Update</option>
          <option value="bulk_update">Bulk update</option>
          <option value="delete">Delete</option>
          <option value="override">Override</option>
          <option value="auto_task">Auto task</option>
        </select>
        <input
          type="text"
          value={actorEmail}
          onChange={(e) => setActorEmail(e.target.value)}
          placeholder="Filter by actor email…"
          className="rounded-lg border border-slate-200 px-3 py-1.5 text-sm flex-1 min-w-[180px]"
        />
      </div>

      {error ? <div className="mb-4 rounded-lg bg-red-50 text-red-700 px-4 py-2 text-sm">{error}</div> : null}

      <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        {loading ? (
          <div className="text-center text-slate-400 py-10">Loading…</div>
        ) : entries.length === 0 ? (
          <div className="text-center text-slate-400 py-10">No audit entries match your filters.</div>
        ) : (
          <ul className="divide-y divide-slate-100">
            {entries.map((e) => {
              const isOpen = expanded.has(e.id);
              return (
                <li key={e.id} className="px-5 py-3 hover:bg-slate-50/60">
                  <button
                    onClick={() => toggle(e.id)}
                    className="w-full flex items-start gap-3 text-left"
                  >
                    <div className="text-xs text-slate-400 w-36 shrink-0 pt-1">{fmtDateTime(e.created_at)}</div>
                    <div className="flex items-center gap-1.5 shrink-0">
                      <span className={"text-[10px] uppercase font-semibold px-2 py-0.5 rounded-full " + (ACTION_COLOR[e.action] || "bg-slate-100 text-slate-700")}>
                        {e.action.replace("_", " ")}
                      </span>
                      <span className={"text-[10px] uppercase font-semibold px-2 py-0.5 rounded-full " + (ENTITY_COLOR[e.entity_type] || "bg-slate-100 text-slate-700")}>
                        {e.entity_type}
                      </span>
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="text-sm text-slate-800 truncate">{e.summary || "(no summary)"}</div>
                      <div className="text-xs text-slate-500 mt-0.5">
                        {e.actor_name || e.actor_email || "system"}
                        {e.actor_source ? <> · {e.actor_source}</> : null}
                        {e.entity_id ? <> · <span className="font-mono">{e.entity_id.slice(0, 8)}</span></> : null}
                      </div>
                    </div>
                    <span className="text-slate-400 text-xs">{isOpen ? "▾" : "▸"}</span>
                  </button>
                  {isOpen ? (
                    <div className="mt-3 grid md:grid-cols-2 gap-3 text-xs">
                      <div>
                        <div className="text-[10px] uppercase font-semibold text-slate-500 mb-1">Before</div>
                        <pre className="bg-slate-50 ring-1 ring-slate-200 rounded-lg p-3 max-h-60 overflow-auto whitespace-pre-wrap">{e.before ? JSON.stringify(e.before, null, 2) : "—"}</pre>
                      </div>
                      <div>
                        <div className="text-[10px] uppercase font-semibold text-slate-500 mb-1">After</div>
                        <pre className="bg-slate-50 ring-1 ring-slate-200 rounded-lg p-3 max-h-60 overflow-auto whitespace-pre-wrap">{e.after ? JSON.stringify(e.after, null, 2) : "—"}</pre>
                      </div>
                      {e.metadata ? (
                        <div className="md:col-span-2">
                          <div className="text-[10px] uppercase font-semibold text-slate-500 mb-1">Metadata</div>
                          <pre className="bg-slate-50 ring-1 ring-slate-200 rounded-lg p-3 max-h-40 overflow-auto whitespace-pre-wrap">{JSON.stringify(e.metadata, null, 2)}</pre>
                        </div>
                      ) : null}
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
