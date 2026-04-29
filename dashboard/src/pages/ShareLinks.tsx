import { useEffect, useState } from "react";
import { Link2, Copy, Trash2, Eye, Lock, Clock, Filter } from "lucide-react";
import { api } from "../lib/api";
import { fmtDateTime, fmtRelative, fmtNum } from "../lib/format";
import type { ShareLink, ShareLinkView } from "../lib/types";
import { Drawer, Field, Section } from "../components/Drawer";
import { useAuth } from "../lib/auth";
import { showFrame, hideFrame, requestAutoFilter } from "../lib/freightpopFrame";

function publicUrlFor(token: string) {
  return `${window.location.origin}/share/${token}`;
}

export function ShareLinksPage() {
  const { clientConfig } = useAuth();
  const embedCfg = clientConfig?.embed_freightpop;
  const [rows, setRows] = useState<ShareLink[]>([]);
  const [loading, setLoading] = useState(true);
  const [detail, setDetail] = useState<{ link: ShareLink; views: ShareLinkView[] } | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  // Tracks the shipment-flavored share link's resolved shipment (so we can
  // surface tracking number + customer name and drive the singleton
  // FreightPOP overlay). null when the link isn't a shipment link OR the
  // lookup failed (revoked underlying record, RLS, etc.).
  const [shipmentMeta, setShipmentMeta] = useState<{
    id: string;
    shipment_id: string | null;
    tracking_number: string | null;
    customer_name: string | null;
  } | null>(null);
  // True while the "Load in FreightPOP" handler is mid-flight; lets us
  // disable the button so a double-click doesn't fire two postMessages.
  const [embedBusy, setEmbedBusy] = useState(false);

  async function load() {
    setLoading(true);
    try { setRows((await api.shareLinks.list()).data); } catch {}
    setLoading(false);
  }
  useEffect(() => { load(); }, []);
  useEffect(() => {
    if (!openId) { setDetail(null); setShipmentMeta(null); return; }
    api.shareLinks.get(openId).then(setDetail).catch(() => setDetail(null));
  }, [openId]);

  // When the opened share link points at a shipment, look the shipment up
  // so the drawer can show tracking + customer and offer the embed button.
  useEffect(() => {
    setShipmentMeta(null);
    if (!detail) return;
    if (detail.link.resource_type !== "shipment") return;
    const id = detail.link.resource_id;
    let cancelled = false;
    api.shipments.get(id)
      .then((r) => {
        if (cancelled) return;
        setShipmentMeta({
          id: r.shipment.id,
          shipment_id: r.shipment.shipment_id,
          tracking_number: r.shipment.tracking_number,
          customer_name: r.shipment.customer_name,
        });
      })
      .catch(() => { if (!cancelled) setShipmentMeta(null); });
    return () => { cancelled = true; };
  }, [detail]);

  // Drawer close ⇒ tear down the overlay so the iframe doesn't sit on top
  // of the rest of the dashboard. We don't unmount the iframe (the
  // singleton overlay only toggles visibility), so login state survives.
  useEffect(() => {
    if (openId) return;
    hideFrame();
  }, [openId]);
  // Page-leave cleanup mirrors what the Shipments page does.
  useEffect(() => () => { hideFrame(); }, []);

  function loadEmbed() {
    if (embedBusy) return;
    if (!embedCfg?.enabled) return;
    if (!shipmentMeta) return;
    setEmbedBusy(true);
    try {
      const url = (embedCfg.url_template || "")
        .replace(/\{tracking_number\}/g, encodeURIComponent(shipmentMeta.tracking_number || ""))
        .replace(/\{shipment_id\}/g, encodeURIComponent(shipmentMeta.shipment_id || shipmentMeta.id))
        .replace(/\{order_number\}/g, "");
      showFrame({
        url,
        shipmentId: shipmentMeta.id,
        shipmentLabel: shipmentMeta.shipment_id,
        trackingNumber: shipmentMeta.tracking_number,
        customerName: shipmentMeta.customer_name,
      });
      // Bump the tick so the overlay re-fires the Kendo filter even if
      // this exact tracking number was loaded previously (e.g. operator
      // already has the iframe open from a different surface).
      requestAutoFilter();
    } finally { setEmbedBusy(false); }
  }

  async function revoke(id: string, label: string | null) {
    if (!confirm(`Revoke link "${label || id}"? Anyone with the link will get a 410 response.`)) return;
    try { await api.shareLinks.revoke(id); load(); } catch (e) { alert((e as Error).message); }
  }

  return (
    <div className="bg-white rounded-2xl ring-1 ring-slate-200 shadow-sm">
      <div className="p-5 border-b border-slate-100">
        <h2 className="text-lg font-semibold flex items-center gap-2">
          <Link2 className="h-5 w-5 text-sky-600" /> Share links
        </h2>
        <p className="text-sm text-slate-500 mt-0.5">
          Public URLs that show a single shipment or audit run. Every view is logged.
        </p>
      </div>
      <div className="overflow-auto">
        <table className="w-full text-sm">
          <thead className="bg-slate-50">
            <tr className="text-left text-[11px] uppercase tracking-wide text-slate-500">
              <th className="px-5 py-2.5 font-medium">Label</th>
              <th className="px-5 py-2.5 font-medium">Type</th>
              <th className="px-5 py-2.5 font-medium">Created</th>
              <th className="px-5 py-2.5 font-medium">Expires</th>
              <th className="px-5 py-2.5 font-medium text-right">Views</th>
              <th className="px-5 py-2.5 font-medium text-right">Last view</th>
              <th className="px-5 py-2.5 font-medium"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {loading ? <tr><td colSpan={7} className="p-8 text-center text-slate-500">Loading…</td></tr>
              : rows.length === 0 ? <tr><td colSpan={7} className="p-8 text-center text-slate-500">No links yet — share a shipment or audit from its detail drawer.</td></tr>
              : rows.map((r) => (
                <tr key={r.id} className="hover:bg-sky-50/50 cursor-pointer" onClick={() => setOpenId(r.id)}>
                  <td className="px-5 py-3 max-w-[260px] truncate flex items-center gap-2">
                    {r.revoked_at ? <span className="text-xs rounded-full bg-slate-200 text-slate-600 px-2 py-0.5">revoked</span> : null}
                    <span className="font-medium truncate">{r.label || `(${r.resource_type})`}</span>
                  </td>
                  <td className="px-5 py-3 text-slate-600">{r.resource_type}</td>
                  <td className="px-5 py-3 text-slate-500">{fmtDateTime(r.created_at)}</td>
                  <td className="px-5 py-3 text-slate-500">
                    {r.expires_at ? <span className="flex items-center gap-1"><Clock className="h-3 w-3" />{fmtDateTime(r.expires_at)}</span> : "never"}
                  </td>
                  <td className="px-5 py-3 text-right">{fmtNum(r.view_count)}</td>
                  <td className="px-5 py-3 text-right text-slate-500">{fmtRelative(r.last_viewed_at)}</td>
                  <td className="px-5 py-3 text-right" onClick={(e) => e.stopPropagation()}>
                    <button
                      onClick={() => navigator.clipboard.writeText(publicUrlFor(r.token))}
                      className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded-md text-slate-600 hover:bg-slate-100"
                      title="Copy URL"
                    >
                      <Copy className="h-3.5 w-3.5" /> Copy
                    </button>
                    {!r.revoked_at && (
                      <button
                        onClick={() => revoke(r.id, r.label)}
                        className="ml-1 inline-flex items-center gap-1 text-xs px-2 py-1 rounded-md text-rose-600 hover:bg-rose-50"
                        title="Revoke"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>

      <Drawer
        open={!!openId}
        onClose={() => setOpenId(null)}
        title={detail?.link.label || "Share link"}
        subtitle={detail ? `${detail.link.resource_type} · ${detail.views.length} views` : undefined}
        // The singleton FreightPOP overlay paints over the gray space when
        // the operator clicks "Load in FreightPOP" from this drawer; the
        // backdrop would dim it.
        suppressBackdrop={!!(embedCfg?.enabled && shipmentMeta)}
      >
        {detail ? (
          <>
            {detail.link.resource_type === "shipment" && shipmentMeta ? (
              <Section title="Shipment">
                <div className="grid grid-cols-2 gap-4 mb-3">
                  <Field label="Shipment ID">
                    <span className="font-semibold">{shipmentMeta.shipment_id || "—"}</span>
                  </Field>
                  <Field label="Customer">{shipmentMeta.customer_name || "—"}</Field>
                  <Field label="Tracking #">
                    <span className="font-mono">{shipmentMeta.tracking_number || "—"}</span>
                  </Field>
                </div>
                {embedCfg?.enabled ? (
                  <button
                    type="button"
                    onClick={loadEmbed}
                    disabled={embedBusy || !shipmentMeta.tracking_number}
                    className="text-xs px-3 py-1.5 rounded-md ring-1 ring-violet-600 bg-violet-600 text-white hover:bg-violet-700 inline-flex items-center gap-1.5 disabled:opacity-50 disabled:cursor-not-allowed"
                    title={shipmentMeta.tracking_number
                      ? `Load FreightPOP and filter the grid to ${shipmentMeta.tracking_number}`
                      : "No tracking number on this shipment"}
                  >
                    <Filter className="h-3.5 w-3.5" /> Load in FreightPOP
                  </button>
                ) : (
                  <div className="text-[11px] text-slate-500">
                    Set <span className="font-mono">embed.freightpop.url_template</span> in Settings
                    to enable the in-page FreightPOP embed.
                  </div>
                )}
              </Section>
            ) : null}
            <Section title="Link">
              <Field label="Public URL">
                <div className="flex items-center gap-2">
                  <code className="flex-1 bg-slate-50 ring-1 ring-slate-200 text-xs p-2 rounded-lg break-all">
                    {publicUrlFor(detail.link.token)}
                  </code>
                  <button
                    onClick={() => navigator.clipboard.writeText(publicUrlFor(detail.link.token))}
                    className="p-2 rounded-lg bg-slate-100 hover:bg-slate-200"
                    title="Copy"
                  >
                    <Copy className="h-4 w-4" />
                  </button>
                </div>
              </Field>
              <div className="grid grid-cols-2 gap-4 mt-4">
                <Field label="Created">{fmtDateTime(detail.link.created_at)}</Field>
                <Field label="Expires">{detail.link.expires_at ? fmtDateTime(detail.link.expires_at) : "never"}</Field>
                <Field label="Views">{detail.link.view_count}</Field>
                <Field label="Last viewed">{fmtRelative(detail.link.last_viewed_at)}</Field>
              </div>
            </Section>
            <Section title={`Views (${detail.views.length})`}>
              {detail.views.length === 0 ? (
                <div className="text-sm text-slate-500 flex items-center gap-1.5"><Eye className="h-4 w-4" /> No views yet.</div>
              ) : detail.views.map((v) => (
                <div key={v.id} className="py-2 border-b border-slate-100 last:border-0">
                  <div className="flex justify-between text-sm">
                    <span>{fmtDateTime(v.viewed_at)}</span>
                    <span className="text-slate-500 font-mono text-xs">{v.viewer_ip || "—"}</span>
                  </div>
                  <div className="text-xs text-slate-500 truncate">{v.viewer_user_agent || ""}</div>
                </div>
              ))}
            </Section>
            {detail.link.revoked_at ? (
              <Section title="Status">
                <div className="rounded-lg bg-rose-50 ring-1 ring-rose-200 text-rose-700 p-3 flex items-center gap-2">
                  <Lock className="h-4 w-4" /> Revoked {fmtRelative(detail.link.revoked_at)}
                </div>
              </Section>
            ) : null}
          </>
        ) : <div className="text-sm text-slate-500">Loading…</div>}
      </Drawer>
    </div>
  );
}
