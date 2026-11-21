import { useCallback, type ReactNode } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { AlertTriangle, ArrowLeft, Building2, ListChecks, Mail, Package, RefreshCw, Truck } from "lucide-react";
import { getShipper, type NameCount, type ShipperDetail } from "../lib/shippersApi";
import { useCached } from "../lib/useCached";
import { fmtDateTime, fmtNum, fmtRelative } from "../lib/format";
import { ShipperShipments } from "../components/shipper/ShipperShipments";
import { ShipperTasks } from "../components/shipper/ShipperTasks";
import { ShipperEmails } from "../components/shipper/ShipperEmails";
import { ShipperTimeline } from "../components/shipper/ShipperTimeline";

// One shipper's dashboard: tracking, tasks, emails and activity off one page.
// Route /shippers/:key, where key = encodeURIComponent(customer_name) or
// "__none__" for shipments with no shipper. The tab lives in ?tab= so the
// compact panels' "See all" buttons can switch it.

type TabKey = "overview" | "tracking" | "tasks" | "emails" | "activity";

const TABS: { id: TabKey; label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "tracking", label: "Tracking" },
  { id: "tasks", label: "Tasks" },
  { id: "emails", label: "Emails" },
  { id: "activity", label: "Activity" },
];

function isNotFound(e: string | null): boolean {
  return !!e && /\b404\b|not found|no shipments/i.test(e);
}

export default function ShipperDetailPage() {
  // React Router hands back the decoded param; re-encode it so the key is
  // always the encodeURIComponent(customer_name) form the API expects.
  const { key: rawParam = "" } = useParams<{ key: string }>();
  const shipperKey = encodeURIComponent(rawParam);
  const [params, setParams] = useSearchParams();

  const fetcher = useCallback((signal: AbortSignal) => getShipper(shipperKey, signal), [shipperKey]);
  const detail = useCached<ShipperDetail>(`shipper:${shipperKey}`, fetcher);
  const data = detail.data;

  const emailAccess = data?.email_access ?? "none";
  const showEmails = !!data && emailAccess !== "none";
  const requested = TABS.find((t) => t.id === params.get("tab"))?.id ?? "overview";
  const tab: TabKey = requested === "emails" && !showEmails ? "overview" : requested;
  const visibleTabs = TABS.filter((t) => t.id !== "emails" || showEmails);

  const setTab = (t: TabKey) => {
    const next = new URLSearchParams(params);
    if (t === "overview") next.delete("tab");
    else next.set("tab", t);
    setParams(next, { replace: false });
  };

  const backLink = (
    <Link to="/shippers" className="inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-900">
      <ArrowLeft className="h-4 w-4" /> All shippers
    </Link>
  );

  // Unknown shipper, or a first load that failed.
  if (!data) {
    if (detail.error && isNotFound(detail.error)) {
      return (
        <div className="space-y-4">
          {backLink}
          <div className="rounded-xl ring-1 ring-slate-200 bg-white p-10 text-center max-w-xl mx-auto">
            <Building2 className="h-10 w-10 text-slate-300 mx-auto" />
            <h2 className="mt-3 text-base font-semibold text-slate-900">Shipper not found</h2>
            <p className="mt-1 text-sm text-slate-500">
              No shipments are scraped for “{rawParam === "__none__" ? "(No shipper)" : rawParam}”.
            </p>
          </div>
        </div>
      );
    }
    if (detail.error) {
      return (
        <div className="space-y-4">
          {backLink}
          <div className="rounded-xl ring-1 ring-rose-200 bg-rose-50 p-4 text-sm text-rose-800 flex items-center gap-3 flex-wrap">
            <AlertTriangle className="h-4 w-4" />
            <span className="break-words">Couldn't load this shipper: {detail.error}</span>
            <button
              onClick={detail.refresh}
              className="ml-auto px-3 py-1.5 rounded-lg bg-white ring-1 ring-rose-300 hover:bg-rose-100 text-rose-800"
            >Retry</button>
          </div>
        </div>
      );
    }
    return (
      <div className="space-y-4">
        {backLink}
        <div className="h-8 w-72 rounded-lg bg-slate-200 animate-pulse" />
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="h-20 rounded-xl bg-slate-100 animate-pulse" />
          ))}
        </div>
        <div className="h-64 rounded-xl bg-slate-100 animate-pulse" />
      </div>
    );
  }

  const s = data.shipper;
  const canDraft = emailAccess === "draft";

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-3 flex-wrap">
        {backLink}
        <div className="ml-auto flex items-center gap-2 text-xs text-slate-500">
          {detail.error ? <span className="text-rose-600" title={detail.error}>Refresh failed</span> : null}
          <span title={fmtDateTime(s.last_scraped_at)}>Last scraped {fmtRelative(s.last_scraped_at)}</span>
          <button
            onClick={detail.refresh}
            className="p-1.5 rounded-lg hover:bg-slate-100 text-slate-500 hover:text-slate-900"
            title="Refresh"
          >
            <RefreshCw className={"h-4 w-4" + (detail.refreshing ? " animate-spin" : "")} />
          </button>
        </div>
      </div>

      <header className="space-y-3">
        <h1 className="text-xl font-semibold flex items-center gap-2 break-words">
          <Building2 className="h-5 w-5 text-sky-600 shrink-0" />
          {s.customer_name}
          <span className="text-sm font-normal text-slate-500">{fmtNum(s.shipments)} shipments</span>
        </h1>

        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
          <Kpi label="Active" value={s.active} Icon={Package} onClick={() => setTab("tracking")} />
          <Kpi label="In transit" value={s.in_transit} Icon={Truck} onClick={() => setTab("tracking")} />
          <Kpi
            label="Exceptions"
            value={s.exceptions}
            Icon={AlertTriangle}
            tone={s.exceptions > 0 ? "amber" : undefined}
            onClick={() => setTab("tracking")}
          />
          <Kpi
            label="Open tasks"
            value={s.open_tasks}
            Icon={ListChecks}
            sub={s.overdue_tasks > 0 ? <span className="text-rose-600 font-medium">{fmtNum(s.overdue_tasks)} overdue</span> : null}
            onClick={() => setTab("tasks")}
          />
          {showEmails ? (
            <Kpi
              label="Awaiting reply"
              value={s.awaiting_reply ?? 0}
              Icon={Mail}
              tone={(s.awaiting_reply ?? 0) > 0 ? "violet" : undefined}
              sub={s.email_threads != null ? <span>{fmtNum(s.email_threads)} threads{s.last_email_at ? ` · ${fmtRelative(s.last_email_at)}` : ""}</span> : null}
              onClick={() => setTab("emails")}
            />
          ) : null}
        </div>

        <div className="flex flex-wrap gap-x-5 gap-y-2">
          <ChipGroup label="Carriers" items={data.carriers} />
          <ChipGroup label="Modes" items={data.modes} />
          <ChipGroup label="Statuses" items={data.statuses} />
        </div>
      </header>

      <div className="border-b border-slate-200 flex gap-1 overflow-x-auto">
        {visibleTabs.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={
              "px-3 py-2 text-sm font-medium border-b-2 -mb-px whitespace-nowrap transition " +
              (tab === t.id
                ? "border-sky-600 text-sky-700"
                : "border-transparent text-slate-500 hover:text-slate-900 hover:border-slate-300")
            }
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === "overview" ? (
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-5 items-start">
          <div className="space-y-5 min-w-0">
            <ShipperShipments shipperKey={shipperKey} compact />
            <ShipperTasks shipperKey={shipperKey} compact />
          </div>
          <div className="space-y-5 min-w-0">
            {showEmails ? <ShipperEmails shipperKey={shipperKey} compact canDraft={canDraft} /> : null}
            <ShipperTimeline shipperKey={shipperKey} compact />
          </div>
        </div>
      ) : null}
      {tab === "tracking" ? <ShipperShipments shipperKey={shipperKey} /> : null}
      {tab === "tasks" ? <ShipperTasks shipperKey={shipperKey} /> : null}
      {tab === "emails" && showEmails ? <ShipperEmails shipperKey={shipperKey} canDraft={canDraft} /> : null}
      {tab === "activity" ? <ShipperTimeline shipperKey={shipperKey} /> : null}
    </div>
  );
}

