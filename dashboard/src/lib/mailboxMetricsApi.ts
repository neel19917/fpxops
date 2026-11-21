import { apiUrl, getAccessTokenOrWait } from "./api";
import { impersonateHeaders } from "./impersonate";

// Client call for the admin-only Support Mailbox metrics page
// (/admin/mailbox-metrics). From GET /api/mailbox-metrics. Read only.

export interface MetricsPeriod {
  period: "today" | "week" | "month";
  /** ISO start of the bucket (PT midnight). */
  start: string;
  /** Inbound messages. */
  received: number;
  /** Outbound messages. */
  sent: number;
  /** Outbound messages that are replies. */
  replies: number;
  /** Distinct conversations with a reply in the period. */
  conversationsReplied: number;
  /** Distinct conversations started by the team (no prior inbound). */
  newOutbound: number;
  /** Distinct conversations with an inbound message in the period. */
  inboundConversations: number;
  /** Threads awaiting reply with last_inbound_at >= start. */
  awaiting: number;
}

export interface RepMetrics {
  /** e.g. "Shaun Zimmerman" | "Victor Z" | "Shared mailbox (unknown)" | "Unmatched sender" */
  rep: string;
  email: string | null;
  confidence: "confirmed" | "likely" | "unknown";
  today: number;
  week: number;
  month: number;
  monthReplies: number;
  monthConversationsReplied: number;
  /** Latest outbound ever attributed. */
  lastSentAt: string | null;
}

export interface MonthlyMetrics {
  /** "2026-07" */
  month: string;
  received: number;
  sent: number;
  replies: number;
  /** Rep name -> sent count. */
  byRep: Record<string, number>;
}

export interface LatestEmail {
  id: string;
  direction: "in" | "out";
  sender: string | null;
  subject: string | null;
  at: string;
  preview: string | null;
  rep: string | null;
}

export interface DataGap {
  id: string;
  owner: "Allen" | "Support team" | "FPX";
  severity: "high" | "medium" | "low";
  title: string;
  detail: string;
  fix: string;
  metric: number | null;
}

export interface MailboxMetrics {
  /** ISO now. */
  asOf: string;
  lastSyncAt: string | null;
  /** "freightsupport@freightpop.com" */
  mailbox: string;
  periods: MetricsPeriod[];
  reps: RepMetrics[];
  /** Oldest -> newest, current (partial) month last. */
  monthly: MonthlyMetrics[];
  /** 10 newest messages. */
  latest: LatestEmail[];
  gaps: DataGap[];
}

const TIMEOUT_MS = 30_000;

export async function getMailboxMetrics(months = 6): Promise<MailboxMetrics> {
  const token = await getAccessTokenOrWait();
  let res: Response;
  try {
    res = await fetch(`${apiUrl}/api/mailbox-metrics?months=${encodeURIComponent(String(months))}`, {
      method: "GET",
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: {
        Authorization: `Bearer ${token}`,
        ...impersonateHeaders(),
      },
    });
  } catch (e) {
    if (e instanceof DOMException && e.name === "TimeoutError") throw new Error("The server took too long to answer. Try again.");
    throw e;
  }
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    if (body?.error) throw new Error(String(body.error));
    if (res.status === 403) throw new Error("Admins only");
    throw new Error(res.status === 404 ? "The server does not have mailbox metrics yet. It needs its next update." : `The server returned ${res.status}`);
  }
  return res.json() as Promise<MailboxMetrics>;
}
