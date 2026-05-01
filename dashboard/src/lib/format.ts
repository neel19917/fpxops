export function fmtDate(s: string | null | undefined): string {
  if (!s) return "—";
  const d = new Date(s);
  if (isNaN(d.getTime())) return String(s);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "2-digit" });
}

export function fmtDateTime(s: string | null | undefined): string {
  if (!s) return "—";
  const d = new Date(s);
  if (isNaN(d.getTime())) return String(s);
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

export function fmtRelative(s: string | null | undefined): string {
  if (!s) return "—";
  const d = new Date(s);
  if (isNaN(d.getTime())) return String(s);
  const diffMs = Date.now() - d.getTime();
  const sec = Math.max(1, Math.round(diffMs / 1000));
  if (sec < 60) return `${sec}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  if (day < 30) return `${day}d ago`;
  return fmtDate(s);
}

export function fmtUsd(n: number | null | undefined): string {
  if (n == null) return "—";
  return `$${Number(n).toFixed(4)}`;
}

export function fmtNum(n: number | null | undefined): string {
  if (n == null) return "—";
  return Number(n).toLocaleString();
}

export function fmtPct(n: number | null | undefined): string {
  if (n == null) return "—";
  return `${Number(n).toFixed(2)}%`;
}

// FreightPOP web-app deep link to a tracking number. Lands the user on
// the FP dashboard with the tracking number pre-applied so they're one
// click away from the FP-native tracking modal. Keeping this distinct
// from carrierTrackingUrl below — operators want the FP modal first
// (richer ops view) and only fall back to the carrier site when the FP
// modal doesn't have what they need.
export function freightpopTrackingUrl(trackingNumber: string | null | undefined): string | null {
  const tn = (trackingNumber || "").trim();
  if (!tn) return null;
  return `https://app.freightpop.com/dashboard?TrackingNumber=${encodeURIComponent(tn)}`;
}

// Resolve a carrier + tracking number to a public tracking URL. Common
// carriers go to their direct tracking pages; anything we don't recognize
// falls back to a Google search so the rep always lands somewhere useful.
// Matching is case-insensitive substring on the carrier name/code so
// scraped variants ("FedEx Ground", "UPS Inc.", etc.) still resolve.
export function carrierTrackingUrl(carrier: string | null | undefined, trackingNumber: string | null | undefined): string | null {
  const tn = (trackingNumber || "").trim();
  if (!tn) return null;
  const c = (carrier || "").toLowerCase();
  if (c.includes("fedex"))   return `https://www.fedex.com/fedextrack/?tracknumbers=${encodeURIComponent(tn)}`;
  if (c.includes("ups"))     return `https://www.ups.com/track?tracknum=${encodeURIComponent(tn)}`;
  if (c.includes("usps"))    return `https://tools.usps.com/go/TrackConfirmAction?tLabels=${encodeURIComponent(tn)}`;
  if (c.includes("dhl"))     return `https://www.dhl.com/en/express/tracking.html?AWB=${encodeURIComponent(tn)}`;
  if (c.includes("ontrac"))  return `https://www.ontrac.com/tracking-details?tracking_number=${encodeURIComponent(tn)}`;
  if (c.includes("estes"))   return `https://www.estes-express.com/myestes/shipment-tracking/?type=PRO&query=${encodeURIComponent(tn)}`;
  if (c.includes("xpo"))     return `https://ltl.xpo.com/tracking?reqid=quicktrack&pros=${encodeURIComponent(tn)}`;
  if (c.includes("saia"))    return `https://www.saia.com/Track/Tracking?tracenumber=${encodeURIComponent(tn)}`;
  if (c.includes("yrc") || c.includes("yellow")) return `https://my.yrc.com/dynamic/national/servlet?CONTROLLER=com.rdwy.ec.rextracking.http.controller.ProcessPublicTrackingController&PRONumber=${encodeURIComponent(tn)}`;
  if (c.includes("old dominion") || c === "odfl") return `https://www.odfl.com/Trace/standardResults.faces?searchType=Tracking&searchValue=${encodeURIComponent(tn)}`;
  // Fallback — Google search with carrier + tracking number, which is
  // what most operators do anyway when the carrier isn't a top-tier.
  const q = encodeURIComponent(`${carrier || ""} tracking ${tn}`.trim());
  return `https://www.google.com/search?q=${q}`;
}
