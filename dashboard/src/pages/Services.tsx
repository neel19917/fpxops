import { useNavigate, useParams } from "react-router-dom";
import {
  Truck,
  Users as UsersIcon,
  Tag,
  FileText,
  Workflow,
  Plug,
  Sparkles,
  ArrowLeft,
  ChevronRight,
  Database,
} from "lucide-react";
import { useAuth } from "../lib/auth";

// "Services" hub — placeholder routes for future SQL-backed admin
// surfaces. Each entry has a slug that becomes a URL the user can
// share / bookmark even before the backend is wired. When the
// prototype clears, the placeholder page gets replaced with the real
// CRUD UI and the backend gets wired via SQL/Supabase.
//
// Adding a new service: drop a new entry below and a sub-route
// auto-renders. The hub grid + the /admin/services/:slug detail view
// both consume this list.
interface ServiceDef {
  slug: string;
  title: string;
  blurb: string;          // shown on the hub card
  details: string[];      // bullets shown on the detail page
  Icon: typeof Truck;
  // Tailwind tones for the card chrome. Keep five-color rotation so
  // the grid doesn't look monotonous.
  tone: "violet" | "sky" | "emerald" | "amber" | "rose" | "slate";
  // Eta is informational only — populated when there's a target. Empty
  // string means "no commitment yet".
  eta: string;
}

const SERVICES: ServiceDef[] = [
  {
    slug: "carriers",
    title: "Carrier Database",
    blurb: "Master list of carriers with contacts, contract terms, and lane coverage.",
    details: [
      "Contact roster per carrier (sales, ops, AP) with primary fallbacks",
      "Contract terms — service modes, lane coverage, blackout dates",
      "Performance rollup pulled from shipments table (on-time, exceptions, GP impact)",
      "Quick-action drawer: pull last 50 shipments for this carrier, draft an outreach",
    ],
    Icon: Truck,
    tone: "violet",
    eta: "",
  },
  {
    slug: "customers",
    title: "Customer Database",
    blurb: "Account profiles, billing preferences, SLA targets, and primary contacts.",
    details: [
      "Account → contacts hierarchy with billing/ops/exec roles",
      "Per-customer SLA targets (transit time, on-time %, exception response)",
      "Billing prefs: terms, invoicing cadence, EDI receivers",
      "Linked tasks + open exceptions surfaced inline so account managers see status at a glance",
    ],
    Icon: UsersIcon,
    tone: "sky",
    eta: "",
  },
  {
    slug: "tariffs",
    title: "Tariffs & Rates",
    blurb: "Lane-based pricing, fuel surcharges, accessorial schedules, and effective dates.",
    details: [
      "Origin/destination lane matrix with mode breakouts (LTL, TL, parcel, intl)",
      "Effective-dated rate cards so historical quotes stay reproducible",
      "Fuel surcharge index + accessorial list (lift gate, residential, etc.)",
      "Margin guard: flag when a quote would breach the configured GP floor",
    ],
    Icon: Tag,
    tone: "emerald",
    eta: "",
  },
  {
    slug: "templates",
    title: "Email Templates",
    blurb: "Reusable templates for carrier outreach, customer updates, and exception alerts.",
    details: [
      "Variable substitution: {{shipment_id}}, {{eta}}, {{carrier}}, {{tracking_number}}",
      "Per-template audience copy (carrier vs customer) editable like the AI prompts",
      "Surface in the drawer's Email modal alongside the AI-drafted version",
      "Track usage + thumbs rating per template so unused ones can be retired",
    ],
    Icon: FileText,
    tone: "amber",
    eta: "",
  },
  {
    slug: "rules",
    title: "Workflow Rules",
    blurb: "Auto-create tasks, assign owners, and escalate exceptions based on conditions.",
    details: [
      "Triggers: shipment status change, ETA slippage, missing POD, custom JSON match",
      "Actions: create task with template, assign to user/role, post to Slack, draft email",
      "Per-rule throttle so a flapping shipment doesn't generate 50 tasks",
      "Audit trail: every rule execution logs to the existing audit log",
    ],
    Icon: Workflow,
    tone: "rose",
    eta: "",
  },
  {
    slug: "integrations",
    title: "Integrations Hub",
    blurb: "TMS connectors, EDI feeds, and ERP sync settings in one place.",
    details: [
      "Per-connector status (last sync, error rate, throughput)",
      "EDI 214/210/990 feed health — green/amber/red based on age of last good message",
      "Manual replay buttons for stuck shipments without round-tripping to engineering",
      "Future: marketplace-style add new integration flow",
    ],
    Icon: Plug,
    tone: "slate",
    eta: "",
  },
];

