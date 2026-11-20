import { apiUrl, getAccessTokenOrWait } from "./api";

// Client for "when did FPX read this from FreightPOP, and what did each read
// change". The server keeps a record the first time it sees something and each
// time a later read finds a value different. Read-only.

export type ScrapeHistorySource = "erp_transactions" | "audit_approvals" | "shipment_details" | "shipment_record" | "tracking";

export interface ScrapeHistoryChange { from: unknown; to: unknown }

export interface ScrapeHistoryEvent {
  id: number | string;
  source: ScrapeHistorySource;
  entity_key: string;
  event: "first_seen" | "changed";
  scraped_at: string;                  // the read that saw this
  previous_scraped_at: string | null;  // the read before it
  changes: Record<string, ScrapeHistoryChange>;
  request_id: string | null;
  run_by: string | null;
}

export interface ScrapeHistoryResponse {
  source: ScrapeHistorySource | null;
  key: string | null;
  last_read_at: string | null;   // null = FPX has not stored this
  first_seen_at: string | null;
  events: ScrapeHistoryEvent[];  // newest first
}

export interface ScrapeHistorySummary {
  as_of: string;
  sources: { source: ScrapeHistorySource; last_read_at: string | null; changes_24h: number | null; changes_7d: number | null; error?: string }[];
}

async function get<T>(path: string): Promise<T> {
  const token = await getAccessTokenOrWait();
  const res = await fetch(`${apiUrl}${path}`, { headers: { authorization: `Bearer ${token}` } });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    if (body?.error) throw new Error(String(body.error));
    throw new Error(`The server returned ${res.status}`);
  }
  return res.json() as Promise<T>;
}

/** The reads of one entity that changed something, newest first, with when it was last and first read. */
export function fetchScrapeHistory(source: ScrapeHistorySource, entityKey: string, opts: { since?: string; limit?: number } = {}): Promise<ScrapeHistoryResponse> {
  const q = new URLSearchParams({ source, key: entityKey });
  if (opts.since) q.set("since", opts.since);
  if (opts.limit) q.set("limit", String(opts.limit));
  return get(`/api/scrape-history?${q.toString()}`);
}

/** Per source: when FPX last read it, and how many reads changed something lately. */
export function fetchScrapeHistorySummary(): Promise<ScrapeHistorySummary> {
  return get("/api/scrape-history/summary");
}

const MONEY_FIELDS = /^(sale|cost|charge|gross_profit|shipment_quote|variance|quote_(freight|fuel|accessorial_total|total)|.*_amount)$/;

/** A column name as words: "gross_profit" → "Gross profit". */
export function historyFieldLabel(field: string): string {
  const words = field.replace(/_/g, " ").trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : field;
}

/** One side of a change as text. Blank is "—". */
export function historyValue(field: string, value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "number") {
    return MONEY_FIELDS.test(field)
      ? value.toLocaleString(undefined, { style: "currency", currency: "USD" })
      : value.toLocaleString();
  }
  if (Array.isArray(value)) {
    if (!value.length) return "—";
    return value.map((v) => {
      if (v && typeof v === "object") {
        const o = v as { name?: unknown; amount?: unknown };
        if ("name" in o || "amount" in o) return `${String(o.name ?? "Accessorial")} ${historyValue("amount", o.amount)}`;
        return JSON.stringify(v);
      }
      return String(v);
    }).join(", ");
  }
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}