function Kpi({ label, value, Icon, tone, sub, onClick }: {
  label: string;
  value: number;
  Icon: typeof Package;
  tone?: "amber" | "violet";
  sub?: ReactNode;
  onClick?: () => void;
}) {
  const ring = tone === "amber" ? "ring-amber-200 bg-amber-50" : tone === "violet" ? "ring-violet-200 bg-violet-50" : "ring-slate-200 bg-white";
  const iconColor = tone === "amber" ? "text-amber-600" : tone === "violet" ? "text-violet-600" : "text-slate-400";
  return (
    <button
      onClick={onClick}
      className={`rounded-xl ring-1 ${ring} p-3 text-left hover:shadow-sm transition min-w-0`}
    >
      <div className="flex items-center gap-1.5 text-xs text-slate-500">
        <Icon className={`h-3.5 w-3.5 ${iconColor}`} /> {label}
      </div>
      <div className="mt-1 text-2xl font-semibold text-slate-900 tabular-nums">{fmtNum(value)}</div>
      {sub ? <div className="text-xs text-slate-500 truncate">{sub}</div> : null}
    </button>
  );
}

function ChipGroup({ label, items }: { label: string; items: NameCount[] }) {
  if (!items?.length) return null;
  return (
    <div className="flex items-center gap-1.5 flex-wrap min-w-0">
      <span className="text-[11px] uppercase tracking-wide text-slate-400 font-semibold">{label}</span>
      {items.slice(0, 8).map((it) => (
        <span
          key={it.name}
          className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-700"
        >
          {it.name || "—"}
          <span className="text-slate-400 tabular-nums">{fmtNum(it.count)}</span>
        </span>
      ))}
    </div>
  );
}
