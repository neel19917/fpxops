import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, CheckCircle2, Package, Search, Users, XOctagon, ListChecks, X, Mail, Copy, Check, Plus, CircleCheck, Circle } from "lucide-react";
import { api } from "../lib/api";
import { fmtDate, fmtDateTime, fmtRelative, fmtUsd } from "../lib/format";
import type { AiAnalysis, EmailDraft, Shipment, ShipmentTask, TaskStatus } from "../lib/types";
import { ActionBadge } from "../components/Badge";
import { KPI } from "../components/KPI";
import { Drawer, Field, Section } from "../components/Drawer";
import { ShareButton } from "../components/ShareButton";

export function ShipmentsPage() {
  const [rows, setRows] = useState<Shipment[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  const [q, setQ] = useState("");
  const [actionFilter, setActionFilter] = useState<string>("");
  const [customerFilter, setCustomerFilter] = useState<string>("");

  const [drawerId, setDrawerId] = useState<string | null>(null);
  const [drawerData, setDrawerData] = useState<{ shipment: Shipment; analyses: AiAnalysis[] } | null>(null);

  // Bulk selection for "create task on N shipments at once".
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulkTitle, setBulkTitle] = useState("");
  const [bulkPriority, setBulkPriority] = useState<"low" | "normal" | "high" | "urgent">("normal");
  const [bulkAssignee, setBulkAssignee] = useState("");
  const [bulkSubmitting, setBulkSubmitting] = useState(false);
  const [bulkResult, setBulkResult] = useState<string | null>(null);

  // Per-shipment tasks shown inside the drawer.
  const [drawerTasks, setDrawerTasks] = useState<ShipmentTask[]>([]);
  const [newTaskTitle, setNewTaskTitle] = useState("");
  const [newTaskBusy, setNewTaskBusy] = useState(false);

  // Email draft modal.
  const [emailModal, setEmailModal] = useState<{
    audience: "carrier" | "customer";
    data: EmailDraft | null;
    loading: boolean;
    copied: boolean;
  } | null>(null);

  async function load() {
    setLoading(true); setErr(null);
    try {
      const r = await api.shipments.list({ limit: 2000 });
      setRows(r.data);
    } catch (e) { setErr((e as Error).message); }
    setLoading(false);
  }
  useEffect(() => { load(); }, []);

  // Drawer-level tab navigation.
  const [drawerTab, setDrawerTab] = useState<"overview" | "tasks" | "email" | "history" | "raw">("overview");

  useEffect(() => {
    if (!drawerId) {
      setDrawerData(null);
      setDrawerTasks([]);
      setDrawerTab("overview");
      setEmailModal(null);
      setNewTaskTitle("");
      return;
    }
    api.shipments.get(drawerId).then(setDrawerData).catch(() => setDrawerData(null));
    api.tasks.listForShipment(drawerId).then((r) => setDrawerTasks(r.data)).catch(() => setDrawerTasks([]));
  }, [drawerId]);

  async function addDrawerTask() {
    if (!drawerId || !newTaskTitle.trim()) return;
    setNewTaskBusy(true);
    try {
      const r = await api.tasks.create(drawerId, { title: newTaskTitle.trim() });
      setDrawerTasks((p) => [r.task, ...p]);
      setNewTaskTitle("");
    } catch (e) { setErr((e as Error).message); }
    finally { setNewTaskBusy(false); }
  }
  async function toggleDrawerTask(t: ShipmentTask) {
    const status: TaskStatus = t.status === "done" ? "open" : "done";
    try {
      const r = await api.tasks.update(t.id, { status });
      setDrawerTasks((p) => p.map((x) => (x.id === r.task.id ? r.task : x)));
    } catch (e) { setErr((e as Error).message); }
  }
  async function openEmailDraft(audience: "carrier" | "customer") {
    if (!drawerId) return;
    setEmailModal({ audience, data: null, loading: true, copied: false });
    try {
      const draft = await api.emailDraft.generate(drawerId, audience);
      setEmailModal({ audience, data: draft, loading: false, copied: false });
    } catch (e) {
      setEmailModal({ audience, data: { subject: "Error", body: (e as Error).message }, loading: false, copied: false });
    }
  }
  async function copyEmail() {
    if (!emailModal?.data) return;
    const txt = `Subject: ${emailModal.data.subject}\n\n${emailModal.data.body}`;
    try { await navigator.clipboard.writeText(txt); } catch {}
    setEmailModal({ ...emailModal, copied: true });
    setTimeout(() => setEmailModal((m) => (m ? { ...m, copied: false } : m)), 1500);
  }

  const customers = useMemo(() => {
    const set = new Set<string>();
    for (const r of rows) if (r.customer_name) set.add(r.customer_name);
    return Array.from(set).sort();
  }, [rows]);

  const filtered = useMemo(() => {
    return rows.filter((r) => {
      if (actionFilter && String(r.action_required || "").toUpperCase() !== actionFilter) return false;
      if (customerFilter && r.customer_name !== customerFilter) return false;
      if (q) {
        const hay = [r.tracking_number, r.customer_name, r.carrier_name, r.carrier, r.ai_issue, r.shipment_status]
          .map((x) => (x || "").toLowerCase()).join(" ");
        if (!hay.includes(q.toLowerCase())) return false;
      }
      return true;
    });
  }, [rows, q, actionFilter, customerFilter]);

  const allFilteredSelected = filtered.length > 0 && filtered.every((r) => selectedIds.has(r.id));
  function toggleRow(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }
  function toggleAllFiltered() {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (allFilteredSelected) for (const r of filtered) next.delete(r.id);
      else for (const r of filtered) next.add(r.id);
      return next;
    });
  }
  function clearSelection() { setSelectedIds(new Set()); }

  async function submitBulk() {
    if (!bulkTitle.trim() || selectedIds.size === 0) return;
    setBulkSubmitting(true); setBulkResult(null);
    try {
      const r = await api.tasks.bulkCreate({
        shipment_ids: Array.from(selectedIds),
        title: bulkTitle.trim(),
        priority: bulkPriority,
        assigned_to: bulkAssignee.trim() || undefined,
      });
      setBulkResult(`Created ${r.created} task${r.created === 1 ? "" : "s"}` + (r.missing.length ? ` · ${r.missing.length} not found` : ""));
      setBulkTitle(""); setBulkAssignee("");
      clearSelection();
      setTimeout(() => { setBulkOpen(false); setBulkResult(null); }, 1500);
    } catch (e) {
      setBulkResult("Error: " + (e as Error).message);
    } finally {
      setBulkSubmitting(false);
    }
  }

  const kpis = useMemo(() => {
    const total = rows.length;
    const action = rows.filter((r) => String(r.action_required || "").toUpperCase() === "YES").length;
    const ontrack = rows.filter((r) => String(r.action_required || "").toUpperCase() === "NO").length;
    const errors = rows.filter((r) => String(r.action_required || "").toUpperCase() === "ERROR").length;
    const custs = new Set(rows.map((r) => r.customer_name).filter(Boolean)).size;
    return { total, action, ontrack, errors, custs };
  }, [rows]);

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <KPI label="Shipments" value={kpis.total} icon={Package} tone="brand" />
        <KPI label="Action needed" value={kpis.action} icon={AlertTriangle} tone="danger" />
        <KPI label="On track" value={kpis.ontrack} icon={CheckCircle2} tone="success" />
        <KPI label="Errors" value={kpis.errors} icon={XOctagon} tone="warn" />
        <KPI label="Customers" value={kpis.custs} icon={Users} />
      </div>

      <div className="bg-white rounded-2xl ring-1 ring-slate-200 shadow-sm">
        <div className="p-4 border-b border-slate-100 flex flex-col md:flex-row gap-2 md:items-center">
          <div className="relative flex-1 min-w-[240px]">
            <Search className="h-4 w-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
            <input
              className="w-full pl-9 pr-3 py-2 rounded-lg border border-slate-300 text-sm focus:ring-2 focus:ring-sky-400 focus:border-sky-400"
              placeholder="Search tracking, customer, carrier, issue…"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
          </div>
          <select
            className="px-3 py-2 rounded-lg border border-slate-300 text-sm"
            value={actionFilter}
            onChange={(e) => setActionFilter(e.target.value)}
          >
            <option value="">All actions</option>
            <option value="YES">Action needed</option>
            <option value="NO">On track</option>
            <option value="ERROR">Error</option>
          </select>
          <select
            className="px-3 py-2 rounded-lg border border-slate-300 text-sm max-w-[220px]"
            value={customerFilter}
            onChange={(e) => setCustomerFilter(e.target.value)}
          >
            <option value="">All customers</option>
            {customers.map((c) => <option key={c}>{c}</option>)}
          </select>
          <button
            onClick={load}
            className="px-3 py-2 text-sm font-medium rounded-lg bg-slate-900 text-white hover:bg-slate-800"
          >
            Refresh
          </button>
        </div>

        {err ? (
          <div className="p-4 bg-rose-50 border-b border-rose-200 text-rose-800 text-sm">
            {err}
          </div>
        ) : null}

        {selectedIds.size > 0 ? (
          <div className="flex items-center gap-3 px-4 py-2.5 bg-sky-50 border-b border-sky-200 text-sm">
            <span className="font-medium text-sky-900">{selectedIds.size} selected</span>
            <button
              onClick={() => setBulkOpen(true)}
              className="px-3 py-1.5 rounded-lg bg-slate-900 text-white text-xs font-medium hover:bg-slate-800 flex items-center gap-1.5"
            >
              <ListChecks className="h-4 w-4" /> Bulk-create task
            </button>
            <button onClick={clearSelection} className="text-xs text-sky-700 hover:text-sky-900 flex items-center gap-1">
              <X className="h-3.5 w-3.5" /> Clear selection
            </button>
          </div>
        ) : null}

        <div className="overflow-auto max-h-[calc(100vh-340px)]">
          <table className="w-full text-sm">
            <thead className="bg-slate-50/80 backdrop-blur sticky top-0">
              <tr className="text-left text-[11px] uppercase tracking-wide text-slate-500">
                <th className="px-3 py-2.5 w-10">
                  <input
                    type="checkbox"
                    checked={allFilteredSelected}
                    onChange={toggleAllFiltered}
                    aria-label="Select all"
                    className="cursor-pointer"
                  />
                </th>
                <th className="px-4 py-2.5 font-medium">Scraped</th>
                <th className="px-4 py-2.5 font-medium">Tracking</th>
                <th className="px-4 py-2.5 font-medium">Customer</th>
                <th className="px-4 py-2.5 font-medium">Carrier</th>
                <th className="px-4 py-2.5 font-medium">Status</th>
                <th className="px-4 py-2.5 font-medium">Action</th>
                <th className="px-4 py-2.5 font-medium">Issue</th>
                <th className="px-4 py-2.5 font-medium">Delivery</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {loading ? (
                <tr><td colSpan={9} className="p-8 text-center text-slate-500">Loading…</td></tr>
              ) : filtered.length === 0 ? (
                <tr><td colSpan={9} className="p-8 text-center text-slate-500">No shipments match your filters.</td></tr>
              ) : filtered.map((r) => (
                <tr
                  key={r.id}
                  className={(selectedIds.has(r.id) ? "bg-sky-50/70 " : "") + "hover:bg-sky-50/50"}
                >
                  <td className="px-3 py-2.5 w-10" onClick={(e) => e.stopPropagation()}>
                    <input
                      type="checkbox"
                      checked={selectedIds.has(r.id)}
                      onChange={() => toggleRow(r.id)}
                      aria-label={`Select ${r.tracking_number}`}
                      className="cursor-pointer"
                    />
                  </td>
                  <td onClick={() => setDrawerId(r.id)} className="px-4 py-2.5 text-slate-500 whitespace-nowrap cursor-pointer" title={fmtDateTime(r.scraped_at)}>{fmtRelative(r.scraped_at)}</td>
                  <td onClick={() => setDrawerId(r.id)} className="px-4 py-2.5 font-medium whitespace-nowrap cursor-pointer">{r.tracking_number || "—"}</td>
                  <td onClick={() => setDrawerId(r.id)} className="px-4 py-2.5 whitespace-nowrap cursor-pointer">{r.customer_name || "—"}</td>
                  <td onClick={() => setDrawerId(r.id)} className="px-4 py-2.5 whitespace-nowrap cursor-pointer">{r.carrier_name || r.carrier || "—"}</td>
                  <td onClick={() => setDrawerId(r.id)} className="px-4 py-2.5 cursor-pointer">{r.shipment_status || "—"}</td>
                  <td onClick={() => setDrawerId(r.id)} className="px-4 py-2.5 cursor-pointer"><ActionBadge action={r.action_required} size="sm" /></td>
                  <td onClick={() => setDrawerId(r.id)} className="px-4 py-2.5 max-w-[320px] truncate cursor-pointer" title={r.ai_issue || ""}>{r.ai_issue || "—"}</td>
                  <td onClick={() => setDrawerId(r.id)} className="px-4 py-2.5 whitespace-nowrap text-slate-600 cursor-pointer">{fmtDate(r.delivery_date)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {bulkOpen ? (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-slate-900/40 backdrop-blur-sm" onClick={() => !bulkSubmitting && setBulkOpen(false)}>
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md p-6" onClick={(e) => e.stopPropagation()}>
            <h2 className="text-lg font-semibold mb-1">Bulk-create task</h2>
            <p className="text-sm text-slate-500 mb-4">Creates one task on each of the {selectedIds.size} selected shipments. If no assignee is set, each task auto-assigns to whoever scraped that shipment.</p>
            <div className="space-y-3">
              <div>
                <label className="text-xs text-slate-500 block mb-1">Title</label>
                <input
                  value={bulkTitle}
                  onChange={(e) => setBulkTitle(e.target.value)}
                  className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
                  placeholder="e.g. Follow up with carrier on missed delivery"
                  required
                  autoFocus
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs text-slate-500 block mb-1">Priority</label>
                  <select
                    value={bulkPriority}
                    onChange={(e) => setBulkPriority(e.target.value as typeof bulkPriority)}
                    className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm bg-white"
                  >
                    <option value="low">Low</option>
                    <option value="normal">Normal</option>
                    <option value="high">High</option>
                    <option value="urgent">Urgent</option>
                  </select>
                </div>
                <div>
                  <label className="text-xs text-slate-500 block mb-1">Assignee (override)</label>
                  <input
                    value={bulkAssignee}
                    onChange={(e) => setBulkAssignee(e.target.value)}
                    className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
                    placeholder="(blank = runner)"
                  />
                </div>
              </div>
              {bulkResult ? <div className="text-sm text-emerald-700">{bulkResult}</div> : null}
              <div className="flex gap-2 justify-end pt-2">
                <button
                  onClick={() => setBulkOpen(false)}
                  disabled={bulkSubmitting}
                  className="px-4 py-2 text-sm rounded-lg text-slate-600 hover:bg-slate-100"
                >Cancel</button>
                <button
                  onClick={submitBulk}
                  disabled={bulkSubmitting || !bulkTitle.trim()}
                  className="px-4 py-2 text-sm rounded-lg bg-slate-900 text-white hover:bg-slate-800 disabled:opacity-50"
                >{bulkSubmitting ? "Creating…" : `Create ${selectedIds.size} task${selectedIds.size === 1 ? "" : "s"}`}</button>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      <Drawer
        open={!!drawerId}
        onClose={() => setDrawerId(null)}
        title={drawerData?.shipment.tracking_number || "Shipment"}
        subtitle={drawerData?.shipment.customer_name || undefined}
      >
        {drawerData ? (
          <>
            <div className="flex justify-end mb-3">
              <ShareButton
                resourceType="shipment"
                resourceId={drawerData.shipment.id}
                defaultLabel={`Shipment ${drawerData.shipment.tracking_number || ""}`.trim()}
              />
            </div>
            <div className="flex gap-1 border-b border-slate-200 mb-5 -mx-1 px-1 overflow-x-auto">
              {([
                { id: "overview", label: "Overview", count: null },
                { id: "tasks", label: "Tasks", count: drawerTasks.length },
                { id: "email", label: "Email", count: null },
                { id: "history", label: "Analysis", count: drawerData.analyses.length },
                { id: "raw", label: "Raw", count: null },
              ] as const).map((t) => (
                <button
                  key={t.id}
                  onClick={() => setDrawerTab(t.id)}
                  className={
                    "px-3 py-2 text-sm font-medium whitespace-nowrap border-b-2 -mb-px transition " +
                    (drawerTab === t.id
                      ? "border-sky-500 text-sky-700"
                      : "border-transparent text-slate-500 hover:text-slate-900 hover:border-slate-300")
                  }
                >
                  {t.label}
                  {t.count != null && t.count > 0 ? (
                    <span className="ml-1.5 inline-flex items-center justify-center text-[10px] font-semibold bg-slate-200 text-slate-700 rounded-full px-1.5 py-0.5 min-w-[18px]">{t.count}</span>
                  ) : null}
                </button>
              ))}
            </div>

            {drawerTab === "overview" && (
              <>
                <Section title="Shipment">
                  <div className="grid grid-cols-2 gap-4">
                    <Field label="Carrier">{drawerData.shipment.carrier_name || drawerData.shipment.carrier}</Field>
                    <Field label="Mode">{drawerData.shipment.mode}</Field>
                    <Field label="Status">{drawerData.shipment.shipment_status}</Field>
                    <Field label="Action"><ActionBadge action={drawerData.shipment.action_required} /></Field>
                    <Field label="Pickup">{fmtDateTime(drawerData.shipment.pickup_date)}</Field>
                    <Field label="ETA">{fmtDateTime(drawerData.shipment.updated_eta)}</Field>
                    <Field label="Delivery">{fmtDateTime(drawerData.shipment.delivery_date)}</Field>
                    <Field label="Signed By">{drawerData.shipment.signed_by}</Field>
                    <Field label="Origin">{drawerData.shipment.ship_from || drawerData.shipment.origin}</Field>
                    <Field label="Destination">{drawerData.shipment.ship_to || drawerData.shipment.destination}</Field>
                    <Field label="GP">{drawerData.shipment.shipment_gross_profit}</Field>
                    <Field label="Rate (marked up)">{drawerData.shipment.shipment_marked_up_rate}</Field>
                  </div>
                </Section>
                <Section title="AI summary">
                  <Field label="Issue">{drawerData.shipment.ai_issue}</Field>
                  <div className="h-3" />
                  <Field label="Recommendation">{drawerData.shipment.ai_recommendation}</Field>
                </Section>
              </>
            )}

            {drawerTab === "tasks" && (
              <Section title={`Tasks (${drawerTasks.length})`}>
                <div className="flex gap-2 mb-4">
                  <input
                    value={newTaskTitle}
                    onChange={(e) => setNewTaskTitle(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") addDrawerTask(); }}
                    placeholder="New task title…"
                    className="flex-1 px-3 py-2 rounded-lg border border-slate-300 text-sm"
                  />
                  <button
                    onClick={addDrawerTask}
                    disabled={!newTaskTitle.trim() || newTaskBusy}
                    className="px-3 py-2 rounded-lg bg-slate-900 text-white text-sm font-medium hover:bg-slate-800 disabled:opacity-50 flex items-center gap-1"
                  >
                    <Plus className="h-4 w-4" /> Add
                  </button>
                </div>
                {drawerTasks.length === 0 ? (
                  <div className="text-sm text-slate-500 text-center py-6">No tasks yet. Auto-assigned to <b>{drawerData.shipment.created_by || "—"}</b> when created here.</div>
                ) : (
                  <ul className="space-y-2">
                    {drawerTasks.map((t) => (
                      <li key={t.id} className="flex items-start gap-3 p-3 rounded-xl bg-slate-50 ring-1 ring-slate-200">
                        <button
                          onClick={() => toggleDrawerTask(t)}
                          className="text-slate-500 hover:text-slate-900 mt-0.5"
                          aria-label={t.status === "done" ? "Mark incomplete" : "Mark done"}
                        >
                          {t.status === "done"
                            ? <CircleCheck className="h-5 w-5 text-emerald-600" />
                            : <Circle className="h-5 w-5" />}
                        </button>
                        <div className="flex-1 min-w-0">
                          <div className={"text-sm " + (t.status === "done" ? "line-through text-slate-400" : "text-slate-900 font-medium")}>{t.title}</div>
                          <div className="text-xs text-slate-500 mt-0.5">
                            {t.assigned_to ? <>Assigned to <b>{t.assigned_to}</b> · </> : null}
                            {t.priority} · {fmtRelative(t.created_at)}
                          </div>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </Section>
            )}

            {drawerTab === "email" && (
              <Section title="Email drafts">
                <p className="text-sm text-slate-500 mb-4">Generate a Claude-drafted follow-up email using this shipment's context.</p>
                <div className="grid grid-cols-2 gap-3">
                  <button
                    onClick={() => openEmailDraft("carrier")}
                    className="flex items-center justify-center gap-2 px-4 py-3 rounded-xl bg-slate-900 text-white text-sm font-medium hover:bg-slate-800"
                  >
                    <Mail className="h-4 w-4" /> Email carrier
                  </button>
                  <button
                    onClick={() => openEmailDraft("customer")}
                    className="flex items-center justify-center gap-2 px-4 py-3 rounded-xl bg-sky-600 text-white text-sm font-medium hover:bg-sky-700"
                  >
                    <Mail className="h-4 w-4" /> Email customer
                  </button>
                </div>
                <div className="mt-4 text-xs text-slate-500">
                  Drafts use the shipment status, dates, addresses, and AI issue context. You can copy or send via your default mail client after generation.
                </div>
              </Section>
            )}

            {drawerTab === "history" && (
              <Section title={`Analysis history (${drawerData.analyses.length})`}>
                {drawerData.analyses.length === 0 ? (
                  <div className="text-sm text-slate-500">No analyses yet.</div>
                ) : drawerData.analyses.map((a) => (
                  <div key={a.id} className="rounded-xl bg-slate-50 ring-1 ring-slate-200 p-3 mb-2">
                    <div className="flex items-center justify-between text-xs text-slate-500 mb-1">
                      <span>{fmtDateTime(a.created_at)} · {a.model}</span>
                      <span>{fmtUsd(a.cost_usd)}</span>
                    </div>
                    {a.issue ? <div className="text-sm"><b className="text-slate-700">Issue:</b> {a.issue}</div> : null}
                    {a.recommendation ? <div className="text-sm mt-0.5"><b className="text-slate-700">Rec:</b> {a.recommendation}</div> : null}
                    {a.response_text ? (
                      <pre className="mt-2 text-[11px] bg-white p-2 rounded-lg ring-1 ring-slate-200 whitespace-pre-wrap max-h-40 overflow-auto">{a.response_text}</pre>
                    ) : null}
                  </div>
                ))}
              </Section>
            )}

            {drawerTab === "raw" && (
              <Section title="Raw scrape">
                <pre className="text-[11px] bg-slate-900 text-slate-100 p-3 rounded-lg whitespace-pre-wrap max-h-[60vh] overflow-auto">
                  {JSON.stringify(drawerData.shipment.raw_data, null, 2)}
                </pre>
              </Section>
            )}
          </>
        ) : <div className="text-sm text-slate-500">Loading…</div>}
      </Drawer>

      {emailModal ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 backdrop-blur-sm"
          onClick={() => setEmailModal(null)}
        >
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl max-h-[85vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between p-5 border-b border-slate-200">
              <div>
                <h2 className="text-lg font-semibold flex items-center gap-2">
                  <Mail className="h-5 w-5 text-slate-700" />
                  {emailModal.audience === "carrier" ? "Email to carrier" : "Email to customer"}
                </h2>
                {drawerData ? <p className="text-xs text-slate-500 mt-0.5">{drawerData.shipment.tracking_number}</p> : null}
              </div>
              <button onClick={() => setEmailModal(null)} className="text-slate-500 hover:text-slate-900 p-2 rounded-lg hover:bg-slate-100">
                <X className="h-5 w-5" />
              </button>
            </div>
            <div className="p-5 overflow-y-auto flex-1">
              {emailModal.loading ? (
                <div className="text-center text-slate-500 py-12">Generating draft with Claude…</div>
              ) : emailModal.data ? (
                <>
                  <div className="text-xs text-slate-500 uppercase mb-1">Subject</div>
                  <div className="text-sm font-medium text-slate-900 mb-4 px-3 py-2 rounded-lg bg-slate-50 ring-1 ring-slate-200">
                    {emailModal.data.subject}
                  </div>
                  <div className="text-xs text-slate-500 uppercase mb-1">Body</div>
                  <pre className="text-sm whitespace-pre-wrap text-slate-800 px-3 py-3 rounded-lg bg-slate-50 ring-1 ring-slate-200 leading-relaxed">{emailModal.data.body}</pre>
                </>
              ) : null}
            </div>
            {emailModal.data && !emailModal.loading ? (
              <div className="p-4 border-t border-slate-200 flex items-center justify-between gap-3">
                <a
                  href={`mailto:?subject=${encodeURIComponent(emailModal.data.subject)}&body=${encodeURIComponent(emailModal.data.body)}`}
                  className="text-sm text-sky-700 hover:text-sky-900 font-medium"
                >Open in mail client →</a>
                <button
                  onClick={copyEmail}
                  className="px-4 py-2 rounded-lg bg-slate-900 text-white text-sm font-medium hover:bg-slate-800 flex items-center gap-2"
                >
                  {emailModal.copied ? <><Check className="h-4 w-4" /> Copied</> : <><Copy className="h-4 w-4" /> Copy</>}
                </button>
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