const TONE_CLASSES: Record<ServiceDef["tone"], { card: string; iconBg: string; iconFg: string; chip: string }> = {
  violet:  { card: "ring-violet-200 hover:ring-violet-300",   iconBg: "bg-violet-100",  iconFg: "text-violet-700",  chip: "bg-violet-50 text-violet-700 ring-violet-200" },
  sky:     { card: "ring-sky-200 hover:ring-sky-300",         iconBg: "bg-sky-100",     iconFg: "text-sky-700",     chip: "bg-sky-50 text-sky-700 ring-sky-200" },
  emerald: { card: "ring-emerald-200 hover:ring-emerald-300", iconBg: "bg-emerald-100", iconFg: "text-emerald-700", chip: "bg-emerald-50 text-emerald-700 ring-emerald-200" },
  amber:   { card: "ring-amber-200 hover:ring-amber-300",     iconBg: "bg-amber-100",   iconFg: "text-amber-700",   chip: "bg-amber-50 text-amber-700 ring-amber-200" },
  rose:    { card: "ring-rose-200 hover:ring-rose-300",       iconBg: "bg-rose-100",    iconFg: "text-rose-700",    chip: "bg-rose-50 text-rose-700 ring-rose-200" },
  slate:   { card: "ring-slate-200 hover:ring-slate-300",     iconBg: "bg-slate-100",   iconFg: "text-slate-700",   chip: "bg-slate-50 text-slate-700 ring-slate-200" },
};

