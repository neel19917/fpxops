// Intel tab: puts one shipment in context. Top half lists the other shipments
// for the same customer, the same carrier, or both, so a rep can see whether
// this problem is a one-off. Bottom half asks FPX (the same assistant as the
// header search) a question about this shipment.
import { useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { AlertTriangle, CornerDownLeft, ExternalLink, Loader2, MessageCircle, Search } from "lucide-react";
import { api } from "../../lib/api";
import { hostedBrowser, type AssistantAction } from "../../lib/hostedBrowser";
import { fmtDateTime } from "../../lib/format";
import type { Shipment } from "../../lib/types";
import { Section } from "../Drawer";
import { statusTone } from "./KeyFacts";

export type SimilarBy = "customer" | "carrier" | "both";

const carrierOf = (s: Shipment) => (s.carrier_name || s.carrier || "").trim();
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

export function IntelTab({ shipment, by, onBy, onOpen }: {
  shipment: Shipment;
  by: SimilarBy;
  onBy: (b: SimilarBy) => void;
  onOpen: (id: string) => void;
}) {
  const customer = (shipment.customer_name || "").trim();
  const carrier = carrierOf(shipment);
  return (
    <>
      <Similar shipment={shipment} customer={customer} carrier={carrier} by={by} onBy={onBy} onOpen={onOpen} />
      {hostedBrowser.enabled ? <Ask key={shipment.id} shipment={shipment} customer={customer} carrier={carrier} onOpen={onOpen} /> : null}
    </>
  );
}

function Similar({ shipment, customer, carrier, by, onBy, onOpen }: {
  shipment: Shipment; customer: string; carrier: string;
  by: SimilarBy; onBy: (b: SimilarBy) => void; onOpen: (id: string) => void;
}) {
  const navigate = useNavigate();
  const [rows, setRows] = useState<Shipment[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [actionOnly, setActionOnly] = useState(false);
  const cache = useRef(new Map<string, Shipment[]>());

  // Fall back to whichever side this shipment actually has.
  const mode: SimilarBy = by === "both" && customer && carrier ? "both" : by === "carrier" && carrier ? "carrier" : customer ? "customer" : "carrier";
  const key = `${mode}|${customer}|${carrier}`;

  useEffect(() => {
    if (!customer && !carrier) { setRows([]); return; }
    const hit = cache.current.get(key);
    if (hit) { setRows(hit); setErr(null); return; }
    let cancelled = false;
    setRows(null); setErr(null);
    // The customer filter is exact on the server; carrier is a text search,
    // so it is narrowed to an exact carrier match here.
    const req = mode === "carrier" ? api.shipments.list({ q: carrier, limit: 1000 }) : api.shipments.list({ customer, limit: 1000 });
    req.then((r) => {
      if (cancelled) return;
      const list = r.data.filter((s) =>
        (mode === "customer" || same(carrierOf(s), carrier)) &&
        (mode === "carrier" || same((s.customer_name || "").trim(), customer)));
      cache.current.set(key, list);
      setRows(list);
    }).catch((e) => { if (!cancelled) setErr((e as Error).message); });
    return () => { cancelled = true; };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps

  const others = useMemo(() => (rows || []).filter((s) => s.id !== shipment.id && s.tracking_number !== shipment.tracking_number), [rows, shipment.id, shipment.tracking_number]);
  const needAction = others.filter((s) => s.action_required === "YES");
  const undelivered = others.filter((s) => !s.delivery_date);
  // Needs-action first, then the soonest ETA.
  const shown = useMemo(() => {
    const list = actionOnly ? needAction : others;
    return [...list].sort((a, b) =>
      Number(b.action_required === "YES") - Number(a.action_required === "YES") ||
      (Date.parse(b.updated_eta || "") || 0) - (Date.parse(a.updated_eta || "") || 0));
  }, [others, actionOnly]); // eslint-disable-line react-hooks/exhaustive-deps

  const options: { id: SimilarBy; label: string; off: boolean }[] = [
    { id: "customer", label: customer ? `Same customer · ${customer}` : "Same customer", off: !customer },
    { id: "carrier", label: carrier ? `Same carrier · ${carrier}` : "Same carrier", off: !carrier },
    { id: "both", label: "Same customer + carrier", off: !customer || !carrier },
  ];
  const trackingLink = () => {
    const p = new URLSearchParams({ reset: "1" });
    if (mode !== "carrier") p.set("customer", customer);
    if (mode !== "customer") p.set("q", carrier);
    return `/tracking?${p}`;
  };

  return (
    <Section title="Similar shipments">
      <div className="flex gap-1.5 flex-wrap mb-3">
        {options.map((o) => (
          <button key={o.id} type="button" disabled={o.off} onClick={() => onBy(o.id)} aria-pressed={mode === o.id}
            className={"text-xs px-2.5 py-1.5 rounded-full ring-1 max-w-full truncate transition disabled:opacity-40 disabled:cursor-not-allowed " +
              (mode === o.id ? "bg-slate-900 text-white ring-slate-900" : "bg-white text-slate-700 ring-slate-200 hover:bg-slate-50")}>
            {o.label}
          </button>
        ))}
      </div>

      {err ? <div className="text-sm text-rose-700">{err}</div> : null}
      {!rows && !err ? <div className="text-sm text-slate-500 inline-flex items-center gap-2"><Loader2 className="h-4 w-4 animate-spin" /> Looking…</div> : null}
      {rows ? (
        <>
          <div className="flex items-center gap-3 flex-wrap text-xs text-slate-600 mb-2">
            <span><b className="text-slate-900">{others.length}</b> other shipment{others.length === 1 ? "" : "s"}</span>
            <span className={needAction.length ? "text-rose-700 font-medium" : ""}>{needAction.length} need action</span>
            <span>{undelivered.length} not delivered</span>
            {needAction.length ? (
              <label className="inline-flex items-center gap-1 cursor-pointer select-none">
                <input type="checkbox" checked={actionOnly} onChange={(e) => setActionOnly(e.target.checked)} className="accent-violet-600" /> Only needing action
              </label>
            ) : null}
            {others.length ? (
              <button type="button" onClick={() => navigate(trackingLink())} className="ml-auto text-sky-700 hover:underline inline-flex items-center gap-1">
                Open in Tracking <ExternalLink className="h-3 w-3" />
              </button>
            ) : null}
          </div>
          {!others.length ? (
            <p className="text-sm text-slate-500">No other shipments match. This one stands alone.</p>
          ) : (
            <ul className="rounded-xl ring-1 ring-slate-200 divide-y divide-slate-100 max-h-80 overflow-y-auto">
              {shown.slice(0, 60).map((s) => (
                <li key={s.id}>
                  <button type="button" onClick={() => onOpen(s.id)} className="w-full text-left px-3 py-2 hover:bg-slate-50 flex items-start gap-2.5" title="Open this shipment">
                    <span className={"mt-1.5 h-2 w-2 rounded-full shrink-0 " + (s.action_required === "YES" ? "bg-rose-500" : s.action_required === "RESOLVED" ? "bg-violet-400" : "bg-emerald-400")} />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-2 flex-wrap">
                        <span className="font-mono text-xs font-semibold text-slate-900">{s.tracking_number || s.shipment_id || "—"}</span>
                        <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded-full ring-1 ${statusTone(s.shipment_status)}`}>{s.shipment_status || "No status"}</span>
                        <span className="text-[11px] text-slate-500 truncate">{mode === "customer" ? carrierOf(s) : mode === "carrier" ? s.customer_name : ""}</span>
                      </span>
                      {s.action_required === "YES" && s.ai_issue ? <span className="block text-xs text-slate-600 truncate">{s.ai_issue}</span> : null}
                    </span>
                    <span className="text-[11px] text-slate-400 shrink-0 text-right whitespace-nowrap">
                      {s.delivery_date ? "Delivered" : s.updated_eta ? `ETA ${fmtDateTime(s.updated_eta)}` : ""}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {shown.length > 60 ? <p className="mt-2 text-xs text-slate-500">Showing 60 of {shown.length}. Open in Tracking for the full list.</p> : null}
        </>
      ) : null}
    </Section>
  );
}

interface Turn { role: "user" | "assistant"; text: string; actions?: AssistantAction[]; error?: boolean }

function Ask({ shipment, customer, carrier, onOpen }: { shipment: Shipment; customer: string; carrier: string; onOpen: (id: string) => void }) {
  const location = useLocation();
  const [turns, setTurns] = useState<Turn[]>([]);
  const [history, setHistory] = useState<unknown[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const chatId = useRef(crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`);

  const suggestions = [
    customer ? `Is this a pattern for ${customer}?` : null,
    carrier ? `How has ${carrier} been performing lately?` : null,
    "Other shipments with the same problem",
    "What happened last time this came up?",
  ].filter((x): x is string => !!x);

  async function send(text: string) {
    const question = text.trim();
    if (!question || busy) return;
    setInput(""); setBusy(true); setDraft(""); setStatus(null);
    const next: Turn[] = [...turns, { role: "user", text: question }];
    setTurns(next);
    // The first message carries the shipment so the question can stay short.
    const about = `(Asked from the drawer for shipment ${shipment.shipment_id || "?"}, tracking ${shipment.tracking_number || "?"}` +
      `${carrier ? `, carrier ${carrier}` : ""}${customer ? `, customer ${customer}` : ""}, status ${shipment.shipment_status || "unknown"}.` +
      ` Answer about this shipment. Do not navigate away or open other pages.)`;
    const message = history.length ? question : `${question}\n\n${about}`;
    try {
      const r = await hostedBrowser.assistantStream(
        { history, message, context: { page: location.pathname, shipment_id: shipment.id, tracking_number: shipment.tracking_number }, chatId: chatId.current },
        (ev) => {
          if (ev.type === "text") { setStatus(null); setDraft((d) => d + ev.delta); }
          else if (ev.type === "reset") setDraft("");
          else if (ev.type === "status") setStatus(ev.text);
        });
      setTurns([...next, { role: "assistant", text: r.reply || "(no answer)", actions: r.actions }]);
      setHistory(r.messages);
    } catch (e) {
      setTurns([...next, { role: "assistant", text: (e as Error).message, error: true }]);
    } finally { setBusy(false); setDraft(""); setStatus(null); }
  }

  return (
    <Section title="Ask about this shipment">
      {turns.length ? (
        <div className="space-y-2.5 mb-3">
          {turns.map((t, i) => t.role === "user" ? (
            <div key={i} className="text-sm font-medium text-slate-900 flex items-start gap-1.5"><MessageCircle className="h-4 w-4 text-violet-600 mt-0.5 shrink-0" /> {t.text}</div>
          ) : (
            <div key={i} className={"rounded-xl ring-1 px-3 py-2.5 text-sm whitespace-pre-wrap leading-relaxed " + (t.error ? "bg-rose-50 ring-rose-200 text-rose-800" : "bg-slate-50 ring-slate-200 text-slate-800")}>
              {t.error ? <AlertTriangle className="inline h-3.5 w-3.5 mr-1" /> : null}{t.text}
              {(t.actions || []).filter((a) => a.type === "open_shipment").length ? (
                <div className="mt-2 flex gap-1.5 flex-wrap">
                  {(t.actions || []).map((a, j) => a.type === "open_shipment" ? (
                    <button key={j} type="button" onClick={() => onOpen(a.id)} className="text-xs px-2 py-1 rounded-md bg-white ring-1 ring-slate-200 text-sky-700 hover:bg-sky-50">
                      Open {a.label || "shipment"}
                    </button>
                  ) : null)}
                </div>
              ) : null}
            </div>
          ))}
          {busy ? (
            <div className="rounded-xl ring-1 ring-slate-200 bg-slate-50 px-3 py-2.5 text-sm whitespace-pre-wrap text-slate-800">
              {draft || <span className="text-slate-500 inline-flex items-center gap-2"><Loader2 className="h-4 w-4 animate-spin" /> {status || "Looking into it…"}</span>}
            </div>
          ) : null}
        </div>
      ) : (
        <div className="flex gap-1.5 flex-wrap mb-3">
          {suggestions.map((q) => (
            <button key={q} type="button" onClick={() => send(q)} disabled={busy}
              className="text-xs px-2.5 py-1.5 rounded-full bg-violet-50 text-violet-800 ring-1 ring-violet-200 hover:bg-violet-100 disabled:opacity-50">{q}</button>
          ))}
        </div>
      )}
      <form onSubmit={(e) => { e.preventDefault(); send(input); }} className="flex items-center gap-2 rounded-lg ring-1 ring-slate-200 focus-within:ring-2 focus-within:ring-violet-400 px-3 py-2">
        {busy ? <Loader2 className="h-4 w-4 text-violet-600 animate-spin shrink-0" /> : <Search className="h-4 w-4 text-slate-400 shrink-0" />}
        <input value={input} onChange={(e) => setInput(e.target.value)} disabled={busy}
          placeholder="Ask anything about this shipment, its carrier or its customer…"
          className="flex-1 min-w-0 text-sm outline-none bg-transparent" />
        <button type="submit" disabled={busy || !input.trim()} className="text-slate-400 hover:text-violet-700 disabled:opacity-40" aria-label="Ask"><CornerDownLeft className="h-4 w-4" /></button>
      </form>
    </Section>
  );
}