// Hub page — grid of service cards. Click → /admin/services/:slug.
export function ServicesPage() {
  const navigate = useNavigate();
  const { profile } = useAuth();
  return (
    <div className="space-y-5">
      <div className="bg-white rounded-2xl ring-1 ring-slate-200 shadow-sm p-5">
        <div className="flex items-start gap-3">
          <div className="shrink-0 h-10 w-10 rounded-xl bg-sky-100 flex items-center justify-center">
            <Database className="h-5 w-5 text-sky-700" />
          </div>
          <div className="min-w-0">
            <h2 className="text-lg font-semibold flex items-center gap-2">
              Services
              <span className="text-[10px] font-bold uppercase tracking-wide px-2 py-0.5 rounded ring-1 bg-amber-50 text-amber-800 ring-amber-200">
                Coming soon
              </span>
            </h2>
            <p className="text-sm text-slate-500 mt-1 max-w-2xl leading-relaxed">
              Future SQL-backed admin surfaces. The routes below are reserved and
              navigable today — each is a placeholder while we validate the prototype.
              When a service ships, the placeholder is replaced with the live CRUD UI.
              {profile?.email ? <> Signed in as <span className="font-mono">{profile.email}</span>.</> : null}
            </p>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
        {SERVICES.map((s) => {
          const t = TONE_CLASSES[s.tone];
          return (
            <button
              key={s.slug}
              onClick={() => navigate(`/admin/services/${s.slug}`)}
              className={`text-left bg-white rounded-2xl ring-1 ${t.card} shadow-sm transition p-5 group focus:outline-none focus:ring-2 focus:ring-offset-1 focus:ring-sky-500`}
            >
              <div className="flex items-start gap-3">
                <div className={`shrink-0 h-10 w-10 rounded-xl ${t.iconBg} flex items-center justify-center`}>
                  <s.Icon className={`h-5 w-5 ${t.iconFg}`} />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between gap-2">
                    <h3 className="text-sm font-semibold text-slate-900 truncate">{s.title}</h3>
                    <ChevronRight className="h-4 w-4 text-slate-400 shrink-0 group-hover:text-slate-700 transition" />
                  </div>
                  <p className="text-xs text-slate-500 mt-1 leading-relaxed line-clamp-3">{s.blurb}</p>
                  <div className="flex items-center gap-2 mt-3 flex-wrap">
                    <span className={`text-[10px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded ring-1 ${t.chip}`}>
                      Coming soon
                    </span>
                    <span className="text-[10px] font-mono text-slate-400">/admin/services/{s.slug}</span>
                    {s.eta ? <span className="text-[10px] text-slate-500">· {s.eta}</span> : null}
                  </div>
                </div>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

// Detail/placeholder page for a specific service. Reachable via
// /admin/services/:slug. Renders a "Coming soon" surface that
// describes what'll live here so stakeholders can preview the
// shape before the backend exists.
export function ServiceDetailPage() {
  const { slug } = useParams<{ slug: string }>();
  const navigate = useNavigate();
  const def = SERVICES.find((s) => s.slug === slug);

  if (!def) {
    return (
      <div className="bg-white rounded-2xl ring-1 ring-slate-200 shadow-sm p-8 text-center">
        <h2 className="text-base font-semibold text-slate-900">Unknown service</h2>
        <p className="text-sm text-slate-500 mt-1">No service named <span className="font-mono">{slug}</span> exists yet.</p>
        <button
          onClick={() => navigate("/admin/services")}
          className="mt-4 inline-flex items-center gap-1.5 text-sm text-sky-700 hover:text-sky-900 font-medium"
        >
          <ArrowLeft className="h-4 w-4" /> Back to Services
        </button>
      </div>
    );
  }

  const t = TONE_CLASSES[def.tone];

  return (
    <div className="space-y-4">
      <button
        onClick={() => navigate("/admin/services")}
        className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-500 hover:text-slate-900"
      >
        <ArrowLeft className="h-3.5 w-3.5" /> All services
      </button>

      <div className={`bg-white rounded-2xl ring-1 ${t.card.split(" ")[0]} shadow-sm overflow-hidden`}>
        <div className="px-6 pt-6 pb-5 flex items-start gap-4">
          <div className={`shrink-0 h-12 w-12 rounded-xl ${t.iconBg} flex items-center justify-center`}>
            <def.Icon className={`h-6 w-6 ${t.iconFg}`} />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              <h2 className="text-xl font-semibold text-slate-900">{def.title}</h2>
              <span className={`text-[10px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded ring-1 ${t.chip}`}>
                Coming soon
              </span>
            </div>
            <p className="text-sm text-slate-500 mt-1.5 leading-relaxed max-w-2xl">{def.blurb}</p>
            <div className="text-[11px] font-mono text-slate-400 mt-2">/admin/services/{def.slug}</div>
          </div>
        </div>
        <div className="border-t border-slate-100 bg-slate-50/40 px-6 py-5">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500 mb-3 flex items-center gap-1.5">
            <Sparkles className="h-3.5 w-3.5" /> What's planned
          </div>
          <ul className="space-y-2">
            {def.details.map((d, i) => (
              <li key={i} className="flex items-start gap-2 text-sm text-slate-700 leading-relaxed">
                <span className="mt-1.5 h-1.5 w-1.5 rounded-full bg-slate-400 shrink-0" />
                <span>{d}</span>
              </li>
            ))}
          </ul>
        </div>
        <div className="border-t border-slate-100 bg-white px-6 py-4 text-xs text-slate-500 leading-relaxed">
          <strong className="text-slate-700">Status:</strong> Reserved route — no UI yet.
          The Supabase schema and SQL migrations land before this page activates.
          Until then, edits happen by direct SQL.
        </div>
      </div>
    </div>
  );
}
